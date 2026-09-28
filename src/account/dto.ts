import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Gender } from '../generated/prisma/enums';

export const PHONE = /^[0-9 +]{9,16}$/;
export const POSTCODE = /^\d{5}$/;

export class UpdateProfileDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional()
  @Matches(PHONE, { message: 'Enter a phone number, e.g. 0812 3456 7890' })
  phone?: string;
  @IsOptional() @Type(() => Date) @IsDate() birthday?: Date;
  @IsOptional() @IsEnum(Gender) preferredGender?: Gender;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(128) currentPassword!: string;
  @IsString()
  @Length(8, 128, { message: 'Use at least 8 characters' })
  newPassword!: string;
}

export class DeleteAccountDto {
  @IsString() @MaxLength(128) password!: string;
}

export class AddressDto {
  @IsString() @Length(1, 120) recipient!: string;
  @Matches(PHONE, { message: 'Enter a phone number, e.g. 0812 3456 7890' })
  phone!: string;
  @IsString() @Length(3, 200) line1!: string;
  @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @IsString() @Length(2, 80) city!: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  @Matches(POSTCODE, { message: 'Enter a valid postcode, e.g. 12190' })
  postcode!: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class MergeWishlistDto {
  /** Product slugs saved locally while signed out */
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) slugs!: string[];
}
