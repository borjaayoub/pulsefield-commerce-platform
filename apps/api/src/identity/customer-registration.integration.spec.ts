import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, OutboxMessageStatus, RoleName } from '../generated/prisma/enums';
import {
  CUSTOMER_REGISTERED_EVENT_TYPE,
  CustomerRegistrationService,
} from './customer-registration.service';
import { EmailVerificationTokenService } from './email-verification-token.service';
import {
  EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EmailVerificationRequestService,
} from './email-verification-request.service';
import { normalizeEmail } from './normalize-email';
import { PasswordHasher } from './password-hasher.service';
import {
  PASSWORD_RECOVERY_REQUEST_EVENT_TYPE,
  PasswordRecoveryRequestService,
} from './password-recovery-request.service';
import { PublicCustomerRegistrationService } from './public-customer-registration.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('CustomerRegistrationService database integration', () => {
  const emailsToClean = new Set<string>();
  const prisma = new PrismaService(testDatabaseUrl);
  const passwordHasher = new PasswordHasher();
  const service = new CustomerRegistrationService(passwordHasher, prisma);
  const publicRegistrations = new PublicCustomerRegistrationService(service);
  const verificationTokens = new EmailVerificationTokenService(prisma);
  const verificationRequests = new EmailVerificationRequestService(prisma);
  const passwordRecoveryRequests = new PasswordRecoveryRequestService(prisma);

  function uniqueEmail(label: string): string {
    const email = `integration-${label}-${randomUUID()}@example.test`;
    emailsToClean.add(normalizeEmail(email));
    return email;
  }

  afterEach(async () => {
    const emails = [...emailsToClean];

    if (emails.length > 0) {
      const users = await prisma.user.findMany({
        where: { emailNormalized: { in: emails } },
        select: { id: true },
      });
      const userIds = users.map(({ id }) => id);

      if (userIds.length > 0) {
        await prisma.outboxMessage.deleteMany({
          where: { aggregateId: { in: userIds } },
        });
        await prisma.notificationDelivery.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.userRole.deleteMany({
          where: { userId: { in: userIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: userIds } },
        });
      }
    }

    emailsToClean.clear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists a pending customer with a verifiable Argon2id hash', async () => {
    // Arrange
    const email = uniqueEmail('success');
    const plainPassword = 'integration-example-password';

    // Act
    const result = await service.register({ email, plainPassword });
    const storedUser = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: normalizeEmail(email) },
      include: { userRoles: true },
    });

    // Assert
    expect(storedUser.status).toBe(AccountStatus.PENDING_VERIFICATION);
    expect(storedUser.verificationEmailRequestedAt).toBeInstanceOf(Date);
    expect(storedUser.userRoles).toHaveLength(1);
    expect(storedUser.userRoles[0]?.role).toBe(RoleName.CUSTOMER);
    expect(storedUser.passwordHash).not.toBe(plainPassword);
    await expect(passwordHasher.verify(plainPassword, storedUser.passwordHash)).resolves.toBe(true);
    expect(result).not.toHaveProperty('passwordHash');

    const outboxMessage = await prisma.outboxMessage.findFirstOrThrow({
      where: { aggregateId: storedUser.id },
    });
    expect(outboxMessage).toMatchObject({
      eventType: CUSTOMER_REGISTERED_EVENT_TYPE,
      eventVersion: 1,
      aggregateType: 'User',
      aggregateId: storedUser.id,
      payload: { userId: storedUser.id },
      status: OutboxMessageStatus.PENDING,
      attemptCount: 0,
    });
    expect(JSON.stringify(outboxMessage)).not.toContain(plainPassword);
    expect(JSON.stringify(outboxMessage)).not.toContain(storedUser.passwordHash);
    expect(JSON.stringify(outboxMessage)).not.toContain(storedUser.emailNormalized);
  });

  it('enforces uniqueness after normalizing equivalent email addresses', async () => {
    // Arrange
    const email = uniqueEmail('duplicate');
    const plainPassword = 'integration-example-password';
    await service.register({ email, plainPassword });

    // Act and Assert
    await expect(
      service.register({
        email: `  ${email.toUpperCase()}  `,
        plainPassword,
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.user.count({
        where: { emailNormalized: normalizeEmail(email) },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.outboxMessage.count({
        where: {
          eventType: CUSTOMER_REGISTERED_EVENT_TYPE,
          aggregateId: {
            in: (
              await prisma.user.findMany({
                where: { emailNormalized: normalizeEmail(email) },
                select: { id: true },
              })
            ).map(({ id }) => id),
          },
        },
      }),
    ).resolves.toBe(1);
  });

  it('gives the public boundary one indistinguishable result without duplicating persistence', async () => {
    // Arrange
    const email = uniqueEmail('public-duplicate');
    const input = { email, plainPassword: 'integration-example-password' };

    // Act
    await publicRegistrations.register(input, { correlationId: `integration-${randomUUID()}` });
    await publicRegistrations.register(
      { ...input, email: `  ${email.toUpperCase()}  ` },
      { correlationId: `integration-${randomUUID()}` },
    );

    // Assert
    const users = await prisma.user.findMany({
      where: { emailNormalized: normalizeEmail(email) },
      select: { id: true },
    });
    expect(users).toHaveLength(1);
    await expect(
      prisma.outboxMessage.count({ where: { aggregateId: users[0]?.id } }),
    ).resolves.toBe(1);
  });

  it('rolls back the user when its outbox event cannot be stored', async () => {
    // Arrange
    const email = uniqueEmail('outbox-rollback');
    const correlationId = `integration-${randomUUID()}`;

    // Act and Assert
    await expect(
      service.register(
        { email, plainPassword: 'integration-example-password' },
        {
          correlationId,
          causationId: 'x'.repeat(129),
        },
      ),
    ).rejects.toThrow();
    await expect(
      prisma.user.findUnique({ where: { emailNormalized: normalizeEmail(email) } }),
    ).resolves.toBeNull();
    await expect(prisma.outboxMessage.count({ where: { correlationId } })).resolves.toBe(0);
  });

  it('rolls back the user when a nested role write violates a constraint', async () => {
    // Arrange
    const email = uniqueEmail('rollback');
    const emailNormalized = normalizeEmail(email);
    const passwordHash = await passwordHasher.hash('integration-example-password');

    // Act and Assert
    await expect(
      prisma.user.create({
        data: {
          emailNormalized,
          passwordHash,
          status: AccountStatus.PENDING_VERIFICATION,
          userRoles: {
            create: [{ role: RoleName.CUSTOMER }, { role: RoleName.CUSTOMER }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.user.findUnique({ where: { emailNormalized } })).resolves.toBeNull();
  });

  it('stores only a verification-token digest and activates the pending user once', async () => {
    // Arrange
    const email = uniqueEmail('verification-success');
    const user = await service.register({
      email,
      plainPassword: 'integration-example-password',
    });
    const first = await verificationTokens.issue(user.id);
    const second = await verificationTokens.issue(user.id);

    // Act
    const consumed = await verificationTokens.consume(first.token);

    // Assert
    const storedTokens = await prisma.emailVerificationToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    const activatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(storedTokens).toHaveLength(2);
    expect(storedTokens[0]?.tokenHash).toBe(
      createHash('sha256').update(first.token, 'utf8').digest('hex'),
    );
    expect(storedTokens[0]?.tokenHash).not.toBe(first.token);
    expect(storedTokens[0]?.consumedAt).toEqual(consumed.verifiedAt);
    expect(storedTokens[1]?.revokedAt).toEqual(consumed.verifiedAt);
    expect(JSON.stringify(storedTokens)).not.toContain(first.token);
    expect(JSON.stringify(storedTokens)).not.toContain(second.token);
    expect(activatedUser.status).toBe(AccountStatus.ACTIVE);
    expect(activatedUser.verifiedAt).toEqual(consumed.verifiedAt);
    await expect(verificationTokens.consume(first.token)).rejects.toMatchObject({
      code: 'INVALID_EMAIL_VERIFICATION_TOKEN',
    });
  });

  it('rejects expired verification tokens without activating the user', async () => {
    // Arrange
    const email = uniqueEmail('verification-expired');
    const user = await service.register({
      email,
      plainPassword: 'integration-example-password',
    });
    const expiredToken = Buffer.alloc(32, 5).toString('base64url');
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const expiresAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(expiredToken, 'utf8').digest('hex'),
        createdAt,
        expiresAt,
      },
    });

    // Act and Assert
    await expect(verificationTokens.consume(expiredToken)).rejects.toMatchObject({
      code: 'INVALID_EMAIL_VERIFICATION_TOKEN',
    });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      status: AccountStatus.PENDING_VERIFICATION,
      verifiedAt: null,
    });
  });

  it('allows only one concurrent consumption of the same verification token', async () => {
    // Arrange
    const email = uniqueEmail('verification-concurrent');
    const user = await service.register({
      email,
      plainPassword: 'integration-example-password',
    });
    const issued = await verificationTokens.issue(user.id);

    // Act
    const results = await Promise.allSettled([
      verificationTokens.consume(issued.token),
      verificationTokens.consume(issued.token),
    ]);

    // Assert
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      status: AccountStatus.ACTIVE,
    });
  });

  it('creates one resend event after cooldown under concurrent requests', async () => {
    const email = uniqueEmail('verification-resend-concurrent');
    const user = await service.register({
      email,
      plainPassword: 'integration-example-password',
    });
    const previousRequestedAt = new Date(
      Date.now() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - 60_000,
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { verificationEmailRequestedAt: previousRequestedAt },
    });

    await Promise.all([
      verificationRequests.request(email, { correlationId: `integration-${randomUUID()}` }),
      verificationRequests.request(`  ${email.toUpperCase()}  `, {
        correlationId: `integration-${randomUUID()}`,
      }),
    ]);
    await verificationRequests.request(email, {
      correlationId: `integration-${randomUUID()}`,
    });

    const resendEvents = await prisma.outboxMessage.findMany({
      where: {
        aggregateId: user.id,
        eventType: EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
      },
    });
    const storedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(resendEvents).toHaveLength(1);
    expect(resendEvents[0]).toMatchObject({
      eventVersion: 1,
      aggregateType: 'User',
      payload: { userId: user.id },
      status: OutboxMessageStatus.PENDING,
    });
    expect(storedUser.verificationEmailRequestedAt?.getTime()).toBeGreaterThan(
      previousRequestedAt.getTime(),
    );
    expect(JSON.stringify(resendEvents)).not.toContain(normalizeEmail(email));
  });

  it.each([AccountStatus.ACTIVE, AccountStatus.SUSPENDED])(
    'does not create a resend event for a %s account',
    async (status) => {
      const email = uniqueEmail(`verification-resend-${status.toLowerCase()}`);
      const user = await service.register({
        email,
        plainPassword: 'integration-example-password',
      });
      const previousRequestedAt = new Date(
        Date.now() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - 60_000,
      );
      await prisma.user.update({
        where: { id: user.id },
        data: { status, verificationEmailRequestedAt: previousRequestedAt },
      });

      await expect(
        verificationRequests.request(email, {
          correlationId: `integration-${randomUUID()}`,
        }),
      ).resolves.toBeUndefined();

      await expect(
        prisma.outboxMessage.count({
          where: {
            aggregateId: user.id,
            eventType: EMAIL_VERIFICATION_REQUEST_EVENT_TYPE,
          },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).resolves.toMatchObject({ verificationEmailRequestedAt: previousRequestedAt });
    },
  );

  it('rolls back the cooldown claim when the resend outbox write fails', async () => {
    const email = uniqueEmail('verification-resend-rollback');
    const user = await service.register({
      email,
      plainPassword: 'integration-example-password',
    });
    const previousRequestedAt = new Date(
      Date.now() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - 60_000,
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { verificationEmailRequestedAt: previousRequestedAt },
    });
    const correlationId = `integration-${randomUUID()}`;

    await expect(
      verificationRequests.request(email, {
        correlationId,
        causationId: 'x'.repeat(129),
      }),
    ).rejects.toThrow();

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      verificationEmailRequestedAt: previousRequestedAt,
    });
    await expect(prisma.outboxMessage.count({ where: { correlationId } })).resolves.toBe(0);
  });

  it('creates one recovery event for an active account under concurrent requests', async () => {
    const email = uniqueEmail('password-recovery-concurrent');
    const user = await service.register({
      email,
      plainPassword: 'integration-example-password',
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: AccountStatus.ACTIVE, verifiedAt: new Date() },
    });

    await Promise.all([
      passwordRecoveryRequests.request(email, {
        correlationId: `integration-${randomUUID()}`,
      }),
      passwordRecoveryRequests.request(`  ${email.toUpperCase()}  `, {
        correlationId: `integration-${randomUUID()}`,
      }),
    ]);
    await passwordRecoveryRequests.request(email, {
      correlationId: `integration-${randomUUID()}`,
    });

    const events = await prisma.outboxMessage.findMany({
      where: { aggregateId: user.id, eventType: PASSWORD_RECOVERY_REQUEST_EVENT_TYPE },
    });
    const storedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventVersion: 1,
      payload: { userId: user.id },
      status: OutboxMessageStatus.PENDING,
    });
    expect(storedUser.passwordRecoveryRequestedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(events)).not.toContain(normalizeEmail(email));
  });

  it.each([AccountStatus.PENDING_VERIFICATION, AccountStatus.SUSPENDED])(
    'does not create recovery work for a %s account',
    async (status) => {
      const email = uniqueEmail(`password-recovery-${status.toLowerCase()}`);
      const user = await service.register({
        email,
        plainPassword: 'integration-example-password',
      });
      await prisma.user.update({ where: { id: user.id }, data: { status } });

      await expect(passwordRecoveryRequests.request(email)).resolves.toBeUndefined();
      await expect(
        prisma.outboxMessage.count({
          where: { aggregateId: user.id, eventType: PASSWORD_RECOVERY_REQUEST_EVENT_TYPE },
        }),
      ).resolves.toBe(0);
    },
  );

  it('rolls back the recovery cooldown when its outbox event fails', async () => {
    const email = uniqueEmail('password-recovery-rollback');
    const user = await service.register({
      email,
      plainPassword: 'integration-example-password',
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: AccountStatus.ACTIVE, verifiedAt: new Date() },
    });
    const correlationId = `integration-${randomUUID()}`;

    await expect(
      passwordRecoveryRequests.request(email, {
        correlationId,
        causationId: 'x'.repeat(129),
      }),
    ).rejects.toThrow();

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      passwordRecoveryRequestedAt: null,
    });
    await expect(prisma.outboxMessage.count({ where: { correlationId } })).resolves.toBe(0);
  });
});
