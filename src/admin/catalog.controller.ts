import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseArrayPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  available,
  productInclude,
  toProduct,
} from '../catalog/catalog.service';
import { Auth } from '../common/auth';
import { RestockService } from '../marketing/marketing.controller';
import { PrismaService } from '../prisma.service';
import {
  AdminProductQueryDto,
  CategoryDto,
  ColorDto,
  CreateProductDto,
  ImageDto,
  InventoryQueryDto,
  PromotionDto,
  SkuDto,
  UpdateCategoryDto,
  UpdateColorDto,
  UpdateProductDto,
  UpdatePromotionDto,
  UpdateSkuDto,
} from './dto';

const skuCode = (...parts: string[]) =>
  parts
    .join('-')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const colorData = (slug: string, c: ColorDto, sortOrder: number) => ({
  name: c.name,
  hex: c.hex,
  tone: c.tone,
  sortOrder,
  images: { create: c.images.map((im, i) => ({ ...im, sortOrder: i })) },
  skus: { create: c.skus.map((s) => skuData(slug, c.name, s)) },
});

const skuData = (slug: string, color: string, s: SkuDto) => ({
  size: s.size,
  sku: s.sku ?? skuCode(slug, color, s.size),
  price: s.price,
  salePrice: s.salePrice,
  stock: s.stock,
});

/** Catalogue, inventory, categories and promotions (ADM-2, 3, 4, 6). */
@ApiTags('admin: catalog')
@ApiBearerAuth()
@Auth('merchandiser')
@Controller('admin')
export class AdminCatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly restock: RestockService,
  ) {}

  @Get('products')
  async products(@Query() query: AdminProductQueryDto) {
    const rows = await this.prisma.product.findMany({
      where: {
        ...(query.status && { status: query.status }),
        ...(query.gender && { gender: query.gender }),
        ...(query.q && {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { slug: { contains: query.q } },
          ],
        }),
      },
      include: productInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((p) => ({ ...toProduct(p), status: p.status }));
  }

  @Get('products/:slug')
  async product(@Param('slug') slug: string) {
    const p = await this.prisma.product.findUnique({
      where: { slug },
      include: productInclude,
    });
    if (!p) throw new NotFoundException('Product not found');
    // raw colours/skus with ids so the admin UI can edit them
    return { ...toProduct(p), status: p.status, colorsDetail: p.colors };
  }

  @Post('products')
  async create(@Body() dto: CreateProductDto) {
    const { colors, categorySlug, ...fields } = dto;
    const categoryId = await this.categoryId(dto.gender, categorySlug);
    const p = await this.prisma.product.create({
      data: {
        ...fields,
        categoryId,
        voucherEligible: dto.voucherEligible ?? !dto.notice,
        colors: { create: colors.map((c, i) => colorData(dto.slug, c, i)) },
      },
      include: productInclude,
    });
    return { ...toProduct(p), status: p.status };
  }

  @Patch('products/:slug')
  async update(@Param('slug') slug: string, @Body() dto: UpdateProductDto) {
    const { categorySlug, ...fields } = dto;
    const current = await this.prisma.product.findUniqueOrThrow({
      where: { slug },
    });
    const categoryId = categorySlug
      ? await this.categoryId(dto.gender ?? current.gender, categorySlug)
      : undefined;
    const p = await this.prisma.product.update({
      where: { slug },
      data: { ...fields, ...(categoryId && { categoryId }) },
      include: productInclude,
    });
    return { ...toProduct(p), status: p.status };
  }

  /** Archive rather than delete: past orders keep pointing at the product's SKUs. */
  @HttpCode(204)
  @Delete('products/:slug')
  async archive(@Param('slug') slug: string) {
    await this.prisma.product.update({
      where: { slug },
      data: { status: 'archived' },
    });
  }

  @Post('products/:slug/colors')
  async addColor(@Param('slug') slug: string, @Body() dto: ColorDto) {
    const p = await this.prisma.product.findUniqueOrThrow({
      where: { slug },
      include: { _count: { select: { colors: true } } },
    });
    return this.prisma.productColor.create({
      data: { productId: p.id, ...colorData(slug, dto, p._count.colors) },
      include: { images: true, skus: true },
    });
  }

  @Patch('colors/:id')
  updateColor(@Param('id') id: string, @Body() dto: UpdateColorDto) {
    return this.prisma.productColor.update({ where: { id }, data: dto });
  }

  @HttpCode(204)
  @Delete('colors/:id')
  async deleteColor(@Param('id') id: string) {
    await this.prisma.productColor.delete({ where: { id } });
  }

  /** Replaces the colour's gallery; order in the array is the display order. */
  @Put('colors/:id/images')
  async setImages(
    @Param('id') id: string,
    @Body(new ParseArrayPipe({ items: ImageDto })) images: ImageDto[],
  ) {
    // ponytail: takes URLs; direct S3 upload (presigned PUT) comes with the admin UI
    await this.prisma.$transaction([
      this.prisma.productImage.deleteMany({ where: { colorId: id } }),
      this.prisma.productImage.createMany({
        data: images.map((im, i) => ({ ...im, colorId: id, sortOrder: i })),
      }),
    ]);
    return this.prisma.productImage.findMany({
      where: { colorId: id },
      orderBy: { sortOrder: 'asc' },
    });
  }

  @Post('colors/:id/skus')
  async addSku(@Param('id') id: string, @Body() dto: SkuDto) {
    const color = await this.prisma.productColor.findUniqueOrThrow({
      where: { id },
      include: { product: true },
    });
    return this.prisma.sku.create({
      data: { colorId: id, ...skuData(color.product.slug, color.name, dto) },
    });
  }

  /** Price and stock changes. Restocking a sold-out size emails its "Notify me" list. */
  @Patch('skus/:id')
  async updateSku(@Param('id') id: string, @Body() dto: UpdateSkuDto) {
    const sku = await this.prisma.sku.update({ where: { id }, data: dto });
    if (dto.stock !== undefined) await this.restock.notify([id]);
    return { ...sku, available: available(sku) };
  }

  // Inventory (ADM-4)

  @Get('inventory')
  async inventory(@Query() query: InventoryQueryDto) {
    const skus = await this.prisma.sku.findMany({
      include: { color: { include: { product: true } } },
      orderBy: { sku: 'asc' },
    });
    return skus
      .map((s) => ({
        id: s.id,
        sku: s.sku,
        product: s.color.product.name,
        slug: s.color.product.slug,
        color: s.color.name,
        size: s.size,
        stock: s.stock,
        reserved: s.reserved,
        available: available(s),
      }))
      .filter(
        (s) => query.lowStock === undefined || s.available <= query.lowStock,
      );
  }

  @Get('inventory.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="inventory.csv"')
  async inventoryCsv() {
    const rows = await this.inventory({});
    const cell = (v: string | number) =>
      /[",\n]/.test(String(v))
        ? `"${String(v).replaceAll('"', '""')}"`
        : String(v);
    return [
      'sku,product,color,size,stock,reserved,available',
      ...rows.map((r) =>
        [r.sku, r.product, r.color, r.size, r.stock, r.reserved, r.available]
          .map(cell)
          .join(','),
      ),
    ].join('\n');
  }

  /** Bulk stock update. Body is text/csv with `sku,stock` columns (a header row is optional). */
  @ApiConsumes('text/csv')
  @Post('inventory.csv')
  async importCsv(@Req() req: Request) {
    const text = typeof req.body === 'string' ? req.body : '';
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.split(',').map((c) => c.trim()))
      .filter(
        ([code, stock]) =>
          code && code.toLowerCase() !== 'sku' && stock !== undefined,
      );
    const bad = rows.filter(([, stock]) => !/^\d+$/.test(stock));
    if (!rows.length || bad.length)
      throw new UnprocessableEntityException(
        bad.length
          ? `Stock must be a whole number (rows for ${bad.map(([c]) => c).join(', ')}).`
          : 'No rows found. Send sku,stock lines.',
      );
    const known = await this.prisma.sku.findMany({
      where: { sku: { in: rows.map(([c]) => c) } },
      select: { id: true, sku: true },
    });
    const ids = new Map(known.map((k) => [k.sku, k.id]));
    const updates = rows.filter(([c]) => ids.has(c));
    await this.prisma.$transaction(
      updates.map(([c, stock]) =>
        this.prisma.sku.update({
          where: { sku: c },
          data: { stock: Number(stock) },
        }),
      ),
    );
    await this.restock.notify(updates.map(([c]) => ids.get(c)!));
    return {
      updated: updates.length,
      notFound: rows.filter(([c]) => !ids.has(c)).map(([c]) => c),
    };
  }

  // Categories (ADM-3)

  @Get('categories')
  categories() {
    return this.prisma.category.findMany({
      orderBy: [{ gender: 'asc' }, { sortOrder: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
  }

  @Post('categories')
  createCategory(@Body() dto: CategoryDto) {
    return this.prisma.category.create({ data: dto });
  }

  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  @HttpCode(204)
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    await this.prisma.category.delete({ where: { id } });
  }

  // Promotions (ADM-6)

  @Get('promotions')
  promotions() {
    return this.prisma.promotion.findMany({ orderBy: { createdAt: 'desc' } });
  }

  @Post('promotions')
  createPromotion(@Body() dto: PromotionDto) {
    return this.prisma.promotion.create({ data: dto });
  }

  @Patch('promotions/:id')
  updatePromotion(@Param('id') id: string, @Body() dto: UpdatePromotionDto) {
    return this.prisma.promotion.update({ where: { id }, data: dto });
  }

  @HttpCode(204)
  @Delete('promotions/:id')
  async deletePromotion(@Param('id') id: string) {
    await this.prisma.promotion.delete({ where: { id } });
  }

  private async categoryId(gender: CreateProductDto['gender'], slug: string) {
    const category = await this.prisma.category.findUnique({
      where: { gender_slug: { gender, slug } },
    });
    if (!category)
      throw new UnprocessableEntityException(
        `No ${gender} category "${slug}".`,
      );
    return category.id;
  }
}
