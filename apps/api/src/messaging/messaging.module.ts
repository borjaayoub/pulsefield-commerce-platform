import { DynamicModule, Module } from '@nestjs/common';
import type { LocalProfile } from '@pulse-field/foundation';
import { BullMqOutboxPublisher } from './bullmq-outbox.publisher';
import { MESSAGING_PROFILE, OUTBOX_PUBLISHER } from './messaging.constants';
import { NotificationDeliveryOutcomeConsumer } from './notification-delivery-outcome.consumer';
import { NotificationDeliveryService } from './notification-delivery.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({})
export class MessagingModule {
  static forRoot(profile: LocalProfile): DynamicModule {
    return {
      module: MessagingModule,
      providers: [
        { provide: MESSAGING_PROFILE, useValue: profile },
        BullMqOutboxPublisher,
        { provide: OUTBOX_PUBLISHER, useExisting: BullMqOutboxPublisher },
        NotificationDeliveryService,
        NotificationDeliveryOutcomeConsumer,
        OutboxRelayService,
      ],
    };
  }
}
