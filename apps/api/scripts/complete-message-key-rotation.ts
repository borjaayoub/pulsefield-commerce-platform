import {
  IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE,
  IDENTITY_NOTIFICATION_QUEUE,
  NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
} from '@pulse-field/contracts';
import { validateLocalProfile } from '@pulse-field/foundation';
import { PrismaPg } from '@prisma/adapter-pg';
import { Queue } from 'bullmq';
import { config as loadEnvironment } from 'dotenv';
import { readFile, rename, writeFile } from 'node:fs/promises';
import Redis from 'ioredis';
import { resolve } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client';
import { TotpSecretCipher } from '../src/identity/totp-secret-cipher';
import { queueConnectionFromUrl } from '../src/messaging/queue-connection';

loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const environmentPath = resolve(process.cwd(), '.env');
const temporaryPath = `${environmentPath}.message-key-finalize.tmp`;
const previousName = 'MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64';
const queueStates = ['waiting', 'active', 'delayed', 'failed', 'paused'] as const;
const mfaChallengePattern = 'pulse-field:mfa-challenge:*';

async function removePreviousKey(): Promise<void> {
  const source = await readFile(environmentPath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (lines.filter((line) => line.startsWith(`${previousName}=`)).length !== 1) {
    throw new Error('The previous message key is not uniquely configured.');
  }
  await writeFile(
    temporaryPath,
    lines.filter((line) => !line.startsWith(`${previousName}=`)).join(newline),
    {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    },
  );
  await rename(temporaryPath, environmentPath);
}

async function hasLegacyEnrollmentChallenge(
  redis: Redis,
  cipher: TotpSecretCipher,
): Promise<boolean> {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', mfaChallengePattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length === 0) continue;
    const records = await redis.mget(keys);
    for (const record of records) {
      if (record === null) continue;
      try {
        const value: unknown = JSON.parse(record);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
        const secret = (value as { protectedTotpSecret?: unknown }).protectedTotpSecret;
        if (typeof secret === 'string' && !cipher.isProtectedWithActiveKey(secret)) return true;
      } catch {
        return true;
      }
    }
  } while (cursor !== '0');
  return false;
}

async function main(): Promise<void> {
  const profile = validateLocalProfile(process.env);
  if (profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64 === undefined) {
    throw new Error('No message-key rotation is in progress.');
  }

  const cipher = new TotpSecretCipher({
    current: profile.MESSAGE_ENCRYPTION_KEY_BASE64,
    previous: profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64,
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: profile.DATABASE_URL }),
  });
  const queues = [
    new Queue(IDENTITY_NOTIFICATION_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
    }),
    new Queue(NOTIFICATION_DELIVERY_OUTCOME_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
    }),
    new Queue(IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
    }),
  ];
  const mfaRedis = new Redis(profile.EPHEMERAL_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  });

  try {
    const legacySecrets = await prisma.user.findMany({
      where: { totpSecretCiphertext: { not: null } },
      select: { totpSecretCiphertext: true },
    });
    if (
      legacySecrets.some(
        ({ totpSecretCiphertext }) => !cipher.isProtectedWithActiveKey(totpSecretCiphertext!),
      )
    ) {
      throw new Error('TOTP secrets still require the previous key.');
    }

    await mfaRedis.connect();
    if (await hasLegacyEnrollmentChallenge(mfaRedis, cipher)) {
      throw new Error('An MFA enrollment challenge still requires the previous key.');
    }

    const counts = await Promise.all(queues.map((queue) => queue.getJobCounts(...queueStates)));
    if (counts.some((queue) => queueStates.some((state) => (queue[state] ?? 0) !== 0))) {
      throw new Error('Notification queues are not drained.');
    }

    await removePreviousKey();
    process.stdout.write(
      'Completed local message-key rotation; the previous key was removed from .env.\n',
    );
  } catch {
    process.stderr.write(
      'Message-key rotation is not ready to complete; the previous key remains required.\n',
    );
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(queues.map((queue) => queue.close()));
    mfaRedis.disconnect(false);
    await prisma.$disconnect();
  }
}

void main();
