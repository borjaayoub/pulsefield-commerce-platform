import { DynamicModule, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { AuditModule } from './audit/audit.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { IdentityModule } from './identity/identity.module';
import { MessagingModule } from './messaging/messaging.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';

@Module({})
export class AppModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot(profile.DATABASE_URL),
        AuditModule.forRoot(profile),
        ConfigurationModule,
        IdempotencyModule.forRoot(profile),
        RateLimitModule.forRoot(profile.EPHEMERAL_REDIS_URL),
        IdentityModule.forRoot(profile),
        MessagingModule.forRoot(profile),
      ],
      controllers: [HealthController],
    };
  }
}
