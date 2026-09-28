import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { publicUser } from '../auth/auth.service';
import { CatalogModule } from '../catalog/catalog.controller';
import { productInclude, toProduct } from '../catalog/catalog.service';
import { Auth, CurrentUser, type AuthUser } from '../common/auth';
import { hashPassword, verifyPassword } from '../common/crypto';
import { PrismaService } from '../prisma.service';
import {
  AddressDto,
  ChangePasswordDto,
  DeleteAccountDto,
  MergeWishlistDto,
  UpdateProfileDto,
} from './dto';

class UpdateAddressDto extends PartialType(AddressDto) {}

@ApiTags('account')
@ApiBearerAuth()
@Auth()
@Controller('me')
export class AccountController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() user: AuthUser) {
    return publicUser(
      await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
  }

  @Patch()
  async update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return publicUser(
      await this.prisma.user.update({ where: { id: user.id }, data: dto }),
    );
  }

  @HttpCode(204)
  @Patch('password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    if (!(await verifyPassword(dto.currentPassword, me.passwordHash)))
      throw new UnauthorizedException('Your current password is incorrect.');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(dto.newPassword) },
    });
  }

  /** Account deletion on request (UU PDP). Orders are kept for accounting but unlinked from the account. */
  @HttpCode(204)
  @Delete()
  async deleteAccount(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeleteAccountDto,
  ) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    if (!(await verifyPassword(dto.password, me.passwordHash)))
      throw new UnauthorizedException('Your password is incorrect.');
    await this.prisma.user.delete({ where: { id: user.id } });
  }

  // Address book (ACC-4)

  @Get('addresses')
  addresses(@CurrentUser() user: AuthUser) {
    return this.prisma.address.findMany({
      where: { userId: user.id },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
  }

  @Post('addresses')
  async addAddress(@CurrentUser() user: AuthUser, @Body() dto: AddressDto) {
    const first =
      (await this.prisma.address.count({ where: { userId: user.id } })) === 0;
    const isDefault = first || !!dto.isDefault;
    return this.prisma.$transaction(async (tx) => {
      if (isDefault)
        await tx.address.updateMany({
          where: { userId: user.id },
          data: { isDefault: false },
        });
      return tx.address.create({
        data: { ...dto, isDefault, userId: user.id },
      });
    });
  }

  @Patch('addresses/:id')
  async updateAddress(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    await this.ownAddress(user.id, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault)
        await tx.address.updateMany({
          where: { userId: user.id },
          data: { isDefault: false },
        });
      return tx.address.update({ where: { id }, data: dto });
    });
  }

  @HttpCode(204)
  @Delete('addresses/:id')
  async deleteAddress(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const address = await this.ownAddress(user.id, id);
    await this.prisma.address.delete({ where: { id } });
    if (address.isDefault) {
      const next = await this.prisma.address.findFirst({
        where: { userId: user.id },
        orderBy: { id: 'asc' },
      });
      if (next)
        await this.prisma.address.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
    }
  }

  // Wishlist (ACC-7, PLP-8)

  @Get('wishlist')
  async wishlist(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.wishlistItem.findMany({
      where: { userId: user.id, product: { status: 'published' } },
      orderBy: { createdAt: 'desc' },
      include: { product: { include: productInclude } },
    });
    return rows.map((r) => toProduct(r.product));
  }

  @HttpCode(204)
  @Put('wishlist/:slug')
  async save(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: 'published' },
      select: { id: true },
    });
    if (!product) throw new NotFoundException("We can't find that product");
    await this.prisma.wishlistItem.upsert({
      where: { userId_productId: { userId: user.id, productId: product.id } },
      create: { userId: user.id, productId: product.id },
      update: {},
    });
  }

  @HttpCode(204)
  @Delete('wishlist/:slug')
  async unsave(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    await this.prisma.wishlistItem.deleteMany({
      where: { userId: user.id, product: { slug } },
    });
  }

  /** Folds a signed-out (localStorage) wishlist into the account after sign-in. Unknown slugs are skipped. */
  @Post('wishlist/merge')
  async merge(@CurrentUser() user: AuthUser, @Body() dto: MergeWishlistDto) {
    const products = await this.prisma.product.findMany({
      where: { slug: { in: dto.slugs }, status: 'published' },
      select: { id: true },
    });
    await this.prisma.wishlistItem.createMany({
      data: products.map((p) => ({ userId: user.id, productId: p.id })),
      skipDuplicates: true,
    });
    return this.wishlist(user);
  }

  private async ownAddress(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({
      where: { id, userId },
    });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }
}

@Module({ imports: [CatalogModule], controllers: [AccountController] })
export class AccountModule {}
