import type { ConnectionOptions } from 'bullmq';

export function workerQueueConnectionFromUrl(
  value: string,
  purpose: 'worker' | 'producer',
): ConnectionOptions {
  const url = new URL(value);
  if (url.protocol !== 'redis:') {
    throw new Error('QUEUE_REDIS_URL must use the redis protocol.');
  }

  const database = url.pathname === '' || url.pathname === '/' ? 0 : Number(url.pathname.slice(1));
  if (!Number.isInteger(database) || database < 0) {
    throw new Error('QUEUE_REDIS_URL must contain a non-negative integer database number.');
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: database,
    maxRetriesPerRequest: purpose === 'worker' ? null : 1,
    ...(purpose === 'producer' ? { enableOfflineQueue: false } : {}),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}
