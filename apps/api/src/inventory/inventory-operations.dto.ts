import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class InventoryAdjustmentDto {
  @ApiProperty({ minimum: -1000000, maximum: 1000000 })
  @IsInt()
  @Min(-1000000)
  @Max(1000000)
  onHandDelta!: number;
  @ApiProperty({ minimum: -1000000, maximum: 1000000 })
  @IsInt()
  @Min(-1000000)
  @Max(1000000)
  damagedDelta!: number;
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}

export class InventoryThresholdDto {
  @ApiProperty({ minimum: 0, maximum: 1000000 })
  @IsInt()
  @Min(0)
  @Max(1000000)
  lowStockThreshold!: number;
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}

export class InventoryTransferLineDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID()
  variantId!: string;
  @ApiProperty({ minimum: 1, maximum: 1000000 }) @IsInt() @Min(1) @Max(1000000) quantity!: number;
}

export class CreateInventoryTransferDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID()
  sourceWarehouseId!: string;
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID()
  destinationWarehouseId!: string;
  @ApiProperty({ type: [InventoryTransferLineDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => InventoryTransferLineDto)
  lines!: InventoryTransferLineDto[];
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}

export class ReceiveInventoryTransferLineDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID()
  variantId!: string;
  @ApiProperty({ minimum: 0, maximum: 1000000 }) @IsInt() @Min(0) @Max(1000000) received!: number;
  @ApiProperty({ minimum: 0, maximum: 1000000 }) @IsInt() @Min(0) @Max(1000000) damaged!: number;
  @ApiProperty({ minimum: 0, maximum: 1000000 }) @IsInt() @Min(0) @Max(1000000) lost!: number;
}

export class InventoryOperationsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize = 25;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsString()
  @Length(1, 512)
  @IsOptional()
  cursor?: string;
  @ApiPropertyOptional({ maxLength: 64 }) @IsString() @Length(1, 64) @IsOptional() sku?: string;
  @ApiPropertyOptional({ maxLength: 64 })
  @IsString()
  @Length(1, 64)
  @IsOptional()
  warehouseCode?: string;
}

export class InventoryTransferTransitionDto {
  @ApiProperty({ enum: ['IN_TRANSIT', 'RECEIVED', 'CANCELLED'] })
  @IsString()
  @IsIn(['IN_TRANSIT', 'RECEIVED', 'CANCELLED'])
  targetStatus!: 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
  @ApiPropertyOptional({ type: [ReceiveInventoryTransferLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReceiveInventoryTransferLineDto)
  lines?: ReceiveInventoryTransferLineDto[];
}
