import {
  checkoutRequestBody,
  guestOrderUrl,
  safePaymentErrorMessage,
  stripeReturnUrl,
  type CheckoutPreview,
} from './checkout-payment';

const address = {
  fullName: 'Demo Buyer',
  line1: '1 Test Street',
  line2: '',
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  countryCode: 'US' as const,
};

function preview(paymentProvider: CheckoutPreview['paymentProvider']): CheckoutPreview {
  return {
    paymentProvider,
    subtotalMinor: 1000,
    shippingMinor: 0,
    taxMinor: 80,
    totalMinor: 1080,
    pricingFingerprint: 'fingerprint',
    taxNotice: 'Demo only.',
  };
}

describe('checkout payment browser boundary', () => {
  it('sends a stub outcome only when the server selected the stub provider', () => {
    expect(checkoutRequestBody(address, preview('stub'), 'stub-decline')).toEqual({
      shippingAddress: address,
      pricingFingerprint: 'fingerprint',
      paymentMethodReference: 'stub-decline',
    });
  });

  it('cannot send a browser-selected provider or stub reference to Stripe checkout', () => {
    expect(checkoutRequestBody(address, preview('stripe'), 'stub-success')).toEqual({
      shippingAddress: address,
      pricingFingerprint: 'fingerprint',
    });
  });

  it('keeps immediate provider errors bounded and rejects unsafe messages', () => {
    expect(safePaymentErrorMessage('  Your card number is incomplete.  ')).toBe(
      'Your card number is incomplete.',
    );
    expect(safePaymentErrorMessage('x'.repeat(181))).toBe(
      'Check your payment details and try again.',
    );
    expect(safePaymentErrorMessage('invalid\nmessage')).toBe('invalid message');
    expect(safePaymentErrorMessage(undefined)).toBe('Check your payment details and try again.');
  });

  it('keeps guest access in a URL fragment', () => {
    expect(guestOrderUrl('PF-TEST0001', 'grant.signature')).toBe(
      '/orders/PF-TEST0001#access=grant.signature',
    );
  });

  it('sends no guest credential in the Stripe return URL', () => {
    expect(stripeReturnUrl('http://localhost:3000', 'PF-TEST0001')).toBe(
      'http://localhost:3000/orders/PF-TEST0001?payment_return=1',
    );
  });
});
