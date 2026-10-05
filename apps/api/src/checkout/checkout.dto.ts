import { ApiProperty } from '@nestjs/swagger';
import type { SupportedCurrency, InternationalMarketCode } from '@pulse-field/contracts';
import { CountryPostalCode, CountryState, SHIPPING_COUNTRIES } from './shipping-address.validation';
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

export class ShippingAddressDto {
  @ApiProperty({ example: 'Ayoub Example' }) @IsString() @Length(1, 120) fullName!: string;
  @ApiProperty({ example: '100 Market Street' }) @IsString() @Length(1, 160) line1!: string;
  @ApiProperty({ example: 'Suite 4', required: false }) @IsString() @Length(0, 160) line2?: string;
  @ApiProperty({ example: 'San Francisco' }) @IsString() @Length(1, 120) city!: string;
  @ApiProperty({
    example: 'CA',
    required: false,
    description: 'Required two-letter state for US; optional bounded area elsewhere.',
  })
  @CountryState()
  state?: string;
  @ApiProperty({ example: '94105' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @CountryPostalCode()
  postalCode!: string;
  @ApiProperty({ example: 'US' }) @IsIn(SHIPPING_COUNTRIES) countryCode!: string;
}

export class CheckoutPreviewDto {
  @ApiProperty({ type: ShippingAddressDto })
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress!: ShippingAddressDto;
}

export class CreateCheckoutDto extends CheckoutPreviewDto {
  @ApiProperty({ example: 'customer@example.test' })
  @IsEmail({ allow_display_name: false, require_tld: true })
  @Length(3, 255)
  customerEmail!: string;
  @ApiProperty() @IsString() @Length(16, 128) pricingFingerprint!: string;
  @ApiProperty({ enum: ['stub-success', 'stub-decline'], required: false })
  @IsOptional()
  @IsIn(['stub-success', 'stub-decline'])
  paymentMethodReference?: 'stub-success' | 'stub-decline';
}

export class CheckoutLineDto {
  @ApiProperty() variantId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPriceMinor!: number;
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() taxMinor!: number;
}

export class CheckoutPreviewResponseDto {
  @ApiProperty({ enum: ['stub', 'stripe'] })
  paymentProvider!: 'stub' | 'stripe';
  @ApiProperty({ enum: ['USD', 'MAD', 'EUR', 'GBP'] }) currency!: SupportedCurrency;
  @ApiProperty({ required: false }) market?: InternationalMarketCode;
  @ApiProperty({ required: false }) configurationId?: string;
  @ApiProperty({ required: false }) taxTreatment?: 'exclusive';
  @ApiProperty() policyVersion!: number;
  @ApiProperty({ type: [CheckoutLineDto] }) lines!: CheckoutLineDto[];
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() shippingMinor!: number;
  @ApiProperty() taxMinor!: number;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() pricingFingerprint!: string;
  @ApiProperty() taxNotice!: string;
}

export class StripePaymentConfigurationDto {
  @ApiProperty() publishableKey!: string;
  @ApiProperty() clientSecret!: string;
}

export class CheckoutResponseDto extends CheckoutPreviewResponseDto {
  @ApiProperty() orderId!: string;
  @ApiProperty() orderReference!: string;
  @ApiProperty({ enum: ['confirmed', 'payment_failed', 'pending_payment'] })
  checkoutStatus!: 'confirmed' | 'payment_failed' | 'pending_payment';
  @ApiProperty({ enum: ['pending_payment', 'confirmed'] })
  orderStatus!: 'pending_payment' | 'confirmed';
  @ApiProperty({ enum: ['requires_payment_method', 'processing', 'succeeded', 'failed'] })
  paymentStatus!: 'requires_payment_method' | 'processing' | 'succeeded' | 'failed';
  @ApiProperty({ required: false, type: () => StripePaymentConfigurationDto })
  paymentConfiguration?: StripePaymentConfigurationDto;
  @ApiProperty({ enum: ['active', 'committed', 'released', 'expired'] })
  reservationStatus!: 'active' | 'committed' | 'released' | 'expired';
  @ApiProperty({ enum: ['allocated', 'picking', 'packed', 'shipped', 'delivered'], nullable: true })
  fulfillmentStatus!: 'allocated' | 'picking' | 'packed' | 'shipped' | 'delivered' | null;
  @ApiProperty()
  reservationExpiresAt!: string;
  @ApiProperty({ description: 'Transient bearer credential for this order only.' })
  guestOrderAccessToken!: string;
  @ApiProperty()
  guestOrderAccessExpiresAt!: string;
}
