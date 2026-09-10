import { DynamicModule, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { AUDIT_RETENTION_PROFILE } from './audit.constants';
import { AuditRetentionScheduler } from './audit-retention.scheduler';
import { AuditService } from './audit.service';
import { AuditQueryService } from './audit-query.service';
import { AuditRetentionService } from './audit-retention.service';

@Module({
  providers: [AuditService, AuditQueryService, AuditRetentionService],
  exports: [AuditService, AuditQueryService, AuditRetentionService],
})
export class AuditModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: AuditModule,
      providers: [{ provide: AUDIT_RETENTION_PROFILE, useValue: profile }, AuditRetentionScheduler],
    };
  }
}
