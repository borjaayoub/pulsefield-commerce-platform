import { DynamicModule, Global, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import Stripe from 'stripe';
import { StubPaymentProvider } from './stub-payment.provider';
import { PaymentApplicationService } from './payment-application.service';
import { StripePaymentProvider } from './stripe-payment.provider';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookVerifier } from './stripe-webhook-verifier';
import { STRIPE_API_VERSION } from './payment-webhook.constants';
import { AuditModule } from '../audit/audit.module';
import { PaymentOutcomeService } from './payment-outcome.service';
import { BullMqPaymentWebhookPublisher } from './payment-webhook.publisher';
import { PaymentWebhookRelayService } from './payment-webhook-relay.service';
import { PaymentWebhookProcessor } from './payment-webhook.processor';
import { PaymentWebhookConsumer } from './payment-webhook.consumer';
import { PAYMENT_PROFILE, PAYMENT_WEBHOOK_PUBLISHER } from './payment-webhook.constants';
import { PaymentCompensationService } from './payment-compensation.service';
import { PaymentReconciliationExecutionService } from './payment-reconciliation-execution.service';

@Global()
@Module({})
export class PaymentsModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: PaymentsModule,
      imports: [AuditModule],
      controllers: profile.PAYMENT_PROVIDER === 'stripe' ? [StripeWebhookController] : [],
      providers: [
        { provide: PAYMENT_PROFILE, useValue: profile },
        PaymentOutcomeService,
        PaymentCompensationService,
        PaymentReconciliationExecutionService,
        {
          provide: PaymentApplicationService,
          useFactory: () => {
            if (profile.PAYMENT_PROVIDER === 'stripe') {
              if (
                !profile.STRIPE_SECRET_KEY ||
                !profile.STRIPE_PUBLISHABLE_KEY ||
                !profile.STRIPE_WEBHOOK_SECRET
              ) {
                throw new Error('Stripe test credentials and webhook secret are required.');
              }
              const stripe = new Stripe(profile.STRIPE_SECRET_KEY, {
                apiVersion: STRIPE_API_VERSION,
                timeout: 10_000,
                maxNetworkRetries: 2,
              });
              return new PaymentApplicationService(
                'stripe',
                new StripePaymentProvider(stripe),
                profile.STRIPE_PUBLISHABLE_KEY,
              );
            }
            return new PaymentApplicationService('stub', new StubPaymentProvider());
          },
        },
        ...(profile.PAYMENT_PROVIDER === 'stripe'
          ? [
              {
                provide: StripeWebhookVerifier,
                useFactory: () => new StripeWebhookVerifier(profile),
              },
              PaymentWebhookInboxService,
              ...(profile.NODE_ENV === 'test'
                ? []
                : [
                    BullMqPaymentWebhookPublisher,
                    {
                      provide: PAYMENT_WEBHOOK_PUBLISHER,
                      useExisting: BullMqPaymentWebhookPublisher,
                    },
                    PaymentWebhookRelayService,
                    PaymentWebhookProcessor,
                    PaymentWebhookConsumer,
                  ]),
            ]
          : []),
      ],
      exports: [
        PaymentApplicationService,
        PaymentOutcomeService,
        PaymentCompensationService,
        PaymentReconciliationExecutionService,
      ],
    };
  }
}
