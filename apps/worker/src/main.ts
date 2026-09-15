import { config as loadEnvironment } from 'dotenv';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import {
  IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE,
  IDENTITY_NOTIFICATION_QUEUE,
  NOTIFICATION_DEAD_LETTER_JOB,
  NOTIFICATION_DELIVERY_OUTCOME_JOB,
  NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
  SEND_EMAIL_VERIFICATION_JOB,
  SEND_PASSWORD_RECOVERY_JOB,
  SEND_ORDER_CONFIRMATION_JOB,
  type EmailVerificationJobData,
  type IdentityNotificationJobData,
  type PasswordRecoveryJobData,
  type OrderConfirmationJobData,
  type NotificationDeadLetterJobData,
  type NotificationDeliveryOutcomeJobData,
} from '@pulse-field/contracts';
import { validateLocalProfile } from '@pulse-field/foundation';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import pino from 'pino';
import { buildNotificationDeadLetter } from './notification/dead-letter';
import {
  buildAcceptedNotificationDeliveryOutcome,
  buildTerminalNotificationDeliveryOutcome,
  notificationDeliveryOutcomeJobId,
} from './notification/delivery-outcome';
import { EmailVerificationProcessor } from './notification/email-verification.processor';
import { PasswordRecoveryProcessor } from './notification/password-recovery.processor';
import { OrderConfirmationProcessor } from './notification/order-confirmation.processor';
import { MailpitNotificationAdapter } from './notification/mailpit-notification.adapter';
import { workerQueueConnectionFromUrl } from './queue-connection';
import { workerHealthResponse } from './worker-health';

loadEnvironment({ path: resolve(process.cwd(), '.env') });
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

async function bootstrap(): Promise<void> {
  const profile = validateLocalProfile(process.env);
  const logger = pino({
    name: 'pulse-field-worker',
    level: profile.LOG_LEVEL,
    base: { service: 'worker', profile: profile.LOCAL_DEVELOPMENT_PROFILE },
    redact: {
      paths: [
        '*.recipient',
        '*.verificationUrl',
        '*.passwordResetUrl',
        '*.orderTimelineUrl',
        '*.encryptedDelivery',
        '*.password',
        '*.newPassword',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
  });
  const telemetry = new NodeSDK({
    serviceName: 'pulse-field-worker',
    traceExporter: new OTLPTraceExporter({
      url: new URL('/v1/traces', profile.OTEL_EXPORTER_OTLP_ENDPOINT).toString(),
    }),
  });
  telemetry.start();

  const notifications = new MailpitNotificationAdapter(profile);
  const processor = new EmailVerificationProcessor(
    profile.MESSAGE_ENCRYPTION_KEY_BASE64,
    profile.WEB_ORIGIN,
    notifications,
    profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64,
  );
  const passwordRecoveryProcessor = new PasswordRecoveryProcessor(
    profile.MESSAGE_ENCRYPTION_KEY_BASE64,
    profile.WEB_ORIGIN,
    notifications,
    profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64,
  );
  const orderConfirmationProcessor = new OrderConfirmationProcessor(
    profile.MESSAGE_ENCRYPTION_KEY_BASE64,
    profile.WEB_ORIGIN,
    notifications,
    profile.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64,
  );
  const workerConnection = workerQueueConnectionFromUrl(profile.QUEUE_REDIS_URL, 'worker');
  const producerConnection = workerQueueConnectionFromUrl(profile.QUEUE_REDIS_URL, 'producer');
  const deadLetterQueue = new Queue<NotificationDeadLetterJobData>(
    IDENTITY_NOTIFICATION_DEAD_LETTER_QUEUE,
    { connection: producerConnection },
  );
  const deliveryOutcomeQueue = new Queue<NotificationDeliveryOutcomeJobData>(
    NOTIFICATION_DELIVERY_OUTCOME_QUEUE,
    { connection: producerConnection },
  );
  const dependencyState = { queue: false, smtp: false };
  const worker = new Worker<IdentityNotificationJobData>(
    IDENTITY_NOTIFICATION_QUEUE,
    async (job) => {
      if (job.name === SEND_EMAIL_VERIFICATION_JOB) {
        return processor.process(job as Job<EmailVerificationJobData>);
      }
      if (job.name === SEND_PASSWORD_RECOVERY_JOB) {
        return passwordRecoveryProcessor.process(job as Job<PasswordRecoveryJobData>);
      }
      if (job.name === SEND_ORDER_CONFIRMATION_JOB) {
        return orderConfirmationProcessor.process(job as Job<OrderConfirmationJobData>);
      }
      throw new UnrecoverableError('Notification job contract is unsupported.');
    },
    { connection: workerConnection, concurrency: 4 },
  );

  worker.on('ready', () => {
    dependencyState.queue = true;
  });
  worker.on('error', () => {
    dependencyState.queue = false;
    logger.error({ errorCode: 'QUEUE_WORKER_ERROR' }, 'Notification queue worker error.');
  });
  worker.on('completed', (job: Job<IdentityNotificationJobData>) => {
    dependencyState.smtp = true;
    const outcome = buildAcceptedNotificationDeliveryOutcome(job);
    if (!outcome) return;
    void deliveryOutcomeQueue
      .add(NOTIFICATION_DELIVERY_OUTCOME_JOB, outcome, {
        jobId: notificationDeliveryOutcomeJobId(outcome),
        attempts: 8,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: false,
        removeOnFail: false,
      })
      .catch(() => {
        logger.error(
          {
            errorCode: 'DELIVERY_OUTCOME_PUBLICATION_FAILED',
            sourceEventId: outcome.sourceEventId,
          },
          'Notification delivery outcome publication failed.',
        );
      });
  });
  worker.on('failed', (job: Job<IdentityNotificationJobData> | undefined, error: Error) => {
    if (!job) return;
    const deadLetter = buildNotificationDeadLetter(job, error);
    if (!deadLetter) return;
    const outcome = buildTerminalNotificationDeliveryOutcome(deadLetter);
    void deadLetterQueue
      .add(NOTIFICATION_DEAD_LETTER_JOB, deadLetter, {
        jobId: deadLetter.sourceEventId,
        removeOnComplete: false,
        removeOnFail: false,
      })
      .catch(() => {
        logger.error(
          { errorCode: 'DEAD_LETTER_PUBLICATION_FAILED', sourceEventId: deadLetter.sourceEventId },
          'Notification dead-letter publication failed.',
        );
      });
    void deliveryOutcomeQueue
      .add(NOTIFICATION_DELIVERY_OUTCOME_JOB, outcome, {
        jobId: notificationDeliveryOutcomeJobId(outcome),
        attempts: 8,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: false,
        removeOnFail: false,
      })
      .catch(() => {
        logger.error(
          {
            errorCode: 'DELIVERY_OUTCOME_PUBLICATION_FAILED',
            sourceEventId: outcome.sourceEventId,
          },
          'Notification delivery outcome publication failed.',
        );
      });
  });

  void notifications
    .verify()
    .then(() => {
      dependencyState.smtp = true;
    })
    .catch(() => {
      dependencyState.smtp = false;
      logger.warn({ errorCode: 'LOCAL_SMTP_UNAVAILABLE' }, 'Local SMTP readiness check failed.');
    });

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const health = workerHealthResponse(dependencyState);
      response.writeHead(health.statusCode, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(health.body));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/problem+json' });
    response.end(JSON.stringify({ status: 404, title: 'Not Found' }));
  });

  const host = process.env.WORKER_BIND_HOST ?? '127.0.0.1';
  await new Promise<void>((resolveListen) =>
    server.listen(profile.WORKER_PORT, host, resolveListen),
  );
  logger.info({ host, port: profile.WORKER_PORT }, 'PULSE//FIELD notification worker is listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down notification worker');
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
    await worker.close();
    await deadLetterQueue.close();
    await deliveryOutcomeQueue.close();
    notifications.close();
    await telemetry.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : 'Worker bootstrap failed.'}\n`);
  process.exitCode = 1;
});
