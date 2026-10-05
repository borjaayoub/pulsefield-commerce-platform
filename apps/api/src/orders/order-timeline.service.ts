import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  PaymentAttemptStatus,
  PaymentCompensationStatus,
  ReservationStatus,
} from '../generated/prisma/enums';
import {
  GUEST_ORDER_ACCESS_KEY,
  GUEST_ORDER_ACCESS_LIFETIME_MS,
  createGuestOrderAccessToken,
  digestGuestOrderAccessToken,
} from './guest-order-access';
import type { OrderTimelineDto, OrderTimelineEventDto } from './order-timeline.dto';
import { fulfillmentProgress } from '../fulfillment/fulfillment-progress';

function safeMoney(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Unsafe order money value.');
  return number;
}

@Injectable()
export class OrderTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(GUEST_ORDER_ACCESS_KEY) private readonly keyBase64: string,
  ) {}

  async issue(orderId: string): Promise<{ token: string; expiresAt: Date }> {
    const existing = await this.prisma.guestOrderAccessGrant.findUnique({ where: { orderId } });
    if (existing) {
      if (existing.revokedAt || existing.expiresAt <= new Date())
        throw new Error('Guest order access is unavailable.');
      const access = createGuestOrderAccessToken(orderId, this.keyBase64, existing.id);
      if (access.tokenDigest !== existing.tokenDigest)
        throw new Error('Guest order access is unavailable.');
      return { token: access.token, expiresAt: existing.expiresAt };
    }
    const access = createGuestOrderAccessToken(orderId, this.keyBase64);
    const expiresAt = new Date(Date.now() + GUEST_ORDER_ACCESS_LIFETIME_MS);
    try {
      await this.prisma.guestOrderAccessGrant.create({
        data: { id: access.id, orderId, tokenDigest: access.tokenDigest, expiresAt },
      });
      return { token: access.token, expiresAt };
    } catch (error) {
      const raced = await this.prisma.guestOrderAccessGrant.findUnique({ where: { orderId } });
      if (!raced || raced.revokedAt || raced.expiresAt <= new Date()) throw error;
      const replay = createGuestOrderAccessToken(orderId, this.keyBase64, raced.id);
      if (replay.tokenDigest !== raced.tokenDigest) throw error;
      return { token: replay.token, expiresAt: raced.expiresAt };
    }
  }

  async read(reference: string, token: string | undefined): Promise<OrderTimelineDto> {
    if (!token) throw new NotFoundException();
    const now = new Date();
    const order = await this.prisma.order.findFirst({
      where: {
        reference,
        guestAccessGrant: {
          tokenDigest: digestGuestOrderAccessToken(token),
          revokedAt: null,
          expiresAt: { gt: now },
        },
      },
      include: {
        guestAccessGrant: true,
        lines: { orderBy: { id: 'asc' } },
        reservation: true,
        recoveryReservation: true,
        paymentAttempts: { orderBy: { createdAt: 'asc' } },
        paymentCompensations: { orderBy: { createdAt: 'asc' } },
        fulfillmentGroups: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: {
            items: {
              orderBy: { id: 'asc' },
              include: {
                orderLine: { select: { productNameSnapshot: true, variantNameSnapshot: true } },
              },
            },
          },
        },
      },
    });
    if (!order?.guestAccessGrant) throw new NotFoundException();

    const events: OrderTimelineEventDto[] = [
      { type: 'order_placed', occurredAt: order.createdAt.toISOString(), label: 'Order placed' },
    ];
    const reservation = order.recoveryReservation ?? order.reservation;
    events.push({
      type:
        reservation.status === ReservationStatus.ACTIVE ||
        reservation.status === ReservationStatus.COMMITTED
          ? 'inventory_reserved'
          : 'inventory_released',
      occurredAt: reservation.updatedAt.toISOString(),
      label:
        reservation.status === ReservationStatus.ACTIVE ||
        reservation.status === ReservationStatus.COMMITTED
          ? 'Items reserved'
          : 'Reservation released',
    });
    for (const payment of order.paymentAttempts) {
      const mapped =
        payment.status === PaymentAttemptStatus.SUCCEEDED
          ? ['payment_confirmed', 'Payment confirmed']
          : payment.status === PaymentAttemptStatus.FAILED
            ? ['payment_failed', 'Payment was not completed']
            : ['payment_pending', 'Payment verification pending'];
      events.push({
        type: mapped[0],
        occurredAt: payment.updatedAt.toISOString(),
        label: mapped[1],
      });
    }
    for (const compensation of order.paymentCompensations) {
      events.push({
        type:
          compensation.status === PaymentCompensationStatus.SUCCEEDED
            ? 'payment_refunded'
            : 'attention_required',
        occurredAt: compensation.completedAt?.toISOString() ?? compensation.updatedAt.toISOString(),
        label:
          compensation.status === PaymentCompensationStatus.SUCCEEDED
            ? 'Payment returned'
            : 'Order needs attention',
      });
    }
    for (const group of order.fulfillmentGroups) {
      const states: Array<[Date | null, string, string]> = [
        [group.createdAt, 'fulfillment_allocated', 'Preparing your order'],
        [group.pickingStartedAt, 'picking', 'Picking started'],
        [group.packedAt, 'packed', 'Order packed'],
        [group.shippedAt, 'shipped', 'Order shipped'],
        [group.deliveredAt, 'delivered', 'Order delivered'],
      ];
      for (const [date, type, label] of states)
        if (date) events.push({ type, occurredAt: date.toISOString(), label });
    }
    events.sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.type.localeCompare(right.type),
    );

    return {
      orderReference: order.reference,
      status: order.status.toLowerCase(),
      fulfillmentProgress: fulfillmentProgress(
        order.fulfillmentGroups.map((group) => group.status),
      ),
      currency: order.currencyCode as OrderTimelineDto['currency'],
      subtotalMinor: safeMoney(order.subtotalMinor),
      shippingMinor: safeMoney(order.shippingMinor),
      taxMinor: safeMoney(order.taxMinor),
      totalMinor: safeMoney(order.totalMinor),
      lines: order.lines.map((line) => ({
        productName: line.productNameSnapshot,
        variantName: line.variantNameSnapshot,
        quantity: line.quantity,
        unitPriceMinor: safeMoney(line.unitPriceMinor),
        lineTotalMinor: safeMoney(line.lineTotalMinor),
      })),
      events,
      shipments: order.fulfillmentGroups.map((group, index) => ({
        ordinal: index + 1,
        total: order.fulfillmentGroups.length,
        status: group.status,
        items: group.items.map((item) => ({
          productName: item.orderLine.productNameSnapshot,
          variantName: item.orderLine.variantNameSnapshot,
          quantity: item.quantity,
        })),
        carrierCode: group.carrierCode,
        trackingReference: group.trackingReference,
      })),
      accessExpiresAt: order.guestAccessGrant.expiresAt.toISOString(),
    };
  }
}
