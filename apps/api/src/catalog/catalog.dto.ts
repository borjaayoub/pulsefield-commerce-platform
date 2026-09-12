import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const CATALOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export enum CatalogSort {
  NEWEST = 'newest',
  NAME = 'name',
  PRICE_ASC = 'price-asc',
  PRICE_DESC = 'price-desc',
}

export enum CatalogAvailability {
  IN_STOCK = 'in-stock',
  OUT_OF_STOCK = 'out-of-stock',
}

export class CatalogQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 48, default: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  @IsOptional()
  pageSize = 12;

  @ApiPropertyOptional({
    maxLength: 80,
    description: 'Searches active product name and description.',
  })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ maxLength: 120, description: 'Active category slug.' })
  @IsString()
  @MaxLength(120)
  @Matches(CATALOG_SLUG_PATTERN)
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ enum: CatalogAvailability })
  @IsEnum(CatalogAvailability)
  @IsOptional()
  availability?: CatalogAvailability;

  @ApiPropertyOptional({ enum: CatalogSort, default: CatalogSort.NEWEST })
  @IsEnum(CatalogSort)
  @IsOptional()
  sort: CatalogSort = CatalogSort.NEWEST;
}

export class CatalogCategoryDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;
}

export class CatalogMediaDto {
  @ApiProperty()
  url!: string;

  @ApiProperty()
  altText!: string;

  @ApiProperty()
  width!: number;

  @ApiProperty()
  height!: number;
}

export class CatalogVariantDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: Object })
  optionValues!: Record<string, string>;

  @ApiProperty()
  priceMinor!: number;

  @ApiProperty({ example: 'USD' })
  currency!: 'USD';

  @ApiProperty()
  available!: number;

  @ApiProperty()
  inStock!: boolean;
}

export class CatalogProductDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: [CatalogCategoryDto] })
  categories!: CatalogCategoryDto[];

  @ApiProperty({ type: [CatalogMediaDto] })
  media!: CatalogMediaDto[];

  @ApiProperty({ type: [CatalogVariantDto] })
  variants!: CatalogVariantDto[];

  @ApiProperty()
  available!: number;

  @ApiProperty()
  inStock!: boolean;

  @ApiProperty({ example: 'USD' })
  currency!: 'USD';

  @ApiPropertyOptional({
    description: 'Present only when a product was requested by a historical slug.',
  })
  canonicalSlug?: string;
}

export class CatalogListDto {
  @ApiProperty({ type: [CatalogProductDto] })
  items!: CatalogProductDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  totalItems!: number;

  @ApiProperty()
  totalPages!: number;
}

export class CatalogRedirectDto {
  @ApiProperty({ example: 'urn:pulse-field:catalog:canonical-slug-redirect' })
  type!: string;

  @ApiProperty({ example: 'aero-tempo-tee' })
  canonicalSlug!: string;
}
