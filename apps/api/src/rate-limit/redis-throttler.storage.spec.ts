import { RateLimitStorageUnavailableError } from './rate-limit.errors';
import { RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  function createSubject(result: unknown = [1, 900, 0, 0]) {
    const evaluate = jest.fn<Promise<unknown>, [string, number, ...(string | number)[]]>(
      async () => result,
    );
    const disconnect = jest.fn();
    const storage = new RedisThrottlerStorage('redis://localhost:6380/0', {
      eval: evaluate,
      disconnect,
    });

    return { storage, evaluate, disconnect };
  }

  it('uses one atomic Redis script and returns the normalized storage record', async () => {
    const { storage, evaluate } = createSubject([4, 812, 0, 0]);

    await expect(
      storage.increment('route-and-client-hash', 900_000, 5, 900_000, 'default'),
    ).resolves.toEqual({
      totalHits: 4,
      timeToExpire: 812,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.slice(1)).toEqual([
      1,
      'pulse-field:rate-limit:default:route-and-client-hash',
      900_000,
      5,
      900_000,
    ]);
    expect(evaluate.mock.calls[0]?.[0]).toContain("redis.call('TIME')");
    expect(evaluate.mock.calls[0]?.[0]).toContain("redis.call('HSET'");
  });

  it('preserves blocked state and retry timing returned by Redis', async () => {
    const { storage } = createSubject([6, 700, 1, 900]);

    await expect(
      storage.increment('blocked-client', 900_000, 5, 900_000, 'default'),
    ).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 700,
      isBlocked: true,
      timeToBlockExpire: 900,
    });
  });

  it('fails closed without exposing the Redis error', async () => {
    const evaluate = jest.fn<Promise<unknown>, [string, number, ...(string | number)[]]>(
      async () => {
        throw new Error('redis://user:secret@remote.example');
      },
    );
    const storage = new RedisThrottlerStorage('redis://localhost:6380/0', {
      eval: evaluate,
      disconnect: jest.fn(),
    });

    await expect(storage.increment('client', 900_000, 5, 900_000, 'default')).rejects.toEqual(
      new RateLimitStorageUnavailableError(),
    );
  });

  it('disconnects its owned client during application shutdown', () => {
    const { storage, disconnect } = createSubject();

    storage.onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledWith(false);
  });
});
