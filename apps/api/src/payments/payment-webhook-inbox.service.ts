import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  StripeWebhookPersistenceUnavailableError,
  StripeWebhookRequestError,
} from './payment-webhook.errors';
import { normalizeStripeWebhook } from './stripe-webhook-normalizer';
import { StripeWebhookVerifier } from './stripe-webhook-verifier';

export type PaymentWebhookReceipt = 'accepted' | 'duplicate' | 'ignored';

@Injectable()
export class PaymentWebhookInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: StripeWebhookVerifier,
  ) {}

  async accept(rawBody: Buffer, signature: string | undefined): Promise<PaymentWebhookReceipt> {
    const event = this.verifier.verify(rawBody, signature);
    const normalized = normalizeStripeWebhook(event);
    if (!normalized) return 'ignored';
    const payloadDigest = createHash('sha256').update(rawBody).digest('hex');
    try {
      await this.prisma.paymentWebhookInbox.create({
        data: {
          provider: 'stripe',
          ...normalized,
          normalizedData: normalized.normalizedData,
          payloadDigest,
        },
      });
      return 'accepted';
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        try {
          const existing = await this.prisma.paymentWebhookInbox.findUnique({
            where: {
              provider_providerEventId: {
                provider: 'stripe',
                providerEventId: normalized.providerEventId,
              },
            },
            select: { payloadDigest: true },
          });
          if (existing?.payloadDigest === payloadDigest) return 'duplicate';
          if (existing) throw new StripeWebhookRequestError();
        } catch (lookupError) {
          if (lookupError instanceof StripeWebhookRequestError) throw lookupError;
          throw new StripeWebhookPersistenceUnavailableError();
        }
      }
      throw new StripeWebhookPersistenceUnavailableError();
    }
  }
}
