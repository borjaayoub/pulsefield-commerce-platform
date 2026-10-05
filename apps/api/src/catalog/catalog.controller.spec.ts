import type { Response } from 'express';
import type { CatalogListDto, CatalogProductDto, CatalogQueryDto } from './catalog.dto';
import { CatalogController } from './catalog.controller';
import type { CatalogService } from './catalog.service';

describe('CatalogController', () => {
  const list = jest.fn();
  const getBySlug = jest.fn();
  const controller = new CatalogController({ list, getBySlug } as unknown as CatalogService);

  beforeEach(() => jest.clearAllMocks());

  it('delegates bounded list queries to the catalog service', async () => {
    const result = {
      market: 'US',
      taxTreatment: 'exclusive',
      currency: 'USD',
      items: [],
      page: 1,
      pageSize: 12,
      totalItems: 0,
      totalPages: 0,
    } satisfies CatalogListDto;
    list.mockResolvedValue(result);

    await expect(controller.list({ page: 1, pageSize: 12 } as CatalogQueryDto)).resolves.toBe(
      result,
    );
    expect(list).toHaveBeenCalledWith({ page: 1, pageSize: 12 });
  });

  it('redirects historical slugs without exposing a second public resource', async () => {
    const product = { id: 'product', slug: 'canonical' } as CatalogProductDto;
    getBySlug.mockResolvedValue({ product, canonicalSlug: 'canonical' });
    const response = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await controller.detail('old-slug', response);

    expect(response.status).toHaveBeenCalledWith(301);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Location',
      '/api/v1/catalog/products/canonical',
    );
    expect(response.json).toHaveBeenCalledWith({
      type: 'urn:pulse-field:catalog:canonical-slug-redirect',
      canonicalSlug: 'canonical',
    });
  });

  it('preserves an explicitly selected market in the canonical slug redirect', async () => {
    getBySlug.mockResolvedValue({
      product: { id: 'product', slug: 'canonical' },
      canonicalSlug: 'canonical',
    });
    const response = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    await controller.detail('old-slug', response, { market: 'EU' });
    expect(getBySlug).toHaveBeenCalledWith('old-slug', 'EU');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Location',
      '/api/v1/catalog/products/canonical?market=EU',
    );
  });

  it('returns canonical detail data with a 200 response', async () => {
    const product = { id: 'product', slug: 'canonical' } as CatalogProductDto;
    getBySlug.mockResolvedValue({ product, canonicalSlug: 'canonical' });
    const response = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await controller.detail('canonical', response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(product);
  });
});
