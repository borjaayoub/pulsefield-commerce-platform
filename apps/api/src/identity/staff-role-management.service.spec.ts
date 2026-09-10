import type { AuditedCommandContext } from '../audit/command-context';
import type { AuditService } from '../audit/audit.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { ForbiddenError } from './authentication.errors';
import { StaffRoleManagementService } from './staff-role-management.service';

describe('StaffRoleManagementService', () => {
  const actorId = '67b3456e-5303-41e7-9c36-4611ee204811';
  const targetId = '1c41ff8c-f6a9-4e8e-af74-2768909e20c4';

  function command(): AuditedCommandContext {
    return {
      requestId: 'request-staff-role-123',
      correlationId: 'request-staff-role-123',
      idempotencyKey: 'request-staff-role-123',
      actor: { type: 'staff', id: actorId, roles: [RoleName.ADMINISTRATOR] },
      reason: 'Approved staffing responsibility change',
    };
  }

  function createSubject(roles: RoleName[] = [RoleName.CUSTOMER]) {
    const executeRaw = jest.fn(async () => 1);
    const findUnique = jest.fn(async ({ where }: { where: { id: string } }) =>
      where.id === actorId
        ? {
            status: AccountStatus.ACTIVE,
            verifiedAt: new Date(),
            userRoles: [{ role: RoleName.ADMINISTRATOR }],
          }
        : {
            id: targetId,
            status: AccountStatus.ACTIVE,
            verifiedAt: new Date(),
            userRoles: roles.map((role) => ({ role })),
          },
    );
    const count = jest.fn(async () => 2);
    const create = jest.fn(async () => ({}));
    const deleteRole = jest.fn(async () => ({}));
    const update = jest.fn(async () => ({}));
    const transaction = {
      $executeRaw: executeRaw,
      user: { findUnique, update },
      userRole: { count, create, delete: deleteRole },
      auditRecord: { create: jest.fn(async () => ({})) },
    };
    const runTransaction = jest.fn(async (work: (writer: typeof transaction) => unknown) =>
      work(transaction),
    );
    const append = jest.fn(async () => ({}));
    const service = new StaffRoleManagementService(
      { $transaction: runTransaction } as never,
      { append } as unknown as AuditService,
    );
    return {
      service,
      executeRaw,
      findUnique,
      count,
      create,
      deleteRole,
      update,
      append,
      runTransaction,
    };
  }

  it('grants a staff role, increments the credential generation, and audits atomically', async () => {
    const subject = createSubject();

    await expect(subject.service.grant(targetId, RoleName.FULFILLER, command())).resolves.toEqual({
      userId: targetId,
      roles: [RoleName.CUSTOMER, RoleName.FULFILLER],
    });

    expect(subject.executeRaw).toHaveBeenCalledTimes(1);
    expect(subject.create).toHaveBeenCalledWith({
      data: { userId: targetId, role: RoleName.FULFILLER },
    });
    expect(subject.update).toHaveBeenCalledWith({
      where: { id: targetId },
      data: { credentialVersion: { increment: 1 } },
    });
    expect(subject.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'identity.staff-role.granted',
        beforeMetadata: { roles: [RoleName.CUSTOMER] },
        afterMetadata: { roles: [RoleName.CUSTOMER, RoleName.FULFILLER] },
      }),
      command(),
    );
  });

  it('treats an already-satisfied grant as a no-op', async () => {
    const subject = createSubject([RoleName.CUSTOMER, RoleName.FULFILLER]);

    await expect(subject.service.grant(targetId, RoleName.FULFILLER, command())).resolves.toEqual({
      userId: targetId,
      roles: [RoleName.CUSTOMER, RoleName.FULFILLER],
    });
    expect(subject.create).not.toHaveBeenCalled();
    expect(subject.update).not.toHaveBeenCalled();
    expect(subject.append).not.toHaveBeenCalled();
  });

  it('rejects self-modification before opening a transaction', async () => {
    const subject = createSubject();

    await expect(subject.service.grant(actorId, RoleName.FULFILLER, command())).rejects.toEqual(
      new ForbiddenError(),
    );
    expect(subject.runTransaction).not.toHaveBeenCalled();
  });

  it('rejects removal of the final administrator before mutation', async () => {
    const subject = createSubject([RoleName.CUSTOMER, RoleName.ADMINISTRATOR]);
    subject.count.mockResolvedValueOnce(1);

    await expect(
      subject.service.revoke(targetId, RoleName.ADMINISTRATOR, command()),
    ).rejects.toEqual(new ForbiddenError());
    expect(subject.deleteRole).not.toHaveBeenCalled();
    expect(subject.update).not.toHaveBeenCalled();
    expect(subject.append).not.toHaveBeenCalled();
  });

  it('propagates audit failure from the transaction boundary', async () => {
    const subject = createSubject();
    subject.append.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(subject.service.grant(targetId, RoleName.FULFILLER, command())).rejects.toThrow(
      'audit unavailable',
    );
    expect(subject.create).toHaveBeenCalled();
    expect(subject.update).toHaveBeenCalled();
  });
});
