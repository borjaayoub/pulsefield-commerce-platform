import { Inject, Injectable } from '@nestjs/common';
import {
  resolveInternationalConfigurationInTransaction,
  type ResolvedInternationalConfiguration,
} from './international-commerce-configuration.reader';
import {
  calculateInternationalCommerce,
  InternationalCommerceCalculationError,
} from './international-commerce.calculation';
import { destinationMarket, validPostalCode } from './shipping-address.validation';
import type {
  PaymentProvider,
  SupportedCurrency,
  InternationalCommerceCalculationResult,
} from '@pulse-field/contracts';
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
} from '../generated/prisma/enums';
import { IdempotencyService, type IdempotencyClaim } from '../idempotency/idempotency.service';
import { AuditService } from '../audit/audit.service';
import {
  appendRealtimeInvalidation,
  INVENTORY_INVALIDATED_EVENT,
} from '../realtime/realtime.events';
import { digestCartToken } from '../cart/cart-cookie';
import { PaymentApplicationService } from '../payments/payment-application.service';
import {
  PaymentOutcomeConflictError,
  PaymentOutcomeService,
} from '../payments/payment-outcome.service';
import {
  PaymentProviderRejectedError,
  PaymentProviderUnavailableError,
} from '../payments/stripe-payment.provider';
import {
  CheckoutConflictError,
  CheckoutPaymentUnavailableError,
  CheckoutRequestError,
  CheckoutMarketMismatchError,
  RegionalPaymentProviderUnavailableError,
} from './checkout.errors';
import type {
  CreateCheckoutDto,
  CheckoutPreviewDto,
  CheckoutPreviewResponseDto,
  CheckoutResponseDto,
} from './checkout.dto';
import { OrderTimelineService } from '../orders/order-timeline.service';
import { normalizeEmail } from '../identity/normalize-email';
import {
  inventoryBalanceKey,
  InventoryAllocationPolicyUnavailableError,
  lockInventoryAllocation,
  readInventoryAllocation,
} from '../inventory/inventory-allocation.persistence';

type CheckoutPayments = Pick<PaymentProvider, 'createPayment'> &
  Partial<Pick<PaymentApplicationService, 'initialAttemptStatus' | 'provider' | 'publishableKey'>>;

const TAX_NOTICE = 'Simulated tax for this local demo only; not tax advice.';
const UNSAFE_CHECKOUT_VALUE_MESSAGE = 'Checkout is temporarily unavailable.';

const CHECKOUT_CART_INCLUDE = {
  items: {
    orderBy: { variantId: 'asc' as const },
    include: {
      variant: {
        include: {
          prices: true,
          product: {
            include: { media: { where: { status: 'ACTIVE' }, orderBy: { position: 'asc' } } },
          },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;
type CheckoutCart = Prisma.CartGetPayload<{ include: typeof CHECKOUT_CART_INCLUDE }>;

type Totals = Omit<CheckoutPreviewResponseDto, 'paymentProvider'> & {
  calculation: InternationalCommerceCalculationResult;
  configuration: ResolvedInternationalConfiguration;
  totalWeightGrams: number;
};
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
  countryCode: string;
} {
  return {
    fullName: address.fullName,
    line1: address.line1,
    line2: address.line2 ?? '',
    city: address.city,
    state: address.state ?? '',
    postalCode: address.postalCode.trim().toUpperCase(),
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
export function supportedOrderCurrency(value: string): SupportedCurrency {
  if (value !== 'USD' && value !== 'MAD' && value !== 'EUR' && value !== 'GBP')
    throw new CheckoutPaymentUnavailableError();
  return value;
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
    @Inject(PaymentApplicationService) private readonly payments: CheckoutPayments,
    @Inject(OrderTimelineService)
    private readonly orderTimeline: Pick<OrderTimelineService, 'issue'> = {
      issue: async () => ({ token: 'test-only-guest-order-token', expiresAt: new Date(0) }),
    },
    private readonly paymentOutcomes: PaymentOutcomeService = new PaymentOutcomeService(
      prisma,
      audit,
    ),
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
    return this.prisma.$transaction(
      async (tx) => {
        const { cart, configuration } = await this.loadOpenCart(tx, token, body);
        if (cart.revision !== expectedRevision)
          throw new CheckoutConflictError(
            'CART_REVISION_CONFLICT',
            'The cart changed since it was last read. Refresh and try again.',
            cart.revision,
          );
        await this.assertCurrentAvailability(tx, cart, configuration);
        return this.publicTotals(this.calculate(cart, configuration, body));
      },
      { isolationLevel: 'RepeatableRead' },
    );
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
    this.assertPaymentRequest(body.paymentMethodReference);
    const cartIdentity = await this.prisma.cart.findUnique({
      where: { tokenDigest: digestCartToken(token) },
      select: {
        id: true,
        marketCode: true,
        status: true,
        revision: true,
        expiresAt: true,
        absoluteExpiresAt: true,
      },
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
    const input = {
      operation: 'checkout.create',
      request: {
        cartId: cartIdentity.id,
        revision: expectedRevision,
        pricingFingerprint: body.pricingFingerprint,
        paymentProvider: this.configuredPaymentProvider,
        paymentMethodReference: body.paymentMethodReference ?? null,
        customerEmail: normalizeEmail(body.customerEmail),
        shippingAddress: toIdempotencyShippingAddress(body.shippingAddress),
      },
    };
    const retained = await this.idempotency.retainedResult(input, command);
    if (retained) return this.resumeOrRespond(retained.id, requestId);
    if (cartIdentity.status === CartStatus.OPEN) {
      await this.prisma.$transaction(
        async (tx) => {
          const loaded = await this.loadOpenCart(tx, token, body);
          if (loaded.cart.revision !== expectedRevision)
            throw new CheckoutConflictError(
              'CART_REVISION_CONFLICT',
              'The cart changed since it was last read. Refresh and try again.',
              loaded.cart.revision,
            );
          const totals = this.calculate(loaded.cart, loaded.configuration, body);
          if (totals.pricingFingerprint !== body.pricingFingerprint)
            throw new CheckoutConflictError(
              'PRICING_FINGERPRINT_CONFLICT',
              'Pricing changed. Refresh the checkout preview and try again.',
            );
          await this.assertCurrentAvailability(tx, loaded.cart, loaded.configuration);
        },
        { isolationLevel: 'RepeatableRead' },
      );
    }
    const claimResult = await this.idempotency.begin(input, command);
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
      const loaded = await this.prisma.$transaction(
        (tx) => this.loadOpenCart(tx, token, body, true),
        { isolationLevel: 'RepeatableRead' },
      );
      cart = loaded.cart;
      const pendingCart = cart.status === CartStatus.CHECKOUT_PENDING;
      if (!pendingCart && cart.revision !== expectedRevision)
        throw new CheckoutConflictError(
          'CART_REVISION_CONFLICT',
          'The cart changed since it was last read. Refresh and try again.',
          cart.revision,
        );
      preview = pendingCart ? undefined : this.calculate(cart, loaded.configuration, body);
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
    return this.preparePayment(pending, requestId);
  }

  private get configuredPaymentProvider(): 'stub' | 'stripe' {
    return this.payments.provider ?? 'stub';
  }

  private assertPaymentRequest(reference: CreateCheckoutDto['paymentMethodReference']): void {
    if (
      (this.configuredPaymentProvider === 'stub' && reference === undefined) ||
      (this.configuredPaymentProvider === 'stripe' && reference !== undefined)
    ) {
      throw new CheckoutRequestError();
    }
  }

  private async preparePayment(
    order: {
      id: string;
      cartId: string;
      reference: string;
      totalMinor: bigint;
      currencyCode: string;
      paymentAttempts: Array<{
        id: string;
        status: PaymentAttemptStatus;
        provider: string;
        paymentMethodReference: string;
        providerPaymentId: string | null;
      }>;
    },
    requestId: string,
  ): Promise<CheckoutResponseDto> {
    const attempt = order.paymentAttempts[0];
    if (!attempt || attempt.provider !== this.configuredPaymentProvider) {
      throw new CheckoutPaymentUnavailableError();
    }
    try {
      const result = await this.payments.createPayment(
        {
          orderId: order.id,
          amount: {
            amountMinor: order.totalMinor,
            currency: supportedOrderCurrency(order.currencyCode),
          },
          ...(this.configuredPaymentProvider === 'stub'
            ? { paymentMethodReference: attempt.paymentMethodReference }
            : {}),
          ...(attempt.providerPaymentId ? { providerPaymentId: attempt.providerPaymentId } : {}),
          metadata: {
            paymentAttemptId: attempt.id,
            orderReference: order.reference,
          },
        },
        {
          idempotencyKey: `checkout-${digestKey({ orderId: order.id, attemptId: attempt.id })}`,
          requestId,
          correlationId: requestId,
          actor: { type: 'customer', id: order.cartId, roles: [] },
        },
      );
      if (this.configuredPaymentProvider === 'stripe') {
        await this.attachProviderIdentity(attempt.id, result.paymentId);
        if (!result.clientSecret || !this.payments.publishableKey) {
          throw new CheckoutPaymentUnavailableError();
        }
        return this.responseFor(order.id, {
          publishableKey: this.payments.publishableKey,
          clientSecret: result.clientSecret,
        });
      }
      if (result.status !== 'succeeded' && result.status !== 'failed')
        return this.responseFor(order.id);
      const terminalStatus = result.status;
      await this.withRetry(() =>
        this.paymentOutcomes.apply({
          orderId: order.id,
          paymentAttemptId: attempt.id,
          status: terminalStatus,
          providerPaymentId: result.paymentId,
          requestId,
        }),
      );
      return this.responseFor(order.id);
    } catch (error) {
      if (error instanceof PaymentOutcomeConflictError) {
        throw new CheckoutConflictError(
          'CHECKOUT_RESULT_CONFLICT',
          'Checkout result could not be applied safely.',
        );
      }
      if (this.configuredPaymentProvider !== 'stripe') throw error;
      if (error instanceof PaymentProviderRejectedError) {
        await this.withRetry(() =>
          this.paymentOutcomes.apply({
            orderId: order.id,
            paymentAttemptId: attempt.id,
            status: 'failed',
            requestId,
            failureCode: 'PAYMENT_PROVIDER_REJECTED',
          }),
        );
      }
      if (
        error instanceof PaymentProviderRejectedError ||
        error instanceof PaymentProviderUnavailableError ||
        error instanceof CheckoutPaymentUnavailableError
      ) {
        throw new CheckoutPaymentUnavailableError();
      }
      throw error;
    }
  }

  private async attachProviderIdentity(
    attemptId: string,
    providerPaymentId: string,
  ): Promise<void> {
    const changed = await this.prisma.paymentAttempt.updateMany({
      where: {
        id: attemptId,
        provider: 'stripe',
        status: PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD,
        providerPaymentId: null,
      },
      data: { providerPaymentId, providerReference: providerPaymentId },
    });
    if (changed.count === 1) return;
    const current = await this.prisma.paymentAttempt.findUnique({
      where: { id: attemptId },
      select: { providerPaymentId: true, status: true },
    });
    if (
      current?.providerPaymentId !== providerPaymentId ||
      (current.status !== PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD &&
        current.status !== PaymentAttemptStatus.PROCESSING)
    ) {
      throw new CheckoutPaymentUnavailableError();
    }
  }

  private async loadOpenCart(
    tx: Prisma.TransactionClient,
    token: string | undefined,
    body: CheckoutPreviewDto,
    allowPending = false,
  ): Promise<{ cart: CheckoutCart; configuration: ResolvedInternationalConfiguration }> {
    if (!token)
      throw new CheckoutConflictError('CART_NOT_FOUND', 'A current cart is required for checkout.');
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const cart = await tx.cart.findUnique({
      where: { tokenDigest: digestCartToken(token) },
      include: CHECKOUT_CART_INCLUDE,
    });
    if (
      !cart ||
      cart.expiresAt <= clock.now ||
      cart.absoluteExpiresAt <= clock.now ||
      cart.status === CartStatus.CONVERTED
    )
      throw new CheckoutConflictError('CART_NOT_FOUND', 'A current cart is required for checkout.');
    if (!allowPending && cart.status !== CartStatus.OPEN)
      throw new CheckoutConflictError(
        'CART_CHECKOUT_PENDING',
        'The cart is being checked out. Try again shortly.',
      );
    this.assertDestination(cart, body);
    if (!cart.items.length)
      throw new CheckoutConflictError('CART_EMPTY', 'Add an item before checkout.');
    const configuration = await resolveInternationalConfigurationInTransaction(
      tx,
      body.shippingAddress.countryCode,
    );
    return { cart, configuration };
  }

  private assertDestination(
    cart: Pick<CheckoutCart, 'marketCode' | 'revision'>,
    body: CheckoutPreviewDto,
  ): void {
    const address = toIdempotencyShippingAddress(body.shippingAddress);
    const market = destinationMarket(address.countryCode);
    if (
      !market ||
      !validPostalCode(address.countryCode, address.postalCode) ||
      (address.countryCode === 'US' && !/^[A-Z]{2}$/u.test(address.state))
    )
      throw new CheckoutRequestError();
    if (market !== cart.marketCode)
      throw new CheckoutMarketMismatchError(cart.marketCode, market, cart.revision);
    if (this.configuredPaymentProvider === 'stripe' && market !== 'US')
      throw new RegionalPaymentProviderUnavailableError();
  }

  private calculate(
    cart: CheckoutCart,
    configuration: ResolvedInternationalConfiguration,
    body: CheckoutPreviewDto,
  ): Totals {
    this.assertDestination(cart, body);
    const sourceLines = cart.items.map((item) => {
      const price = item.variant.prices.find(
        (candidate) => candidate.priceBookVersionId === configuration.priceBookVersionId,
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
        currency: configuration.currency,
        unitPriceMinor: asNumber(price.amountMinor),
        weightGrams: item.variant.weightGrams,
      };
    });
    let calculation: InternationalCommerceCalculationResult;
    try {
      calculation = calculateInternationalCommerce({
        version: 1,
        market: configuration.market,
        currency: configuration.currency,
        lines: sourceLines,
        policy: configuration.policy,
        reportingRate: configuration.reportingRate,
      });
    } catch (error) {
      if (error instanceof InternationalCommerceCalculationError)
        throw new CheckoutConflictError('CHECKOUT_UNAVAILABLE', UNSAFE_CHECKOUT_VALUE_MESSAGE);
      throw error;
    }
    const pricingFingerprint = hash({
      cartId: cart.id,
      revision: cart.revision,
      address: toIdempotencyShippingAddress(body.shippingAddress),
      configuration,
      calculation,
    });
    return {
      configuration,
      calculation,
      currency: configuration.currency,
      market: configuration.market,
      configurationId: configuration.policy.configurationId,
      taxTreatment: 'exclusive',
      policyVersion: configuration.policy.configurationVersion,
      lines: calculation.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        subtotalMinor: line.subtotalMinor,
        taxMinor: line.taxMinor,
      })),
      subtotalMinor: calculation.subtotalMinor,
      shippingMinor: calculation.shippingMinor,
      taxMinor: calculation.taxMinor,
      totalMinor: calculation.totalMinor,
      totalWeightGrams: calculation.totalWeightGrams,
      pricingFingerprint,
      taxNotice: TAX_NOTICE,
    };
  }

  private publicTotals(totals: Totals): CheckoutPreviewResponseDto {
    return {
      paymentProvider: this.configuredPaymentProvider,
      currency: totals.currency,
      market: totals.market,
      configurationId: totals.configurationId,
      taxTreatment: totals.taxTreatment,
      policyVersion: totals.policyVersion,
      lines: totals.lines,
      subtotalMinor: totals.subtotalMinor,
      shippingMinor: totals.shippingMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      pricingFingerprint: totals.pricingFingerprint,
      taxNotice: totals.taxNotice,
    };
  }

  private async assertCurrentAvailability(
    tx: Prisma.TransactionClient,
    cart: CheckoutCart,
    configuration: ResolvedInternationalConfiguration,
  ): Promise<void> {
    let decision: Awaited<ReturnType<typeof readInventoryAllocation>>;
    try {
      decision = await readInventoryAllocation(
        tx,
        cart.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
        configuration.allocationPolicyVersionId,
      );
    } catch (error) {
      if (error instanceof InventoryAllocationPolicyUnavailableError)
        throw new CheckoutConflictError(
          'CHECKOUT_UNAVAILABLE',
          'Checkout is temporarily unavailable.',
        );
      throw error;
    }
    if (!decision)
      throw new CheckoutConflictError(
        'INSUFFICIENT_STOCK',
        'A cart item no longer has enough available stock.',
      );
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
        this.assertDestination(lockedCart, body);
        const configuration = await resolveInternationalConfigurationInTransaction(
          tx,
          body.shippingAddress.countryCode,
        );
        if (lockedCart.status !== CartStatus.OPEN || lockedCart.revision !== revision)
          throw new CheckoutConflictError(
            'CART_REVISION_CONFLICT',
            'The cart changed since it was last read. Refresh and try again.',
            lockedCart.revision,
          );
        const variants = [...lockedCart.items].sort((a, b) =>
          a.variantId.localeCompare(b.variantId),
        );
        if (variants.length === 0)
          throw new CheckoutConflictError('CART_EMPTY', 'Add an item before checkout.');
        let allocationDecision: Awaited<ReturnType<typeof lockInventoryAllocation>>;
        try {
          allocationDecision = await lockInventoryAllocation(
            tx,
            variants.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
            configuration.allocationPolicyVersionId,
          );
        } catch (error) {
          if (error instanceof InventoryAllocationPolicyUnavailableError) {
            throw new CheckoutConflictError(
              'CHECKOUT_UNAVAILABLE',
              'Checkout is temporarily unavailable.',
            );
          }
          throw error;
        }
        if (!allocationDecision)
          throw new CheckoutConflictError(
            'INSUFFICIENT_STOCK',
            'A cart item no longer has enough available stock.',
          );
        const [{ now }] = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT CURRENT_TIMESTAMP AS "now"`;
        if (lockedCart.expiresAt <= now || lockedCart.absoluteExpiresAt <= now)
          throw new CheckoutConflictError(
            'CART_NOT_FOUND',
            'A current cart is required for checkout.',
          );
        const priceBookVersion = await tx.priceBookVersion.findUniqueOrThrow({
          where: { id: configuration.priceBookVersionId },
          select: { version: true },
        });
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
        const authoritativeTotals = this.calculate(cart, configuration, body);
        if (authoritativeTotals.pricingFingerprint !== body.pricingFingerprint)
          throw new CheckoutConflictError(
            'PRICING_FINGERPRINT_CONFLICT',
            'Pricing changed. Refresh the checkout preview and try again.',
          );
        const reservation = await tx.inventoryReservation.create({
          data: {
            expiresAt: new Date(now.getTime() + configuration.reservationDurationSeconds * 1000),
            allocationPolicyVersionId: allocationDecision.policyVersionId,
          },
        });
        for (const [sequence, allocation] of allocationDecision.allocations.entries()) {
          const balance = allocationDecision.balancesByKey.get(
            inventoryBalanceKey(allocation.warehouseId, allocation.variantId),
          );
          if (!balance)
            throw new CheckoutConflictError(
              'INSUFFICIENT_STOCK',
              'A cart item is no longer available.',
            );
          const updated = await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { reserved: { increment: allocation.quantity }, version: { increment: 1 } },
          });
          await tx.inventoryReservationItem.create({
            data: {
              reservationId: reservation.id,
              warehouseId: balance.warehouseId,
              variantId: allocation.variantId,
              quantity: allocation.quantity,
            },
          });
          await tx.inventoryMovement.create({
            data: {
              warehouseId: balance.warehouseId,
              variantId: allocation.variantId,
              type: InventoryMovementType.RESERVED,
              reservedDelta: allocation.quantity,
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
          await appendRealtimeInvalidation(tx, {
            type: INVENTORY_INVALIDATED_EVENT,
            aggregateType: 'inventory-balance',
            resourceId: updated.id,
            resourceVersion: updated.version,
            correlationId: requestId,
            causationId: claim.recordId,
          });
        }
        const reference = `PF-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
        const order = await tx.order.create({
          data: {
            reference,
            cartId,
            commerceMarketVersionId: configuration.policy.configurationId,
            reportingRateVersionId: configuration.reportingRate.revisionId,
            priceBookVersionId: configuration.priceBookVersionId,
            reservationId: reservation.id,
            currencyCode: configuration.currency,
            subtotalMinor: authoritativeTotals.subtotalMinor,
            shippingMinor: authoritativeTotals.shippingMinor,
            taxMinor: authoritativeTotals.taxMinor,
            totalMinor: authoritativeTotals.totalMinor,
            reportingSubtotalMinor: authoritativeTotals.calculation.reporting.subtotalMinor,
            reportingShippingMinor: authoritativeTotals.calculation.reporting.shippingMinor,
            reportingTaxMinor: authoritativeTotals.calculation.reporting.taxMinor,
            reportingTotalMinor: authoritativeTotals.calculation.reporting.totalMinor,
            reportingRoundingAdjustmentMinor:
              authoritativeTotals.calculation.reporting.roundingAdjustmentMinor,
            calculationSnapshot: {
              schemaVersion: 2,
              ...(JSON.parse(
                JSON.stringify(authoritativeTotals.calculation),
              ) as Prisma.InputJsonObject),
              priceBookVersionId: configuration.priceBookVersionId,
              priceBookVersion: priceBookVersion.version,
              allocationPolicyVersionId: configuration.allocationPolicyVersionId,
              countryCode: body.shippingAddress.countryCode,
              reservationDurationSeconds: configuration.reservationDurationSeconds,
              pricingFingerprint: authoritativeTotals.pricingFingerprint,
              simulatedTax: true,
              taxNotice: TAX_NOTICE,
            },
            shippingAddressSnapshot: toIdempotencyShippingAddress(body.shippingAddress),
            customerEmailNormalized: normalizeEmail(body.customerEmail),
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
            provider: this.configuredPaymentProvider,
            status: this.payments.initialAttemptStatus ?? PaymentAttemptStatus.PROCESSING,
            paymentMethodReference: body.paymentMethodReference ?? 'stripe-card',
            amountMinor: authoritativeTotals.totalMinor,
            currencyCode: configuration.currency,
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
              policyVersion: configuration.policy.configurationVersion,
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

  private async responseFor(
    orderId: string,
    paymentConfiguration?: { publishableKey: string; clientSecret: string },
  ): Promise<CheckoutResponseDto> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        lines: true,
        policyVersion: true,
        commerceMarketVersion: { include: { market: true } },
        reservation: true,
        fulfillmentGroups: true,
        paymentAttempts: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const payment = order.paymentAttempts[0];
    if (!payment || (payment.provider !== 'stub' && payment.provider !== 'stripe')) {
      throw new CheckoutPaymentUnavailableError();
    }
    const guestAccess = await this.orderTimeline.issue(order.id);
    return {
      orderId: order.id,
      orderReference: order.reference,
      currency: supportedOrderCurrency(order.currencyCode),
      policyVersion: order.policyVersion?.version ?? order.commerceMarketVersion!.version,
      ...(order.commerceMarketVersion
        ? {
            market: order.commerceMarketVersion.market
              .code as InternationalCommerceCalculationResult['market'],
            configurationId: order.commerceMarketVersionId!,
            taxTreatment: 'exclusive' as const,
          }
        : {}),
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
      paymentProvider: payment.provider,
      paymentStatus:
        payment?.status === PaymentAttemptStatus.SUCCEEDED
          ? 'succeeded'
          : payment?.status === PaymentAttemptStatus.FAILED
            ? 'failed'
            : payment?.status === PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD
              ? 'requires_payment_method'
              : 'processing',
      ...(paymentConfiguration &&
      payment.provider === 'stripe' &&
      (payment.status === PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD ||
        payment.status === PaymentAttemptStatus.PROCESSING)
        ? { paymentConfiguration }
        : {}),
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
      guestOrderAccessToken: guestAccess.token,
      guestOrderAccessExpiresAt: guestAccess.expiresAt.toISOString(),
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
      attempt &&
      (attempt.status === PaymentAttemptStatus.REQUIRES_PAYMENT_METHOD ||
        attempt.status === PaymentAttemptStatus.PROCESSING)
    ) {
      return this.preparePayment(order, requestId);
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
