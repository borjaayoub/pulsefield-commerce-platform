import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { IdentityModule } from '../identity/identity.module';
import { InventoryOperationsController } from './inventory-operations.controller';
import { InventoryOperationsReadController } from './inventory-operations-read.controller';
import { InventoryOperationsService } from './inventory-operations.service';
import type { LocalProfile } from '@pulse-field/foundation';
import { INVENTORY_OPERATIONS_CURSOR_KEY } from './inventory-operations.constants';
@Module({
  imports: [AuditModule, IdempotencyModule, IdentityModule],
  controllers: [InventoryOperationsController, InventoryOperationsReadController],
  providers: [InventoryOperationsService],
  exports: [InventoryOperationsService],
})
export class InventoryOperationsModule {
  static forRoot(profile: LocalProfile) {
    return {
      module: InventoryOperationsModule,
      imports: [AuditModule, IdempotencyModule, IdentityModule],
      controllers: [InventoryOperationsController, InventoryOperationsReadController],
      providers: [
        InventoryOperationsService,
        {
          provide: INVENTORY_OPERATIONS_CURSOR_KEY,
          useValue: profile.MESSAGE_ENCRYPTION_KEY_BASE64,
        },
      ],
      exports: [InventoryOperationsService],
    };
  }
}
