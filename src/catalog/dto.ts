import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Gender, ReviewFit } from '../generated/prisma/enums';

export class ProductQueryDto {
  @IsOptional() @IsEnum(Gender) gender?: Gender;
  /** Comma separated, e.g. `Tops,Outerwear` (names or slugs) */
  @IsOptional() @IsString() category?: string;
  /** Comma separated, e.g. `A/S,A/M`. Only sizes in stock match. */
  @IsOptional() @IsString() size?: string;
  @IsOptional() @IsString() colour?: string;
  /** `New`, `Sale`, `Limited` */
  @IsOptional() @IsString() badge?: string;
  /** First word of the fit, e.g. `Regular,Relaxed` */
  @IsOptional() @IsString() fit?: string;
  @IsOptional() @IsString() sport?: string;
  /** Comma separated product slugs, e.g. to show a signed-out wishlist */
  @IsOptional() @IsString() slugs?: string;
  @IsOptional() @IsInt() @Min(0) priceMin?: number;
  @IsOptional() @IsInt() @Min(0) priceMax?: number;
  @IsOptional() @IsString() @Length(1, 80) q?: string;
  @IsOptional()
  @IsIn(['recommended', 'newest', 'price-asc', 'price-desc', 'rating'])
  sort?: string;
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) limit?: number;
}

export class CategoryQueryDto {
  @IsOptional() @IsEnum(Gender) gender?: Gender;
}

export class SuggestQueryDto {
  @IsString() @Length(2, 80) q!: string;
}

export class ReviewQueryDto {
  @IsOptional() @IsIn(['newest', 'highest', 'lowest']) sort?: string;
  @IsOptional() @IsEnum(ReviewFit) fit?: ReviewFit;
  @IsOptional() @IsInt() @Min(1) page?: number;
}

export class CreateReviewDto {
  @IsInt() @Min(1) @Max(5) rating!: number;
  @IsEnum(ReviewFit) fit!: ReviewFit;
  @IsString() @Length(2, 80) title!: string;
  @IsString() @Length(10, 2000) body!: string;
}
