import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser, type AuthUser } from '../common/auth';
import { CartService } from './cart.service';
import { AddItemDto, PromoDto, SetQtyDto } from './dto';

/** The bag. Guests are tracked by an httpOnly cookie; send requests with credentials. */
@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@Req() req: Request, @CurrentUser() user?: AuthUser) {
    return this.cart.get(req, user);
  }

  @Post('items')
  add(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: AddItemDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.cart.add(req, res, user, dto);
  }

  @Patch('items/:id')
  setQty(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: SetQtyDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.cart.setQty(req, user, id, dto.qty);
  }

  @Delete('items/:id')
  remove(
    @Req() req: Request,
    @Param('id') id: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.cart.remove(req, user, id);
  }

  @Delete()
  clear(@Req() req: Request, @CurrentUser() user?: AuthUser) {
    return this.cart.clear(req, user);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('promo')
  applyPromo(
    @Req() req: Request,
    @Body() dto: PromoDto,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.cart.applyPromo(req, user, dto.code);
  }

  @Delete('promo')
  removePromo(@Req() req: Request, @CurrentUser() user?: AuthUser) {
    return this.cart.removePromo(req, user);
  }
}

@Module({
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
