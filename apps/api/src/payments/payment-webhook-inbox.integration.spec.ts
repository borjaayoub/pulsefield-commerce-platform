import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { PaymentWebhookEventType, PaymentWebhookInboxStatus } from '../generated/prisma/enums';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required. Run this suite through pnpm test:integration.');
}

describe('payment webhook inbox database integration', () => {
  const prisma = new PrismaService(testDatabaseUrl);
  const createdIds: string[] = [];

  afterEach(async () => {
    await prisma.paymentWebhookInbox.deleteMany({ where: { id: { in: createdIds.splice(0) } } });
  });

  afterAll(async () => prisma.$disconnect());

  function inboxData(providerEventId = `evt_${randomUUID()}`) {
    const id = randomUUID();
    createdIds.push(id);
    return {
      id,
      provider: 'stripe',
      providerEventId,
      eventType: PaymentWebhookEventType.SUCCEEDED,
      providerObjectId: `pi_${randomUUID()}`,
      apiVersion: '2026-08-27',
      livemode: false,
      providerCreatedAt: new Date(),
      normalizedData: { paymentStatus: 'succeeded', schemaVersion: 1 },
      payloadDigest: 'a'.repeat(64),
    };
  }

  it('deduplicates provider events and rejects live-mode evidence', async () => {
    const first = inboxData();
    await prisma.paymentWebhookInbox.create({ data: first });

    await expect(
      prisma.paymentWebhookInbox.create({ data: inboxData(first.providerEventId) }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentWebhookInbox.create({ data: { ...inboxData(), livemode: true } }),
    ).rejects.toThrow();
  });

  it('keeps accepted event identity and normalized evidence immutable', async () => {
    const event = await prisma.paymentWebhookInbox.create({ data: inboxData() });

    await expect(
      prisma.paymentWebhookInbox.update({
        where: { id: event.id },
        data: { providerObjectId: `pi_changed_${randomUUID()}` },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentWebhookInbox.update({
        where: { id: event.id },
        data: { normalizedData: { paymentStatus: 'failed', schemaVersion: 1 } },
      }),
    ).rejects.toThrow();
  });

  it('enforces claimed processing and terminal lifecycle shapes', async () => {
    const event = await prisma.paymentWebhookInbox.create({ data: inboxData() });
    const claimedAt = new Date();

    await expect(
      prisma.paymentWebhookInbox.update({
        where: { id: event.id },
        data: { status: PaymentWebhookInboxStatus.PROCESSING },
      }),
    ).rejects.toThrow();

    const processing = await prisma.paymentWebhookInbox.update({
      where: { id: event.id },
      data: {
        status: PaymentWebhookInboxStatus.PROCESSING,
        processingAttempts: 1,
        claimTokenDigest: 'b'.repeat(64),
        claimedAt,
        leaseExpiresAt: new Date(claimedAt.getTime() + 30_000),
      },
    });
    expect(processing.status).toBe(PaymentWebhookInboxStatus.PROCESSING);

    const processed = await prisma.paymentWebhookInbox.update({
      where: { id: event.id },
      data: {
        status: PaymentWebhookInboxStatus.PROCESSED,
        claimTokenDigest: null,
        leaseExpiresAt: null,
        processedAt: new Date(claimedAt.getTime() + 1_000),
      },
    });
    expect(processed.status).toBe(PaymentWebhookInboxStatus.PROCESSED);

    await expect(
      prisma.paymentWebhookInbox.update({
        where: { id: event.id },
        data: { status: PaymentWebhookInboxStatus.PROCESSING },
      }),
    ).rejects.toThrow();
  });

  it('rejects oversized normalized envelopes and malformed digests', async () => {
    await expect(
      prisma.paymentWebhookInbox.create({
        data: { ...inboxData(), normalizedData: { safe: 'x'.repeat(8_192) } },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.paymentWebhookInbox.create({
        data: { ...inboxData(), payloadDigest: 'not-a-digest' },
      }),
    ).rejects.toThrow();
  });
});
