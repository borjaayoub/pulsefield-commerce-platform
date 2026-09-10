import { createHash } from 'node:crypto';
import { SessionStoreUnavailableError } from './authentication.errors';
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from './identity.constants';
import { RedisSessionStore } from './redis-session.store';

describe('RedisSessionStore', () => {
  const userId = '67b3456e-5303-41e7-9c36-4611ee204811';
  const now = 1_788_350_400_000;

  function createSubject() {
    const evaluate = jest.fn<Promise<unknown>, [string, number, ...(string | number)[]]>(
      async (
        _script,
        _keyCount,
        _newKey,
        _previousKey,
        requestedUserId,
        credentialVersion,
        authenticationAssurance,
        roleFingerprint,
        csrfToken,
      ) =>
        JSON.stringify({
          version: 3,
          userId: typeof requestedUserId === 'string' ? requestedUserId : userId,
          credentialVersion: typeof credentialVersion === 'number' ? credentialVersion : 1,
          authenticationAssurance:
            authenticationAssurance === 'PASSWORD_MFA' ? 'PASSWORD_MFA' : 'PASSWORD',
          roleFingerprint: typeof roleFingerprint === 'string' ? roleFingerprint : 'a'.repeat(64),
          csrfToken:
            typeof csrfToken === 'string' ? csrfToken : Buffer.alloc(32, 6).toString('base64url'),
          authenticatedAt: now,
          idleExpiresAt: now + SESSION_IDLE_TIMEOUT_MS,
          absoluteExpiresAt: now + SESSION_ABSOLUTE_TIMEOUT_MS,
        }),
    );
    const del = jest.fn(async () => 1);
    const disconnect = jest.fn();
    const store = new RedisSessionStore('redis://localhost:6380/0', {
      eval: evaluate,
      del,
      disconnect,
    });
    return { store, evaluate, del, disconnect };
  }

  it('creates a random session while Redis receives only digested session lookup keys', async () => {
    const { store, evaluate } = createSubject();
    const previousSessionId = Buffer.alloc(32, 8).toString('base64url');

    const fingerprint = 'a'.repeat(64);
    const created = await store.create(userId, 3, 'PASSWORD_MFA', fingerprint, previousSessionId);

    expect(created.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.record).toMatchObject({
      userId,
      version: 3,
      credentialVersion: 3,
      authenticationAssurance: 'PASSWORD_MFA',
      roleFingerprint: fingerprint,
    });
    expect(created.record).not.toHaveProperty('sessionId');
    const call = evaluate.mock.calls[0];
    expect(call?.[0]).toContain("redis.call('TIME')");
    expect(call?.[0]).toContain("'NX'");
    expect(call?.[2]).toBe(
      `pulse-field:session:${createHash('sha256').update(created.sessionId).digest('hex')}`,
    );
    expect(call?.[3]).toBe(
      `pulse-field:session:${createHash('sha256').update(previousSessionId).digest('hex')}`,
    );
    expect(JSON.stringify(call?.slice(2))).not.toContain(created.sessionId);
    expect(call?.slice(4, 8)).toEqual([userId, 3, 'PASSWORD_MFA', fingerprint]);
    expect(call?.slice(-2)).toEqual([SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_TIMEOUT_MS]);
  });

  it('uses one atomic Redis script to refresh idle expiry', async () => {
    const { store, evaluate } = createSubject();
    const sessionId = Buffer.alloc(32, 9).toString('base64url');

    await expect(store.readAndRefresh(sessionId)).resolves.toMatchObject({ userId });
    expect(evaluate.mock.calls[0]?.[0]).toContain('record.idleExpiresAt = math.min');
    expect(evaluate.mock.calls[0]?.[0]).toContain('record.absoluteExpiresAt');
    expect(evaluate.mock.calls[0]?.slice(1)).toEqual([
      1,
      `pulse-field:session:${createHash('sha256').update(sessionId).digest('hex')}`,
      SESSION_IDLE_TIMEOUT_MS,
    ]);
  });

  it('deletes legacy records instead of treating them as a Redis outage', async () => {
    const { store, evaluate } = createSubject();
    evaluate.mockResolvedValueOnce(null);

    await expect(
      store.readAndRefresh(Buffer.alloc(32, 2).toString('base64url')),
    ).resolves.toBeNull();
    expect(evaluate.mock.calls[0]?.[0]).toContain('tonumber(record.version) ~= 3');
  });

  it('fails closed and hides Redis details', async () => {
    const { store, evaluate } = createSubject();
    evaluate.mockRejectedValueOnce(new Error('redis://user:secret@remote.example'));

    await expect(store.peek(Buffer.alloc(32, 1).toString('base64url'))).rejects.toEqual(
      new SessionStoreUnavailableError(),
    );
  });

  it('revokes by digest and disconnects its owned boundary', async () => {
    const { store, del, disconnect } = createSubject();
    const sessionId = Buffer.alloc(32, 4).toString('base64url');

    await store.revoke(sessionId);
    store.onApplicationShutdown();

    expect(del).toHaveBeenCalledWith(
      `pulse-field:session:${createHash('sha256').update(sessionId).digest('hex')}`,
    );
    expect(disconnect).toHaveBeenCalledWith(false);
  });
});
