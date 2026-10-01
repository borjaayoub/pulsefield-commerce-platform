import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { RealtimeRelayService } from './realtime-relay.service';

const redisUrl = process.env.EPHEMERAL_REDIS_URL;
const databaseUrl = process.env.TEST_DATABASE_URL;

if (!redisUrl || !databaseUrl) {
  throw new Error('EPHEMERAL_REDIS_URL and TEST_DATABASE_URL are required. Run through the guarded integration runner.');
}

describe('realtime Redis fan-out integration', () => {
  const published: string[][] = [];
  const gateway = {
    publish: (topics: string[]): void => {
      published.push(topics);
    },
    connectionCount: () => 0,
  };
  const relay = new RealtimeRelayService(
    { outboxMessage: { count: jest.fn(), findFirst: jest.fn() } } as never,
    gateway as never,
    { DATABASE_URL: databaseUrl, EPHEMERAL_REDIS_URL: redisUrl } as never,
  );
  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

  afterAll(async () => {
    await publisher.quit();
    await relay.onModuleDestroy();
  });

  it('delivers a bounded invalidation through the real ephemeral Redis channel', async () => {
    await relay.onApplicationBootstrap();
    const channel = (relay as unknown as { channel: string }).channel;
    const marker = randomUUID();
    const received = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}.`)), 3_000);
      const original = gateway.publish;
      gateway.publish = (topics: string[]) => {
        original(topics);
        if (topics.includes('catalog')) {
          clearTimeout(deadline);
          resolve();
        }
      };
    });
    await publisher.publish(channel, JSON.stringify({ version: 1, marker, topics: ['catalog'] }));
    await received;
    expect(published).toContainEqual(['catalog']);
  });
});
