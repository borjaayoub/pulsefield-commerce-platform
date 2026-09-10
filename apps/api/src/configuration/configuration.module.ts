import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FoundationConfigurationService } from './foundation-configuration.service';

@Module({
  imports: [AuditModule],
  providers: [FoundationConfigurationService],
  exports: [FoundationConfigurationService],
})
export class ConfigurationModule {}
