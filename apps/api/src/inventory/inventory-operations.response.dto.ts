import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class InventoryWarehouseDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
export class InventoryVariantDto {
  @ApiProperty() sku!: string;
  @ApiProperty() name!: string;
}
export class InventoryBalanceProjectionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() onHand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() allocated!: number;
  @ApiProperty() damaged!: number;
  @ApiProperty() lowStockThreshold!: number;
  @ApiProperty() available!: number;
  @ApiProperty() version!: number;
  @ApiProperty() warehouseCode!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() createdAt!: string;
}
export class InventoryBalanceAdjustmentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) balanceId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ example: '"inventory-2"' }) etag!: string;
  @ApiProperty() onHand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() allocated!: number;
  @ApiProperty() damaged!: number;
  @ApiProperty() available!: number;
}
export class InventoryThresholdResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) balanceId!: string;
  @ApiProperty() lowStockThreshold!: number;
  @ApiProperty() available!: number;
  @ApiProperty() version!: number;
  @ApiProperty({ example: '"inventory-2"' }) etag!: string;
}
export class InventoryTransferLineResponseDto {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) received!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) damaged!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) lost!: number | null;
  @ApiProperty({ type: InventoryVariantDto }) variant!: InventoryVariantDto;
}
export class InventoryTransferResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sourceWarehouseId!: string;
  @ApiProperty({ format: 'uuid' }) destinationWarehouseId!: string;
  @ApiProperty({ enum: ['REQUESTED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() reason!: string;
  @ApiProperty({ type: InventoryWarehouseDto }) sourceWarehouse!: InventoryWarehouseDto;
  @ApiProperty({ type: InventoryWarehouseDto }) destinationWarehouse!: InventoryWarehouseDto;
  @ApiProperty({ type: [InventoryTransferLineResponseDto] })
  lines!: InventoryTransferLineResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) dispatchedAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) receivedAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) cancelledAt!: string | null;
}
export class InventoryTransferCommandResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ example: '"transfer-1"' }) etag!: string;
  @ApiProperty({ type: InventoryTransferResponseDto }) transfer!: InventoryTransferResponseDto;
}
export class InventoryTransferPageDto {
  @ApiProperty({ type: [InventoryTransferResponseDto] }) items!: InventoryTransferResponseDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() pageScoped!: boolean;
}
export class InventoryLowStockPageDto {
  @ApiProperty({ type: [InventoryBalanceProjectionDto] }) items!: InventoryBalanceProjectionDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() pageScoped!: boolean;
}
export class InventoryBucketDto {
  @ApiProperty() onHand!: number;
  @ApiProperty() reserved!: number;
  @ApiProperty() allocated!: number;
  @ApiProperty() damaged!: number;
}
export class InventoryBusinessDto {
  @ApiProperty() reserved!: number;
  @ApiProperty() allocated!: number;
}
export class InventoryTransferExpectedDto {
  @ApiProperty() outbound!: number;
  @ApiProperty() inboundReceived!: number;
  @ApiProperty() inboundDamaged!: number;
  @ApiProperty() inboundLost!: number;
}
export class InventoryTransferActualDto {
  @ApiProperty() dispatched!: number;
  @ApiProperty() received!: number;
  @ApiProperty() damaged!: number;
}
export class InventoryTransferInTransitDto {
  @ApiProperty() sourceOutbound!: number;
  @ApiProperty() destinationInbound!: number;
}
export class InventoryMovementCoverageDto {
  @ApiProperty() invalidLineCount!: number;
  @ApiProperty() unlinkedMovementCount!: number;
  @ApiProperty() dispatchCount!: number;
  @ApiProperty() dispatchQuantity!: number;
  @ApiProperty() receiptCount!: number;
  @ApiProperty() receiptQuantity!: number;
  @ApiProperty() damageCount!: number;
  @ApiProperty() damageQuantity!: number;
}
export class InventoryTransferEvidenceDto {
  @ApiProperty({ type: InventoryTransferExpectedDto }) expected!: InventoryTransferExpectedDto;
  @ApiProperty({ type: InventoryTransferActualDto }) actual!: InventoryTransferActualDto;
  @ApiProperty({ type: InventoryTransferInTransitDto }) inTransit!: InventoryTransferInTransitDto;
  @ApiProperty({ type: InventoryMovementCoverageDto })
  movementCoverage!: InventoryMovementCoverageDto;
}
export class InventoryActualBalanceDto extends InventoryBucketDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
export class InventoryReconciliationItemDto {
  @ApiProperty({ format: 'uuid' }) balanceId!: string;
  @ApiProperty({ type: InventoryBucketDto }) ledger!: InventoryBucketDto;
  @ApiProperty({ type: InventoryBusinessDto }) business!: InventoryBusinessDto;
  @ApiProperty({ type: InventoryActualBalanceDto }) actual!: InventoryActualBalanceDto;
  @ApiProperty({ type: InventoryTransferEvidenceDto }) transfer!: InventoryTransferEvidenceDto;
  @ApiProperty({ type: [String] }) mismatchCategories!: string[];
  @ApiProperty() mismatch!: boolean;
}
export class InventoryReconciliationPageDto {
  @ApiProperty({ type: [InventoryReconciliationItemDto] }) items!: InventoryReconciliationItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() pageScoped!: boolean;
  @ApiProperty() scanned!: number;
  @ApiProperty() mismatchCount!: number;
  @ApiProperty() clean!: boolean;
}
export class InventoryProblemDetailsDto {
  @ApiProperty() type!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: number;
  @ApiProperty() detail!: string;
  @ApiProperty() instance!: string;
  @ApiProperty() code!: string;
  @ApiPropertyOptional({ type: Number }) currentVersion?: number;
  @ApiPropertyOptional({ type: [String] }) errors?: string[];
  @ApiProperty() requestId!: string;
}
