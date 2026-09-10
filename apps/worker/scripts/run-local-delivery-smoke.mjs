import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnvironment } from 'dotenv';
import { Queue } from 'bullmq';
import { IDENTITY_NOTIFICATION_QUEUE, SEND_EMAIL_VERIFICATION_JOB } from '@pulse-field/contracts';
import { encryptQueueMessage, validateLocalProfile } from '@pulse-field/foundation';

loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const profile = validateLocalProfile(process.env);
const redisUrl = new URL(profile.QUEUE_REDIS_URL);
const connection = {
  host: redisUrl.hostname,
  port: redisUrl.port ? Number(redisUrl.port) : 6379,
  db:
    redisUrl.pathname === '' || redisUrl.pathname === '/' ? 0 : Number(redisUrl.pathname.slice(1)),
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
};

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main() {
  const sourceEventId = randomUUID();
  const recipient = `messaging-smoke-${sourceEventId}@example.test`;
  const token = randomBytes(32).toString('base64url');
  const queue = new Queue(IDENTITY_NOTIFICATION_QUEUE, { connection });

  try {
    const job = await queue.add(
      SEND_EMAIL_VERIFICATION_JOB,
      {
        version: 1,
        sourceEventId,
        correlationId: `smoke-${sourceEventId}`,
        userId: randomUUID(),
        encryptedDelivery: encryptQueueMessage(
          {
            version: 1,
            recipient,
            verificationUrl: `${profile.WEB_ORIGIN}/verify-email?token=${token}`,
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          },
          profile.MESSAGE_ENCRYPTION_KEY_BASE64,
        ),
      },
      {
        jobId: sourceEventId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 250 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    let state = await job.getState();
    for (
      let attempt = 0;
      attempt < 60 && state !== 'completed' && state !== 'failed';
      attempt += 1
    ) {
      await delay(250);
      state = await job.getState();
    }
    if (state !== 'completed') throw new Error(`Notification smoke job ended in state: ${state}.`);

    let captured = false;
    for (let attempt = 0; attempt < 20 && !captured; attempt += 1) {
      const response = await fetch('http://127.0.0.1:8025/api/v1/messages');
      if (!response.ok) throw new Error(`Mailpit API returned HTTP ${response.status}.`);
      const inbox = await response.json();
      captured = JSON.stringify(inbox).includes(recipient);
      if (!captured) await delay(250);
    }
    if (!captured)
      throw new Error('Completed notification job was not found in the Mailpit inbox.');

    await job.remove();
    process.stdout.write(
      `Local delivery smoke passed for event ${sourceEventId}; Mailpit captured ${recipient}.\n`,
    );
  } finally {
    await queue.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Messaging smoke failed.'}\n`);
  process.exitCode = 1;
});
