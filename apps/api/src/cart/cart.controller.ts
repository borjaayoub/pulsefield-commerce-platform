import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { BrowserRequestGuard } from '../identity/browser-request.guard';
import { IDENTITY_WEB_ORIGIN } from '../identity/identity.constants';
import { IdentityThrottlerGuard } from '../rate-limit/identity-throttler.guard';
import {
  CART_MUTATION_RATE_LIMIT,
  CART_REQUEST_RATE_LIMIT,
  IDENTITY_RATE_LIMIT_WINDOW_MS,
} from '../rate-limit/rate-limit.module';
import { digestCartToken, readCartToken } from './cart-cookie';
import { CartRequestValidationError } from './cart.errors';
import { setCartCookie } from './cart-cookie';
import {
  CartDto,
  SetCartItemDto,
  PreviewCartMarketDto,
  ConfirmCartMarketDto,
  CartMarketPreviewDto,
} from './cart.dto';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { CartService } from './cart.service';

function parseRevision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^"cart-([1-9][0-9]*)"$/u.exec(value);
  if (!match) throw new CartRequestValidationError();
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new CartRequestValidationError();
  return revision;
}

const MARKET_MUTATION_THROTTLE = {
  cartMutation: {
    limit: CART_MUTATION_RATE_LIMIT,
    ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
    blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    getTracker: async (request: Record<string, unknown>) => {
      const socket = request.socket as { remoteAddress?: string } | undefined;
      const token = readCartToken(request as unknown as Request);
      return `${socket?.remoteAddress ?? 'unknown'}:${token ? digestCartToken(token) : 'absent'}`;
    },
    generateKey: (_context: unknown, tracker: string, name: string) => `cart-${name}-${tracker}`,
  },
};

@ApiTags('Cart')
@Controller('cart')
@UseGuards(IdentityThrottlerGuard)
@SkipThrottle({
  default: true,
  loginIp: true,
  loginIdentifier: true,
  verificationRequestIdentifier: true,
  passwordRecoveryIdentifier: true,
  passwordRecoveryIp: true,
  passwordResetIp: true,
  mfaChallenge: true,
})
@Throttle({
  cartAll: {
    limit: CART_REQUEST_RATE_LIMIT,
    ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
    blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    getTracker: async (request: Record<string, unknown>) => {
      const socket = request.socket as { remoteAddress?: string } | undefined;
      return socket?.remoteAddress ?? 'unknown';
    },
    generateKey: (_context, tracker, name) => `cart-${name}-${tracker}`,
  },
})
export class CartController {
  constructor(
    private readonly carts: CartService,
    @Inject(IDENTITY_WEB_ORIGIN) private readonly webOrigin: string,
  ) {}

  @Post('market-preview')
  @UseGuards(BrowserRequestGuard)
  @Throttle(MARKET_MUTATION_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CartMarketPreviewDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 428, type: ProblemDetailsDto })
  @ApiResponse({ status: 409, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async previewMarket(
    @Body() body: PreviewCartMarketDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartMarketPreviewDto> {
    const result = await this.carts.previewMarket(
      readCartToken(request),
      body.market,
      parseRevision(ifMatch),
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('ETag', `"cart-${result.cart.revision}"`);
    return { cart: result.cart, pricingFingerprint: result.pricingFingerprint };
  }

  @Put('market')
  @UseGuards(BrowserRequestGuard)
  @Throttle(MARKET_MUTATION_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CartDto })
  @ApiResponse({ status: 400, type: ProblemDetailsDto })
  @ApiResponse({ status: 428, type: ProblemDetailsDto })
  @ApiResponse({ status: 409, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async confirmMarket(
    @Body() body: ConfirmCartMarketDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartDto> {
    const result = await this.carts.confirmMarket(
      readCartToken(request),
      body.market,
      body.pricingFingerprint,
      parseRevision(ifMatch),
    );
    this.finish(response, result.token, result.cart.revision);
    return result.cart;
  }

  @Get()
  @ApiOperation({ summary: 'Read the current anonymous cart.' })
  @ApiOkResponse({ type: CartDto })
  @ApiResponse({
    status: 429,
    description: 'Cart request rate limit exceeded.',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Cart request protection is unavailable.',
    type: ProblemDetailsDto,
  })
  async get(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartDto> {
    const result = await this.carts.getCurrent(readCartToken(request));
    this.finish(response, result.token, result.cart.revision);
    return result.cart;
  }

  @Put('items/:variantId')
  @UseGuards(BrowserRequestGuard)
  @Throttle({
    cartMutation: {
      limit: CART_MUTATION_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
      getTracker: async (request: Record<string, unknown>) => {
        const socket = request.socket as { remoteAddress?: string } | undefined;
        const token = readCartToken(request as unknown as Request);
        return `${socket?.remoteAddress ?? 'unknown'}:${token ? digestCartToken(token) : 'absent'}`;
      },
      generateKey: (_context, tracker, name) => `cart-${name}-${tracker}`,
    },
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set an anonymous cart line quantity.' })
  @ApiOkResponse({ type: CartDto })
  @ApiResponse({ status: 400, description: 'Request validation failed.', type: ProblemDetailsDto })
  @ApiResponse({ status: 428, description: 'Cart revision is required.', type: ProblemDetailsDto })
  @ApiResponse({
    status: 409,
    description: 'Cart revision or item availability conflict.',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 429,
    description: 'Cart mutation rate limit exceeded.',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Cart request protection is unavailable.',
    type: ProblemDetailsDto,
  })
  async set(
    @Param('variantId', new ParseUUIDPipe({ version: '4' })) variantId: string,
    @Body() body: SetCartItemDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartDto> {
    const result = await this.carts.setItem(
      readCartToken(request),
      variantId,
      body.quantity,
      parseRevision(ifMatch),
    );
    this.finish(response, result.token, result.revision);
    return result.cart;
  }

  @Delete('items/:variantId')
  @UseGuards(BrowserRequestGuard)
  @Throttle({
    cartMutation: {
      limit: CART_MUTATION_RATE_LIMIT,
      ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
      blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
      getTracker: async (request: Record<string, unknown>) => {
        const socket = request.socket as { remoteAddress?: string } | undefined;
        const token = readCartToken(request as unknown as Request);
        return `${socket?.remoteAddress ?? 'unknown'}:${token ? digestCartToken(token) : 'absent'}`;
      },
      generateKey: (_context, tracker, name) => `cart-${name}-${tracker}`,
    },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiResponse({ status: 400, description: 'Request validation failed.', type: ProblemDetailsDto })
  @ApiResponse({ status: 428, description: 'Cart revision is required.', type: ProblemDetailsDto })
  @ApiResponse({
    status: 409,
    description: 'Cart revision or item availability conflict.',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 429,
    description: 'Cart mutation rate limit exceeded.',
    type: ProblemDetailsDto,
  })
  @ApiResponse({
    status: 503,
    description: 'Cart request protection is unavailable.',
    type: ProblemDetailsDto,
  })
  async remove(
    @Param('variantId', new ParseUUIDPipe({ version: '4' })) variantId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.carts.removeItem(
      readCartToken(request),
      variantId,
      parseRevision(ifMatch),
    );
    this.finish(response, result.token, result.revision);
  }

  private finish(response: Response, token: string, revision: number): void {
    response.setHeader('Cache-Control', 'no-store');
    setCartCookie(response, token, new URL(this.webOrigin).protocol === 'https:');
    response.setHeader('ETag', `"cart-${revision}"`);
  }
}
