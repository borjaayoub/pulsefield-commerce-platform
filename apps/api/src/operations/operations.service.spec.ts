import { ForbiddenException } from '@nestjs/common';
import {
  AccountStatus,
  OrderStatus,
  PaymentAttemptStatus,
  PaymentCompensationStatus,
  RoleName,
} from '../generated/prisma/enums';
import type { PrismaService } from '../database/prisma.service';
import type { AuthenticatedSessionRequest } from '../identity/session-authentication.guard';
import { OperationsService } from './operations.service';
import {
  OperationsQueryDto,
  ReconciliationAttentionCategory,
  ReconciliationQueryDto,
} from './operations.dto';

const adminRequest = (roles: RoleName[] = [RoleName.ADMINISTRATOR]) =>
  ({
    authenticatedSession: { user: { id: 'actor-1', roles } },
  }) as unknown as AuthenticatedSessionRequest;

function query(overrides: Partial<OperationsQueryDto> = {}): OperationsQueryDto {
  return Object.assign(new OperationsQueryDto(), overrides);
}

function reconciliationQuery(
  overrides: Partial<ReconciliationQueryDto> = {},
): ReconciliationQueryDto {
  return Object.assign(new ReconciliationQueryDto(), overrides);
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
    await expect(
      service.reconciliation(reconciliationQuery(), adminRequest([RoleName.FULFILLER])),
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
    await expect(service.reconciliation(reconciliationQuery(), request)).resolves.toBeDefined();
    await expect(service.fulfillment(query(), request)).resolves.toBeDefined();
    await expect(service.audit(query(), request)).resolves.toBeDefined();
  });

  it('returns masked, payment-centered reconciliation evidence without sensitive fields', async () => {
    const createdAt = new Date('2026-09-14T10:00:00.000Z');
    const updatedAt = new Date('2026-09-14T10:05:00.000Z');
    const prisma = prismaMock({
      paymentAttempt: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'payment-1',
            status: PaymentAttemptStatus.SUCCEEDED,
            provider: 'stripe',
            providerPaymentId: 'pi_sensitive_12345678',
            failureCode: null,
            amountMinor: 12500n,
            currencyCode: 'USD',
            createdAt,
            updatedAt,
            order: { reference: 'PF-100', status: OrderStatus.MANUAL_RESOLUTION },
            compensation: {
              reason: 'LATE_SUCCESS_STOCK_UNAVAILABLE',
              status: PaymentCompensationStatus.FAILED,
              failureCode: 'provider_declined',
              providerCompensationId: 're_sensitive_87654321',
            },
          },
        ]),
      },
    });
    const result = await new OperationsService(
      prisma,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ).reconciliation(reconciliationQuery(), adminRequest());

    expect(result.items[0]).toEqual({
      id: 'payment-1',
      orderReference: 'PF-100',
      orderStatus: 'MANUAL_RESOLUTION',
      paymentStatus: 'SUCCEEDED',
      provider: 'STRIPE',
      providerPaymentReference: '***5678',
      failureCode: null,
      amountMinor: 12500,
      currency: 'USD',
      attentionCategory: 'COMPENSATION_FAILED',
      compensation: {
        reason: 'LATE_SUCCESS_STOCK_UNAVAILABLE',
        status: 'FAILED',
        failureCode: 'provider_declined',
        providerReference: '***4321',
      },
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(JSON.stringify(result.items[0])).not.toMatch(
      /pi_sensitive|re_sensitive|paymentMethod|webhook|normalized|payload/iu,
    );
  });

  it.each([
    [null, OrderStatus.CONFIRMED, PaymentAttemptStatus.SUCCEEDED, 'NONE'],
    [null, OrderStatus.CONFIRMED, PaymentAttemptStatus.FAILED, 'NONE'],
    [null, OrderStatus.CONFIRMED, PaymentAttemptStatus.PROCESSING, 'NONE'],
    [null, OrderStatus.PENDING_PAYMENT, PaymentAttemptStatus.FAILED, 'PAYMENT_FAILED'],
    [null, OrderStatus.PENDING_PAYMENT, PaymentAttemptStatus.PROCESSING, 'PAYMENT_PROCESSING'],
    [null, OrderStatus.MANUAL_RESOLUTION, PaymentAttemptStatus.FAILED, 'MANUAL_RESOLUTION'],
    [
      PaymentCompensationStatus.REQUIRED,
      OrderStatus.MANUAL_RESOLUTION,
      PaymentAttemptStatus.SUCCEEDED,
      'COMPENSATION_REQUIRED',
    ],
    [
      PaymentCompensationStatus.PROCESSING,
      OrderStatus.MANUAL_RESOLUTION,
      PaymentAttemptStatus.SUCCEEDED,
      'COMPENSATION_PROCESSING',
    ],
    [
      PaymentCompensationStatus.FAILED,
      OrderStatus.MANUAL_RESOLUTION,
      PaymentAttemptStatus.SUCCEEDED,
      'COMPENSATION_FAILED',
    ],
    [
      PaymentCompensationStatus.SUCCEEDED,
      OrderStatus.MANUAL_RESOLUTION,
      PaymentAttemptStatus.SUCCEEDED,
      'COMPENSATED',
    ],
  ])(
    'derives attention from compensation %s, order %s, and payment %s',
    async (compensationStatus, orderStatus, paymentStatus, expected) => {
      const now = new Date();
      const prisma = prismaMock({
        paymentAttempt: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'payment-1',
              status: paymentStatus,
              provider: 'stub',
              providerPaymentId: null,
              failureCode: null,
              amountMinor: 100n,
              currencyCode: 'USD',
              createdAt: now,
              updatedAt: now,
              order: { reference: 'PF-1', status: orderStatus },
              compensation: compensationStatus
                ? {
                    reason: 'LATE_SUCCESS_STOCK_UNAVAILABLE',
                    status: compensationStatus,
                    failureCode: null,
                    providerCompensationId: null,
                  }
                : null,
            },
          ]),
        },
      });
      const result = await new OperationsService(
        prisma,
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ).reconciliation(reconciliationQuery(), adminRequest());
      expect(result.items[0]?.attentionCategory).toBe(expected);
    },
  );

  it('applies bounded reconciliation filters and binds its cursor to the resource', async () => {
    const now = new Date('2026-09-14T10:00:00.000Z');
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'payment-1',
        status: PaymentAttemptStatus.FAILED,
        provider: 'stub',
        providerPaymentId: null,
        failureCode: 'declined',
        amountMinor: 100n,
        currencyCode: 'USD',
        createdAt: now,
        updatedAt: now,
        order: { reference: 'PF-1', status: OrderStatus.PENDING_PAYMENT },
        compensation: null,
      },
      {
        id: 'payment-0',
        status: PaymentAttemptStatus.FAILED,
        provider: 'stub',
        providerPaymentId: null,
        failureCode: 'declined',
        amountMinor: 100n,
        currencyCode: 'USD',
        createdAt: now,
        updatedAt: now,
        order: { reference: 'PF-0', status: OrderStatus.PENDING_PAYMENT },
        compensation: null,
      },
    ]);
    const service = new OperationsService(
      prismaMock({ paymentAttempt: { findMany } }),
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    const first = await service.reconciliation(
      reconciliationQuery({
        pageSize: 1,
        paymentStatus: PaymentAttemptStatus.FAILED,
        orderStatus: OrderStatus.PENDING_PAYMENT,
        attentionCategory: ReconciliationAttentionCategory.PAYMENT_FAILED,
      }),
      adminRequest(),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({
          status: PaymentAttemptStatus.FAILED,
          AND: expect.arrayContaining([
            { order: { status: OrderStatus.PENDING_PAYMENT } },
            {
              compensation: null,
              status: PaymentAttemptStatus.FAILED,
              order: { status: OrderStatus.PENDING_PAYMENT },
            },
          ]),
        }),
      }),
    );
    await expect(
      service.payments(query({ cursor: first.nextCursor! }), adminRequest()),
    ).rejects.toBeInstanceOf(Error);
  });

  it('filters confirmed historical failed and processing attempts as no current attention', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    await new OperationsService(
      prismaMock({ paymentAttempt: { findMany } }),
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ).reconciliation(
      reconciliationQuery({
        orderStatus: OrderStatus.CONFIRMED,
        attentionCategory: ReconciliationAttentionCategory.NONE,
      }),
      adminRequest(),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { order: { status: OrderStatus.CONFIRMED } },
            {
              compensation: null,
              order: { status: { not: OrderStatus.MANUAL_RESOLUTION } },
              OR: [
                { order: { status: { not: OrderStatus.PENDING_PAYMENT } } },
                {
                  status: {
                    in: [
                      PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD,
                      PaymentAttemptStatus.SUCCEEDED,
                    ],
                  },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it('rejects unsafe reconciliation money and unknown provider values', async () => {
    const now = new Date();
    const base = {
      id: 'payment-1',
      status: PaymentAttemptStatus.SUCCEEDED,
      providerPaymentId: null,
      failureCode: null,
      amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      currencyCode: 'USD',
      createdAt: now,
      updatedAt: now,
      order: { reference: 'PF-1', status: OrderStatus.CONFIRMED },
      compensation: null,
    };
    const unsafeMoney = new OperationsService(
      prismaMock({
        paymentAttempt: { findMany: jest.fn().mockResolvedValue([{ ...base, provider: 'stub' }]) },
      }),
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    await expect(unsafeMoney.reconciliation(reconciliationQuery(), adminRequest())).rejects.toThrow(
      'Unsafe monetary value.',
    );

    const unknownProvider = new OperationsService(
      prismaMock({
        paymentAttempt: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ ...base, amountMinor: 100n, provider: 'unexpected' }]),
        },
      }),
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
    await expect(
      unknownProvider.reconciliation(reconciliationQuery(), adminRequest()),
    ).rejects.toThrow('Unsupported payment provider in operations projection.');
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
