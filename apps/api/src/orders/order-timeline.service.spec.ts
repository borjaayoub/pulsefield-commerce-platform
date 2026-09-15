import { NotFoundException } from '@nestjs/common';
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
});
