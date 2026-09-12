import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { BrowserRequestGuard } from '../identity/browser-request.guard';
import { IdentityThrottlerGuard } from '../rate-limit/identity-throttler.guard';
import { IDENTITY_RATE_LIMIT_WINDOW_MS } from '../rate-limit/rate-limit.module';
import { readCartToken } from '../cart/cart-cookie';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import {
  CheckoutPreviewDto,
  CheckoutPreviewResponseDto,
  CheckoutResponseDto,
  CreateCheckoutDto,
} from './checkout.dto';
import { CheckoutRequestError } from './checkout.errors';
import { CheckoutService } from './checkout.service';

const CHECKOUT_LIMIT = 20;
function revision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^"cart-([1-9][0-9]*)"$/u.exec(value);
  if (!match) throw new CheckoutRequestError();
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed)) throw new CheckoutRequestError();
  return parsed;
}

@ApiTags('Checkout')
@Controller('checkouts')
@UseGuards(IdentityThrottlerGuard, BrowserRequestGuard)
@SkipThrottle({
  default: true,
  loginIp: true,
  loginIdentifier: true,
  verificationRequestIdentifier: true,
  passwordRecoveryIdentifier: true,
  passwordRecoveryIp: true,
  passwordResetIp: true,
  mfaChallenge: true,
  cartAll: true,
  cartMutation: true,
})
@Throttle({
  checkout: {
    limit: CHECKOUT_LIMIT,
    ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
    blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    getTracker: async (request: Record<string, unknown>) => {
      const socket = request.socket as { remoteAddress?: string } | undefined;
      return socket?.remoteAddress ?? 'unknown';
    },
    generateKey: (_context, tracker, name) => `checkout-${name}-${tracker}`,
  },
})
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CheckoutPreviewResponseDto })
  @ApiResponse({ status: 409, type: ProblemDetailsDto })
  async preview(
    @Body() body: CheckoutPreviewDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CheckoutPreviewResponseDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.checkout.preview(readCartToken(request), revision(ifMatch), body);
  }

  @Post()
  @ApiCreatedResponse({ type: CheckoutResponseDto })
  @ApiResponse({ status: 409, type: ProblemDetailsDto })
  @ApiResponse({ status: 428, type: ProblemDetailsDto })
  async create(
    @Body() body: CreateCheckoutDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CheckoutResponseDto> {
    response.setHeader('Cache-Control', 'no-store');
    return this.checkout.create(
      readCartToken(request),
      revision(ifMatch),
      idempotencyKey,
      body,
      request.header('x-request-id') ?? 'request-unavailable',
    );
  }
}
