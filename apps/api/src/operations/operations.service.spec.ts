import { ForbiddenException } from '@nestjs/common';
import { AccountStatus, RoleName } from '../generated/prisma/enums';
import type { PrismaService } from '../database/prisma.service';
import type { AuthenticatedSessionRequest } from '../identity/session-authentication.guard';
import { OperationsService } from './operations.service';
import { OperationsQueryDto } from './operations.dto';

const adminRequest = (roles: RoleName[] = [RoleName.ADMINISTRATOR]) =>
  ({
    authenticatedSession: { user: { id: 'actor-1', roles } },
  }) as unknown as AuthenticatedSessionRequest;

function query(overrides: Partial<OperationsQueryDto> = {}): OperationsQueryDto {
  return Object.assign(new OperationsQueryDto(), overrides);
}

function prismaMock(overrides: Record<string, unknown> = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        status: AccountStatus.ACTIVE,
        verifiedAt: new Date(),
        userRoles: [{ role: RoleName.ADMINISTRATOR }],
      }),
    },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryBalance: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryReservation: { findMany: jest.fn().mockResolvedValue([]) },
    order: { findMany: jest.fn().mockResolvedValue([]) },
    paymentAttempt: { findMany: jest.fn().mockResolvedValue([]) },
    fulfillmentGroup: { findMany: jest.fn().mockResolvedValue([]) },
    auditRecord: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides,
  };
  return prisma as unknown as PrismaService;
}

describe('OperationsService', () => {
  it('uses the 25-item default and caps the database read at max page size plus one', async () => {
    const prisma = prismaMock({ product: { findMany: jest.fn().mockResolvedValue([]) } });
    await new OperationsService(prisma, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').catalog(
      query(),
      adminRequest(),
    );
    expect(prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 26 }));
  });

  it('permits administrators for all reads but limits fulfillers to fulfillment', async () => {
    const prisma = prismaMock({
      user: {
        findUnique: jest.fn().mockResolvedValue({
          status: AccountStatus.ACTIVE,
          verifiedAt: new Date(),
          userRoles: [{ role: RoleName.FULFILLER }],
        }),
      },
    });
    const service = new OperationsService(prisma, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    await expect(
      service.catalog(query(), adminRequest([RoleName.FULFILLER])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.fulfillment(query(), adminRequest([RoleName.FULFILLER]))).resolves.toEqual(
      { items: [], nextCursor: null },
    );
  });

  it('permits an administrator to read every operations projection', async () => {
    const service = new OperationsService(
      prismaMock(),
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    const request = adminRequest();
    await expect(service.catalog(query(), request)).resolves.toBeDefined();
    await expect(service.inventory(query(), request)).resolves.toBeDefined();
    await expect(service.reservations(query(), request)).resolves.toBeDefined();
    await expect(service.orders(query(), request)).resolves.toBeDefined();
    await expect(service.payments(query(), request)).resolves.toBeDefined();
    await expect(service.fulfillment(query(), request)).resolves.toBeDefined();
    await expect(service.audit(query(), request)).resolves.toBeDefined();
  });

  it('revalidates active verified persisted roles instead of trusting session claims', async () => {
    const prisma = prismaMock({
      user: {
        findUnique: jest.fn().mockResolvedValue({
          status: AccountStatus.ACTIVE,
          verifiedAt: null,
          userRoles: [{ role: RoleName.ADMINISTRATOR }],
        }),
      },
    });
    await expect(
      new OperationsService(prisma, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').catalog(
        query(),
        adminRequest(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies customer and anonymous operation reads', async () => {
    const customerPrisma = prismaMock({
      user: {
        findUnique: jest.fn().mockResolvedValue({
          status: AccountStatus.ACTIVE,
          verifiedAt: new Date(),
          userRoles: [{ role: RoleName.CUSTOMER }],
        }),
      },
    });
    const service = new OperationsService(
      customerPrisma,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    await expect(
      service.catalog(query(), adminRequest([RoleName.CUSTOMER])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.catalog(query(), {} as AuthenticatedSessionRequest),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects tampered and wrong-resource cursors', async () => {
    const createdAt = new Date('2026-09-12T00:00:00.000Z');
    const prisma = prismaMock({
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', name: 'P', status: 'ACTIVE', createdAt, variants: [] },
          { id: 'p2', name: 'P2', status: 'ACTIVE', createdAt, variants: [] },
        ]),
      },
    });
    const service = new OperationsService(prisma, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    const first = await service.catalog(query({ pageSize: 1 }), adminRequest());
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      service.catalog(query({ cursor: `${first.nextCursor}x` }), adminRequest()),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      service.inventory(query({ cursor: first.nextCursor! }), adminRequest()),
    ).rejects.toBeInstanceOf(Error);
  });

  it('returns masked audit evidence and excludes non-commerce records at the query boundary', async () => {
    const prisma = prismaMock({
      auditRecord: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'audit-1234',
            action: 'commerce.order.confirmed',
            targetType: 'order',
            targetId: 'order-1234',
            actorId: 'staff-1234',
            reason: 'safe reason',
            occurredAt: new Date('2026-09-12T00:00:00.000Z'),
          },
        ]),
      },
    });
    const result = await new OperationsService(
      prisma,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ).audit(query(), adminRequest());
    expect(prisma.auditRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: { startsWith: 'commerce.' } } }),
    );
    expect(result.items[0]).toMatchObject({
      action: 'commerce.order.confirmed',
      targetId: '***1234',
      actorId: '***1234',
    });
    expect(result.items[0]).not.toHaveProperty('metadata');
  });

  it('returns only the safe destination projection for orders', async () => {
    const prisma = prismaMock({
      order: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'o1',
            reference: 'PF-1',
            status: 'CONFIRMED',
            currencyCode: 'USD',
            subtotalMinor: 100n,
            shippingMinor: 10n,
            taxMinor: 5n,
            totalMinor: 115n,
            shippingAddressSnapshot: {
              fullName: 'Private Person',
              line1: 'Private Street',
              postalCode: '00000',
              city: 'Austin',
              state: 'TX',
              countryCode: 'US',
            },
            createdAt: new Date(),
            updatedAt: new Date(),
            lines: [],
          },
        ]),
      },
    });
    const result = await new OperationsService(
      prisma,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ).orders(query(), adminRequest());
    expect(result.items[0]).toHaveProperty('destination', {
      city: 'Austin',
      state: 'TX',
      countryCode: 'US',
    });
    expect(JSON.stringify(result.items[0])).not.toMatch(/Private Person|Private Street|00000/u);
  });
});
