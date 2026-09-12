import { DynamicModule, Global, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { AuditModule } from '../audit/audit.module';
import { IDEMPOTENCY_RETENTION_PROFILE } from './idempotency.constants';
import { IdempotencyRetentionScheduler } from './idempotency-retention.scheduler';
import { IdempotencyRetentionService } from './idempotency-retention.service';
import { IdempotencyService } from './idempotency.service';

@Global()
@Module({
  imports: [AuditModule],
})
export class IdempotencyModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: IdempotencyModule,
      providers: [
        { provide: IDEMPOTENCY_RETENTION_PROFILE, useValue: profile },
        IdempotencyService,
        IdempotencyRetentionService,
        IdempotencyRetentionScheduler,
      ],
      exports: [IdempotencyService, IdempotencyRetentionService],
    };
  }
}
