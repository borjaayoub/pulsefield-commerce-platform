import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import {
  CatalogListDto,
  CatalogProductDto,
  CatalogQueryDto,
  CatalogRedirectDto,
} from './catalog.dto';
import { CatalogService } from './catalog.service';

@ApiTags('Catalog')
@Controller('catalog/products')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'List active US/USD storefront products.' })
  @ApiOkResponse({ type: CatalogListDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  async list(@Query() query: CatalogQueryDto): Promise<CatalogListDto> {
    return this.catalog.list(query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Read an active product by canonical or historical slug.' })
  @ApiOkResponse({ type: CatalogProductDto })
  @ApiResponse({
    status: 301,
    type: CatalogRedirectDto,
    description: 'Historical slug redirect to the canonical slug.',
  })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  async detail(@Param('slug') slug: string, @Res() response: Response): Promise<void> {
    const result = await this.catalog.getBySlug(slug);
    if (result.canonicalSlug !== slug) {
      response
        .status(301)
        .setHeader('Location', `/api/v1/catalog/products/${result.canonicalSlug}`)
        .json({
          type: 'urn:pulse-field:catalog:canonical-slug-redirect',
          canonicalSlug: result.canonicalSlug,
        });
      return;
    }
    response.status(200).json(result.product);
  }
}
