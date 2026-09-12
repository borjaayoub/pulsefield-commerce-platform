import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { FulfillmentGroupStatus } from '../generated/prisma/enums';

export const FULFILLMENT_TARGET_STATUSES = [
  FulfillmentGroupStatus.PICKING,
  FulfillmentGroupStatus.PACKED,
  FulfillmentGroupStatus.SHIPPED,
  FulfillmentGroupStatus.DELIVERED,
] as const;

const ASCII_PRINTABLE_PATTERN = /^[\x21-\x7E]+$/u;

export class FulfillmentTransitionDto {
  @ApiProperty({ enum: FULFILLMENT_TARGET_STATUSES })
  @IsIn(FULFILLMENT_TARGET_STATUSES)
  targetStatus!: (typeof FULFILLMENT_TARGET_STATUSES)[number];

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason!: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 32, pattern: ASCII_PRINTABLE_PATTERN.source })
  @IsOptional()
  @IsString()
  @Length(2, 32)
  @Matches(ASCII_PRINTABLE_PATTERN)
  carrierCode?: string;

  @ApiPropertyOptional({ minLength: 6, maxLength: 64, pattern: ASCII_PRINTABLE_PATTERN.source })
  @IsOptional()
  @IsString()
  @Length(6, 64)
  @Matches(ASCII_PRINTABLE_PATTERN)
  trackingReference?: string;
}

export class FulfillmentGroupDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  orderId!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ enum: FulfillmentGroupStatus })
  status!: FulfillmentGroupStatus;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  pickingStartedAt!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  packedAt!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  shippedAt!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  deliveredAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  carrierCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  trackingReference!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
