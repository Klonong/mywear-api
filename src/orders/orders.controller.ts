import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CartModule } from '../cart/cart.controller';
import { Auth, CurrentUser, type AuthUser } from '../common/auth';
import { hmacSha256, safeEqual } from '../common/crypto';
import { env } from '../config';
import {
  CheckoutDto,
  LookupDto,
  MockPaymentDto,
  PaymentEventDto,
  ReturnRequestDto,
} from './dto';
import { OrdersService, toOrder } from './orders.service';

@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Places the order from the current bag and reserves stock for 15 minutes while payment completes. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout')
  checkout(
    @Req() req: Request,
    @Body() dto: CheckoutDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.orders.checkout(req, user, dto);
  }

  @ApiBearerAuth()
  @Auth()
  @Get('me/orders')
  mine(@CurrentUser() user: AuthUser) {
    return this.orders.mine(user.id);
  }

  @ApiBearerAuth()
  @Auth()
  @Get('me/orders/:number')
  async one(@CurrentUser() user: AuthUser, @Param('number') number: string) {
    return toOrder(await this.orders.byNumber(number, { userId: user.id }));
  }

  @ApiBearerAuth()
  @Auth()
  @Post('me/orders/:number/returns')
  requestReturn(
    @CurrentUser() user: AuthUser,
    @Param('number') number: string,
    @Body() dto: ReturnRequestDto,
  ) {
    return this.orders.requestReturn(user.id, number, dto);
  }

  /** Guest order status and the confirmation page: needs the order number and the email used at checkout. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('orders/lookup')
  lookup(@Query() query: LookupDto) {
    return this.orders.lookup(query.number, query.email);
  }
}

@ApiTags('payments')
@SkipThrottle()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Gateway callback. `X-MyWear-Signature` must be the hex HMAC-SHA256 of the raw body with PAYMENT_WEBHOOK_SECRET.
   */
  @HttpCode(200)
  @Post('webhook')
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-mywear-signature') signature: string | undefined,
    @Body() dto: PaymentEventDto,
  ) {
    const expected = hmacSha256(env.paymentWebhookSecret, req.rawBody ?? '');
    if (!signature || !safeEqual(signature, expected))
      throw new UnauthorizedException('Invalid signature');
    return this.orders.handlePayment(dto);
  }

  /** Development only: completes (or fails) the mock payment the way the gateway webhook would. */
  @HttpCode(200)
  @Post('mock/:number/confirm')
  async mockConfirm(
    @Param('number') number: string,
    @Body() dto: MockPaymentDto,
  ) {
    if (env.production) throw new NotFoundException();
    const order = await this.orders.byNumber(number);
    return this.orders.handlePayment({
      orderNumber: number,
      status: dto.status ?? 'paid',
      amount: order.total,
      providerRef: `mock_${Date.now()}`,
    });
  }
}

@Module({
  imports: [CartModule],
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
