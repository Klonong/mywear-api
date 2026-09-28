import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import {
  SkipThrottle,
  ThrottlerGuard,
  ThrottlerModule,
} from '@nestjs/throttler';
import { AccountModule } from './account/account.controller';
import { AdminCatalogController } from './admin/catalog.controller';
import { AdminOperationsController } from './admin/operations.controller';
import { AuthModule } from './auth/auth.controller';
import { CartModule } from './cart/cart.controller';
import { CatalogModule } from './catalog/catalog.controller';
import { AuthGuard } from './common/auth';
import { MailModule } from './common/mail.service';
import { ACCESS_TOKEN_TTL, env } from './config';
import { MarketingModule } from './marketing/marketing.controller';
import { OrdersModule } from './orders/orders.controller';
import { PrismaModule, PrismaService } from './prisma.service';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}

@Module({
  imports: [
    PrismaModule,
    MailModule,
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: env.jwtSecret,
        signOptions: { expiresIn: ACCESS_TOKEN_TTL },
      }),
    }),
    // 120 requests a minute per IP by default; auth, promo, checkout and lookup routes are tighter
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    CatalogModule,
    AuthModule,
    AccountModule,
    CartModule,
    OrdersModule,
    MarketingModule,
  ],
  controllers: [
    HealthController,
    AdminCatalogController,
    AdminOperationsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
