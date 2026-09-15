import { Controller, Get, Headers, Param, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ProblemDetailsDto } from '../http/problem-details.dto';
import { IdentityThrottlerGuard } from '../rate-limit/identity-throttler.guard';
import {
  GUEST_ORDER_IP_RATE_LIMIT,
  GUEST_ORDER_TOKEN_RATE_LIMIT,
  IDENTITY_RATE_LIMIT_WINDOW_MS,
} from '../rate-limit/rate-limit.module';
import { digestGuestOrderAccessToken, readGuestOrderAccessToken } from './guest-order-access';
import { OrderTimelineDto } from './order-timeline.dto';
import { OrderTimelineService } from './order-timeline.service';

@ApiTags('Orders')
@Controller('orders')
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
  cartAll: true,
  cartMutation: true,
  checkout: true,
})
@Throttle({
  guestOrderIp: {
    limit: GUEST_ORDER_IP_RATE_LIMIT,
    ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
    blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    getTracker: async (request: Record<string, unknown>) =>
      (request.socket as { remoteAddress?: string } | undefined)?.remoteAddress ?? 'unknown',
    generateKey: (_context, tracker, name) => `orders-${name}-${tracker}`,
  },
  guestOrderToken: {
    limit: GUEST_ORDER_TOKEN_RATE_LIMIT,
    ttl: IDENTITY_RATE_LIMIT_WINDOW_MS,
    blockDuration: IDENTITY_RATE_LIMIT_WINDOW_MS,
    getTracker: async (request: Record<string, unknown>) => {
      const headers = request.headers as Record<string, string | undefined>;
      const token = readGuestOrderAccessToken(headers.authorization);
      return token ? digestGuestOrderAccessToken(token) : 'absent';
    },
    generateKey: (_context, tracker, name) => `orders-${name}-${tracker}`,
  },
})
export class OrdersController {
  constructor(private readonly orders: OrderTimelineService) {}

  @Get(':reference/timeline')
  @ApiOkResponse({ type: OrderTimelineDto })
  @ApiResponse({ status: 404, type: ProblemDetailsDto })
  @ApiResponse({ status: 429, type: ProblemDetailsDto })
  @ApiResponse({ status: 503, type: ProblemDetailsDto })
  async timeline(
    @Param('reference') reference: string,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderTimelineDto> {
    response.setHeader('Cache-Control', 'no-store');
    if (!/^PF-[A-Z0-9]{8,24}$/u.test(reference)) return this.orders.read('', undefined);
    return this.orders.read(reference, readGuestOrderAccessToken(authorization));
  }
}
