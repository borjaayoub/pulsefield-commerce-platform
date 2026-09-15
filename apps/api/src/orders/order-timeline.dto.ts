import { ApiProperty } from '@nestjs/swagger';

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

export class OrderTimelineDto {
  @ApiProperty() orderReference!: string;
  @ApiProperty() status!: string;
  @ApiProperty() currency!: 'USD';
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() shippingMinor!: number;
  @ApiProperty() taxMinor!: number;
  @ApiProperty() totalMinor!: number;
  @ApiProperty({ type: [OrderTimelineLineDto] }) lines!: OrderTimelineLineDto[];
  @ApiProperty({ type: [OrderTimelineEventDto] }) events!: OrderTimelineEventDto[];
  @ApiProperty() accessExpiresAt!: string;
}
