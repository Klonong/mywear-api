import { IsInt, IsString, Length, Max, Min } from 'class-validator';

export class AddItemDto {
  @IsString() slug!: string;
  /** Colour name, e.g. `Craft Khaki` */
  @IsString() color!: string;
  /** e.g. `A/M` */
  @IsString() size!: string;
  @IsInt() @Min(1) @Max(10) qty: number = 1;
}

export class SetQtyDto {
  @IsInt() @Min(1) @Max(10) qty!: number;
}

export class PromoDto {
  @IsString() @Length(1, 40) code!: string;
}
