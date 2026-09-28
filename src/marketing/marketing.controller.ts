import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString } from 'class-validator';
import { available } from '../catalog/catalog.service';
import { randomToken, sha256 } from '../common/crypto';
import { MailService } from '../common/mail.service';
import { env } from '../config';
import { PrismaService } from '../prisma.service';

class StockAlertDto {
  @IsString() slug!: string;
  @IsString() color!: string;
  @IsString() size!: string;
  @IsEmail() email!: string;
}

class NewsletterDto {
  @IsEmail() email!: string;
}

class ConfirmDto {
  @IsString() token!: string;
}

@Injectable()
export class RestockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Emails everyone waiting on these SKUs once they have stock again. Call after any stock increase. */
  async notify(skuIds: string[]) {
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: skuIds } },
      include: {
        color: { include: { product: true } },
        alerts: { where: { notifiedAt: null } },
      },
    });
    for (const sku of skus.filter((s) => available(s) > 0 && s.alerts.length)) {
      const { product } = sku.color;
      for (const alert of sku.alerts) {
        await this.mail.send(
          alert.email,
          `${product.name} is back in ${sku.size}`,
          `${env.webOrigin}/product/${product.slug}?color=${encodeURIComponent(sku.color.name)}`,
        );
      }
      await this.prisma.stockAlert.updateMany({
        where: { skuId: sku.id, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
    }
  }
}

@ApiTags('marketing')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller()
export class MarketingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** "Notify me" for a sold-out size (PDP-10). */
  @HttpCode(204)
  @Post('stock-alerts')
  async stockAlert(@Body() dto: StockAlertDto) {
    const sku = await this.prisma.sku.findFirst({
      where: {
        size: dto.size,
        color: { name: dto.color, product: { slug: dto.slug } },
      },
    });
    if (!sku)
      throw new NotFoundException("That colour and size isn't available.");
    if (available(sku) > 0)
      throw new ConflictException(
        `${dto.size} is in stock now. Add it to your bag.`,
      );
    const email = dto.email.toLowerCase();
    await this.prisma.stockAlert.upsert({
      where: { skuId_email: { skuId: sku.id, email } },
      create: { skuId: sku.id, email },
      update: { notifiedAt: null },
    });
  }

  /** Newsletter sign-up with double opt-in (CNT-3). Always 204 so it doesn't reveal who subscribed. */
  @HttpCode(204)
  @Post('newsletter')
  async subscribe(@Body() dto: NewsletterDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.newsletterSubscriber.findUnique({
      where: { email },
    });
    if (existing?.confirmedAt) return;
    const token = randomToken();
    await this.prisma.newsletterSubscriber.upsert({
      where: { email },
      create: { email, tokenHash: sha256(token) },
      update: { tokenHash: sha256(token) },
    });
    await this.mail.send(
      email,
      'Confirm your MyWear newsletter sign-up',
      `${env.webOrigin}/newsletter/confirm?token=${token}`,
    );
  }

  @HttpCode(204)
  @Post('newsletter/confirm')
  async confirm(@Body() dto: ConfirmDto) {
    const { count } = await this.prisma.newsletterSubscriber.updateMany({
      where: { tokenHash: sha256(dto.token), confirmedAt: null },
      data: { confirmedAt: new Date() },
    });
    if (!count)
      throw new UnauthorizedException(
        'This link has expired or was already used.',
      );
  }
}

@Module({
  controllers: [MarketingController],
  providers: [RestockService],
  exports: [RestockService],
})
export class MarketingModule {}
