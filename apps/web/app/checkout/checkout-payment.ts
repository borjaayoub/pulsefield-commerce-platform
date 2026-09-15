export type CheckoutPaymentProvider = 'stub' | 'stripe';
export type StubPaymentChoice = 'stub-success' | 'stub-decline';

export type ShippingAddress = {
  fullName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: 'US';
};

export type CheckoutPreview = {
  paymentProvider: CheckoutPaymentProvider;
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  pricingFingerprint: string;
  taxNotice: string;
};

export type CheckoutResult = CheckoutPreview & {
  orderId: string;
  orderReference: string;
  checkoutStatus: 'confirmed' | 'payment_failed' | 'pending_payment';
  orderStatus: 'pending_payment' | 'confirmed';
  paymentStatus: 'requires_payment_method' | 'processing' | 'succeeded' | 'failed';
  paymentConfiguration?: { publishableKey: string; clientSecret: string };
  guestOrderAccessToken: string;
  guestOrderAccessExpiresAt: string;
};

export function guestOrderUrl(reference: string, token: string): string {
  return `/orders/${encodeURIComponent(reference)}#access=${encodeURIComponent(token)}`;
}

export function stripeReturnUrl(origin: string, reference: string): string {
  return `${origin}/orders/${encodeURIComponent(reference)}?payment_return=1`;
}

export function checkoutRequestBody(
  address: ShippingAddress,
  customerEmail: string,
  preview: CheckoutPreview,
  choice: StubPaymentChoice,
): {
  shippingAddress: ShippingAddress;
  customerEmail: string;
  pricingFingerprint: string;
  paymentMethodReference?: StubPaymentChoice;
} {
  return {
    shippingAddress: address,
    customerEmail,
    pricingFingerprint: preview.pricingFingerprint,
    ...(preview.paymentProvider === 'stub' ? { paymentMethodReference: choice } : {}),
  };
}

export function safePaymentErrorMessage(message: unknown): string {
  if (typeof message !== 'string') return 'Check your payment details and try again.';
  const normalized = message.replace(/\s+/gu, ' ').trim();
  const containsControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > 180 || containsControlCharacter) {
    return 'Check your payment details and try again.';
  }
  return normalized;
}
