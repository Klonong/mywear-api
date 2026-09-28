import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PHONE, POSTCODE } from '../account/dto';
import {
  DeliveryMethod,
  OrderStatus,
  PaymentMethod,
} from '../generated/prisma/enums';

export class CheckoutAddressDto {
  @IsString() @Length(1, 60) firstName!: string;
  @IsString() @Length(1, 60) lastName!: string;
  @IsString() @Length(3, 200) line1!: string;
  @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @IsString() @Length(2, 80) city!: string;
  @IsOptional() @IsString() @MaxLength(80) province?: string;
  @Matches(POSTCODE, { message: 'Enter a valid postcode, e.g. 12190' })
  postcode!: string;
}

/** Guest or member checkout (CHK-1/2). Send `address`, or `addressId` for a saved one when signed in. */
export class CheckoutDto {
  @IsEmail() email!: string;
  @Matches(PHONE, { message: 'Enter a phone number, e.g. 0812 3456 7890' })
  phone!: string;
  @IsEnum(DeliveryMethod) deliveryMethod!: DeliveryMethod;
  @IsEnum(PaymentMethod) paymentMethod!: PaymentMethod;
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutAddressDto)
  address?: CheckoutAddressDto;
  @IsOptional() @IsString() addressId?: string;
  /** Members: also save `address` to the address book */
  @IsOptional() @IsBoolean() saveAddress?: boolean;
}

export class PaymentEventDto {
  @IsString() orderNumber!: string;
  @IsIn(['paid', 'failed']) status!: 'paid' | 'failed';
  @IsInt() @Min(0) amount!: number;
  @IsOptional() @IsString() providerRef?: string;
}

export class MockPaymentDto {
  @IsOptional() @IsIn(['paid', 'failed']) status?: 'paid' | 'failed';
}

export class LookupDto {
  @IsString() @Length(4, 40) number!: string;
  @IsEmail() email!: string;
}

export class ReturnItemDto {
  @IsString() orderItemId!: string;
  @IsInt() @Min(1) qty!: number;
}

export class ReturnRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];
  @IsString() @Length(3, 500) reason!: string;
}

export class SetStatusDto {
  @IsEnum(OrderStatus) status!: OrderStatus;
}

export class ShipmentDto {
  @IsString() @Length(2, 40) courier!: string;
  @IsString() @Length(4, 60) trackingNumber!: string;
}

export class NoteDto {
  @IsString() @Length(1, 1000) body!: string;
}
