import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { InternationalMarketCode, SupportedCurrency } from '@pulse-field/contracts';
import { SHOPPING_MARKETS } from '../checkout/shopping-configuration.service';
import { IsIn, Matches, IsInt, Max, Min } from 'class-validator';

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
  @ApiProperty({ example: 'USD' }) currency!: SupportedCurrency;
  @ApiProperty() available!: number;
  @ApiProperty() purchasable!: boolean;
  @ApiPropertyOptional({ nullable: true }) media!: CartItemMediaDto | null;
}

export class CartItemMediaDto {
  @ApiProperty() url!: string;
  @ApiProperty() altText!: string;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

export class CartDto {
  @ApiProperty({ enum: SHOPPING_MARKETS }) market!: InternationalMarketCode;
  @ApiProperty({ enum: ['exclusive'] }) taxTreatment!: 'exclusive';
  @ApiProperty() revision!: number;
  @ApiProperty({ example: 'USD' }) currency!: SupportedCurrency;
  @ApiPropertyOptional({ nullable: true }) subtotalMinor!: number | null;
  @ApiPropertyOptional({ nullable: true }) totalMinor!: number | null;
  @ApiProperty() hasUnavailableItems!: boolean;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ type: [CartItemDto] }) items!: CartItemDto[];
}

export class PreviewCartMarketDto {
  @ApiProperty({ enum: SHOPPING_MARKETS })
  @IsIn(SHOPPING_MARKETS)
  market!: InternationalMarketCode;
}
export class ConfirmCartMarketDto extends PreviewCartMarketDto {
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' })
  @Matches(/^[a-f0-9]{64}$/u)
  pricingFingerprint!: string;
}
export class CartMarketPreviewDto {
  @ApiProperty({ type: CartDto }) cart!: CartDto;
  @ApiProperty() pricingFingerprint!: string;
}
