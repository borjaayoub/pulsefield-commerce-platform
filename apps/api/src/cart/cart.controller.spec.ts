import type { Request, Response } from 'express';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

describe('CartController', () => {
  it('returns the cart with an ETag and reissues the opaque cookie for valid activity', async () => {
    const service = {
      getCurrent: jest.fn().mockResolvedValue({
        cart: { revision: 1, items: [] },
        token: 'a'.repeat(43),
        createdCookie: false,
      }),
    } as unknown as CartService;
    const controller = new CartController(service, 'http://localhost:3000');
    const response = { setHeader: jest.fn(), cookie: jest.fn() } as unknown as Response;
    const request = { header: jest.fn().mockReturnValue(undefined) } as unknown as Request;

    await controller.get(request, response);

    expect(response.setHeader).toHaveBeenCalledWith('ETag', '"cart-1"');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.cookie).toHaveBeenCalledWith(
      'pulse_field_cart',
      'a'.repeat(43),
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/api/v1',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      }),
    );
  });
});
