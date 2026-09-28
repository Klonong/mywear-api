import { OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  Badge,
  Gender,
  ProductStatus,
  PromotionType,
  ReviewStatus,
  Role,
} from '../generated/prisma/enums';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ImageDto {
  /** Absolute URL or a path on the storefront, e.g. /hero/sweater.webp */
  @IsString() @MaxLength(500) url!: string;
  @IsString() @Length(1, 200) alt!: string;
}

export class SkuDto {
  @IsString() @Length(1, 20) size!: string;
  /** Generated from slug-colour-size when omitted */
  @IsOptional() @IsString() @Length(3, 80) sku?: string;
  @IsInt() @Min(0) price!: number;
  @IsOptional() @IsInt() @Min(0) salePrice?: number;
  @IsInt() @Min(0) stock!: number;
}

export class ColorDto {
  @IsString() @Length(1, 40) name!: string;
  @IsHexColor() hex!: string;
  @IsHexColor() tone!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImageDto)
  images: ImageDto[] = [];
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SkuDto)
  skus!: SkuDto[];
}

export class CreateProductDto {
  @Matches(SLUG, { message: 'Use lowercase words joined by hyphens' })
  slug!: string;
  @IsString() @Length(2, 120) name!: string;
  @IsString() @Length(2, 2000) description!: string;
  @IsEnum(Gender) gender!: Gender;
  @Matches(SLUG) categorySlug!: string;
  @IsString() @Length(2, 40) sport!: string;
  @IsString() @Length(2, 300) material!: string;
  @IsString() @Length(2, 200) fit!: string;
  @IsOptional() @IsEnum(Badge) badge?: Badge | null;
  /** e.g. "Excluded from vouchers & coupons" */
  @IsOptional() @IsString() @MaxLength(120) notice?: string | null;
  @IsOptional() @IsBoolean() voucherEligible?: boolean;
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ColorDto)
  colors!: ColorDto[];
}

export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['slug', 'colors'] as const),
) {}

export class UpdateColorDto extends PartialType(
  OmitType(ColorDto, ['images', 'skus'] as const),
) {
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateSkuDto extends PartialType(
  OmitType(SkuDto, ['size', 'sku'] as const),
) {}

export class AdminProductQueryDto {
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @IsOptional() @IsEnum(Gender) gender?: Gender;
  @IsOptional() @IsString() q?: string;
}

export class InventoryQueryDto {
  /** Only SKUs with at most this many available */
  @IsOptional() @IsInt() @Min(0) lowStock?: number;
}

export class CategoryDto {
  @IsEnum(Gender) gender!: Gender;
  @IsString() @Length(1, 60) name!: string;
  @Matches(SLUG) slug!: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsString() parentId?: string | null;
}

export class UpdateCategoryDto extends PartialType(CategoryDto) {}

export class PromotionDto {
  @Matches(/^[A-Z0-9_-]{3,40}$/, {
    message: 'Use 3 to 40 capital letters, digits, - or _',
  })
  code!: string;
  @IsEnum(PromotionType) type!: PromotionType;
  /** percent: 10 = 10%. fixed: IDR. free_delivery: ignored */
  @IsInt() @Min(0) value: number = 0;
  @IsOptional() @IsInt() @Min(0) minSpend?: number;
  @IsOptional() @Type(() => Date) @IsDate() startsAt?: Date | null;
  @IsOptional() @Type(() => Date) @IsDate() endsAt?: Date | null;
  @IsOptional() @IsInt() @Min(1) usageLimit?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdatePromotionDto extends PartialType(PromotionDto) {}

export class AdminOrderQueryDto {
  @IsOptional() @IsString() status?: string;
  /** Order number or email contains */
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsInt() @Min(1) page?: number;
}

export class ModerateReviewDto {
  @IsEnum(ReviewStatus) status!: ReviewStatus;
}

export class ReviewQueryDto {
  @IsOptional() @IsEnum(ReviewStatus) status?: ReviewStatus;
}

export class UserQueryDto {
  @IsOptional() @IsString() q?: string;
}

export class RoleDto {
  @IsEnum(Role) role!: Role;
}

export class StatsQueryDto {
  @IsOptional() @IsInt() @Min(1) @Max(365) days?: number;
}
