import { validateLocalProfile } from './local-profile';

const baseEnvironment: NodeJS.ProcessEnv = {
  LOCAL_DEVELOPMENT_PROFILE: 'zero-cost-local',
  NODE_ENV: 'test',
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
};

describe('validateLocalProfile', () => {
  it('accepts the isolated local profile', () => {
    expect(validateLocalProfile(baseEnvironment).DATABASE_URL).toContain('localhost');
  });

  it('rejects a remote SMTP host', () => {
    expect(() =>
      validateLocalProfile({ ...baseEnvironment, SMTP_HOST: 'smtp.example.test' }),
    ).toThrow('SMTP_HOST');
  });

  it('rejects an invalid queue-message encryption key', () => {
    expect(() =>
      validateLocalProfile({ ...baseEnvironment, MESSAGE_ENCRYPTION_KEY_BASE64: 'not-a-key' }),
    ).toThrow('MESSAGE_ENCRYPTION_KEY_BASE64');
  });

  it('rejects an invalid or duplicated previous message key', () => {
    expect(() =>
      validateLocalProfile({
        ...baseEnvironment,
        MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64: 'not-a-key',
      }),
    ).toThrow('MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64');
    expect(() =>
      validateLocalProfile({
        ...baseEnvironment,
        MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64: baseEnvironment.MESSAGE_ENCRYPTION_KEY_BASE64,
      }),
    ).toThrow('must differ');
  });

  it('rejects live Stripe credentials', () => {
    expect(() =>
      validateLocalProfile({ ...baseEnvironment, STRIPE_SECRET_KEY: 'sk_live_not_allowed' }),
    ).toThrow('Live Stripe credentials');
  });

  it('accepts Stripe only with complete test-mode credentials and a webhook secret', () => {
    expect(
      validateLocalProfile({
        ...baseEnvironment,
        PAYMENT_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test_local_placeholder',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_local_placeholder',
        STRIPE_WEBHOOK_SECRET: 'whsec_local_placeholder',
      }).PAYMENT_PROVIDER,
    ).toBe('stripe');
    expect(() =>
      validateLocalProfile({
        ...baseEnvironment,
        PAYMENT_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test_local_placeholder',
      }),
    ).toThrow('complete secret/publishable pair');
    expect(() =>
      validateLocalProfile({
        ...baseEnvironment,
        PAYMENT_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test_',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_local_placeholder',
      }),
    ).toThrow('STRIPE_SECRET_KEY must be a test-mode key');
    expect(() =>
      validateLocalProfile({
        ...baseEnvironment,
        PAYMENT_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test_local_placeholder',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_local_placeholder',
      }),
    ).toThrow('webhook signing secret');
    expect(() =>
      validateLocalProfile({
        ...baseEnvironment,
        STRIPE_WEBHOOK_SECRET: 'not-a-webhook-secret',
      }),
    ).toThrow('STRIPE_WEBHOOK_SECRET');
  });
});
