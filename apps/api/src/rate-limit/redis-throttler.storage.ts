import type { OnApplicationShutdown } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';
import { RateLimitStorageUnavailableError } from './rate-limit.errors';

interface RedisRateLimitClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
}

interface RateLimitStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

const incrementScript = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])
local currentTime = redis.call('TIME')
local now = (tonumber(currentTime[1]) * 1000) + math.floor(tonumber(currentTime[2]) / 1000)

local values = redis.call('HMGET', key, 'totalHits', 'windowExpiresAt', 'blockedUntil')
local totalHits = tonumber(values[1]) or 0
local windowExpiresAt = tonumber(values[2]) or 0
local blockedUntil = tonumber(values[3]) or 0

if blockedUntil > now then
  local timeToExpire = math.max(0, math.ceil((windowExpiresAt - now) / 1000))
  local timeToBlockExpire = math.max(1, math.ceil((blockedUntil - now) / 1000))
  return { totalHits, timeToExpire, 1, timeToBlockExpire }
end

if windowExpiresAt <= now or blockedUntil > 0 then
  totalHits = 0
  windowExpiresAt = now + ttl
  blockedUntil = 0
end

totalHits = totalHits + 1
local isBlocked = 0

if totalHits > limit then
  isBlocked = 1
  blockedUntil = now + blockDuration
end

redis.call('HSET', key,
  'totalHits', totalHits,
  'windowExpiresAt', windowExpiresAt,
  'blockedUntil', blockedUntil
)

local retainedUntil = math.max(windowExpiresAt, blockedUntil)
redis.call('PEXPIRE', key, math.max(1, retainedUntil - now))

local timeToExpire = math.max(1, math.ceil((windowExpiresAt - now) / 1000))
local timeToBlockExpire = 0
if isBlocked == 1 then
  timeToBlockExpire = math.max(1, math.ceil((blockedUntil - now) / 1000))
end

return { totalHits, timeToExpire, isBlocked, timeToBlockExpire }
`;

function parseStorageRecord(result: unknown): RateLimitStorageRecord {
  if (!Array.isArray(result) || result.length !== 4) {
    throw new Error('Redis returned an invalid rate-limit record.');
  }

  const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result.map(Number);

  if (
    !Number.isSafeInteger(totalHits) ||
    totalHits < 0 ||
    !Number.isSafeInteger(timeToExpire) ||
    timeToExpire < 0 ||
    (isBlocked !== 0 && isBlocked !== 1) ||
    !Number.isSafeInteger(timeToBlockExpire) ||
    timeToBlockExpire < 0
  ) {
    throw new Error('Redis returned an invalid rate-limit record.');
  }

  return {
    totalHits,
    timeToExpire,
    isBlocked: isBlocked === 1,
    timeToBlockExpire,
  };
}

export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly redis: RedisRateLimitClient;

  constructor(redisUrl: string, redis?: RedisRateLimitClient) {
    if (redis) {
      this.redis = redis;
    } else {
      const client = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 1_000,
        maxRetriesPerRequest: 1,
        retryStrategy: null,
      });
      client.on('error', () => undefined);
      this.redis = client;
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<RateLimitStorageRecord> {
    try {
      const result = await this.redis.eval(
        incrementScript,
        1,
        `pulse-field:rate-limit:${throttlerName}:${key}`,
        ttl,
        limit,
        blockDuration,
      );

      return parseStorageRecord(result);
    } catch {
      throw new RateLimitStorageUnavailableError();
    }
  }

  onApplicationShutdown(): void {
    this.redis.disconnect(false);
  }
}
