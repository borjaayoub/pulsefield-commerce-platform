import {
  SEND_ORDER_CONFIRMATION_JOB,
  type NotificationProvider,
  type OrderConfirmationDeliveryPayload,
  type OrderConfirmationJobData,
} from '@pulse-field/contracts';
import { decryptQueueMessage } from '@pulse-field/foundation';
import { type Job, UnrecoverableError } from 'bullmq';
import { ORDER_CONFIRMATION_TEMPLATE } from './order-confirmation.template';

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class OrderConfirmationProcessor {
  constructor(
    private readonly key: string,
    private readonly webOrigin: string,
    private readonly notifications: NotificationProvider,
    private readonly previousKey?: string,
  ) {}

  async process(job: Job<OrderConfirmationJobData>): Promise<void> {
    const data = job.data;
    if (
      !record(data) ||
      data.version !== 1 ||
      typeof data.sourceEventId !== 'string' ||
      typeof data.correlationId !== 'string' ||
      typeof data.orderId !== 'string' ||
      !record(data.encryptedDelivery) ||
      job.name !== SEND_ORDER_CONFIRMATION_JOB ||
      !job.id ||
      job.id !== data.sourceEventId
    )
      throw new UnrecoverableError('Notification job contract is invalid.');
    let value: unknown;
    try {
      value = decryptQueueMessage(data.encryptedDelivery, this.key, this.previousKey);
    } catch {
      throw new UnrecoverableError('Notification payload authentication failed.');
    }
    if (!record(value)) throw new UnrecoverableError('Notification payload is invalid.');
    const { version, recipient, orderReference, orderTimelineUrl, accessExpiresAt } = value;
    if (
      version !== 1 ||
      typeof recipient !== 'string' ||
      recipient.length < 3 ||
      recipient.length > 255 ||
      !recipient.includes('@') ||
      typeof orderReference !== 'string' ||
      !/^PF-[A-Z0-9]{12}$/u.test(orderReference) ||
      typeof orderTimelineUrl !== 'string' ||
      typeof accessExpiresAt !== 'string'
    )
      throw new UnrecoverableError('Notification payload is invalid.');
    let url: URL;
    try {
      url = new URL(orderTimelineUrl);
    } catch {
      throw new UnrecoverableError('Notification payload is invalid.');
    }
    if (
      url.origin !== new URL(this.webOrigin).origin ||
      url.pathname !== `/orders/${encodeURIComponent(orderReference)}` ||
      !/^#access=.+/u.test(url.hash)
    )
      throw new UnrecoverableError('Notification order URL is invalid.');
    const expiry = new Date(accessExpiresAt);
    if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now())
      throw new UnrecoverableError('Notification order access has expired.');
    const delivery: OrderConfirmationDeliveryPayload = {
      version: 1,
      recipient,
      orderReference,
      orderTimelineUrl,
      accessExpiresAt,
    };
    await this.notifications.send({
      recipient: delivery.recipient,
      template: ORDER_CONFIRMATION_TEMPLATE,
      locale: 'en',
      data: {
        orderReference,
        orderTimelineUrl,
        accessExpiresAt,
        sourceEventId: data.sourceEventId,
      },
    });
  }
}
