import Redis from 'ioredis';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { CredentialAuthenticationService } from './credential-authentication.service';
import { roleFingerprint } from './authorization.service';
import { PasswordHasher } from './password-hasher.service';
import { PasswordResetTokenService } from './password-reset-token.service';
import { RedisSessionStore } from './redis-session.store';
import { SessionService } from './session.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ephemeralRedisUrl = process.env.EPHEMERAL_REDIS_URL;

if (!testDatabaseUrl || !ephemeralRedisUrl) {
  throw new Error(
    'TEST_DATABASE_URL and EPHEMERAL_REDIS_URL are required. Run this suite through pnpm test:integration.',
  );
}

describe('credential and server-side session integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const passwordHasher = new PasswordHasher();
  const credentials = new CredentialAuthenticationService(prisma, passwordHasher);
  const passwordResetTokens = new PasswordResetTokenService(prisma, passwordHasher);
  const store = new RedisSessionStore(ephemeralRedisUrl);
  const sessions = new SessionService(store, prisma);
  const redis = new Redis(ephemeralRedisUrl, { maxRetriesPerRequest: 1 });
  const userIds = new Set<string>();
  const sessionIds = new Set<string>();

  async function createActiveUser() {
    const plainPassword = `integration-session-password-${randomUUID()}`;
    const user = await prisma.user.create({
      data: {
        emailNormalized: `session-${randomUUID()}@example.test`,
        passwordHash: await passwordHasher.hash(plainPassword),
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: { create: { role: RoleName.CUSTOMER } },
      },
    });
    userIds.add(user.id);
    return { user, plainPassword };
  }

  afterEach(async () => {
    for (const sessionId of sessionIds) {
      await redis.del(
        `pulse-field:session:${createHash('sha256').update(sessionId, 'utf8').digest('hex')}`,
      );
    }
    sessionIds.clear();

    const ids = [...userIds];
    if (ids.length > 0) {
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    userIds.clear();
  });

  afterAll(async () => {
    store.onApplicationShutdown();
    redis.disconnect(false);
    await prisma.$disconnect();
  });

  it('authenticates an active account and stores only a session-ID digest in Redis', async () => {
    const { user, plainPassword } = await createActiveUser();
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);

    const created = await sessions.create(principal, 'PASSWORD');
    sessionIds.add(created.sessionId);
    const digest = createHash('sha256').update(created.sessionId, 'utf8').digest('hex');
    const key = `pulse-field:session:${digest}`;
    const stored = await redis.get(key);
    const ttl = await redis.pttl(key);

    expect(principal).toMatchObject({ id: user.id, roles: [RoleName.CUSTOMER] });
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject({
      version: 3,
      authenticationAssurance: 'PASSWORD',
      roleFingerprint: roleFingerprint([RoleName.CUSTOMER]),
    });
    expect(key).not.toContain(created.sessionId);
    expect(stored).not.toContain(created.sessionId);
    expect(stored).not.toContain(user.passwordHash);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30 * 60 * 1000);
    await expect(sessions.current(created.sessionId)).resolves.toMatchObject({
      user: { id: user.id, roles: [RoleName.CUSTOMER] },
    });
  });

  it('rotates an existing session and makes the previous identifier unusable', async () => {
    const { user, plainPassword } = await createActiveUser();
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const first = await sessions.create(principal, 'PASSWORD');
    const second = await sessions.create(principal, 'PASSWORD', first.sessionId);
    sessionIds.add(first.sessionId);
    sessionIds.add(second.sessionId);

    await expect(store.peek(first.sessionId)).resolves.toBeNull();
    await expect(store.peek(second.sessionId)).resolves.toMatchObject({ userId: user.id });
  });

  it('revokes the server-side session when the account becomes suspended', async () => {
    const { user, plainPassword } = await createActiveUser();
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const created = await sessions.create(principal, 'PASSWORD');
    sessionIds.add(created.sessionId);
    await prisma.user.update({
      where: { id: user.id },
      data: { status: AccountStatus.SUSPENDED },
    });

    await expect(sessions.current(created.sessionId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(store.peek(created.sessionId)).resolves.toBeNull();
  });

  it('invalidates an existing password session when its database role changes', async () => {
    const { user, plainPassword } = await createActiveUser();
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const created = await sessions.create(principal, 'PASSWORD');
    sessionIds.add(created.sessionId);

    await prisma.userRole.updateMany({
      where: { userId: user.id },
      data: { role: RoleName.FULFILLER },
    });

    await expect(sessions.current(created.sessionId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(store.peek(created.sessionId)).resolves.toBeNull();
  });

  it('rejects a password-only session whose matching current role requires MFA', async () => {
    const { user, plainPassword } = await createActiveUser();
    await prisma.userRole.updateMany({
      where: { userId: user.id },
      data: { role: RoleName.FULFILLER },
    });
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const created = await sessions.create(principal, 'PASSWORD');
    sessionIds.add(created.sessionId);

    await expect(sessions.current(created.sessionId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(store.peek(created.sessionId)).resolves.toBeNull();
  });

  it('invalidates an MFA-assured staff session after demotion', async () => {
    const { user, plainPassword } = await createActiveUser();
    await prisma.userRole.updateMany({
      where: { userId: user.id },
      data: { role: RoleName.FULFILLER },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecretCiphertext: 'protected-test-value', totpEnrolledAt: new Date() },
    });
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const created = await sessions.create(principal, 'PASSWORD_MFA');
    sessionIds.add(created.sessionId);

    await prisma.userRole.updateMany({
      where: { userId: user.id },
      data: { role: RoleName.CUSTOMER },
    });

    await expect(sessions.current(created.sessionId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(store.peek(created.sessionId)).resolves.toBeNull();
  });

  it('requires CSRF before logout and revokes the matching session', async () => {
    const { user, plainPassword } = await createActiveUser();
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const created = await sessions.create(principal, 'PASSWORD');
    sessionIds.add(created.sessionId);

    await expect(sessions.logout(created.sessionId, 'wrong-token')).rejects.toMatchObject({
      code: 'INVALID_CSRF_TOKEN',
    });
    await expect(store.peek(created.sessionId)).resolves.not.toBeNull();

    await sessions.logout(created.sessionId, created.view.csrfToken);
    await expect(store.peek(created.sessionId)).resolves.toBeNull();
  });

  it('logs out every old-version session and permits a later new-version login', async () => {
    const { user, plainPassword } = await createActiveUser();
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const first = await sessions.create(principal, 'PASSWORD');
    const second = await sessions.create(principal, 'PASSWORD');
    sessionIds.add(first.sessionId);
    sessionIds.add(second.sessionId);

    await sessions.logoutAll(first.sessionId, first.view.csrfToken);

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      credentialVersion: 2,
    });
    await expect(store.peek(first.sessionId)).resolves.toBeNull();
    await expect(sessions.current(second.sessionId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(store.peek(second.sessionId)).resolves.toBeNull();

    const newPrincipal = await credentials.authenticate(user.emailNormalized, plainPassword);
    expect(newPrincipal.credentialVersion).toBe(2);
    const replacement = await sessions.create(newPrincipal, 'PASSWORD');
    sessionIds.add(replacement.sessionId);
    await expect(sessions.current(replacement.sessionId)).resolves.toMatchObject({
      user: { id: user.id },
    });
  });

  it('increments the session generation only once across concurrent logout-all requests', async () => {
    const { user, plainPassword } = await createActiveUser();
    const principal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const first = await sessions.create(principal, 'PASSWORD');
    const second = await sessions.create(principal, 'PASSWORD');
    sessionIds.add(first.sessionId);
    sessionIds.add(second.sessionId);

    await expect(
      Promise.all([
        sessions.logoutAll(first.sessionId, first.view.csrfToken),
        sessions.logoutAll(second.sessionId, second.view.csrfToken),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      credentialVersion: 2,
    });
    await expect(store.peek(first.sessionId)).resolves.toBeNull();
    await expect(store.peek(second.sessionId)).resolves.toBeNull();
  });

  it('deletes a record whose absolute deadline has passed', async () => {
    const expiredSessionId = randomBytes(32).toString('base64url');
    sessionIds.add(expiredSessionId);
    const key = `pulse-field:session:${createHash('sha256')
      .update(expiredSessionId, 'utf8')
      .digest('hex')}`;
    const now = Date.now();
    await redis.set(
      key,
      JSON.stringify({
        version: 3,
        userId: randomUUID(),
        credentialVersion: 1,
        authenticationAssurance: 'PASSWORD',
        roleFingerprint: roleFingerprint([RoleName.CUSTOMER]),
        csrfToken: randomBytes(32).toString('base64url'),
        authenticatedAt: now - 60_000,
        idleExpiresAt: now + 60_000,
        absoluteExpiresAt: now - 1,
      }),
      'PX',
      60_000,
    );

    await expect(store.readAndRefresh(expiredSessionId)).resolves.toBeNull();
    await expect(redis.exists(key)).resolves.toBe(0);
  });

  it('changes the password, revokes sibling tokens, and invalidates the old session version', async () => {
    const { user, plainPassword } = await createActiveUser();
    const oldPrincipal = await credentials.authenticate(user.emailNormalized, plainPassword);
    const oldSession = await sessions.create(oldPrincipal, 'PASSWORD');
    sessionIds.add(oldSession.sessionId);
    const first = await passwordResetTokens.issue(user.id);
    const sibling = await passwordResetTokens.issue(user.id);
    const newPassword = `new-integration-reset-password-${randomUUID()}`;

    const completed = await passwordResetTokens.reset(first.token, newPassword);

    const storedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const storedTokens = await prisma.passwordResetToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(completed).toEqual({ userId: user.id, credentialVersion: 2 });
    expect(storedUser.credentialVersion).toBe(2);
    expect(storedUser.passwordHash).not.toBe(newPassword);
    await expect(passwordHasher.verify(newPassword, storedUser.passwordHash)).resolves.toBe(true);
    expect(JSON.stringify(storedTokens)).not.toContain(first.token);
    expect(JSON.stringify(storedTokens)).not.toContain(sibling.token);
    expect(storedTokens[0]?.consumedAt).not.toBeNull();
    expect(storedTokens[1]?.revokedAt).not.toBeNull();
    await expect(sessions.current(oldSession.sessionId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      credentials.authenticate(user.emailNormalized, plainPassword),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const newPrincipal = await credentials.authenticate(user.emailNormalized, newPassword);
    expect(newPrincipal.credentialVersion).toBe(2);
    const newSession = await sessions.create(newPrincipal, 'PASSWORD');
    sessionIds.add(newSession.sessionId);
    await expect(sessions.current(newSession.sessionId)).resolves.toMatchObject({
      user: { id: user.id },
    });
    await expect(passwordResetTokens.reset(first.token, newPassword)).rejects.toMatchObject({
      code: 'INVALID_PASSWORD_RESET_TOKEN',
    });
  });

  it('allows only one concurrent reset with the same credential', async () => {
    const { user } = await createActiveUser();
    const issued = await passwordResetTokens.issue(user.id);
    const newPassword = `concurrent-reset-password-${randomUUID()}`;

    const results = await Promise.allSettled([
      passwordResetTokens.reset(issued.token, newPassword),
      passwordResetTokens.reset(issued.token, newPassword),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      credentialVersion: 2,
    });
  });

  it('does not change credentials when the reset token is expired', async () => {
    const { user } = await createActiveUser();
    const expiredToken = randomBytes(32).toString('base64url');
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(expiredToken, 'utf8').digest('hex'),
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    await expect(
      passwordResetTokens.reset(expiredToken, `expired-token-new-password-${randomUUID()}`),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD_RESET_TOKEN' });

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      passwordHash: user.passwordHash,
      credentialVersion: 1,
    });
  });
});
