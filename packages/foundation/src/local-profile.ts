import { z } from 'zod';

const localHostnames = new Set([
  'localhost',
  '127.0.0.1',
  'postgres',
  'redis-queue',
  'redis-cache',
  'mailpit',
  'jaeger',
]);

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

function mustUseLocalHost(value: string, label: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (!localHostnames.has(url.hostname)) {
    throw new Error(`${label} must resolve only to a local Compose or localhost service.`);
  }

  return value;
}

function mustUseLocalSmtpHost(value: string): string {
  if (!localHostnames.has(value)) {
    throw new Error('SMTP_HOST must be localhost or the Compose Mailpit service.');
  }

  return value;
}

const localProfileSchema = z
  .object({
    LOCAL_DEVELOPMENT_PROFILE: z.literal('zero-cost-local'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1),
    QUEUE_REDIS_URL: z.string().min(1),
    EPHEMERAL_REDIS_URL: z.string().min(1),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_ALLOW_EXTERNAL: booleanFromEnvironment,
    MESSAGE_ENCRYPTION_KEY_BASE64: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be one canonical base64-encoded 32-byte key'),
    MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be one canonical base64-encoded 32-byte key')
      .optional(),
    OUTBOX_RELAY_ENABLED: booleanFromEnvironment,
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1),
    PRODUCT_MEDIA_ROOT: z.string().min(1),
    WEB_ORIGIN: z.string().url(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
    PAYMENT_PROVIDER: z.enum(['stub', 'stripe']).default('stub'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_PUBLISHABLE_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    BILLABLE_ADAPTERS_ENABLED: booleanFromEnvironment,
  })
  .superRefine((value, context) => {
    const checks: Array<[string, string]> = [
      [value.DATABASE_URL, 'DATABASE_URL'],
      [value.QUEUE_REDIS_URL, 'QUEUE_REDIS_URL'],
      [value.EPHEMERAL_REDIS_URL, 'EPHEMERAL_REDIS_URL'],
      [value.OTEL_EXPORTER_OTLP_ENDPOINT, 'OTEL_EXPORTER_OTLP_ENDPOINT'],
      [value.WEB_ORIGIN, 'WEB_ORIGIN'],
    ];

    for (const [entry, label] of checks) {
      try {
        mustUseLocalHost(entry, label);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : `${label} is invalid.`,
          path: [label],
        });
      }
    }

    try {
      mustUseLocalSmtpHost(value.SMTP_HOST);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'SMTP_HOST is invalid.',
        path: ['SMTP_HOST'],
      });
    }

    if (value.SMTP_ALLOW_EXTERNAL) {
      context.addIssue({
        code: 'custom',
        message: 'SMTP_ALLOW_EXTERNAL must remain false in the zero-cost local profile.',
        path: ['SMTP_ALLOW_EXTERNAL'],
      });
    }

    const hasValidMessageKey = (key: string) => {
      const decoded = Buffer.from(key, 'base64');
      return decoded.length === 32 && decoded.toString('base64') === key;
    };

    if (!hasValidMessageKey(value.MESSAGE_ENCRYPTION_KEY_BASE64)) {
      context.addIssue({
        code: 'custom',
        message: 'MESSAGE_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes.',
        path: ['MESSAGE_ENCRYPTION_KEY_BASE64'],
      });
    }

    if (
      value.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64 !== undefined &&
      !hasValidMessageKey(value.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64 must decode to exactly 32 bytes.',
        path: ['MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64'],
      });
    }

    if (
      value.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64 !== undefined &&
      value.MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64 === value.MESSAGE_ENCRYPTION_KEY_BASE64
    ) {
      context.addIssue({
        code: 'custom',
        message: 'MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64 must differ from the active key.',
        path: ['MESSAGE_ENCRYPTION_PREVIOUS_KEY_BASE64'],
      });
    }

    if (value.BILLABLE_ADAPTERS_ENABLED) {
      context.addIssue({
        code: 'custom',
        message: 'BILLABLE_ADAPTERS_ENABLED must remain false in the zero-cost local profile.',
        path: ['BILLABLE_ADAPTERS_ENABLED'],
      });
    }

    if (
      value.STRIPE_SECRET_KEY?.startsWith('sk_live_') ||
      value.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_live_')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Live Stripe credentials are prohibited in the local development profile.',
        path: ['STRIPE_SECRET_KEY'],
      });
    }

    if (
      value.STRIPE_SECRET_KEY &&
      !/^sk_test_[A-Za-z0-9][A-Za-z0-9_]*$/u.test(value.STRIPE_SECRET_KEY)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'STRIPE_SECRET_KEY must be a test-mode key when supplied.',
        path: ['STRIPE_SECRET_KEY'],
      });
    }

    if (
      value.STRIPE_PUBLISHABLE_KEY &&
      !/^pk_test_[A-Za-z0-9][A-Za-z0-9_]*$/u.test(value.STRIPE_PUBLISHABLE_KEY)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'STRIPE_PUBLISHABLE_KEY must be a test-mode key when supplied.',
        path: ['STRIPE_PUBLISHABLE_KEY'],
      });
    }

    if (
      value.STRIPE_WEBHOOK_SECRET &&
      !/^whsec_[A-Za-z0-9][A-Za-z0-9_]*$/u.test(value.STRIPE_WEBHOOK_SECRET)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'STRIPE_WEBHOOK_SECRET must be a Stripe endpoint signing secret when supplied.',
        path: ['STRIPE_WEBHOOK_SECRET'],
      });
    }

    const hasStripeSecret = value.STRIPE_SECRET_KEY !== undefined;
    const hasStripePublishable = value.STRIPE_PUBLISHABLE_KEY !== undefined;
    if (hasStripeSecret !== hasStripePublishable) {
      context.addIssue({
        code: 'custom',
        message: 'Stripe test credentials must be supplied as a complete secret/publishable pair.',
        path: ['PAYMENT_PROVIDER'],
      });
    }

    if (
      value.PAYMENT_PROVIDER === 'stripe' &&
      (!hasStripeSecret || !hasStripePublishable || !value.STRIPE_WEBHOOK_SECRET)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'PAYMENT_PROVIDER=stripe requires Stripe test credentials and a webhook signing secret.',
        path: ['PAYMENT_PROVIDER'],
      });
    }
  });

export type LocalProfile = z.infer<typeof localProfileSchema>;

export function validateLocalProfile(environment: NodeJS.ProcessEnv): LocalProfile {
  const parsed = localProfileSchema.safeParse(environment);

  if (!parsed.success) {
    const messages = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Local profile validation failed:\n- ${messages.join('\n- ')}`);
  }

  return parsed.data;
}
