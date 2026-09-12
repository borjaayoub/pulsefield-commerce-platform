import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class SetCartItemDto {
  @ApiProperty({ minimum: 1, maximum: 99, example: 2 })
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}

export class CartItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() productId!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() variantId!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: Object }) optionValues!: Record<string, string>;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional({ nullable: true }) currentUnitPriceMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) currentLinePriceMinor!: number | null;
  @ApiProperty({ example: 'USD' }) currency!: 'USD';
  @ApiProperty() available!: number;
  @ApiProperty() purchasable!: boolean;
}

export class CartDto {
  @ApiProperty() revision!: number;
  @ApiProperty({ example: 'USD' }) currency!: 'USD';
  @ApiPropertyOptional({ nullable: true }) subtotalMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) totalMinor!: number | null;
  @ApiProperty() hasUnavailableItems!: boolean;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ type: [CartItemDto] }) items!: CartItemDto[];
}
