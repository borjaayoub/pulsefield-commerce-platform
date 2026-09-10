import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuditedCommandContext } from '../audit/command-context';
import { PrismaService } from '../database/prisma.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { RedisSessionStore } from './redis-session.store';
import { SessionService } from './session.service';
import { StaffRoleManagementService } from './staff-role-management.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ephemeralRedisUrl = process.env.EPHEMERAL_REDIS_URL;

if (!testDatabaseUrl || !ephemeralRedisUrl) {
  throw new Error(
    'TEST_DATABASE_URL and EPHEMERAL_REDIS_URL are required. Run this suite through pnpm test:integration.',
  );
}

describe('staff-role management integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const audit = new AuditService();
  const service = new StaffRoleManagementService(prisma, audit);
  const sessionStore = new RedisSessionStore(ephemeralRedisUrl);
  const sessions = new SessionService(sessionStore, prisma);
  const userIds = new Set<string>();
  const sessionIds = new Set<string>();

  function context(actorId: string): AuditedCommandContext {
    const id = randomUUID();
    return {
      requestId: `request-${id}`,
      correlationId: `correlation-${id}`,
      idempotencyKey: `idempotency-${id}`,
      actor: { type: 'staff', id: actorId, roles: [RoleName.ADMINISTRATOR] },
      reason: 'Approved integration staffing change',
    };
  }

  async function createUser(roles: RoleName[]) {
    const id = randomUUID();
    userIds.add(id);
    return prisma.user.create({
      data: {
        id,
        emailNormalized: `staff-role-${id}@example.test`,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder',
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: { create: roles.map((role) => ({ role })) },
      },
      include: { userRoles: true },
    });
  }

  afterEach(async () => {
    for (const sessionId of sessionIds) await sessionStore.revoke(sessionId);
    sessionIds.clear();
    const ids = [...userIds];
    if (ids.length > 0) {
      await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    userIds.clear();
  });

  afterAll(async () => {
    sessionStore.onApplicationShutdown();
    await prisma.$disconnect();
  });

  it('atomically grants a role, audits it, and invalidates the target session', async () => {
    const administrator = await createUser([RoleName.CUSTOMER, RoleName.ADMINISTRATOR]);
    const target = await createUser([RoleName.CUSTOMER]);
    const session = await sessions.create(
      {
        id: target.id,
        email: target.emailNormalized,
        roles: [RoleName.CUSTOMER],
        credentialVersion: target.credentialVersion,
        mfaEnrolled: false,
      },
      'PASSWORD',
    );
    sessionIds.add(session.sessionId);
    const command = context(administrator.id);

    await expect(service.grant(target.id, RoleName.FULFILLER, command)).resolves.toEqual({
      userId: target.id,
      roles: [RoleName.CUSTOMER, RoleName.FULFILLER],
    });
    await expect(sessions.current(session.sessionId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
      include: { userRoles: true },
    });
    expect(stored.credentialVersion).toBe(target.credentialVersion + 1);
    expect(stored.userRoles.map(({ role }) => role).sort()).toEqual([
      RoleName.CUSTOMER,
      RoleName.FULFILLER,
    ]);
    await expect(
      prisma.auditRecord.count({
        where: {
          actorId: administrator.id,
          targetId: target.id,
          action: 'identity.staff-role.granted',
          requestId: command.requestId,
        },
      }),
    ).resolves.toBe(1);

    await service.grant(target.id, RoleName.FULFILLER, context(administrator.id));
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: target.id } }),
    ).resolves.toMatchObject({
      credentialVersion: target.credentialVersion + 1,
    });
  });

  it('rolls back the role and credential generation when audit insertion fails', async () => {
    const administrator = await createUser([RoleName.ADMINISTRATOR]);
    const target = await createUser([RoleName.CUSTOMER]);
    const failing = new StaffRoleManagementService(prisma, {
      append: async () => {
        throw new Error('audit unavailable');
      },
    } as AuditService);

    await expect(
      failing.grant(target.id, RoleName.FULFILLER, context(administrator.id)),
    ).rejects.toThrow('audit unavailable');
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
      include: { userRoles: true },
    });
    expect(stored.credentialVersion).toBe(target.credentialVersion);
    expect(stored.userRoles.map(({ role }) => role)).toEqual([RoleName.CUSTOMER]);
  });

  it('serializes competing removals so at least one administrator remains', async () => {
    const existingAdministratorCount = await prisma.userRole.count({
      where: { role: RoleName.ADMINISTRATOR },
    });
    const first = await createUser([RoleName.ADMINISTRATOR]);
    const second = await createUser([RoleName.ADMINISTRATOR]);

    const results = await Promise.allSettled([
      service.revoke(second.id, RoleName.ADMINISTRATOR, context(first.id)),
      service.revoke(first.id, RoleName.ADMINISTRATOR, context(second.id)),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    await expect(prisma.userRole.count({ where: { role: RoleName.ADMINISTRATOR } })).resolves.toBe(
      existingAdministratorCount + 1,
    );
  });
});
