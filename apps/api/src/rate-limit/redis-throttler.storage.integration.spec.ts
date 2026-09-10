import { randomUUID } from 'node:crypto';
import { RedisThrottlerStorage } from './redis-throttler.storage';

const ephemeralRedisUrl = process.env.EPHEMERAL_REDIS_URL;

if (!ephemeralRedisUrl) {
  throw new Error('EPHEMERAL_REDIS_URL is required. Run this suite through pnpm test:integration.');
}

describe('RedisThrottlerStorage integration', () => {
  const storage = new RedisThrottlerStorage(ephemeralRedisUrl);

  afterAll(() => {
    storage.onApplicationShutdown();
  });

  it('shares an atomic route/client counter and blocks only after the configured limit', async () => {
    const key = `integration-${randomUUID()}`;

    const first = await storage.increment(key, 1_000, 2, 1_000, 'integration');
    const second = await storage.increment(key, 1_000, 2, 1_000, 'integration');
    const third = await storage.increment(key, 1_000, 2, 1_000, 'integration');

    expect(first).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(second).toMatchObject({ totalHits: 2, isBlocked: false });
    expect(third).toMatchObject({ totalHits: 3, isBlocked: true });
    expect(third.timeToBlockExpire).toBeGreaterThan(0);
  });
});
