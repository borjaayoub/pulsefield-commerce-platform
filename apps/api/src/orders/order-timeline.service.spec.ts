import { NotFoundException } from '@nestjs/common';
import {
  FulfillmentGroupStatus,
  OrderStatus,
  PaymentAttemptStatus,
  ReservationStatus,
} from '../generated/prisma/enums';
import { createGuestOrderAccessToken } from './guest-order-access';
import { OrderTimelineService } from './order-timeline.service';

describe('guest order timeline', () => {
  const key = Buffer.alloc(32, 8).toString('base64');
  const orderId = '90000000-0000-4000-8000-000000000001';
  const grantId = '80000000-0000-4000-8000-000000000001';

  it('reissues the same token without persisting plaintext', async () => {
    const access = createGuestOrderAccessToken(orderId, key, grantId);
    const prisma = {
      guestOrderAccessGrant: {
        findUnique: jest.fn().mockResolvedValue({
          id: grantId,
          orderId,
          tokenDigest: access.tokenDigest,
          expiresAt: new Date('2026-10-14T00:00:00.000Z'),
          revokedAt: null,
        }),
      },
    };
    await expect(new OrderTimelineService(prisma as never, key).issue(orderId)).resolves.toEqual({
      token: access.token,
      expiresAt: new Date('2026-10-14T00:00:00.000Z'),
    });
    expect(JSON.stringify(prisma)).not.toContain(access.token);
  });

  it('scopes the read by reference, digest, expiry, and revocation', async () => {
    const access = createGuestOrderAccessToken(orderId, key, grantId);
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = new OrderTimelineService({ order: { findFirst } } as never, key);
    await expect(service.read('PF-TEST0001', access.token)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst.mock.calls[0][0].where).toEqual({
      reference: 'PF-TEST0001',
      guestAccessGrant: {
        tokenDigest: access.tokenDigest,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });

  it('does not query an order without a valid credential', async () => {
    const findFirst = jest.fn();
    const service = new OrderTimelineService({ order: { findFirst } } as never, key);
    await expect(service.read('PF-TEST0001', undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns customer-safe shipment groups with stable presentation ordinals', async () => {
    const access = createGuestOrderAccessToken(orderId, key, grantId);
    const now = new Date('2026-09-30T12:00:00.000Z');
    const findFirst = jest.fn().mockResolvedValue({
      reference: 'PF-TEST0001',
      status: OrderStatus.CONFIRMED,
      subtotalMinor: 1000n,
      shippingMinor: 0n,
      taxMinor: 80n,
      totalMinor: 1080n,
      createdAt: now,
      guestAccessGrant: { expiresAt: new Date('2026-10-14T00:00:00.000Z') },
      lines: [],
      reservation: { status: ReservationStatus.COMMITTED, updatedAt: now },
      recoveryReservation: null,
      paymentAttempts: [{ status: PaymentAttemptStatus.SUCCEEDED, updatedAt: now }],
      paymentCompensations: [],
      fulfillmentGroups: [
        {
          id: 'group-1',
          status: FulfillmentGroupStatus.SHIPPED,
          createdAt: now,
          pickingStartedAt: null,
          packedAt: null,
          shippedAt: now,
          deliveredAt: null,
          carrierCode: 'UPS',
          trackingReference: 'TRACK-1',
          warehouseId: 'warehouse-internal',
          items: [
            {
              quantity: 2,
              orderLine: { productNameSnapshot: 'Sprint Tee', variantNameSnapshot: 'Blue / M' },
            },
          ],
        },
        {
          id: 'group-2',
          status: FulfillmentGroupStatus.PACKED,
          createdAt: new Date('2026-09-30T12:01:00.000Z'),
          pickingStartedAt: null,
          packedAt: now,
          shippedAt: null,
          deliveredAt: null,
          carrierCode: null,
          trackingReference: null,
          warehouseId: 'warehouse-internal-2',
          items: [],
        },
      ],
    });
    const timeline = await new OrderTimelineService({ order: { findFirst } } as never, key).read(
      'PF-TEST0001',
      access.token,
    );

    expect(timeline.fulfillmentProgress).toBe('PARTIALLY_SHIPPED');
    expect(timeline.shipments).toEqual([
      {
        ordinal: 1,
        total: 2,
        status: 'SHIPPED',
        items: [{ productName: 'Sprint Tee', variantName: 'Blue / M', quantity: 2 }],
        carrierCode: 'UPS',
        trackingReference: 'TRACK-1',
      },
      {
        ordinal: 2,
        total: 2,
        status: 'PACKED',
        items: [],
        carrierCode: null,
        trackingReference: null,
      },
    ]);
    expect(JSON.stringify(timeline)).not.toMatch(
      /warehouse|group-1|group-2|balance|audit|provider/iu,
    );
    expect(findFirst.mock.calls[0][0].include.fulfillmentGroups).toMatchObject({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });
});
