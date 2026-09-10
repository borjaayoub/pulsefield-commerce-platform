import { Inject, Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { MfaServiceUnavailableError } from './authentication.errors';
import {
  MFA_CHALLENGE_REDIS_CLIENT,
  MFA_CHALLENGE_TIMEOUT_MS,
  SESSION_REDIS_URL,
} from './identity.constants';

export type MfaChallengePurpose = 'ENROLLMENT' | 'AUTHENTICATION';

export interface MfaChallengeRecord {
  version: 1;
  purpose: MfaChallengePurpose;
  userId: string;
  credentialVersion: number;
  protectedTotpSecret?: string;
  expiresAt: number;
}

interface RedisClient {
  set(key: string, value: string, mode: 'PX', ttl: number, condition: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  disconnect(reconnect?: boolean): void;
}

function key(token: string): string {
  return `pulse-field:mfa-challenge:${createHash('sha256').update(token).digest('hex')}`;
}

function parse(encoded: string): MfaChallengeRecord {
  const value = JSON.parse(encoded) as Partial<MfaChallengeRecord>;
  if (
    value.version !== 1 ||
    !['ENROLLMENT', 'AUTHENTICATION'].includes(value.purpose ?? '') ||
    typeof value.userId !== 'string' ||
    !Number.isSafeInteger(value.credentialVersion) ||
    Number(value.credentialVersion) < 1 ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.purpose === 'ENROLLMENT' && typeof value.protectedTotpSecret !== 'string') ||
    (value.purpose === 'AUTHENTICATION' && value.protectedTotpSecret !== undefined)
  ) {
    throw new Error('Invalid MFA challenge record.');
  }
  return value as MfaChallengeRecord;
}

@Injectable()
export class MfaChallengeStore implements OnApplicationShutdown {
  private readonly redis: RedisClient;

  constructor(
    @Inject(SESSION_REDIS_URL) redisUrl: string,
    @Optional() @Inject(MFA_CHALLENGE_REDIS_CLIENT) redis?: RedisClient,
  ) {
    const client =
      redis ??
      new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 1_000,
        maxRetriesPerRequest: 1,
        retryStrategy: null,
      });
    if (!redis && client instanceof Redis) client.on('error', () => undefined);
    this.redis = client as RedisClient;
  }

  async create(input: Omit<MfaChallengeRecord, 'version' | 'expiresAt'>) {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const token = randomBytes(32).toString('base64url');
        const record: MfaChallengeRecord = {
          version: 1,
          ...input,
          expiresAt: Date.now() + MFA_CHALLENGE_TIMEOUT_MS,
        };
        if (
          await this.redis.set(
            key(token),
            JSON.stringify(record),
            'PX',
            MFA_CHALLENGE_TIMEOUT_MS,
            'NX',
          )
        ) {
          return { token, record };
        }
      }
      throw new Error('Could not allocate MFA challenge.');
    } catch {
      throw new MfaServiceUnavailableError();
    }
  }

  async read(token: string): Promise<MfaChallengeRecord | null> {
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const encoded = await this.redis.get(key(token));
      if (!encoded) return null;
      const record = parse(encoded);
      if (record.expiresAt <= Date.now()) {
        await this.redis.del(key(token));
        return null;
      }
      return record;
    } catch (error) {
      if (error instanceof MfaServiceUnavailableError) throw error;
      throw new MfaServiceUnavailableError();
    }
  }

  async revoke(token: string): Promise<void> {
    try {
      await this.redis.del(key(token));
    } catch {
      throw new MfaServiceUnavailableError();
    }
  }

  onApplicationShutdown(): void {
    this.redis.disconnect(false);
  }
}
