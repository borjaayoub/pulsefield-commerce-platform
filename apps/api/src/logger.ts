import pino from 'pino';
import type { LocalProfile } from '@pulse-field/foundation';

export function createLogger(
  profile: LocalProfile,
  destination?: pino.DestinationStream,
): pino.Logger {
  return pino(
    {
      name: 'pulse-field-api',
      level: profile.LOG_LEVEL,
      base: {
        service: 'api',
        profile: profile.LOCAL_DEVELOPMENT_PROFILE,
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-csrf-token',
          'req.body.password',
          'req.body.email',
          'req.body.newPassword',
          'req.body.csrfToken',
          'req.body.token',
          'req.body.secret',
          'req.body.challengeToken',
          'req.body.totpCode',
          'req.body.recoveryCode',
          'sharedSecret',
          'provisioningUri',
          'recoveryCodes',
          'res.headers.set-cookie',
          'stripeSecretKey',
        ],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}
