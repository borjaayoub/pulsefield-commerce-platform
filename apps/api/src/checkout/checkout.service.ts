import { Inject, Injectable } from '@nestjs/common';
import type { PaymentProvider } from '@pulse-field/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  AuditActorType,
  CartStatus,
  CatalogLifecycle,
  InventoryMovementType,
  OrderStatus,
  PaymentAttemptStatus,
  ReservationStatus,
  WarehouseStatus,
  CommercePolicyLifecycle,
} from '../generated/prisma/enums';
import { IdempotencyService, type IdempotencyClaim } from '../idempotency/idempotency.service';
import { AuditService } from '../audit/audit.service';
import { digestCartToken } from '../cart/cart-cookie';
import { CheckoutConflictError } from './checkout.errors';
import type {
  CreateCheckoutDto,
  CheckoutPreviewDto,
  CheckoutPreviewResponseDto,
  CheckoutResponseDto,
} from './checkout.dto';
import { PAYMENT_PROVIDER } from './payment-provider.token';

const TAX_NOTICE = 'Simulated tax for this local demo only; not tax advice.';
const PHASE_3_WAREHOUSE_CODE = 'US-EAST-01';
const UNSAFE_CHECKOUT_VALUE_MESSAGE = 'Checkout is temporarily unavailable.';

const CHECKOUT_CART_INCLUDE = {
  items: {
    orderBy: { variantId: 'asc' as const },
    include: {
      variant: {
        include: {
          prices: {
            where: {
              priceBookVersion: {
                lifecycle: 'ACTIVE',
                priceBook: { code: 'US-RETAIL', marketCode: 'US', currencyCode: 'USD' },
              },
            },
          },
          product: {
            include: { media: { where: { status: 'ACTIVE' }, orderBy: { position: 'asc' } } },
          },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;
type CheckoutCart = Prisma.CartGetPayload<{ include: typeof CHECKOUT_CART_INCLUDE }>;

type Totals = CheckoutPreviewResponseDto & { policyId: string; totalWeightGrams: number };
export type CheckoutPolicy = {
  id: string;
  version: number;
  priceBookVersionId: string;
  shippingBaseMinor: number;
  freeShippingThresholdMinor: number;
  heavySurchargeMinor: number;
  heavyThresholdGrams: number;
  taxRateBasisPoints: number;
  reservationDurationSeconds: number;
  calculationVersion: string;
};

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function digestKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function toIdempotencyShippingAddress(address: CreateCheckoutDto['shippingAddress']): {
  fullName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: 'US';
} {
  return {
    fullName: address.fullName,
    line1: address.line1,
    line2: address.line2 ?? '',
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  };
}

function requireSafeNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
  return value;
}

function safeAdd(left: number, right: number): number {
  requireSafeNonNegativeInteger(left);
  requireSafeNonNegativeInteger(right);
  const result = left + right;
  if (!Number.isSafeInteger(result))
    throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
  return result;
}

function safeMultiply(left: number, right: number): number {
  requireSafeNonNegativeInteger(left);
  requireSafeNonNegativeInteger(right);
  const result = left * right;
  if (!Number.isSafeInteger(result))
    throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
  return result;
}

export function roundHalfUp(value: number, divisor: number): number {
  requireSafeNonNegativeInteger(value);
  if (!Number.isSafeInteger(divisor) || divisor <= 0)
    throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
  return Math.floor(safeAdd(value, Math.floor(divisor / 2)) / divisor);
}
export function calculateUsdCheckoutTotals(
  lines: Array<{
    variantId: string;
    quantity: number;
    unitPriceMinor: number;
    weightGrams: number;
  }>,
  policy: Pick<
    CheckoutPolicy,
    | 'shippingBaseMinor'
    | 'freeShippingThresholdMinor'
    | 'heavySurchargeMinor'
    | 'heavyThresholdGrams'
    | 'taxRateBasisPoints'
  >,
): {
  lines: CheckoutPreviewResponseDto['lines'];
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  totalWeightGrams: number;
} {
  let subtotalMinor = 0;
  let taxMinor = 0;
  let totalWeightGrams = 0;
  const calculatedLines = lines.map((line) => {
    requireSafeNonNegativeInteger(line.unitPriceMinor);
    requireSafeNonNegativeInteger(line.quantity);
    requireSafeNonNegativeInteger(line.weightGrams);
    requireSafeNonNegativeInteger(policy.taxRateBasisPoints);
    if (policy.taxRateBasisPoints > 10_000)
      throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
    if (line.quantity <= 0)
      throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
    const lineSubtotalMinor = safeMultiply(line.unitPriceMinor, line.quantity);
    const lineTaxNumerator = safeMultiply(lineSubtotalMinor, policy.taxRateBasisPoints);
    const lineTaxMinor = roundHalfUp(lineTaxNumerator, 10_000);
    subtotalMinor = safeAdd(subtotalMinor, lineSubtotalMinor);
    taxMinor = safeAdd(taxMinor, lineTaxMinor);
    totalWeightGrams = safeAdd(totalWeightGrams, safeMultiply(line.weightGrams, line.quantity));
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      subtotalMinor: lineSubtotalMinor,
      taxMinor: lineTaxMinor,
    };
  });
  requireSafeNonNegativeInteger(policy.freeShippingThresholdMinor);
  requireSafeNonNegativeInteger(policy.shippingBaseMinor);
  requireSafeNonNegativeInteger(policy.heavyThresholdGrams);
  requireSafeNonNegativeInteger(policy.heavySurchargeMinor);
  const shippingMinor = safeAdd(
    subtotalMinor >= policy.freeShippingThresholdMinor ? 0 : policy.shippingBaseMinor,
    totalWeightGrams > policy.heavyThresholdGrams ? policy.heavySurchargeMinor : 0,
  );
  return {
    lines: calculatedLines,
    subtotalMinor,
    shippingMinor,
    taxMinor,
    totalMinor: safeAdd(safeAdd(subtotalMinor, shippingMinor), taxMinor),
    totalWeightGrams,
  };
}
function asNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
  return number;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: Pick<PaymentProvider, 'createPayment'>,
  ) {}

  async preview(
    token: string | undefined,
    expectedRevision: number | undefined,
    body: CheckoutPreviewDto,
  ): Promise<CheckoutPreviewResponseDto> {
    if (expectedRevision === undefined)
      throw new CheckoutConflictError(
        'CART_REVISION_REQUIRED',
        'The cart revision is required for checkout.',
      );
    const { cart, policy } = await this.loadOpenCart(token);
    if (cart.revision !== expectedRevision)
      throw new CheckoutConflictError(
        'CART_REVISION_CONFLICT',
        'The cart changed since it was last read. Refresh and try again.',
        cart.revision,
      );
    await this.assertCurrentAvailability(cart);
    return this.calculate(cart, policy, body);
  }

  async create(
    token: string | undefined,
    expectedRevision: number | undefined,
    idempotencyKey: string | undefined,
    body: CreateCheckoutDto,
    requestId: string,
  ): Promise<CheckoutResponseDto> {
    if (expectedRevision === undefined)
      throw new CheckoutConflictError(
        'CART_REVISION_REQUIRED',
        'The cart revision is required for checkout.',
      );
    if (!token)
      throw new CheckoutConflictError('CART_NOT_FOUND', 'A current cart is required for checkout.');
    if (!idempotencyKey)
      throw new CheckoutConflictError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'An idempotency key is required for checkout.',
      );
    const cartIdentity = await this.prisma.cart.findUnique({
      where: { tokenDigest: digestCartToken(token) },
      select: { id: true, status: true, revision: true, expiresAt: true, absoluteExpiresAt: true },
    });
    const now = new Date();
    if (!cartIdentity)
      throw new CheckoutConflictError('CART_NOT_FOUND', 'A current cart is required for checkout.');
    const command = {
      idempotencyKey,
      requestId,
      correlationId: requestId,
      actor: { type: 'customer' as const, id: cartIdentity.id, roles: [] },
    };
    const claimResult = await this.idempotency.begin(
      {
        operation: 'checkout.create',
        request: {
          cartId: cartIdentity.id,
          revision: expectedRevision,
          pricingFingerprint: body.pricingFingerprint,
          paymentMethodReference: body.paymentMethodReference,
          shippingAddress: toIdempotencyShippingAddress(body.shippingAddress),
        },
      },
      command,
    );
    if (claimResult.kind === 'replay')
      return this.resumeOrRespond(claimResult.result.id, requestId);
    if (claimResult.kind === 'in-progress')
      throw new CheckoutConflictError(
        'CHECKOUT_IN_PROGRESS',
        'Checkout is already in progress. Retry shortly.',
      );
    if (
      cartIdentity.status === CartStatus.CONVERTED ||
      cartIdentity.expiresAt <= now ||
      cartIdentity.absoluteExpiresAt <= now
    ) {
      await this.idempotency.fail(claimResult.claim, 'CART_NOT_FOUND').catch(() => undefined);
      throw new CheckoutConflictError('CART_NOT_FOUND', 'A current cart is required for checkout.');
    }
    let cart: CheckoutCart;
    let preview: Totals | undefined;
    let orderId: string;
    try {
      const loaded = await this.loadOpenCart(token, true);
      cart = loaded.cart;
      const pendingCart = cart.status === CartStatus.CHECKOUT_PENDING;
      if (!pendingCart && cart.revision !== expectedRevision)
        throw new CheckoutConflictError(
          'CART_REVISION_CONFLICT',
          'The cart changed since it was last read. Refresh and try again.',
          cart.revision,
        );
      preview = pendingCart ? undefined : this.calculate(cart, loaded.policy, body);
      if (preview && preview.pricingFingerprint !== body.pricingFingerprint)
        throw new CheckoutConflictError(
          'PRICING_FINGERPRINT_CONFLICT',
          'Pricing changed. Refresh the checkout preview and try again.',
        );
      if (!preview)
        throw new CheckoutConflictError(
          'CART_CHECKOUT_PENDING',
          'The cart is being checked out. Try again shortly.',
        );
      orderId = await this.withRetry(() =>
        this.createPending(cart.id, expectedRevision, body, claimResult.claim, requestId),
      );
    } catch (error) {
      await this.idempotency
        .fail(
          claimResult.claim,
          error instanceof CheckoutConflictError ? error.code : 'CHECKOUT_RETRYABLE',
        )
        .catch(() => undefined);
      throw error;
    }
    const pending = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { paymentAttempts: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const result = await this.payments.createPayment(
      {
        orderId,
        amount: { amountMinor: pending.totalMinor, currency: 'USD' },
        paymentMethodReference: body.paymentMethodReference,
        metadata: { orderReference: pending.reference },
      },
      {
        idempotencyKey: `checkout-${digestKey({ orderId, payment: body.paymentMethodReference })}`,
        requestId,
        correlationId: requestId,
        actor: { type: 'customer', id: cart.id, roles: [] },
      },
    );
    await this.withRetry(() =>
      this.applyPaymentResult(orderId, result.status, result.paymentId, requestId),
    );
    return this.responseFor(orderId);
  }

  private async loadOpenCart(
    token: string | undefined,
    allowPending = false,
  ): Promise<{ cart: CheckoutCart; policy: CheckoutPolicy }> {
    if (!token)
      throw new CheckoutConflictError('CART_NOT_FOUND', 'A current cart is required for checkout.');
    const now = new Date();
    const cart = await this.prisma.cart.findUnique({
      where: { tokenDigest: digestCartToken(token) },
      include: CHECKOUT_CART_INCLUDE,
    });
    if (
      !cart ||
      cart.expiresAt <= now ||
      cart.absoluteExpiresAt <= now ||
      cart.status === CartStatus.CONVERTED
    )
      throw new CheckoutConflictError('CART_NOT_FOUND', 'A current cart is required for checkout.');
    if (!allowPending && cart.status !== CartStatus.OPEN)
      throw new CheckoutConflictError(
        'CART_CHECKOUT_PENDING',
        'The cart is being checked out. Try again shortly.',
      );
    if (cart.items.length === 0)
      throw new CheckoutConflictError('CART_EMPTY', 'Add an item before checkout.');
    const policy = await this.prisma.commercePolicyVersion.findFirst({
      where: {
        countryCode: 'US',
        currencyCode: 'USD',
        lifecycle: CommercePolicyLifecycle.ACTIVE,
        effectiveFrom: { lte: now },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
      },
      orderBy: { version: 'desc' },
    });
    if (!policy)
      throw new CheckoutConflictError(
        'COMMERCE_POLICY_UNAVAILABLE',
        'Checkout is temporarily unavailable.',
      );
    return { cart, policy };
  }

  private calculate(cart: CheckoutCart, policy: CheckoutPolicy, body: CheckoutPreviewDto): Totals {
    if (body.shippingAddress.countryCode !== 'US')
      throw new CheckoutConflictError(
        'ADDRESS_NOT_SUPPORTED',
        'Only US shipping addresses are supported in this demo.',
      );
    const sourceLines = cart.items.map((item) => {
      const price = item.variant.prices.find(
        (candidate) => candidate.priceBookVersionId === policy.priceBookVersionId,
      );
      if (
        item.variant.status !== CatalogLifecycle.ACTIVE ||
        item.variant.product.status !== CatalogLifecycle.ACTIVE ||
        !price
      )
        throw new CheckoutConflictError(
          'CART_ITEM_UNAVAILABLE',
          'A cart item is no longer available.',
        );
      return {
        variantId: item.variantId,
        quantity: item.quantity,
        unitPriceMinor: asNumber(price.amountMinor),
        weightGrams: item.variant.weightGrams,
      };
    });
    const calculated = calculateUsdCheckoutTotals(sourceLines, policy);
    const pricingFingerprint = hash({
      cartId: cart.id,
      revision: cart.revision,
      policyId: policy.id,
      policyVersion: policy.version,
      priceBookVersionId: policy.priceBookVersionId,
      calculationVersion: policy.calculationVersion,
      shippingBaseMinor: policy.shippingBaseMinor,
      freeShippingThresholdMinor: policy.freeShippingThresholdMinor,
      heavySurchargeMinor: policy.heavySurchargeMinor,
      heavyThresholdGrams: policy.heavyThresholdGrams,
      taxRateBasisPoints: policy.taxRateBasisPoints,
      lines: calculated.lines,
      subtotal: calculated.subtotalMinor,
      shipping: calculated.shippingMinor,
      tax: calculated.taxMinor,
      totalMinor: calculated.totalMinor,
      countryCode: body.shippingAddress.countryCode,
    });
    return {
      policyId: policy.id,
      currency: 'USD',
      policyVersion: policy.version,
      lines: calculated.lines,
      subtotalMinor: calculated.subtotalMinor,
      shippingMinor: calculated.shippingMinor,
      taxMinor: calculated.taxMinor,
      totalMinor: calculated.totalMinor,
      pricingFingerprint,
      taxNotice: TAX_NOTICE,
      totalWeightGrams: calculated.totalWeightGrams,
    };
  }

  private async assertCurrentAvailability(cart: CheckoutCart): Promise<void> {
    const warehouse = await this.resolvePhase3Warehouse(this.prisma);
    const balances = await this.prisma.inventoryBalance.groupBy({
      by: ['variantId'],
      where: {
        variantId: { in: cart.items.map((item) => item.variantId) },
        warehouseId: warehouse.id,
      },
      _sum: { onHand: true, reserved: true, allocated: true, damaged: true },
    });
    const available = new Map(
      balances.map((balance) => [
        balance.variantId,
        (balance._sum.onHand ?? 0) -
          (balance._sum.reserved ?? 0) -
          (balance._sum.allocated ?? 0) -
          (balance._sum.damaged ?? 0),
      ]),
    );
    for (const item of cart.items) {
      if ((available.get(item.variantId) ?? 0) < item.quantity)
        throw new CheckoutConflictError(
          'INSUFFICIENT_STOCK',
          'A cart item no longer has enough available stock.',
        );
    }
  }

  private async resolvePhase3Warehouse(client: PrismaService | Prisma.TransactionClient) {
    const warehouse = await client.warehouse.findUnique({
      where: { code: PHASE_3_WAREHOUSE_CODE },
      select: { id: true, code: true, countryCode: true, status: true },
    });
    if (!warehouse || warehouse.status !== WarehouseStatus.ACTIVE || warehouse.countryCode !== 'US')
      throw new CheckoutConflictError(
        'CHECKOUT_UNAVAILABLE',
        'Checkout is temporarily unavailable.',
      );
    return warehouse;
  }

  private async createPending(
    cartId: string,
    revision: number,
    body: CreateCheckoutDto,
    claim: IdempotencyClaim,
    requestId: string,
  ): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${cartId} FOR UPDATE`;
        const lockedCart = await tx.cart.findUniqueOrThrow({
          where: { id: cartId },
          include: CHECKOUT_CART_INCLUDE,
        });
        if (lockedCart.status !== CartStatus.OPEN || lockedCart.revision !== revision)
          throw new CheckoutConflictError(
            'CART_REVISION_CONFLICT',
            'The cart changed since it was last read. Refresh and try again.',
            lockedCart.revision,
          );
        const variants = [...lockedCart.items].sort((a, b) =>
          a.variantId.localeCompare(b.variantId),
        );
        const variantIds = variants.map((item) => item.variantId);
        if (variantIds.length === 0)
          throw new CheckoutConflictError('CART_EMPTY', 'Add an item before checkout.');
        const warehouse = await this.resolvePhase3Warehouse(tx);
        await tx.$queryRaw`
          SELECT "InventoryBalance"."id"
          FROM "InventoryBalance"
          WHERE "InventoryBalance"."variantId" IN (${Prisma.join(variantIds)})
            AND "InventoryBalance"."warehouseId" = ${warehouse.id}
          ORDER BY "InventoryBalance"."variantId" ASC,
                   "InventoryBalance"."id" ASC
          FOR UPDATE
        `;
        const balances = await tx.inventoryBalance.findMany({
          where: {
            variantId: { in: variantIds },
            warehouseId: warehouse.id,
          },
          orderBy: [{ variantId: 'asc' }, { id: 'asc' }],
        });
        const balancesByVariant = new Map(balances.map((balance) => [balance.variantId, balance]));
        for (const line of variants) {
          const balance = balancesByVariant.get(line.variantId);
          if (
            !balance ||
            balance.onHand - balance.reserved - balance.allocated - balance.damaged < line.quantity
          )
            throw new CheckoutConflictError(
              'INSUFFICIENT_STOCK',
              'A cart item no longer has enough available stock.',
            );
        }
        const [{ now }] = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT CURRENT_TIMESTAMP AS "now"`;
        const policy = await tx.commercePolicyVersion.findFirst({
          where: {
            countryCode: 'US',
            currencyCode: 'USD',
            lifecycle: CommercePolicyLifecycle.ACTIVE,
            effectiveFrom: { lte: now },
            OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
          },
          orderBy: { version: 'desc' },
        });
        if (!policy)
          throw new CheckoutConflictError(
            'COMMERCE_POLICY_UNAVAILABLE',
            'Checkout is temporarily unavailable.',
          );
        const priceBookVersion = await tx.priceBookVersion.findUnique({
          where: { id: policy.priceBookVersionId },
          select: {
            id: true,
            version: true,
            lifecycle: true,
            priceBook: { select: { code: true, marketCode: true, currencyCode: true } },
          },
        });
        if (
          !priceBookVersion ||
          priceBookVersion.lifecycle !== 'ACTIVE' ||
          priceBookVersion.priceBook.code !== 'US-RETAIL' ||
          priceBookVersion.priceBook.marketCode !== 'US' ||
          priceBookVersion.priceBook.currencyCode !== 'USD'
        )
          throw new CheckoutConflictError(
            'COMMERCE_POLICY_UNAVAILABLE',
            'Checkout is temporarily unavailable.',
          );
        const cart = await tx.cart.findUniqueOrThrow({
          where: { id: cartId },
          include: CHECKOUT_CART_INCLUDE,
        });
        if (cart.status !== CartStatus.OPEN || cart.revision !== revision)
          throw new CheckoutConflictError(
            'CART_REVISION_CONFLICT',
            'The cart changed since it was last read. Refresh and try again.',
            cart.revision,
          );
        const authoritativeTotals = this.calculate(cart, policy, body);
        if (authoritativeTotals.pricingFingerprint !== body.pricingFingerprint)
          throw new CheckoutConflictError(
            'PRICING_FINGERPRINT_CONFLICT',
            'Pricing changed. Refresh the checkout preview and try again.',
          );
        const reservation = await tx.inventoryReservation.create({
          data: { expiresAt: new Date(now.getTime() + policy.reservationDurationSeconds * 1000) },
        });
        for (const [sequence, line] of variants.entries()) {
          const balance = balancesByVariant.get(line.variantId);
          if (!balance)
            throw new CheckoutConflictError(
              'INSUFFICIENT_STOCK',
              'A cart item is no longer available.',
            );
          const updated = await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { reserved: { increment: line.quantity }, version: { increment: 1 } },
          });
          await tx.inventoryReservationItem.create({
            data: {
              reservationId: reservation.id,
              warehouseId: balance.warehouseId,
              variantId: line.variantId,
              quantity: line.quantity,
            },
          });
          await tx.inventoryMovement.create({
            data: {
              warehouseId: balance.warehouseId,
              variantId: line.variantId,
              type: InventoryMovementType.RESERVED,
              reservedDelta: line.quantity,
              resultingOnHand: updated.onHand,
              resultingReserved: updated.reserved,
              resultingAllocated: updated.allocated,
              resultingDamaged: updated.damaged,
              commandId: reservation.id,
              commandSequence: sequence + 1,
              actorType: AuditActorType.CUSTOMER,
              actorId: cart.id,
              reason: 'checkout-reservation',
            },
          });
        }
        const reference = `PF-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
        const order = await tx.order.create({
          data: {
            reference,
            cartId,
            policyVersionId: policy.id,
            priceBookVersionId: policy.priceBookVersionId,
            reservationId: reservation.id,
            currencyCode: 'USD',
            subtotalMinor: authoritativeTotals.subtotalMinor,
            shippingMinor: authoritativeTotals.shippingMinor,
            taxMinor: authoritativeTotals.taxMinor,
            totalMinor: authoritativeTotals.totalMinor,
            calculationSnapshot: {
              policyId: policy.id,
              policyVersion: policy.version,
              priceBookVersionId: policy.priceBookVersionId,
              priceBookVersion: priceBookVersion.version,
              currencyCode: 'USD',
              pricingFingerprint: authoritativeTotals.pricingFingerprint,
              shippingBaseMinor: policy.shippingBaseMinor,
              freeShippingThresholdMinor: policy.freeShippingThresholdMinor,
              heavySurchargeMinor: policy.heavySurchargeMinor,
              heavyThresholdGrams: policy.heavyThresholdGrams,
              taxRateBasisPoints: policy.taxRateBasisPoints,
              rounding: 'half-up-per-line',
              calculationVersion: policy.calculationVersion,
              reservationDurationSeconds: policy.reservationDurationSeconds,
              totalWeightGrams: authoritativeTotals.totalWeightGrams,
              simulatedTax: true,
              taxNotice: TAX_NOTICE,
            },
            shippingAddressSnapshot: body.shippingAddress as unknown as Prisma.InputJsonValue,
            lines: {
              create: cart.items.map((item) => {
                const calculated = authoritativeTotals.lines.find(
                  (line) => line.variantId === item.variantId,
                )!;
                return {
                  variantId: item.variantId,
                  productNameSnapshot: item.variant.product.name,
                  variantNameSnapshot: item.variant.name,
                  skuSnapshot: item.variant.sku,
                  optionValuesSnapshot: item.variant.optionValues as Prisma.InputJsonValue,
                  taxClassSnapshot: item.variant.taxClass,
                  weightGramsSnapshot: item.variant.weightGrams,
                  mediaSnapshot: item.variant.product.media.map((media) => ({
                    storageKey: media.storageKey,
                    altText: media.altText,
                    width: media.width,
                    height: media.height,
                  })),
                  quantity: item.quantity,
                  unitPriceMinor: calculated.unitPriceMinor,
                  lineSubtotalMinor: calculated.subtotalMinor,
                  lineTaxMinor: calculated.taxMinor,
                  lineTotalMinor: safeAdd(calculated.subtotalMinor, calculated.taxMinor),
                };
              }),
            },
          },
          include: { lines: true },
        });
        await tx.paymentAttempt.create({
          data: {
            orderId: order.id,
            provider: 'stub',
            paymentMethodReference: body.paymentMethodReference,
            amountMinor: authoritativeTotals.totalMinor,
            currencyCode: 'USD',
          },
        });
        await tx.cart.update({
          where: { id: cartId },
          data: { status: CartStatus.CHECKOUT_PENDING, revision: { increment: 1 } },
        });
        await this.audit.append(
          tx,
          {
            action: 'commerce.checkout.reserved',
            targetType: 'reservation',
            targetId: reservation.id,
            afterMetadata: {
              orderId: order.id,
              policyVersion: policy.version,
              priceBookVersion: priceBookVersion.version,
            },
          },
          {
            idempotencyKey: `checkout-${digestKey({ orderId: order.id, reservationId: reservation.id, outcome: 'reserved' })}`,
            requestId,
            correlationId: requestId,
            actor: { type: 'customer', id: cart.id, roles: [] },
            reason: 'Reserve inventory for checkout.',
          },
        );
        await this.idempotency.complete(tx, claim, {
          type: 'checkout',
          id: order.id,
          responseStatus: 201,
        });
        return order.id;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async applyPaymentResult(
    orderId: string,
    status: 'succeeded' | 'failed' | 'processing' | 'requires_payment_method',
    providerPaymentId: string,
    requestId: string,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const lockedOrder = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { reservationId: true },
        });
        await tx.$queryRaw`SELECT "id" FROM "InventoryReservation" WHERE "id" = ${lockedOrder.reservationId} FOR UPDATE`;
        await tx.$queryRaw`
          SELECT "id"
          FROM "PaymentAttempt"
          WHERE "orderId" = ${orderId}
          ORDER BY "createdAt" DESC, "id" DESC
          FOR UPDATE
        `;
        const order = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          include: {
            lines: true,
            reservation: { include: { items: true } },
            paymentAttempts: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
            fulfillmentGroups: { include: { items: true } },
          },
        });
        const attempt = order.paymentAttempts[0];
        if (!attempt)
          throw new CheckoutConflictError(
            'CHECKOUT_RESULT_CONFLICT',
            'Checkout result could not be applied safely.',
          );
        const reservationItems = [...order.reservation.items].sort(
          (left, right) =>
            left.variantId.localeCompare(right.variantId) ||
            left.warehouseId.localeCompare(right.warehouseId),
        );
        const variantIds = [...new Set(reservationItems.map((item) => item.variantId))];
        const warehouseIds = [...new Set(reservationItems.map((item) => item.warehouseId))];
        if (variantIds.length === 0 || warehouseIds.length === 0)
          throw new CheckoutConflictError(
            'CHECKOUT_RESULT_CONFLICT',
            'Checkout result could not be applied safely.',
          );
        await tx.$queryRaw`
          SELECT "id"
          FROM "InventoryBalance"
          WHERE "variantId" IN (${Prisma.join(variantIds)})
            AND "warehouseId" IN (${Prisma.join(warehouseIds)})
          ORDER BY "variantId" ASC, "warehouseId" ASC, "id" ASC
          FOR UPDATE
        `;
        const balances = await tx.inventoryBalance.findMany({
          where: { variantId: { in: variantIds }, warehouseId: { in: warehouseIds } },
          orderBy: [{ variantId: 'asc' }, { warehouseId: 'asc' }, { id: 'asc' }],
        });
        const balanceByKey = new Map(
          balances.map((balance) => [`${balance.warehouseId}:${balance.variantId}`, balance]),
        );
        const [{ now }] = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT CURRENT_TIMESTAMP AS "now"`;
        const incomingTerminal = status === 'succeeded' || status === 'failed';
        if (attempt.status !== PaymentAttemptStatus.PROCESSING) {
          const sameOutcome =
            (status === 'succeeded' && attempt.status === PaymentAttemptStatus.SUCCEEDED) ||
            (status === 'failed' && attempt.status === PaymentAttemptStatus.FAILED);
          if (!sameOutcome || attempt.providerPaymentId !== providerPaymentId)
            throw new CheckoutConflictError(
              'CHECKOUT_RESULT_CONFLICT',
              'Checkout result could not be applied safely.',
            );
          const committed = attempt.status === PaymentAttemptStatus.SUCCEEDED;
          const expiredFailure =
            !committed &&
            attempt.failureCode === 'RESERVATION_EXPIRED' &&
            order.reservation.status === ReservationStatus.EXPIRED;
          const movementType = committed
            ? InventoryMovementType.RESERVATION_COMMITTED
            : expiredFailure
              ? InventoryMovementType.RESERVATION_EXPIRED
              : InventoryMovementType.RESERVATION_RELEASED;
          const movementCount = await tx.inventoryMovement.count({
            where: { commandId: order.reservationId, type: movementType },
          });
          const hasExpectedFulfillment = committed
            ? order.fulfillmentGroups.some(
                (group) =>
                  group.status === 'ALLOCATED' &&
                  group.items.length === reservationItems.length &&
                  group.items.every((item) =>
                    order.lines.some(
                      (line) => line.id === item.orderLineId && item.quantity === line.quantity,
                    ),
                  ),
              )
            : order.fulfillmentGroups.length === 0;
          const cart = await tx.cart.findUniqueOrThrow({
            where: { id: order.cartId },
            include: { items: true },
          });
          const failedStateComplete =
            order.status === OrderStatus.PENDING_PAYMENT &&
            order.reservation.status ===
              (expiredFailure ? ReservationStatus.EXPIRED : ReservationStatus.RELEASED) &&
            cart.status === CartStatus.OPEN &&
            hasExpectedFulfillment &&
            ((expiredFailure && attempt.failureCode === 'RESERVATION_EXPIRED') ||
              (!expiredFailure && attempt.failureCode !== 'RESERVATION_EXPIRED'));
          const terminalStateComplete =
            movementCount === reservationItems.length &&
            ((committed &&
              order.status === OrderStatus.CONFIRMED &&
              order.reservation.status === ReservationStatus.COMMITTED &&
              hasExpectedFulfillment) ||
              (!committed && failedStateComplete));
          if (
            !terminalStateComplete ||
            (committed && (cart.status !== CartStatus.CONVERTED || cart.items.length !== 0)) ||
            (!committed && cart.status !== CartStatus.OPEN)
          )
            throw new CheckoutConflictError(
              'CHECKOUT_RESULT_CONFLICT',
              'Checkout result could not be applied safely.',
            );
          return;
        }
        if (!incomingTerminal) return;
        const expired = order.reservation.expiresAt <= now;
        const succeeded = status === 'succeeded' && !expired;
        const failedReservationStatus = expired
          ? ReservationStatus.EXPIRED
          : ReservationStatus.RELEASED;
        const failedMovementType = expired
          ? InventoryMovementType.RESERVATION_EXPIRED
          : InventoryMovementType.RESERVATION_RELEASED;
        const failedMovementSequenceBase = expired ? 2000 : 1000;
        const reservationChanged = await tx.inventoryReservation.updateMany({
          where: { id: order.reservationId, status: ReservationStatus.ACTIVE },
          data: {
            status: succeeded ? ReservationStatus.COMMITTED : failedReservationStatus,
          },
        });
        if (reservationChanged.count !== 1)
          throw new CheckoutConflictError(
            'CHECKOUT_RESULT_CONFLICT',
            'Checkout result could not be applied safely.',
          );
        for (const [sequence, item] of reservationItems.entries()) {
          const balance = balanceByKey.get(`${item.warehouseId}:${item.variantId}`);
          if (!balance || balance.reserved < item.quantity)
            throw new CheckoutConflictError(
              'CHECKOUT_RESULT_CONFLICT',
              'Checkout result could not be applied safely.',
            );
          const updated = await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: succeeded
              ? {
                  reserved: { decrement: item.quantity },
                  allocated: { increment: item.quantity },
                  version: { increment: 1 },
                }
              : { reserved: { decrement: item.quantity }, version: { increment: 1 } },
          });
          await tx.inventoryMovement.create({
            data: {
              warehouseId: item.warehouseId,
              variantId: item.variantId,
              type: succeeded ? InventoryMovementType.RESERVATION_COMMITTED : failedMovementType,
              reservedDelta: -item.quantity,
              allocatedDelta: succeeded ? item.quantity : 0,
              resultingOnHand: updated.onHand,
              resultingReserved: updated.reserved,
              resultingAllocated: updated.allocated,
              resultingDamaged: updated.damaged,
              commandId: order.reservationId,
              commandSequence: (succeeded ? 1000 : failedMovementSequenceBase) + sequence,
              actorType: AuditActorType.SYSTEM,
              actorId: 'checkout',
              reason: succeeded ? 'payment-succeeded' : 'payment-failed',
            },
          });
        }
        const changed = await tx.paymentAttempt.updateMany({
          where: { id: attempt.id, status: PaymentAttemptStatus.PROCESSING },
          data: {
            status: succeeded ? PaymentAttemptStatus.SUCCEEDED : PaymentAttemptStatus.FAILED,
            providerPaymentId,
            providerReference: providerPaymentId,
            failureCode: succeeded ? null : expired ? 'RESERVATION_EXPIRED' : 'PAYMENT_DECLINED',
          },
        });
        if (changed.count !== 1)
          throw new CheckoutConflictError(
            'CHECKOUT_RESULT_CONFLICT',
            'Checkout result could not be applied safely.',
          );
        if (succeeded) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.CONFIRMED },
          });
          const group = await tx.fulfillmentGroup.create({
            data: { orderId: order.id, warehouseId: order.reservation.items[0]!.warehouseId },
          });
          await tx.fulfillmentGroupItem.createMany({
            data: reservationItems.map((item) => ({
              fulfillmentGroupId: group.id,
              orderLineId: order.lines.find((line) => line.variantId === item.variantId)!.id,
              quantity: item.quantity,
            })),
          });
          await tx.cartItem.deleteMany({ where: { cartId: order.cartId } });
          await tx.cart.update({
            where: { id: order.cartId },
            data: { status: CartStatus.CONVERTED, revision: { increment: 1 } },
          });
        } else
          await tx.cart.update({
            where: { id: order.cartId },
            data: { status: CartStatus.OPEN, revision: { increment: 1 } },
          });
        const commandKey = digestKey({
          orderId,
          providerPaymentId,
          outcome: succeeded ? 'succeeded' : 'failed',
        }).slice(0, 64);
        await this.audit.append(
          tx,
          {
            action: succeeded ? 'commerce.order.confirmed' : 'commerce.payment.failed',
            targetType: 'order',
            targetId: order.id,
            afterMetadata: { outcome: succeeded ? 'confirmed' : 'paymentFailed' },
          },
          {
            idempotencyKey: `checkout-${commandKey}`,
            requestId,
            correlationId: requestId,
            actor: { type: 'system', id: 'checkout', roles: [] },
            reason: succeeded
              ? 'Apply local payment-stub success.'
              : 'Apply local payment-stub failure.',
          },
        );
        await tx.outboxMessage.create({
          data: {
            eventType: succeeded ? 'commerce.order.confirmed' : 'commerce.payment.failed',
            eventVersion: 1,
            aggregateType: 'order',
            aggregateId: order.id,
            payload: {
              orderId: order.id,
              orderReference: order.reference,
              outcome: succeeded ? 'confirmed' : 'payment_failed',
            },
            correlationId: requestId,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async responseFor(orderId: string): Promise<CheckoutResponseDto> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        lines: true,
        policyVersion: true,
        reservation: true,
        fulfillmentGroups: true,
        paymentAttempts: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const payment = order.paymentAttempts[0];
    return {
      orderId: order.id,
      orderReference: order.reference,
      currency: 'USD',
      policyVersion: order.policyVersion.version,
      lines: order.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceMinor: asNumber(line.unitPriceMinor),
        subtotalMinor: asNumber(line.lineSubtotalMinor),
        taxMinor: asNumber(line.lineTaxMinor),
      })),
      subtotalMinor: asNumber(order.subtotalMinor),
      shippingMinor: asNumber(order.shippingMinor),
      taxMinor: asNumber(order.taxMinor),
      totalMinor: asNumber(order.totalMinor),
      pricingFingerprint:
        typeof order.calculationSnapshot === 'object' &&
        order.calculationSnapshot !== null &&
        'pricingFingerprint' in order.calculationSnapshot
          ? String(order.calculationSnapshot.pricingFingerprint)
          : '',
      taxNotice: TAX_NOTICE,
      orderStatus: order.status === OrderStatus.CONFIRMED ? 'confirmed' : 'pending_payment',
      paymentStatus:
        payment?.status === PaymentAttemptStatus.SUCCEEDED
          ? 'succeeded'
          : payment?.status === PaymentAttemptStatus.FAILED
            ? 'failed'
            : 'processing',
      reservationStatus:
        order.reservation.status === ReservationStatus.COMMITTED
          ? 'committed'
          : order.reservation.status === ReservationStatus.RELEASED
            ? 'released'
            : order.reservation.status === ReservationStatus.EXPIRED
              ? 'expired'
              : 'active',
      fulfillmentStatus:
        order.fulfillmentGroups[0]?.status === 'ALLOCATED'
          ? 'allocated'
          : order.fulfillmentGroups[0]?.status === 'PICKING'
            ? 'picking'
            : order.fulfillmentGroups[0]?.status === 'PACKED'
              ? 'packed'
              : order.fulfillmentGroups[0]?.status === 'SHIPPED'
                ? 'shipped'
                : order.fulfillmentGroups[0]?.status === 'DELIVERED'
                  ? 'delivered'
                  : null,
      reservationExpiresAt: order.reservation.expiresAt.toISOString(),
      checkoutStatus:
        order.status === OrderStatus.CONFIRMED
          ? 'confirmed'
          : payment?.status === PaymentAttemptStatus.FAILED
            ? 'payment_failed'
            : 'pending_payment',
    };
  }

  private async resumeOrRespond(orderId: string, requestId: string): Promise<CheckoutResponseDto> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { paymentAttempts: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const attempt = order.paymentAttempts[0];
    if (
      order.status === OrderStatus.PENDING_PAYMENT &&
      attempt?.status === PaymentAttemptStatus.PROCESSING
    ) {
      const result = await this.payments.createPayment(
        {
          orderId,
          amount: { amountMinor: order.totalMinor, currency: 'USD' },
          paymentMethodReference: attempt.paymentMethodReference,
          metadata: { orderReference: order.reference },
        },
        {
          idempotencyKey: `checkout-${digestKey({ orderId, payment: attempt.paymentMethodReference })}`,
          requestId,
          correlationId: requestId,
          actor: { type: 'customer', id: order.cartId, roles: [] },
        },
      );
      await this.withRetry(() =>
        this.applyPaymentResult(orderId, result.status, result.paymentId, requestId),
      );
    }
    return this.responseFor(orderId);
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    return withCheckoutTransactionRetry(operation);
  }
}

export const CHECKOUT_RETRY_DELAYS_MS = [0, 10, 25] as const;

export async function withCheckoutTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (const delay of CHECKOUT_RETRY_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      last = error;
    }
  }
  throw last ?? new Error('Checkout transaction failed after retry attempts.');
}

/** Prisma reports PostgreSQL serialization failures as P2034; drivers may expose SQLSTATE directly. */
export function isRetryableTransactionError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (typeof current === 'string') {
      if (/\b(?:40001|40P01)\b/u.test(current)) return true;
      continue;
    }
    if (typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    const record = current as Record<string, unknown>;
    for (const key of ['code', 'originalCode', 'sqlState', 'sqlstate', 'errorCode']) {
      const value = record[key];
      if (typeof value === 'string' && ['P2034', '40001', '40P01'].includes(value)) return true;
    }
    const meta = record.meta;
    if (meta && typeof meta === 'object') pending.push(meta);
    if (record.cause) pending.push(record.cause);
    if (record.originalError) pending.push(record.originalError);
    if (typeof record.message === 'string') pending.push(record.message);
  }
  return false;
}
