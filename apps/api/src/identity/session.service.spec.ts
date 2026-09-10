import { AccountStatus, RoleName } from '../generated/prisma/enums';
import {
  InvalidCsrfTokenError,
  SessionStoreUnavailableError,
  UnauthenticatedError,
} from './authentication.errors';
import { roleFingerprint } from './authorization.service';
import type { AuthenticationAssurance, SessionRecord } from './redis-session.store';
import { SessionService } from './session.service';

describe('SessionService', () => {
  const sessionId = Buffer.alloc(32, 3).toString('base64url');
  const csrfToken = Buffer.alloc(32, 5).toString('base64url');
  const record: SessionRecord = {
    version: 3,
    userId: '67b3456e-5303-41e7-9c36-4611ee204811',
    credentialVersion: 1,
    authenticationAssurance: 'PASSWORD',
    roleFingerprint: roleFingerprint([RoleName.CUSTOMER]),
    csrfToken,
    authenticatedAt: Date.parse('2026-09-02T10:00:00.000Z'),
    idleExpiresAt: Date.parse('2026-09-02T10:30:00.000Z'),
    absoluteExpiresAt: Date.parse('2026-09-03T10:00:00.000Z'),
  };

  function createSubject(status: AccountStatus = AccountStatus.ACTIVE) {
    const store = {
      create: jest.fn<
        Promise<{ sessionId: string; record: SessionRecord }>,
        [string, number, AuthenticationAssurance, string, string?]
      >(async () => ({ sessionId, record })),
      readAndRefresh: jest.fn<Promise<SessionRecord | null>, [string]>(async () => record),
      peek: jest.fn<Promise<SessionRecord | null>, [string]>(async () => record),
      revoke: jest.fn<Promise<void>, [string]>(async () => undefined),
    };
    const findUnique = jest.fn(async () => ({
      id: record.userId,
      emailNormalized: 'customer@example.test',
      status,
      credentialVersion: 1,
      totpEnrolledAt: null as Date | null,
      userRoles: [{ role: RoleName.CUSTOMER as RoleName }],
    }));
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const service = new SessionService(
      store as never,
      { user: { findUnique, updateMany } } as never,
    );
    return { service, store, findUnique, updateMany };
  }

  it('creates a response view without exposing the session identifier inside it', async () => {
    const { service, store } = createSubject();
    const principal = {
      id: record.userId,
      email: 'customer@example.test',
      roles: [RoleName.CUSTOMER],
      credentialVersion: 1,
      mfaEnrolled: false,
    };

    const created = await service.create(principal, 'PASSWORD', 'previous-session');

    expect(store.create).toHaveBeenCalledWith(
      principal.id,
      1,
      'PASSWORD',
      roleFingerprint(principal.roles),
      'previous-session',
    );
    expect(created.sessionId).toBe(sessionId);
    expect(created.view).toMatchObject({
      user: { id: principal.id, email: principal.email, roles: principal.roles },
      csrfToken,
    });
    expect(created.view.user).not.toHaveProperty('credentialVersion');
    expect(created.view).not.toHaveProperty('sessionId');
  });

  it('reloads current account status and roles for every authenticated read', async () => {
    const { service, findUnique } = createSubject();

    await expect(service.current(sessionId)).resolves.toMatchObject({
      user: { email: 'customer@example.test', roles: [RoleName.CUSTOMER] },
      csrfToken,
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: record.userId } }),
    );
  });

  it('revokes a session when the account is no longer active', async () => {
    const { service, store } = createSubject(AccountStatus.SUSPENDED);

    await expect(service.current(sessionId)).rejects.toEqual(new UnauthenticatedError());
    expect(store.revoke).toHaveBeenCalledWith(sessionId);
  });

  it('revokes a session created under an older credential version', async () => {
    const { service, store, findUnique } = createSubject();
    findUnique.mockResolvedValueOnce({
      id: record.userId,
      emailNormalized: 'customer@example.test',
      status: AccountStatus.ACTIVE,
      credentialVersion: 2,
      totpEnrolledAt: null,
      userRoles: [{ role: RoleName.CUSTOMER }],
    });

    await expect(service.current(sessionId)).rejects.toEqual(new UnauthenticatedError());
    expect(store.revoke).toHaveBeenCalledWith(sessionId);
  });

  it('revokes a session after any role change', async () => {
    const { service, store, findUnique } = createSubject();
    findUnique.mockResolvedValueOnce({
      id: record.userId,
      emailNormalized: 'customer@example.test',
      status: AccountStatus.ACTIVE,
      credentialVersion: 1,
      totpEnrolledAt: new Date(),
      userRoles: [{ role: RoleName.FULFILLER }],
    });

    await expect(service.current(sessionId)).rejects.toEqual(new UnauthenticatedError());
    expect(store.revoke).toHaveBeenCalledWith(sessionId);
  });

  it('rejects password-only staff sessions even when their current role fingerprint matches', async () => {
    const { service, store, findUnique } = createSubject();
    store.readAndRefresh.mockResolvedValueOnce({
      ...record,
      roleFingerprint: roleFingerprint([RoleName.FULFILLER]),
    });
    findUnique.mockResolvedValueOnce({
      id: record.userId,
      emailNormalized: 'staff@example.test',
      status: AccountStatus.ACTIVE,
      credentialVersion: 1,
      totpEnrolledAt: new Date(),
      userRoles: [{ role: RoleName.FULFILLER }],
    });

    await expect(service.current(sessionId)).rejects.toEqual(new UnauthenticatedError());
    expect(store.revoke).toHaveBeenCalledWith(sessionId);
  });

  it('accepts only MFA-assured staff sessions with a currently enrolled factor', async () => {
    const { service, store, findUnique } = createSubject();
    const staffRecord: SessionRecord = {
      ...record,
      authenticationAssurance: 'PASSWORD_MFA',
      roleFingerprint: roleFingerprint([RoleName.FULFILLER]),
    };
    store.readAndRefresh.mockResolvedValue(staffRecord);
    findUnique.mockResolvedValue({
      id: record.userId,
      emailNormalized: 'staff@example.test',
      status: AccountStatus.ACTIVE,
      credentialVersion: 1,
      totpEnrolledAt: new Date(),
      userRoles: [{ role: RoleName.FULFILLER }],
    });

    await expect(service.current(sessionId)).resolves.toMatchObject({
      user: { roles: [RoleName.FULFILLER] },
    });

    findUnique.mockResolvedValueOnce({
      id: record.userId,
      emailNormalized: 'staff@example.test',
      status: AccountStatus.ACTIVE,
      credentialVersion: 1,
      totpEnrolledAt: null,
      userRoles: [{ role: RoleName.FULFILLER }],
    });
    await expect(service.current(sessionId)).rejects.toEqual(new UnauthenticatedError());
  });

  it('requires the matching CSRF token before revoking a valid session', async () => {
    const { service, store } = createSubject();

    await expect(service.logout(sessionId, 'wrong-token')).rejects.toEqual(
      new InvalidCsrfTokenError(),
    );
    expect(store.revoke).not.toHaveBeenCalled();

    await expect(service.logout(sessionId, csrfToken)).resolves.toBeUndefined();
    expect(store.revoke).toHaveBeenCalledWith(sessionId);
  });

  it('keeps logout idempotent when no session exists', async () => {
    const { service, store } = createSubject();
    store.peek.mockResolvedValueOnce(null);

    await expect(service.logout(undefined, undefined)).resolves.toBeUndefined();
    await expect(service.logout(sessionId, undefined)).resolves.toBeUndefined();
    expect(store.revoke).not.toHaveBeenCalled();
  });

  it('increments the matching account session generation before revoking the current session', async () => {
    const { service, store, updateMany } = createSubject();

    await expect(service.logoutAll(sessionId, csrfToken)).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: record.userId,
        status: AccountStatus.ACTIVE,
        credentialVersion: record.credentialVersion,
      },
      data: { credentialVersion: { increment: 1 } },
    });
    expect(store.revoke).toHaveBeenCalledWith(sessionId);
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      store.revoke.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('rejects logout-all before database mutation when authentication or CSRF is invalid', async () => {
    const { service, store, updateMany } = createSubject();

    await expect(service.logoutAll(undefined, csrfToken)).rejects.toEqual(
      new UnauthenticatedError(),
    );
    store.peek.mockResolvedValueOnce(null);
    await expect(service.logoutAll(sessionId, csrfToken)).rejects.toEqual(
      new UnauthenticatedError(),
    );
    await expect(service.logoutAll(sessionId, 'wrong-token')).rejects.toEqual(
      new InvalidCsrfTokenError(),
    );

    expect(updateMany).not.toHaveBeenCalled();
    expect(store.revoke).not.toHaveBeenCalled();
  });

  it('keeps concurrent logout-all deletion idempotent when the generation already changed', async () => {
    const { service, store, updateMany } = createSubject();
    updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.logoutAll(sessionId, csrfToken)).resolves.toBeUndefined();

    expect(store.revoke).toHaveBeenCalledWith(sessionId);
  });

  it('keeps the successful database invalidation when current-session cleanup is unavailable', async () => {
    const { service, store, updateMany } = createSubject();
    store.revoke.mockRejectedValueOnce(new SessionStoreUnavailableError());

    await expect(service.logoutAll(sessionId, csrfToken)).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
