import type { SupportedCurrency } from '@pulse-field/contracts';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrderTimelineLineDto {
  @ApiProperty() productName!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPriceMinor!: number;
  @ApiProperty() lineTotalMinor!: number;
}

export class OrderTimelineEventDto {
  @ApiProperty({
    enum: [
      'order_placed',
      'payment_pending',
      'payment_confirmed',
      'payment_failed',
      'payment_refunded',
      'inventory_reserved',
      'inventory_released',
      'fulfillment_allocated',
      'picking',
      'packed',
      'shipped',
      'delivered',
      'attention_required',
    ],
  })
  type!: string;
  @ApiProperty() occurredAt!: string;
  @ApiProperty() label!: string;
}

export class OrderTimelineShipmentItemDto {
  @ApiProperty() productName!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty({ minimum: 1 }) quantity!: number;
}

export class OrderTimelineShipmentDto {
  @ApiProperty({ minimum: 1 }) ordinal!: number;
  @ApiProperty({ minimum: 1 }) total!: number;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [OrderTimelineShipmentItemDto] }) items!: OrderTimelineShipmentItemDto[];
  @ApiPropertyOptional({ nullable: true }) carrierCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingReference!: string | null;
}

export class OrderTimelineDto {
  @ApiProperty() orderReference!: string;
  @ApiProperty() status!: string;
  @ApiProperty({
    enum: ['PREPARING', 'PARTIALLY_SHIPPED', 'SHIPPED', 'PARTIALLY_DELIVERED', 'DELIVERED'],
  })
  fulfillmentProgress!: string;
  @ApiProperty() currency!: SupportedCurrency;
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() shippingMinor!: number;
  @ApiProperty() taxMinor!: number;
  @ApiProperty() totalMinor!: number;
  @ApiProperty({ type: [OrderTimelineLineDto] }) lines!: OrderTimelineLineDto[];
  @ApiProperty({ type: [OrderTimelineEventDto] }) events!: OrderTimelineEventDto[];
  @ApiProperty({ type: [OrderTimelineShipmentDto] }) shipments!: OrderTimelineShipmentDto[];
  @ApiProperty() accessExpiresAt!: string;
}
