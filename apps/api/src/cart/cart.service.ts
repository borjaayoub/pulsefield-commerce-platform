import { createHash } from 'node:crypto';
import {
  ShoppingConfigurationService,
  CommerceConfigurationUnavailableError,
  shoppingInventoryFilter,
  type ShoppingConfiguration,
} from '../checkout/shopping-configuration.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { CatalogLifecycle, CartStatus } from '../generated/prisma/enums';
import { PrismaService } from '../database/prisma.service';
import {
  CartItemUnavailableError,
  CartRevisionConflictError,
  CartRevisionRequiredError,
  CartCheckoutPendingError,
  CartMarketPreviewStaleError,
} from './cart.errors';
import {
  CART_ABSOLUTE_TIMEOUT_MS,
  CART_INACTIVITY_TIMEOUT_MS,
  createCartToken,
  digestCartToken,
} from './cart-cookie';
import type { CartDto } from './cart.dto';

const PUBLIC_MEDIA_ROOT = '/catalog';
const PUBLIC_MEDIA_KEY = /^catalog\/[a-z0-9-]+\/(?:[a-z0-9-]+)\.(?:svg|webp|jpg|jpeg|png)$/u;

export function isMarketSelectionContention(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010') return false;
  const adapter: unknown = error.meta?.driverAdapterError;
  const cause: unknown =
    adapter && typeof adapter === 'object' ? Reflect.get(adapter, 'cause') : undefined;
  const code: unknown =
    cause && typeof cause === 'object' ? Reflect.get(cause, 'originalCode') : error.meta?.code;
  return code === '40001' || code === '40P01';
}
function cartInclude(config: ShoppingConfiguration) {
  return {
    items: {
      orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
      include: {
        variant: {
          include: {
            product: {
              include: {
                media: {
                  where: { status: CatalogLifecycle.ACTIVE },
                  orderBy: { position: 'asc' },
                  take: 1,
                },
              },
            },
            prices: {
              where: { priceBookVersionId: config.priceBookVersionId },
              include: { priceBookVersion: true },
            },
            inventoryBalances: {
              where: shoppingInventoryFilter(config),
            },
          },
        },
      },
    },
  } satisfies Prisma.CartInclude;
}

type CartRecord = Prisma.CartGetPayload<{ include: ReturnType<typeof cartInclude> }>;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly configurations: ShoppingConfigurationService = new ShoppingConfigurationService(),
  ) {}

  async getCurrent(
    token: string | undefined,
  ): Promise<{ cart: CartDto; token: string; createdCookie: boolean }> {
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const existing = token
          ? await tx.cart.findUnique({ where: { tokenDigest: digestCartToken(token) } })
          : null;
        const usable =
          existing &&
          existing.status !== CartStatus.CONVERTED &&
          existing.expiresAt > now &&
          existing.absoluteExpiresAt > now;
        const config = await this.configurations.resolve(tx, usable ? existing.marketCode : 'US');
        if (usable) {
          const refreshed = await tx.cart.update({
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
            include: cartInclude(config),
          });
          return { cart: this.toDto(refreshed, config), token: token!, createdCookie: false };
        }
        const newToken = createCartToken();
        const created = await tx.cart.create({
          data: {
            tokenDigest: digestCartToken(newToken),
            lastAccessedAt: now,
            expiresAt: new Date(now.getTime() + CART_INACTIVITY_TIMEOUT_MS),
            absoluteExpiresAt: new Date(now.getTime() + CART_ABSOLUTE_TIMEOUT_MS),
          },
          include: cartInclude(config),
        });
        return { cart: this.toDto(created, config), token: newToken, createdCookie: true };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async setItem(
    token: string | undefined,
    variantId: string,
    quantity: number,
    expectedRevision?: number,
  ): Promise<MutationResult> {
    return this.mutate(token, variantId, quantity, expectedRevision, 'set');
  }

  async previewMarket(token: string | undefined, market: string, expectedRevision?: number) {
    return this.marketSelection(token, market, expectedRevision);
  }

  async confirmMarket(
    token: string | undefined,
    market: string,
    fingerprint: string,
    expectedRevision?: number,
  ) {
    return this.marketSelection(token, market, expectedRevision, fingerprint);
  }

  private async marketSelection(
    token: string | undefined,
    market: string,
    expectedRevision: number | undefined,
    fingerprint?: string,
    attempt = 0,
  ): Promise<{ cart: CartDto; pricingFingerprint: string; token: string }> {
    if (expectedRevision === undefined) throw new CartRevisionRequiredError();
    if (!token) throw new CartRevisionConflictError();
    return this.prisma
      .$transaction(
        async (tx) => {
          const digest = digestCartToken(token);
          if (fingerprint !== undefined)
            await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "tokenDigest" = ${digest} FOR UPDATE`;
          const current = await tx.cart.findUnique({ where: { tokenDigest: digest } });
          const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
          if (!current || current.expiresAt <= clock.now || current.absoluteExpiresAt <= clock.now)
            throw new CartRevisionConflictError();
          if (current.status !== CartStatus.OPEN) throw new CartCheckoutPendingError();
          if (current.revision !== expectedRevision)
            throw new CartRevisionConflictError(current.revision);
          const config = await this.configurations.resolve(tx, market);
          const record = await tx.cart.findUniqueOrThrow({
            where: { id: current.id },
            include: cartInclude(config),
          });
          const cart = this.toDto(record, config);
          const pricingFingerprint = createHash('sha256')
            .update(
              JSON.stringify({
                cartId: current.id,
                revision: current.revision,
                market: config.market,
                configurationId: config.configurationId,
                configurationVersion: config.configurationVersion,
                priceBookVersionId: config.priceBookVersionId,
                allocationPolicyVersionId: config.allocationPolicyVersionId,
                lines: cart.items
                  .map((item) => ({
                    id: item.id,
                    variantId: item.variantId,
                    quantity: item.quantity,
                    price: item.currentUnitPriceMinor,
                    available: item.available,
                    purchasable: item.purchasable,
                  }))
                  .sort((a, b) => a.id.localeCompare(b.id)),
              }),
            )
            .digest('hex');
          if (fingerprint !== undefined) {
            if (fingerprint !== pricingFingerprint) throw new CartMarketPreviewStaleError();
            if (current.marketCode !== market) {
              await tx.cart.update({
                where: { id: current.id },
                data: { marketCode: market, revision: { increment: 1 } },
              });
              cart.revision++;
            }
          }
          return { cart, pricingFingerprint, token };
        },
        { isolationLevel: 'RepeatableRead' },
      )
      .catch((error: unknown) => {
        if (isMarketSelectionContention(error)) {
          if (attempt === 0)
            return this.marketSelection(token, market, expectedRevision, fingerprint, 1);
          throw new CartRevisionConflictError();
        }
        throw error;
      });
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
      const config = await this.configurations.resolve(tx, current.marketCode);
      const variant = await tx.productVariant.findUnique({
        where: { id: variantId },
        include: {
          product: true,
          prices: {
            where: { priceBookVersionId: config.priceBookVersionId },
            include: { priceBookVersion: true },
          },
          inventoryBalances: {
            where: shoppingInventoryFilter(config),
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
              include: cartInclude(config),
            }),
            changed: false,
            config,
          };
        }
        await tx.cartItem.delete({ where: { id: item.id } });
      } else if (item) {
        if (item.quantity === quantity) {
          return {
            cart: await tx.cart.findUniqueOrThrow({
              where: { id: current.id },
              include: cartInclude(config),
            }),
            changed: false,
            config,
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
        cart: await tx.cart.findUniqueOrThrow({
          where: { id: current.id },
          include: cartInclude(config),
        }),
        changed: true,
        config,
      };
    });
    const refreshed = result.cart;
    return {
      cart: this.toDto(refreshed, result.config),
      revision: refreshed.revision,
      token: effectiveToken!,
      createdCookie: replacing,
      changed: result.changed,
    };
  }

  private toDto(cart: CartRecord, config: ShoppingConfiguration): CartDto {
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
      if (line !== null && !Number.isSafeInteger(line))
        throw new CommerceConfigurationUnavailableError();
      if (line !== null) {
        subtotal += line;
        if (!Number.isSafeInteger(subtotal)) throw new CommerceConfigurationUnavailableError();
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
        currency: config.currency,
        available,
        purchasable,
        media:
          item.variant.product.media[0] &&
          PUBLIC_MEDIA_KEY.test(item.variant.product.media[0].storageKey)
            ? {
                url: `${PUBLIC_MEDIA_ROOT}/${item.variant.product.media[0].storageKey.replace(/^catalog\//u, '')}`,
                altText: item.variant.product.media[0].altText,
                width: item.variant.product.media[0].width,
                height: item.variant.product.media[0].height,
              }
            : null,
      };
    });
    const total = hasPricedLine ? subtotal : null;
    return {
      market: config.market,
      taxTreatment: 'exclusive',
      revision: cart.revision,
      currency: config.currency,
      subtotalMinor: total,
      totalMinor: total,
      hasUnavailableItems,
      expiresAt: cart.expiresAt.toISOString(),
      items,
    };
  }
}
