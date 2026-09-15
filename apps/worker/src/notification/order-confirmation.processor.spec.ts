import {
  SEND_ORDER_CONFIRMATION_JOB,
  type OrderConfirmationDeliveryPayload,
  type OrderConfirmationJobData,
} from '@pulse-field/contracts';
import { encryptQueueMessage } from '@pulse-field/foundation';
import type { Job } from 'bullmq';
import { OrderConfirmationProcessor } from './order-confirmation.processor';

describe('OrderConfirmationProcessor', () => {
  const key = Buffer.alloc(32, 9).toString('base64');
  const delivery: OrderConfirmationDeliveryPayload = {
    version: 1,
    recipient: 'buyer@example.test',
    orderReference: 'PF-ABCDEF123456',
    orderTimelineUrl: 'http://localhost:3000/orders/PF-ABCDEF123456#access=token',
    accessExpiresAt: '2099-10-01T20:00:00.000Z',
  };
  it('decrypts and sends only a same-origin order link', async () => {
    const send = jest.fn().mockResolvedValue({ status: 'accepted', providerMessageId: 'local' });
    const data: OrderConfirmationJobData = {
      version: 1,
      sourceEventId: 'event-1',
      correlationId: 'request-1',
      orderId: 'order-1',
      encryptedDelivery: encryptQueueMessage(delivery, key),
    };
    const job = {
      id: 'event-1',
      name: SEND_ORDER_CONFIRMATION_JOB,
      data,
    } as Job<OrderConfirmationJobData>;
    await new OrderConfirmationProcessor(key, 'http://localhost:3000', { send }).process(job);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'buyer@example.test' }));
  });
  it('rejects a cross-origin order link', async () => {
    const bad = {
      ...delivery,
      orderTimelineUrl: 'https://example.com/orders/PF-ABCDEF123456#access=token',
    };
    const data: OrderConfirmationJobData = {
      version: 1,
      sourceEventId: 'event-1',
      correlationId: 'request-1',
      orderId: 'order-1',
      encryptedDelivery: encryptQueueMessage(bad, key),
    };
    const job = {
      id: 'event-1',
      name: SEND_ORDER_CONFIRMATION_JOB,
      data,
    } as Job<OrderConfirmationJobData>;
    await expect(
      new OrderConfirmationProcessor(key, 'http://localhost:3000', { send: jest.fn() }).process(
        job,
      ),
    ).rejects.toThrow('order URL');
  });
});
