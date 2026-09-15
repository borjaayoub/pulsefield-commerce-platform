import { Writable } from 'node:stream';
import { validateLocalProfile } from '@pulse-field/foundation';
import { createLogger } from './logger';

const profile = validateLocalProfile({
  LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://pulsefield:password@localhost:5432/pulsefield',
  QUEUE_REDIS_URL: 'redis://localhost:6379/0',
  EPHEMERAL_REDIS_URL: 'redis://localhost:6380/0',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_ALLOW_EXTERNAL: 'false',
  MESSAGE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  OUTBOX_RELAY_ENABLED: 'false',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  PRODUCT_MEDIA_ROOT: './.local/media',
  WEB_ORIGIN: 'http://localhost:3000',
  API_PORT: '4000',
  WORKER_PORT: '4001',
  PAYMENT_PROVIDER: 'stub',
  BILLABLE_ADAPTERS_ENABLED: 'false',
});

describe('API logger redaction', () => {
  it('redacts inbound authentication data and the outbound session cookie', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger(profile, destination);

    logger.info({
      req: {
        headers: {
          cookie: 'pulse_field_session=raw-session-id',
          'stripe-signature': 't=1,v1=raw-webhook-signature',
          'x-csrf-token': 'raw-csrf-token',
        },
        body: {
          email: 'private@example.test',
          customerEmail: 'buyer@example.test',
          password: 'plain-password',
          newPassword: 'new-plain-password',
          challengeToken: 'raw-challenge-token',
          totpCode: '123456',
          recoveryCode: 'ABCDE-12345-ABCDE-12345',
        },
      },
      sharedSecret: 'raw-shared-secret',
      provisioningUri: 'otpauth://raw-provisioning-uri',
      recoveryCodes: ['RAW-RECOVERY-CODE'],
      res: { headers: { 'set-cookie': 'pulse_field_session=outbound-session-id' } },
    });

    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('raw-session-id');
    expect(output).not.toContain('raw-webhook-signature');
    expect(output).not.toContain('outbound-session-id');
    expect(output).not.toContain('raw-csrf-token');
    expect(output).not.toContain('plain-password');
    expect(output).not.toContain('private@example.test');
    expect(output).not.toContain('buyer@example.test');
    expect(output).not.toContain('new-plain-password');
    expect(output).not.toContain('raw-challenge-token');
    expect(output).not.toContain('123456');
    expect(output).not.toContain('ABCDE-12345-ABCDE-12345');
    expect(output).not.toContain('raw-shared-secret');
    expect(output).not.toContain('otpauth://raw-provisioning-uri');
    expect(output).not.toContain('RAW-RECOVERY-CODE');
  });
});
