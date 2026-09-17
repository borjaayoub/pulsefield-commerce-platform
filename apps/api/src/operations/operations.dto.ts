import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  FulfillmentGroupStatus,
  OrderStatus,
  PaymentCompensationStatus,
  PaymentAttemptStatus,
  ReservationStatus,
} from '../generated/prisma/enums';

export class OperationsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize = 25;

  @ApiPropertyOptional({ description: 'Opaque cursor returned by the same resource.' })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  @IsOptional()
  sku?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  @IsOptional()
  warehouseCode?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ enum: ReservationStatus })
  @IsEnum(ReservationStatus)
  @IsOptional()
  reservationStatus?: ReservationStatus;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  @IsOptional()
  orderStatus?: OrderStatus;

  @ApiPropertyOptional({ enum: PaymentAttemptStatus })
  @IsEnum(PaymentAttemptStatus)
  @IsOptional()
  paymentStatus?: PaymentAttemptStatus;

  @ApiPropertyOptional({ enum: FulfillmentGroupStatus })
  @IsEnum(FulfillmentGroupStatus)
  @IsOptional()
  fulfillmentStatus?: FulfillmentGroupStatus;
}

export enum ReconciliationAttentionCategory {
  NONE = 'NONE',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  PAYMENT_PROCESSING = 'PAYMENT_PROCESSING',
  MANUAL_RESOLUTION = 'MANUAL_RESOLUTION',
  COMPENSATION_REQUIRED = 'COMPENSATION_REQUIRED',
  COMPENSATION_PROCESSING = 'COMPENSATION_PROCESSING',
  COMPENSATION_FAILED = 'COMPENSATION_FAILED',
  COMPENSATED = 'COMPENSATED',
}

export class ReconciliationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize = 25;

  @ApiPropertyOptional({ description: 'Opaque cursor returned by this resource.' })
  @IsString()
  @MaxLength(512)
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ enum: PaymentAttemptStatus })
  @IsEnum(PaymentAttemptStatus)
  @IsOptional()
  paymentStatus?: PaymentAttemptStatus;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  @IsOptional()
  orderStatus?: OrderStatus;

  @ApiPropertyOptional({ enum: PaymentCompensationStatus })
  @IsEnum(PaymentCompensationStatus)
  @IsOptional()
  compensationStatus?: PaymentCompensationStatus;

  @ApiPropertyOptional({ enum: ReconciliationAttentionCategory })
  @IsEnum(ReconciliationAttentionCategory)
  @IsOptional()
  attentionCategory?: ReconciliationAttentionCategory;
}

export class OperationsPageDto {
  @ApiProperty({ type: [Object] })
  items!: unknown[];

  @ApiPropertyOptional({ nullable: true })
  nextCursor!: string | null;
}

export class OperationsCatalogItemDto {
  id!: string;
  name!: string;
  status!: string;
  variants!: Array<{ id: string; sku: string; name: string; priceMinor: number; currency: 'USD' }>;
}

export class OperationsInventoryItemDto {
  id!: string;
  warehouseCode!: string;
  sku!: string;
  onHand!: number;
  reserved!: number;
  allocated!: number;
  damaged!: number;
  available!: number;
  version!: number;
}

export class OperationsReservationItemDto {
  id!: string;
  status!: ReservationStatus;
  expiresAt!: string;
  orderReference!: string | null;
  items!: Array<{ sku: string; quantity: number; warehouseCode: string }>;
  createdAt!: string;
}

export class OperationsOrderItemDto {
  id!: string;
  reference!: string;
  status!: OrderStatus;
  currency!: string;
  subtotalMinor!: number;
  shippingMinor!: number;
  taxMinor!: number;
  totalMinor!: number;
  destination!: { city: string; state: string; countryCode: string };
  lines!: Array<{ sku: string; productName: string; quantity: number; unitPriceMinor: number }>;
  createdAt!: string;
  updatedAt!: string;
}

export class OperationsPaymentItemDto {
  id!: string;
  orderReference!: string;
  status!: PaymentAttemptStatus;
  amountMinor!: number;
  currency!: string;
  failureCode!: string | null;
  createdAt!: string;
}

export class OperationsReconciliationItemDto {
  id!: string;
  orderReference!: string;
  orderStatus!: OrderStatus;
  paymentStatus!: PaymentAttemptStatus;
  provider!: 'STRIPE' | 'STUB';
  providerPaymentReference!: string | null;
  failureCode!: string | null;
  amountMinor!: number;
  currency!: string;
  attentionCategory!: ReconciliationAttentionCategory;
  compensation!: {
    reason: string;
    status: PaymentCompensationStatus;
    failureCode: string | null;
    providerReference: string | null;
  } | null;
  createdAt!: string;
  updatedAt!: string;
}

export class OperationsFulfillmentItemDto {
  id!: string;
  orderReference!: string;
  warehouseCode!: string;
  status!: FulfillmentGroupStatus;
  version!: number;
  trackingReference!: string | null;
  createdAt!: string;
  updatedAt!: string;
  pickingStartedAt!: string | null;
  packedAt!: string | null;
  shippedAt!: string | null;
  deliveredAt!: string | null;
}

export class OperationsAuditItemDto {
  id!: string;
  action!: string;
  targetType!: string;
  targetId!: string;
  actorId!: string;
  reason!: string;
  occurredAt!: string;
}
