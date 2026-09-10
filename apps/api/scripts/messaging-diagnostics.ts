import {
  IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE,
  IDENTITY_NOTIFICATION_QUEUE,
  NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
} from '@pulse-field/contracts';
import { validateLocalProfile } from '@pulse-field/foundation';
import { PrismaPg } from '@prisma/adapter-pg';
import { Queue } from 'bullmq';
import { config as loadEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/client';
import { collectMessagingDiagnostics } from '../src/messaging/messaging-diagnostics';
import { queueConnectionFromUrl } from '../src/messaging/queue-connection';

loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

async function main(): Promise<void> {
  const profile = validateLocalProfile(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: profile.DATABASE_URL }),
  });
  const queues = {
    identityNotifications: new Queue(IDENTITY_NOTIFICATION_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
    }),
    deliveryOutcomes: new Queue(NOTIFICATION_DELIVERY_OUTCOME_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
    }),
    notificationDeadLetter: new Queue(IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE, {
      connection: queueConnectionFromUrl(profile.QUEUE_REDIS_URL),
    }),
  };

  try {
    const snapshot = await collectMessagingDiagnostics(prisma, queues);
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } catch {
    process.stderr.write('Messaging diagnostics could not query local PostgreSQL and Redis.\n');
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([
      queues.identityNotifications.close(),
      queues.deliveryOutcomes.close(),
      queues.notificationDeadLetter.close(),
    ]);
    await prisma.$disconnect();
  }
}

void main();
