import type { AuditedCommandContext } from '../audit/command-context';
import type { AuditService } from '../audit/audit.service';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import { ForbiddenError, StaffAccountNotFoundError } from './authentication.errors';
import { StaffAccountLookupService } from './staff-account-lookup.service';

describe('StaffAccountLookupService', () => {
  const actorId = '67b3456e-5303-41e7-9c36-4611ee204811';
  const targetId = '1c41ff8c-f6a9-4e8e-af74-2768909e20c4';
  const fullEmail = 'ayoub.exampleshop@example.com';

  function context(): AuditedCommandContext {
    return {
      requestId: 'request-account-view-123',
      correlationId: 'request-account-view-123',
      idempotencyKey: 'request-account-view-123',
      actor: { type: 'staff', id: actorId, roles: [RoleName.ADMINISTRATOR] },
      reason: 'Locate account for approved staff assignment',
    };
  }

  function createSubject() {
    const findUnique = jest.fn(async ({ where }: { where: Record<string, string> }) =>
      where.id
        ? {
            status: AccountStatus.ACTIVE,
            verifiedAt: new Date(),
            userRoles: [{ role: RoleName.ADMINISTRATOR }],
          }
        : {
            id: targetId,
            emailNormalized: fullEmail,
            status: AccountStatus.ACTIVE,
            verifiedAt: new Date(),
            userRoles: [{ role: RoleName.CUSTOMER }],
          },
    );
    const transaction = {
      user: { findUnique },
      auditRecord: { create: jest.fn(async () => ({})) },
    };
    const runTransaction = jest.fn(async (work: (writer: typeof transaction) => unknown) =>
      work(transaction),
    );
    const append = jest.fn(async () => ({}));
    const service = new StaffAccountLookupService(
      { $transaction: runTransaction } as never,
      { append } as unknown as AuditService,
    );
    return { service, findUnique, append, runTransaction };
  }

  it('returns only a minimal masked account view and appends safe evidence', async () => {
    const { service, findUnique, append } = createSubject();

    await expect(service.findByEmail(`  ${fullEmail.toUpperCase()}  `, context())).resolves.toEqual(
      {
        userId: targetId,
        emailMasked: 'a***@e***.com',
        status: AccountStatus.ACTIVE,
        verified: true,
        roles: [RoleName.CUSTOMER],
      },
    );
    expect(findUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { emailNormalized: fullEmail } }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      {
        action: 'identity.staff-account.viewed',
        targetType: 'identity.user',
        targetId,
      },
      context(),
    );
    expect(JSON.stringify(append.mock.calls)).not.toContain(fullEmail);
  });

  it('rejects an actor whose current database role is no longer administrator', async () => {
    const { service, findUnique, append } = createSubject();
    findUnique.mockResolvedValueOnce({
      status: AccountStatus.ACTIVE,
      verifiedAt: new Date(),
      userRoles: [{ role: RoleName.FULFILLER }],
    } as never);

    await expect(service.findByEmail(fullEmail, context())).rejects.toEqual(new ForbiddenError());
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it('returns a safe not-found error without writing audit evidence', async () => {
    const { service, findUnique, append } = createSubject();
    findUnique.mockResolvedValueOnce({
      status: AccountStatus.ACTIVE,
      verifiedAt: new Date(),
      userRoles: [{ role: RoleName.ADMINISTRATOR }],
    } as never);
    findUnique.mockResolvedValueOnce(null as never);

    await expect(service.findByEmail(fullEmail, context())).rejects.toEqual(
      new StaffAccountNotFoundError(),
    );
    expect(append).not.toHaveBeenCalled();
  });

  it('does not return account data when audit persistence fails', async () => {
    const { service, append } = createSubject();
    append.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(service.findByEmail(fullEmail, context())).rejects.toThrow('audit unavailable');
  });
});
