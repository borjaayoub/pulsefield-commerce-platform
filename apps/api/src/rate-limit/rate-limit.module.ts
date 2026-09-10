import { DynamicModule, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './redis-throttler.storage';

export const IDENTITY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const REGISTRATION_RATE_LIMIT = 5;
export const EMAIL_VERIFICATION_RATE_LIMIT = 10;
export const EMAIL_VERIFICATION_REQUEST_IP_RATE_LIMIT = 10;
export const EMAIL_VERIFICATION_REQUEST_IDENTIFIER_RATE_LIMIT = 3;
export const PASSWORD_RECOVERY_REQUEST_IP_RATE_LIMIT = 10;
export const PASSWORD_RECOVERY_REQUEST_IDENTIFIER_RATE_LIMIT = 3;
export const PASSWORD_RESET_IP_RATE_LIMIT = 10;
export const LOGIN_IP_RATE_LIMIT = 20;
export const LOGIN_IDENTIFIER_RATE_LIMIT = 5;
export const MFA_IP_RATE_LIMIT = 20;
export const MFA_CHALLENGE_RATE_LIMIT = 5;

@Module({})
export class RateLimitModule {
  static forRoot(redisUrl: string): DynamicModule {
    const storage = new RedisThrottlerStorage(redisUrl);

    return {
      module: RateLimitModule,
      global: true,
      imports: [
        ThrottlerModule.forRoot({
          storage,
          throttlers: [
            {
              name: 'default',
              ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
              limit: EMAIL_VERIFICATION_RATE_LIMIT,
              blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
            },
            {
              name: 'loginIp',
              ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
              limit: LOGIN_IP_RATE_LIMIT,
              blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
            },
            {
              name: 'loginIdentifier',
              ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
              limit: LOGIN_IDENTIFIER_RATE_LIMIT,
              blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
            },
            {
              name: 'verificationRequestIdentifier',
              ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
              limit: EMAIL_VERIFICATION_REQUEST_IDENTIFIER_RATE_LIMIT,
              blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
            },
            {
              name: 'passwordRecoveryIdentifier',
              ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
              limit: PASSWORD_RECOVERY_REQUEST_IDENTIFIER_RATE_LIMIT,
              blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
            },
            {
              name: 'mfaChallenge',
              ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
              limit: MFA_CHALLENGE_RATE_LIMIT,
              blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
            },
          ],
        }),
      ],
      exports: [ThrottlerModule],
    };
  }
}
