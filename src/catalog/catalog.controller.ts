import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, type AuthUser } from '../common/auth';
import { CatalogService } from './catalog.service';
import {
  CategoryQueryDto,
  CreateReviewDto,
  ProductQueryDto,
  ReviewQueryDto,
  SuggestQueryDto,
} from './dto';
import { ReviewsService } from './reviews.service';

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly reviews: ReviewsService,
  ) {}

  @Get('categories')
  categories(@Query() query: CategoryQueryDto) {
    return this.catalog.categories(query.gender);
  }

  /** PLP and search results: filters, sort, pagination and facet counts */
  @Get('products')
  products(@Query() query: ProductQueryDto) {
    return this.catalog.list(query);
  }

  @Get('products/:slug')
  product(@Param('slug') slug: string) {
    return this.catalog.detail(slug);
  }

  @Get('products/:slug/reviews')
  productReviews(@Param('slug') slug: string, @Query() query: ReviewQueryDto) {
    return this.reviews.list(slug, query);
  }

  @Auth()
  @Post('products/:slug/reviews')
  review(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviews.create(slug, user.id, dto);
  }

  @Get('search/suggest')
  suggest(@Query() query: SuggestQueryDto) {
    return this.catalog.suggest(query.q);
  }
}

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, ReviewsService],
  exports: [CatalogService],
})
export class CatalogModule {}
