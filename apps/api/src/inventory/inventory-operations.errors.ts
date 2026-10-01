import { BadRequestException, ConflictException } from '@nestjs/common';
export class InventoryOperationConflict extends ConflictException {
  readonly code: string;
  constructor(
    message = 'Inventory operation conflict.',
    code = 'INVENTORY_OPERATION_CONFLICT',
    readonly currentVersion?: number,
  ) {
    super(message);
    this.code = code;
  }
}
export class InventoryOperationInvalid extends BadRequestException {
  readonly code: string;
  constructor(message = 'Invalid inventory operation.', code = 'INVENTORY_OPERATION_INVALID') {
    super(message);
    this.code = code;
  }
}
