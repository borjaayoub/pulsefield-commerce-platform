import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import {
  AccountStatus,
  CatalogLifecycle,
  PriceBookVersionLifecycle,
  OrderStatus,
  PaymentAttemptStatus,
  PaymentCompensationStatus,
  RoleName,
  WarehouseStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedSessionRequest } from '../identity/session-authentication.guard';
import { maskAuditIdentifier, redactAuditText } from '../audit/audit-mask';
import {
  OperationsQueryDto,
  ReconciliationAttentionCategory,
  ReconciliationQueryDto,
} from './operations.dto';
import { OPERATIONS_CURSOR_KEY } from './operations.constants';

const CURSOR_VERSION = 1;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
type Cursor = { resource: string; createdAt: string; id: string };

function encodeCursor(key: string, resource: string, createdAt: Date, id: string): string {
  const payload = Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, resource, createdAt: createdAt.toISOString(), id }),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`operations:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function decodeCursor(
  key: string,
  value: string | undefined,
  resource: string,
): Cursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 512) throw new Error('long');
    const [payload, signature] = value.split('.');
    if (!payload || !signature) throw new Error('parts');
    const expected = createHmac('sha256', Buffer.from(key, 'base64'))
      .update(`operations:${payload}`)
      .digest('base64url');
    const a = Buffer.from(signature, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('signature');
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('payload');
    const candidate = parsed as Record<string, unknown>;
    const date = typeof candidate.createdAt === 'string' ? new Date(candidate.createdAt) : null;
    if (
      candidate.v !== CURSOR_VERSION ||
      candidate.resource !== resource ||
      typeof candidate.id !== 'string' ||
      !date ||
      !Number.isFinite(date.getTime()) ||
      candidate.id.length < 1 ||
      candidate.id.length > 64
    )
      throw new Error('values');
    return { resource, createdAt: date.toISOString(), id: candidate.id };
  } catch {
    throw new BadRequestException('Invalid operations cursor.');
  }
}

function minor(value: bigint): number {
  if (value > MAX_SAFE_MINOR || value < -MAX_SAFE_MINOR) throw new Error('Unsafe monetary value.');
  return Number(value);
}

function date(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function cursorWhere(cursor: Cursor | undefined): Prisma.ProductWhereInput['AND'] {
  return cursor
    ? [
        {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
          ],
        },
      ]
    : undefined;
}

function reconciliationAttentionWhere(
  attention: ReconciliationAttentionCategory | undefined,
): Prisma.PaymentAttemptWhereInput {
  switch (attention) {
    case ReconciliationAttentionCategory.COMPENSATION_REQUIRED:
      return { compensation: { status: PaymentCompensationStatus.REQUIRED } };
    case ReconciliationAttentionCategory.COMPENSATION_PROCESSING:
      return { compensation: { status: PaymentCompensationStatus.PROCESSING } };
    case ReconciliationAttentionCategory.COMPENSATION_FAILED:
      return { compensation: { status: PaymentCompensationStatus.FAILED } };
    case ReconciliationAttentionCategory.COMPENSATED:
      return { compensation: { status: PaymentCompensationStatus.SUCCEEDED } };
    case ReconciliationAttentionCategory.MANUAL_RESOLUTION:
      return { compensation: null, order: { status: OrderStatus.MANUAL_RESOLUTION } };
    case ReconciliationAttentionCategory.PAYMENT_FAILED:
      return {
        compensation: null,
        status: PaymentAttemptStatus.FAILED,
        order: { status: OrderStatus.PENDING_PAYMENT },
      };
    case ReconciliationAttentionCategory.PAYMENT_PROCESSING:
      return {
        compensation: null,
        status: PaymentAttemptStatus.PROCESSING,
        order: { status: OrderStatus.PENDING_PAYMENT },
      };
    case ReconciliationAttentionCategory.NONE:
      return {
        compensation: null,
        order: { status: { not: OrderStatus.MANUAL_RESOLUTION } },
        OR: [
          { order: { status: { not: OrderStatus.PENDING_PAYMENT } } },
          {
            status: {
              in: [PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD, PaymentAttemptStatus.SUCCEEDED],
            },
          },
        ],
      };
    default:
      return {};
  }
}

function reconciliationAttention(record: {
  status: PaymentAttemptStatus;
  order: { status: OrderStatus };
  compensation: { status: PaymentCompensationStatus } | null;
}): ReconciliationAttentionCategory {
  if (record.compensation) {
    const byStatus: Record<PaymentCompensationStatus, ReconciliationAttentionCategory> = {
      REQUIRED: ReconciliationAttentionCategory.COMPENSATION_REQUIRED,
      PROCESSING: ReconciliationAttentionCategory.COMPENSATION_PROCESSING,
      FAILED: ReconciliationAttentionCategory.COMPENSATION_FAILED,
      SUCCEEDED: ReconciliationAttentionCategory.COMPENSATED,
    };
    return byStatus[record.compensation.status];
  }
  if (record.order.status === OrderStatus.MANUAL_RESOLUTION)
    return ReconciliationAttentionCategory.MANUAL_RESOLUTION;
  if (
    record.order.status === OrderStatus.PENDING_PAYMENT &&
    record.status === PaymentAttemptStatus.FAILED
  )
    return ReconciliationAttentionCategory.PAYMENT_FAILED;
  if (
    record.order.status === OrderStatus.PENDING_PAYMENT &&
    record.status === PaymentAttemptStatus.PROCESSING
  )
    return ReconciliationAttentionCategory.PAYMENT_PROCESSING;
  return ReconciliationAttentionCategory.NONE;
}

function providerName(value: string): 'STRIPE' | 'STUB' {
  if (value.toLowerCase() === 'stripe') return 'STRIPE';
  if (value.toLowerCase() === 'stub') return 'STUB';
  throw new Error('Unsupported payment provider in operations projection.');
}

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPERATIONS_CURSOR_KEY) private readonly cursorKey: string,
  ) {}

  private async assertActor(request: AuthenticatedSessionRequest, roles: readonly RoleName[]) {
    const actor = request.authenticatedSession?.user;
    if (!actor) throw new ForbiddenException();
    const persisted = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { status: true, verifiedAt: true, userRoles: { select: { role: true } } },
    });
    if (
      !persisted ||
      persisted.status !== AccountStatus.ACTIVE ||
      !persisted.verifiedAt ||
      !persisted.userRoles.some(({ role }) => roles.includes(role))
    )
      throw new ForbiddenException();
    return actor;
  }

  private pageSize(query: OperationsQueryDto): number {
    return query.pageSize ?? 25;
  }

  async catalog(query: OperationsQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'catalog');
    const records = await this.prisma.product.findMany({
      where: {
        status: CatalogLifecycle.ACTIVE,
        ...(query.search ? { name: { contains: query.search.trim(), mode: 'insensitive' } } : {}),
        AND: cursorWhere(cursor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        variants: {
          where: { status: CatalogLifecycle.ACTIVE },
          select: {
            id: true,
            sku: true,
            name: true,
            prices: {
              where: {
                priceBookVersion: {
                  lifecycle: PriceBookVersionLifecycle.ACTIVE,
                  priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
                },
              },
              select: { amountMinor: true },
              take: 1,
            },
          },
        },
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    return {
      items: visible.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        variants: p.variants.flatMap((v) =>
          v.prices[0]
            ? [
                {
                  id: v.id,
                  sku: v.sku,
                  name: v.name,
                  priceMinor: minor(v.prices[0].amountMinor),
                  currency: 'USD' as const,
                },
              ]
            : [],
        ),
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(this.cursorKey, 'catalog', visible.at(-1)!.createdAt, visible.at(-1)!.id)
          : null,
    };
  }

  async inventory(query: OperationsQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'inventory');
    const records = await this.prisma.inventoryBalance.findMany({
      where: {
        warehouse: {
          status: WarehouseStatus.ACTIVE,
          ...(query.warehouseCode ? { code: query.warehouseCode.trim() } : {}),
        },
        variant: {
          status: CatalogLifecycle.ACTIVE,
          ...(query.sku ? { sku: query.sku.trim() } : {}),
        },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        onHand: true,
        reserved: true,
        allocated: true,
        damaged: true,
        version: true,
        createdAt: true,
        warehouse: { select: { code: true } },
        variant: { select: { sku: true } },
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    return {
      items: visible.map((b) => ({
        id: b.id,
        warehouseCode: b.warehouse.code,
        sku: b.variant.sku,
        onHand: b.onHand,
        reserved: b.reserved,
        allocated: b.allocated,
        damaged: b.damaged,
        available: Math.max(0, b.onHand - b.reserved - b.allocated - b.damaged),
        version: b.version,
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(this.cursorKey, 'inventory', visible.at(-1)!.createdAt, visible.at(-1)!.id)
          : null,
    };
  }

  async reservations(query: OperationsQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'reservations');
    const records = await this.prisma.inventoryReservation.findMany({
      where: {
        ...(query.reservationStatus ? { status: query.reservationStatus } : {}),
        ...(query.sku ? { items: { some: { variant: { sku: query.sku.trim() } } } } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        order: { select: { reference: true } },
        items: {
          select: {
            quantity: true,
            variant: { select: { sku: true } },
            warehouse: { select: { code: true } },
          },
        },
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    return {
      items: visible.map((r) => ({
        id: r.id,
        status: r.status,
        expiresAt: r.expiresAt.toISOString(),
        orderReference: r.order?.reference ?? null,
        items: r.items.map((i) => ({
          sku: i.variant.sku,
          quantity: i.quantity,
          warehouseCode: i.warehouse.code,
        })),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(
              this.cursorKey,
              'reservations',
              visible.at(-1)!.createdAt,
              visible.at(-1)!.id,
            )
          : null,
    };
  }

  async orders(query: OperationsQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'orders');
    const records = await this.prisma.order.findMany({
      where: {
        ...(query.orderStatus ? { status: query.orderStatus } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        reference: true,
        status: true,
        currencyCode: true,
        subtotalMinor: true,
        shippingMinor: true,
        taxMinor: true,
        totalMinor: true,
        shippingAddressSnapshot: true,
        createdAt: true,
        updatedAt: true,
        lines: {
          select: {
            skuSnapshot: true,
            productNameSnapshot: true,
            quantity: true,
            unitPriceMinor: true,
          },
        },
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    const destination = (
      snapshot: Prisma.JsonValue,
    ): { city: string; state: string; countryCode: string } => {
      const v = snapshot as Record<string, unknown>;
      return {
        city: typeof v.city === 'string' ? v.city : '',
        state: typeof v.state === 'string' ? v.state : '',
        countryCode: typeof v.countryCode === 'string' ? v.countryCode : '',
      };
    };
    return {
      items: visible.map((o) => ({
        id: o.id,
        reference: o.reference,
        status: o.status,
        currency: o.currencyCode,
        subtotalMinor: minor(o.subtotalMinor),
        shippingMinor: minor(o.shippingMinor),
        taxMinor: minor(o.taxMinor),
        totalMinor: minor(o.totalMinor),
        destination: destination(o.shippingAddressSnapshot),
        lines: o.lines.map((l) => ({
          sku: l.skuSnapshot,
          productName: l.productNameSnapshot,
          quantity: l.quantity,
          unitPriceMinor: minor(l.unitPriceMinor),
        })),
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(this.cursorKey, 'orders', visible.at(-1)!.createdAt, visible.at(-1)!.id)
          : null,
    };
  }

  async payments(query: OperationsQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'payments');
    const records = await this.prisma.paymentAttempt.findMany({
      where: {
        ...(query.paymentStatus ? { status: query.paymentStatus } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        status: true,
        amountMinor: true,
        currencyCode: true,
        failureCode: true,
        createdAt: true,
        order: { select: { reference: true } },
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    return {
      items: visible.map((p) => ({
        id: p.id,
        orderReference: p.order.reference,
        status: p.status,
        amountMinor: minor(p.amountMinor),
        currency: p.currencyCode,
        failureCode: p.failureCode,
        createdAt: p.createdAt.toISOString(),
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(this.cursorKey, 'payments', visible.at(-1)!.createdAt, visible.at(-1)!.id)
          : null,
    };
  }

  async reconciliation(query: ReconciliationQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'reconciliation');
    const records = await this.prisma.paymentAttempt.findMany({
      where: {
        ...(query.paymentStatus ? { status: query.paymentStatus } : {}),
        AND: [
          ...(query.orderStatus ? [{ order: { status: query.orderStatus } }] : []),
          ...(query.compensationStatus
            ? [{ compensation: { status: query.compensationStatus } }]
            : []),
          reconciliationAttentionWhere(query.attentionCategory),
          ...(cursor
            ? [
                {
                  OR: [
                    { createdAt: { lt: new Date(cursor.createdAt) } },
                    { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        status: true,
        provider: true,
        providerPaymentId: true,
        failureCode: true,
        amountMinor: true,
        currencyCode: true,
        createdAt: true,
        updatedAt: true,
        order: { select: { reference: true, status: true } },
        compensation: {
          select: {
            reason: true,
            status: true,
            failureCode: true,
            providerCompensationId: true,
          },
        },
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    return {
      items: visible.map((payment) => ({
        id: payment.id,
        orderReference: payment.order.reference,
        orderStatus: payment.order.status,
        paymentStatus: payment.status,
        provider: providerName(payment.provider),
        providerPaymentReference: payment.providerPaymentId
          ? maskAuditIdentifier(payment.providerPaymentId)
          : null,
        failureCode: payment.failureCode,
        amountMinor: minor(payment.amountMinor),
        currency: payment.currencyCode,
        attentionCategory: reconciliationAttention(payment),
        compensation: payment.compensation
          ? {
              reason: payment.compensation.reason,
              status: payment.compensation.status,
              failureCode: payment.compensation.failureCode,
              providerReference: payment.compensation.providerCompensationId
                ? maskAuditIdentifier(payment.compensation.providerCompensationId)
                : null,
            }
          : null,
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(
              this.cursorKey,
              'reconciliation',
              visible.at(-1)!.createdAt,
              visible.at(-1)!.id,
            )
          : null,
    };
  }

  async fulfillment(query: OperationsQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR, RoleName.FULFILLER]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'fulfillment');
    const records = await this.prisma.fulfillmentGroup.findMany({
      where: {
        ...(query.fulfillmentStatus ? { status: query.fulfillmentStatus } : {}),
        warehouse: {
          status: WarehouseStatus.ACTIVE,
          ...(query.warehouseCode ? { code: query.warehouseCode.trim() } : {}),
        },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        status: true,
        version: true,
        carrierCode: true,
        trackingReference: true,
        pickingStartedAt: true,
        packedAt: true,
        shippedAt: true,
        deliveredAt: true,
        createdAt: true,
        updatedAt: true,
        warehouse: { select: { code: true } },
        order: { select: { reference: true } },
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    return {
      items: visible.map((f) => ({
        id: f.id,
        orderReference: f.order.reference,
        warehouseCode: f.warehouse.code,
        status: f.status,
        version: f.version,
        trackingReference: f.trackingReference,
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
        pickingStartedAt: date(f.pickingStartedAt),
        packedAt: date(f.packedAt),
        shippedAt: date(f.shippedAt),
        deliveredAt: date(f.deliveredAt),
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(
              this.cursorKey,
              'fulfillment',
              visible.at(-1)!.createdAt,
              visible.at(-1)!.id,
            )
          : null,
    };
  }

  async audit(query: OperationsQueryDto, request: AuthenticatedSessionRequest) {
    await this.assertActor(request, [RoleName.ADMINISTRATOR]);
    const cursor = decodeCursor(this.cursorKey, query.cursor, 'audit');
    const records = await this.prisma.auditRecord.findMany({
      where: {
        action: { startsWith: 'commerce.' },
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: new Date(cursor.createdAt) } },
                { occurredAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: this.pageSize(query) + 1,
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        actorId: true,
        reason: true,
        occurredAt: true,
      },
    });
    const visible = records.slice(0, this.pageSize(query));
    return {
      items: visible.map((a) => ({
        id: maskAuditIdentifier(a.id),
        action: a.action,
        targetType: a.targetType,
        targetId: maskAuditIdentifier(a.targetId),
        actorId: maskAuditIdentifier(a.actorId),
        reason: redactAuditText(a.reason),
        occurredAt: a.occurredAt.toISOString(),
      })),
      nextCursor:
        records.length > visible.length && visible.length
          ? encodeCursor(this.cursorKey, 'audit', visible.at(-1)!.occurredAt, visible.at(-1)!.id)
          : null,
    };
  }
}
