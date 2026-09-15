import { Prisma } from '../generated/prisma/client';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { StripeWebhookRequestError } from './payment-webhook.errors';

const rawBody = Buffer.from('{"safe":true}');
const event = {
  id: 'evt_slice43test',
  object: 'event',
  api_version: '2026-07-29.dahlia',
  created: 1_788_700_000,
  livemode: false,
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: 'pi_slice43test',
      object: 'payment_intent',
      livemode: false,
      status: 'succeeded',
      amount: 12_345,
      currency: 'usd',
      metadata: {
        payment_attempt_id: '11111111-1111-4111-8111-111111111111',
        order_reference: 'PF-ABCDEF123456',
      },
    },
  },
} as never;

describe('PaymentWebhookInboxService', () => {
  it('persists normalized evidence and treats the identical provider retry as a duplicate', async () => {
    const create = jest.fn().mockResolvedValueOnce(undefined);
    const findUnique = jest.fn();
    const verifier = { verify: jest.fn().mockReturnValue(event) };
    const service = new PaymentWebhookInboxService(
      { paymentWebhookInbox: { create, findUnique } } as never,
      verifier as never,
    );

    await expect(service.accept(rawBody, 'signature')).resolves.toBe('accepted');
    const payloadDigest = create.mock.calls[0]![0].data.payloadDigest as string;
    expect(create.mock.calls[0]![0].data).toMatchObject({
      provider: 'stripe',
      providerEventId: 'evt_slice43test',
      providerObjectId: 'pi_slice43test',
      payloadDigest,
    });

    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    );
    findUnique.mockResolvedValueOnce({ payloadDigest });
    await expect(service.accept(rawBody, 'signature')).resolves.toBe('duplicate');
  });

  it('fails closed when a provider event ID is reused with different evidence', async () => {
    const create = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    );
    const service = new PaymentWebhookInboxService(
      {
        paymentWebhookInbox: {
          create,
          findUnique: jest.fn().mockResolvedValue({ payloadDigest: '0'.repeat(64) }),
        },
      } as never,
      { verify: jest.fn().mockReturnValue(event) } as never,
    );

    await expect(service.accept(rawBody, 'signature')).rejects.toBeInstanceOf(
      StripeWebhookRequestError,
    );
  });
});
