import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuditedCommandContext } from '../audit/command-context';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { StaffAccountLookupService } from './staff-account-lookup.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('masked staff account lookup integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const service = new StaffAccountLookupService(prisma, new AuditService());
  const userIds = new Set<string>();

  async function createUser(email: string, roles: RoleName[]) {
    const id = randomUUID();
    userIds.add(id);
    return prisma.user.create({
      data: {
        id,
        emailNormalized: email,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder',
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: { create: roles.map((role) => ({ role })) },
      },
    });
  }

  function context(actorId: string): AuditedCommandContext {
    const id = randomUUID();
    return {
      requestId: `request-${id}`,
      correlationId: `correlation-${id}`,
      idempotencyKey: `idempotency-${id}`,
      actor: { type: 'staff', id: actorId, roles: [RoleName.ADMINISTRATOR] },
      reason: 'Locate account for approved staff assignment',
    };
  }

  afterEach(async () => {
    const ids = [...userIds];
    if (ids.length > 0) {
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    userIds.clear();
  });

  afterAll(async () => prisma.$disconnect());

  it('returns a masked projection and commits minimal access evidence', async () => {
    const administrator = await createUser('lookup-admin@example.test', [RoleName.ADMINISTRATOR]);
    const fullEmail = `ayoub.exampleshop-${randomUUID()}@example.com`;
    const target = await createUser(fullEmail, [RoleName.CUSTOMER]);
    const command = context(administrator.id);

    const result = await service.findByEmail(fullEmail.toUpperCase(), command);

    expect(result).toEqual({
      userId: target.id,
      emailMasked: 'a***@e***.com',
      status: AccountStatus.ACTIVE,
      verified: true,
      roles: [RoleName.CUSTOMER],
    });
    expect(JSON.stringify(result)).not.toContain(fullEmail);
    const evidence = await prisma.auditRecord.findFirstOrThrow({
      where: { requestId: command.requestId, action: 'identity.staff-account.viewed' },
    });
    expect(evidence).toMatchObject({
      actorId: administrator.id,
      targetId: target.id,
      beforeMetadata: null,
      afterMetadata: null,
    });
    expect(JSON.stringify(evidence)).not.toContain(fullEmail);
  });

  it('revalidates current administrator authority before reading the target', async () => {
    const formerAdministrator = await createUser('former-admin@example.test', [RoleName.FULFILLER]);
    const fullEmail = `private-${randomUUID()}@example.test`;
    await createUser(fullEmail, [RoleName.CUSTOMER]);

    await expect(
      service.findByEmail(fullEmail, context(formerAdministrator.id)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
