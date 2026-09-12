import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  CatalogLifecycle,
  CartStatus,
  PriceBookVersionLifecycle,
  WarehouseStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import {
  CartItemUnavailableError,
  CartRevisionConflictError,
  CartRevisionRequiredError,
  CartCheckoutPendingError,
} from './cart.errors';
import {
  CART_ABSOLUTE_TIMEOUT_MS,
  CART_INACTIVITY_TIMEOUT_MS,
  createCartToken,
  digestCartToken,
} from './cart-cookie';
import type { CartDto } from './cart.dto';

const PRICE_FILTER = {
  priceBookVersion: {
    lifecycle: PriceBookVersionLifecycle.ACTIVE,
    priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
  },
} satisfies Prisma.VariantPriceWhereInput;

const CART_INCLUDE = {
  items: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    include: {
      variant: {
        include: {
          product: true,
          prices: { where: PRICE_FILTER, include: { priceBookVersion: true } },
          inventoryBalances: {
            where: { warehouse: { status: WarehouseStatus.ACTIVE, countryCode: 'US' } },
          },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;

type CartRecord = Prisma.CartGetPayload<{ include: typeof CART_INCLUDE }>;
interface MutationResult {
  cart: CartDto;
  revision: number;
  token: string;
  createdCookie: boolean;
  changed: boolean;
}

function safeOptions(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function activePrice(variant: CartRecord['items'][number]['variant']): number | null {
  const amount = variant.prices[0]?.amountMinor;
  if (amount === undefined) return null;
  const numeric = Number(amount);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function availableQuantity(variant: CartRecord['items'][number]['variant']): number {
  return Math.max(
    0,
    variant.inventoryBalances.reduce(
      (total, balance) =>
        total + balance.onHand - balance.reserved - balance.allocated - balance.damaged,
      0,
    ),
  );
}

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrent(
    token: string | undefined,
  ): Promise<{ cart: CartDto; token: string; createdCookie: boolean }> {
    const now = new Date();
    if (token) {
      const existing = await this.prisma.cart.findUnique({
        where: { tokenDigest: digestCartToken(token) },
        include: CART_INCLUDE,
      });
      if (
        existing &&
        existing.status !== CartStatus.CONVERTED &&
        existing.expiresAt > now &&
        existing.absoluteExpiresAt > now
      ) {
        const refreshed = await this.prisma.cart.update({
          where: { id: existing.id },
          data: {
            lastAccessedAt: now,
            expiresAt: new Date(
              Math.min(
                now.getTime() + CART_INACTIVITY_TIMEOUT_MS,
                existing.absoluteExpiresAt.getTime(),
              ),
            ),
          },
          include: CART_INCLUDE,
        });
        return { cart: this.toDto(refreshed), token, createdCookie: false };
      }
    }
    const created = await this.createCart(now);
    return { cart: this.toDto(created.cart), token: created.token, createdCookie: true };
  }

  async setItem(
    token: string | undefined,
    variantId: string,
    quantity: number,
    expectedRevision?: number,
  ): Promise<MutationResult> {
    return this.mutate(token, variantId, quantity, expectedRevision, 'set');
  }

  async removeItem(
    token: string | undefined,
    variantId: string,
    expectedRevision?: number,
  ): Promise<MutationResult> {
    return this.mutate(token, variantId, null, expectedRevision, 'remove');
  }

  async sweepExpired(limit = 500): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Cart"
      WHERE ("expiresAt" <= CURRENT_TIMESTAMP OR "absoluteExpiresAt" <= CURRENT_TIMESTAMP)
        AND NOT EXISTS (
          SELECT 1 FROM "Order"
          WHERE "Order"."cartId" = "Cart"."id"
        )
      ORDER BY "expiresAt" ASC, "id" ASC
      LIMIT ${limit}
    `;
    if (rows.length === 0) return 0;
    return this.prisma.$executeRaw`
      DELETE FROM "Cart"
      WHERE "id" IN (${Prisma.join(rows.map((row) => row.id))})
        AND NOT EXISTS (
          SELECT 1 FROM "Order"
          WHERE "Order"."cartId" = "Cart"."id"
        )
    `;
  }

  private async mutate(
    token: string | undefined,
    variantId: string,
    quantity: number | null,
    expectedRevision: number | undefined,
    operation: 'set' | 'remove',
  ): Promise<MutationResult> {
    const now = new Date();
    const suppliedDigest = token ? digestCartToken(token) : undefined;
    const existing = suppliedDigest
      ? await this.prisma.cart.findUnique({ where: { tokenDigest: suppliedDigest } })
      : null;
    const replacing = !existing || existing.expiresAt <= now || existing.absoluteExpiresAt <= now;
    if (!replacing && expectedRevision === undefined) {
      throw new CartRevisionRequiredError();
    }
    const effectiveToken = replacing ? createCartToken() : token!;
    const digest = digestCartToken(effectiveToken);

    const result = await this.prisma.$transaction(async (tx) => {
      let current = replacing
        ? await tx.cart.create({
            data: {
              tokenDigest: digest,
              expiresAt: new Date(now.getTime() + CART_INACTIVITY_TIMEOUT_MS),
              absoluteExpiresAt: new Date(now.getTime() + CART_ABSOLUTE_TIMEOUT_MS),
              lastAccessedAt: now,
            },
          })
        : await tx.cart.findUnique({ where: { tokenDigest: digest } });
      if (!current) throw new CartRevisionConflictError();
      if (!replacing) {
        await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${current.id} FOR UPDATE`;
        current = await tx.cart.findUnique({ where: { tokenDigest: digest } });
        if (!current) throw new CartRevisionConflictError();
      }
      if (current.expiresAt <= now || current.absoluteExpiresAt <= now)
        throw new CartRevisionConflictError(current.revision);
      if (current.status !== CartStatus.OPEN) throw new CartCheckoutPendingError();
      if (!replacing && expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new CartRevisionConflictError(current.revision);
      }
      const variant = await tx.productVariant.findUnique({
        where: { id: variantId },
        include: {
          product: true,
          prices: { where: PRICE_FILTER, include: { priceBookVersion: true } },
          inventoryBalances: {
            where: { warehouse: { status: WarehouseStatus.ACTIVE, countryCode: 'US' } },
          },
        },
      });
      const item = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId: current.id, variantId } },
      });
      if (operation === 'set') {
        const price =
          variant &&
          variant.status === CatalogLifecycle.ACTIVE &&
          variant.product.status === CatalogLifecycle.ACTIVE
            ? activePrice(variant as CartRecord['items'][number]['variant'])
            : null;
        const available = variant
          ? Math.max(
              0,
              variant.inventoryBalances.reduce(
                (total, balance) =>
                  total + balance.onHand - balance.reserved - balance.allocated - balance.damaged,
                0,
              ),
            )
          : 0;
        if (!variant || price === null || available < quantity!)
          throw new CartItemUnavailableError(available);
      }
      if (operation === 'remove') {
        if (!item) {
          return {
            cart: await tx.cart.findUniqueOrThrow({
              where: { id: current.id },
              include: CART_INCLUDE,
            }),
            changed: false,
          };
        }
        await tx.cartItem.delete({ where: { id: item.id } });
      } else if (item) {
        if (item.quantity === quantity) {
          return {
            cart: await tx.cart.findUniqueOrThrow({
              where: { id: current.id },
              include: CART_INCLUDE,
            }),
            changed: false,
          };
        }
        await tx.cartItem.update({ where: { id: item.id }, data: { quantity: quantity! } });
      } else {
        await tx.cartItem.create({ data: { cartId: current.id, variantId, quantity: quantity! } });
      }
      const revisionToMatch = replacing ? current.revision : (expectedRevision ?? current.revision);
      const updated = await tx.cart.updateMany({
        where: { id: current.id, revision: revisionToMatch },
        data: {
          revision: { increment: 1 },
          lastAccessedAt: now,
          expiresAt: new Date(
            Math.min(
              now.getTime() + CART_INACTIVITY_TIMEOUT_MS,
              current.absoluteExpiresAt.getTime(),
            ),
          ),
        },
      });
      if (updated.count !== 1) throw new CartRevisionConflictError(current.revision);
      return {
        cart: await tx.cart.findUniqueOrThrow({ where: { id: current.id }, include: CART_INCLUDE }),
        changed: true,
      };
    });
    const refreshed = result.cart;
    return {
      cart: this.toDto(refreshed),
      revision: refreshed.revision,
      token: effectiveToken!,
      createdCookie: replacing,
      changed: result.changed,
    };
  }

  private async createCart(now: Date): Promise<{ cart: CartRecord; token: string }> {
    const token = createCartToken();
    const absoluteExpiresAt = new Date(now.getTime() + CART_ABSOLUTE_TIMEOUT_MS);
    const cart = await this.prisma.cart.create({
      data: {
        tokenDigest: digestCartToken(token),
        expiresAt: new Date(now.getTime() + CART_INACTIVITY_TIMEOUT_MS),
        absoluteExpiresAt,
        lastAccessedAt: now,
      },
      include: CART_INCLUDE,
    });
    return { cart, token };
  }

  private toDto(cart: CartRecord): CartDto {
    let subtotal = 0;
    let hasPricedLine = false;
    let hasUnavailableItems = false;
    const items = cart.items.map((item) => {
      const variantIsActive =
        item.variant.status === CatalogLifecycle.ACTIVE &&
        item.variant.product.status === CatalogLifecycle.ACTIVE;
      const unitPrice = variantIsActive ? activePrice(item.variant) : null;
      const available = variantIsActive ? availableQuantity(item.variant) : 0;
      const purchasable = unitPrice !== null && available >= item.quantity;
      if (!purchasable) hasUnavailableItems = true;
      const line = unitPrice === null ? null : unitPrice * item.quantity;
      if (line !== null) {
        subtotal += line;
        hasPricedLine = true;
      }
      return {
        id: item.id,
        productId: item.variant.productId,
        productName: item.variant.product.name,
        variantId: item.variantId,
        sku: item.variant.sku,
        name: item.variant.name,
        optionValues: safeOptions(item.variant.optionValues),
        quantity: item.quantity,
        currentUnitPriceMinor: unitPrice,
        currentLinePriceMinor: line,
        currency: 'USD' as const,
        available,
        purchasable,
      };
    });
    const total = hasPricedLine ? subtotal : null;
    return {
      revision: cart.revision,
      currency: 'USD',
      subtotalMinor: total,
      totalMinor: total,
      hasUnavailableItems,
      expiresAt: cart.expiresAt.toISOString(),
      items,
    };
  }
}
