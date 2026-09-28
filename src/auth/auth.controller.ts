import {
  Body,
  Controller,
  HttpCode,
  Module,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CartModule } from '../cart/cart.controller';
import { CartService } from '../cart/cart.service';
import {
  CART_COOKIE,
  cartCookie,
  REFRESH_COOKIE,
  refreshCookie,
} from '../common/cookies';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto';

/**
 * Returns `{ accessToken, user }`; send the token as `Authorization: Bearer`. The refresh token rides in an
 * httpOnly cookie scoped to /api/auth, so call /auth/refresh with credentials when the access token expires.
 */
@ApiTags('auth')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cart: CartService,
  ) {}

  @Post('register')
  async register(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: RegisterDto,
  ) {
    return this.signedIn(req, res, await this.auth.register(dto));
  }

  @HttpCode(200)
  @Post('login')
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LoginDto,
  ) {
    return this.signedIn(req, res, await this.auth.login(dto));
  }

  @HttpCode(200)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, ...rest } = await this.auth.refresh(
      req.cookies?.[REFRESH_COOKIE] as string | undefined,
    );
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookie());
    return rest;
  }

  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookie(), maxAge: undefined });
  }

  @HttpCode(204)
  @Post('forgot-password')
  forgot(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @HttpCode(204)
  @Post('reset-password')
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  /** Sets the refresh cookie and folds any guest bag into the member's bag. */
  private async signedIn(
    req: Request,
    res: Response,
    result: Awaited<ReturnType<AuthService['login']>>,
  ) {
    const { refreshToken, ...rest } = result;
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookie());
    const guestCart = req.cookies?.[CART_COOKIE] as string | undefined;
    if (guestCart) {
      await this.cart.mergeGuest(guestCart, rest.user.id);
      res.clearCookie(CART_COOKIE, { ...cartCookie(), maxAge: undefined });
    }
    return rest;
  }
}

@Module({
  imports: [CartModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
