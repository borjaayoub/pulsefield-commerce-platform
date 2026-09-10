import { Inject, Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { SessionStoreUnavailableError } from './authentication.errors';
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_REDIS_CLIENT,
  SESSION_REDIS_URL,
} from './identity.constants';

interface RedisSessionClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...arguments_: Array<string | number>
  ): Promise<unknown>;
  del(key: string): Promise<number>;
  disconnect(reconnect?: boolean): void;
}

export interface SessionRecord {
  version: 3;
  userId: string;
  credentialVersion: number;
  authenticationAssurance: AuthenticationAssurance;
  roleFingerprint: string;
  csrfToken: string;
  authenticatedAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export type AuthenticationAssurance = 'PASSWORD' | 'PASSWORD_MFA';

export interface CreatedSession {
  sessionId: string;
  record: SessionRecord;
}

const createSessionScript = `
local newKey = KEYS[1]
local previousKey = KEYS[2]
local userId = ARGV[1]
local credentialVersion = tonumber(ARGV[2])
local authenticationAssurance = ARGV[3]
local roleFingerprint = ARGV[4]
local csrfToken = ARGV[5]
local idleTimeout = tonumber(ARGV[6])
local absoluteTimeout = tonumber(ARGV[7])
local currentTime = redis.call('TIME')
local now = (tonumber(currentTime[1]) * 1000) + math.floor(tonumber(currentTime[2]) / 1000)
local absoluteExpiresAt = now + absoluteTimeout
local idleExpiresAt = math.min(now + idleTimeout, absoluteExpiresAt)
local record = cjson.encode({
  version = 3,
  userId = userId,
  credentialVersion = credentialVersion,
  authenticationAssurance = authenticationAssurance,
  roleFingerprint = roleFingerprint,
  csrfToken = csrfToken,
  authenticatedAt = now,
  idleExpiresAt = idleExpiresAt,
  absoluteExpiresAt = absoluteExpiresAt
})
local created = redis.call('SET', newKey, record, 'PX', math.max(1, idleExpiresAt - now), 'NX')

if not created then
  return nil
end

if previousKey ~= newKey then
  redis.call('DEL', previousKey)
end

return record
`;

const readAndRefreshSessionScript = `
local key = KEYS[1]
local idleTimeout = tonumber(ARGV[1])
local encoded = redis.call('GET', key)

if not encoded then
  return nil
end

local record = cjson.decode(encoded)

if tonumber(record.version) ~= 3 or not tonumber(record.credentialVersion) or tonumber(record.credentialVersion) < 1 then
  redis.call('DEL', key)
  return nil
end

local currentTime = redis.call('TIME')
local now = (tonumber(currentTime[1]) * 1000) + math.floor(tonumber(currentTime[2]) / 1000)

if tonumber(record.absoluteExpiresAt) <= now then
  redis.call('DEL', key)
  return nil
end

record.idleExpiresAt = math.min(now + idleTimeout, tonumber(record.absoluteExpiresAt))
encoded = cjson.encode(record)
redis.call('SET', key, encoded, 'PX', math.max(1, record.idleExpiresAt - now))
return encoded
`;

const peekSessionScript = `
local key = KEYS[1]
local encoded = redis.call('GET', key)

if not encoded then
  return nil
end

local record = cjson.decode(encoded)

if tonumber(record.version) ~= 3 or not tonumber(record.credentialVersion) or tonumber(record.credentialVersion) < 1 then
  redis.call('DEL', key)
  return nil
end

local currentTime = redis.call('TIME')
local now = (tonumber(currentTime[1]) * 1000) + math.floor(tonumber(currentTime[2]) / 1000)

if tonumber(record.absoluteExpiresAt) <= now then
  redis.call('DEL', key)
  return nil
end

return encoded
`;

function sessionKey(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return `pulse-field:session:${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSessionRecord(encoded: unknown): SessionRecord {
  if (typeof encoded !== 'string') {
    throw new Error('Redis returned an invalid session record.');
  }

  const value: unknown = JSON.parse(encoded);
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    typeof value.userId !== 'string' ||
    !Number.isSafeInteger(value.credentialVersion) ||
    Number(value.credentialVersion) < 1 ||
    !['PASSWORD', 'PASSWORD_MFA'].includes(String(value.authenticationAssurance)) ||
    typeof value.roleFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.roleFingerprint) ||
    typeof value.csrfToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) ||
    !Number.isSafeInteger(value.authenticatedAt) ||
    !Number.isSafeInteger(value.idleExpiresAt) ||
    !Number.isSafeInteger(value.absoluteExpiresAt) ||
    Number(value.authenticatedAt) > Number(value.idleExpiresAt) ||
    Number(value.idleExpiresAt) > Number(value.absoluteExpiresAt)
  ) {
    throw new Error('Redis returned an invalid session record.');
  }

  return value as unknown as SessionRecord;
}

@Injectable()
export class RedisSessionStore implements OnApplicationShutdown {
  private readonly redis: RedisSessionClient;

  constructor(
    @Inject(SESSION_REDIS_URL) redisUrl: string,
    @Optional() @Inject(SESSION_REDIS_CLIENT) redis?: RedisSessionClient,
  ) {
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

  async create(
    userId: string,
    credentialVersion: number,
    authenticationAssurance: AuthenticationAssurance,
    roleFingerprint: string,
    previousSessionId?: string,
  ): Promise<CreatedSession> {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const sessionId = randomBytes(32).toString('base64url');
        const csrfToken = randomBytes(32).toString('base64url');
        const key = sessionKey(sessionId);
        const previousKey = previousSessionId ? sessionKey(previousSessionId) : key;
        const result = await this.redis.eval(
          createSessionScript,
          2,
          key,
          previousKey,
          userId,
          credentialVersion,
          authenticationAssurance,
          roleFingerprint,
          csrfToken,
          SESSION_IDLE_TIMEOUT_MS,
          SESSION_ABSOLUTE_TIMEOUT_MS,
        );

        if (result !== null) {
          return { sessionId, record: parseSessionRecord(result) };
        }
      }

      throw new Error('Could not allocate a unique session identifier.');
    } catch {
      throw new SessionStoreUnavailableError();
    }
  }

  async readAndRefresh(sessionId: string): Promise<SessionRecord | null> {
    try {
      const result = await this.redis.eval(
        readAndRefreshSessionScript,
        1,
        sessionKey(sessionId),
        SESSION_IDLE_TIMEOUT_MS,
      );
      return result === null ? null : parseSessionRecord(result);
    } catch {
      throw new SessionStoreUnavailableError();
    }
  }

  async peek(sessionId: string): Promise<SessionRecord | null> {
    try {
      const result = await this.redis.eval(peekSessionScript, 1, sessionKey(sessionId));
      return result === null ? null : parseSessionRecord(result);
    } catch {
      throw new SessionStoreUnavailableError();
    }
  }

  async revoke(sessionId: string): Promise<void> {
    try {
      await this.redis.del(sessionKey(sessionId));
    } catch {
      throw new SessionStoreUnavailableError();
    }
  }

  onApplicationShutdown(): void {
    this.redis.disconnect(false);
  }
}
