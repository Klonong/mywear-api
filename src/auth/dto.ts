import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString() @Length(1, 80) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsString()
  @Length(8, 128, { message: 'Use at least 8 characters' })
  password!: string;
}

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MaxLength(128) password!: string;
}

export class ForgotPasswordDto {
  @IsEmail() email!: string;
}

export class ResetPasswordDto {
  @IsString() token!: string;
  @IsString()
  @Length(8, 128, { message: 'Use at least 8 characters' })
  password!: string;
}
