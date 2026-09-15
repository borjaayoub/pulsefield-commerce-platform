import type { LocalProfile } from '@pulse-field/foundation';
import { PaymentWebhookRelayService } from './payment-webhook-relay.service';

const profile = { NODE_ENV: 'test' } as LocalProfile;

describe('PaymentWebhookRelayService', () => {
  it('recovers expired claims before publishing only an inbox UUID', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findFirst = jest.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      processingAttempts: 2,
    });
    const publish = jest.fn().mockResolvedValue(undefined);
    const relay = new PaymentWebhookRelayService(
      { paymentWebhookInbox: { updateMany, findFirst } } as never,
      { publish },
      profile,
    );

    await expect(relay.drainOnce()).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(
      { version: 1, inboxId: '11111111-1111-4111-8111-111111111111' },
      3,
    );
    expect(JSON.stringify(publish.mock.calls)).not.toContain('normalizedData');
  });

  it('leaves the durable pending row available when Redis publication fails', async () => {
    const relay = new PaymentWebhookRelayService(
      {
        paymentWebhookInbox: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findFirst: jest.fn().mockResolvedValue({
            id: '11111111-1111-4111-8111-111111111111',
            processingAttempts: 0,
          }),
        },
      } as never,
      { publish: jest.fn().mockRejectedValue(new Error('queue unavailable')) },
      profile,
    );

    await expect(relay.drainOnce()).rejects.toThrow('queue unavailable');
  });
});
