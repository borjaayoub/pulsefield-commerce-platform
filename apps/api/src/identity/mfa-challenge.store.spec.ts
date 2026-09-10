import { createHash } from 'node:crypto';
import { MfaServiceUnavailableError } from './authentication.errors';
import { MFA_CHALLENGE_TIMEOUT_MS } from './identity.constants';
import { MfaChallengeStore } from './mfa-challenge.store';

describe('MfaChallengeStore', () => {
  function createSubject() {
    const set = jest.fn<Promise<'OK' | null>, [string, string, 'PX', number, 'NX']>(
      async () => 'OK',
    );
    const get = jest.fn<Promise<string | null>, [string]>(async () => null);
    const del = jest.fn(async () => 1);
    const disconnect = jest.fn();
    const store = new MfaChallengeStore('redis://localhost:6380/0', {
      set,
      get,
      del,
      disconnect,
    });
    return { store, set, get, del, disconnect };
  }

  it('stores only a digest lookup key with a five-minute TTL', async () => {
    const { store, set } = createSubject();
    const created = await store.create({
      purpose: 'AUTHENTICATION',
      userId: '67b3456e-5303-41e7-9c36-4611ee204811',
      credentialVersion: 3,
    });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [storedKey, encoded, mode, ttl, condition] = set.mock.calls[0]!;
    expect(storedKey).toBe(
      `pulse-field:mfa-challenge:${createHash('sha256').update(created.token).digest('hex')}`,
    );
    expect(storedKey).not.toContain(created.token);
    expect(encoded).not.toContain(created.token);
    expect([mode, ttl, condition]).toEqual(['PX', MFA_CHALLENGE_TIMEOUT_MS, 'NX']);
  });

  it('reads valid records and deletes locally expired records', async () => {
    const { store, get, del } = createSubject();
    const token = Buffer.alloc(32, 4).toString('base64url');
    get.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        purpose: 'AUTHENTICATION',
        userId: '67b3456e-5303-41e7-9c36-4611ee204811',
        credentialVersion: 1,
        expiresAt: Date.now() - 1,
      }),
    );

    await expect(store.read(token)).resolves.toBeNull();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('fails closed for corrupted cache data without exposing Redis details', async () => {
    const { store, get } = createSubject();
    get.mockResolvedValueOnce('{"version":1,"purpose":"ENROLLMENT"}');

    await expect(store.read(Buffer.alloc(32, 5).toString('base64url'))).rejects.toEqual(
      new MfaServiceUnavailableError(),
    );
  });

  it('revokes by digest and disconnects its owned boundary', async () => {
    const { store, del, disconnect } = createSubject();
    const token = Buffer.alloc(32, 6).toString('base64url');

    await store.revoke(token);
    store.onApplicationShutdown();

    expect(del).toHaveBeenCalledWith(
      `pulse-field:mfa-challenge:${createHash('sha256').update(token).digest('hex')}`,
    );
    expect(disconnect).toHaveBeenCalledWith(false);
  });
});
