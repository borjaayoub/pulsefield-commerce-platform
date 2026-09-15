import { Controller, Header, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { StripeWebhookRequestError } from './payment-webhook.errors';

type RawWebhookRequest = Request & { body?: unknown };

@ApiTags('payments')
@Controller('payments/webhooks/stripe')
export class StripeWebhookController {
  constructor(private readonly inbox: PaymentWebhookInboxService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Accept a verified Stripe test-mode webhook event' })
  @ApiResponse({ status: 200, description: 'The delivery was accepted.' })
  @ApiResponse({ status: 400, description: 'The delivery was rejected.' })
  @ApiResponse({ status: 413, description: 'The delivery body is too large.' })
  @ApiResponse({ status: 503, description: 'Durable persistence is unavailable.' })
  async receive(
    @Req() request: RawWebhookRequest,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!Buffer.isBuffer(request.body)) throw new StripeWebhookRequestError();
    await this.inbox.accept(request.body, signature);
    return { received: true };
  }
}
