'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { API_ORIGIN } from '../catalog/catalog-types';
import { StorefrontShell } from '../../components/storefront-shell';
import { cartUrl, type Cart } from '../cart/cart-types';
import {
  checkoutRequestBody,
  checkoutRequiresNewPreview,
  guestOrderUrl,
  type CheckoutPreview,
  type CheckoutResult,
  type ShippingAddress,
  type StubPaymentChoice,
} from './checkout-payment';
import styles from './page.module.css';
import {
  DESTINATIONS,
  destinationMarket,
  formatMoney,
  marketUrl,
  MARKET_LABELS,
  type Destination,
} from '../../lib/market';
import { CartMarketReview } from '../../components/cart-market-review';
import type { InternationalMarketCode } from '@pulse-field/contracts';

const StripePaymentStep = dynamic(() => import('./stripe-payment-step'), {
  ssr: false,
  loading: () => (
    <p className="state" role="status">
      Loading secure payment form…
    </p>
  ),
});

const blankAddress: ShippingAddress = {
  fullName: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  countryCode: 'US',
};

function newIdempotencyKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export default function CheckoutPage() {
  const [targetMarket, setTargetMarket] = useState<InternationalMarketCode | null>(null);
  const destinationInitialized = useRef(false);
  const attempt = useRef<{ body: string; etag: string; key: string } | null>(null);
  const [retryLocked, setRetryLocked] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [cart, setCart] = useState<Cart | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [address, setAddress] = useState(blankAddress);
  const [customerEmail, setCustomerEmail] = useState('');
  const [preview, setPreview] = useState<CheckoutPreview | null>(null);
  const [choice, setChoice] = useState<StubPaymentChoice>('stub-success');
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [state, setState] = useState<'loading' | 'ready' | 'submitting' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [paymentSubmitted, setPaymentSubmitted] = useState(false);
  const [returnedFromPayment, setReturnedFromPayment] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(cartUrl(), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('CART');
      const loaded = (await response.json()) as Cart;
      setCart(loaded);
      if (!destinationInitialized.current)
        setAddress((current) => ({
          ...current,
          countryCode:
            loaded.market === 'UK' ? 'GB' : loaded.market === 'EU' ? 'DE' : loaded.market,
        }));
      destinationInitialized.current = true;
      setEtag(response.headers.get('etag'));
      setState('ready');
    } catch {
      setState('error');
      setMessage('Checkout is unavailable. Start the local API and try again.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('payment_return') !== '1') return;
    window.history.replaceState(null, '', window.location.pathname);
    setReturnedFromPayment(true);
  }, []);
  const update = (key: keyof typeof blankAddress, value: string) => {
    setAddress((current) => ({ ...current, [key]: key === 'state' ? value.toUpperCase() : value }));
    setPreview(null);
    setIdempotencyKey(newIdempotencyKey());
  };
  async function requestPreview(event: FormEvent) {
    event.preventDefault();
    if (retryLocked || previewPending) return;
    setPreview(null);
    setMessage('');
    if (!etag) {
      setMessage('Refresh the current cart before previewing checkout.');
      return;
    }
    if (cart && destinationMarket(address.countryCode) !== cart.market) {
      setTargetMarket(destinationMarket(address.countryCode));
      return;
    }
    setPreviewPending(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/v1/checkouts/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'If-Match': etag,
        },
        body: JSON.stringify({ shippingAddress: address }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => ({}))) as {
          code?: string;
          requiredMarket?: InternationalMarketCode;
        };
        if (problem.code === 'CART_MARKET_MISMATCH' && problem.requiredMarket)
          setTargetMarket(problem.requiredMarket);
        throw new Error('PREVIEW');
      }
      const nextPreview = (await response.json()) as CheckoutPreview;
      if (preview?.pricingFingerprint !== nextPreview.pricingFingerprint)
        setIdempotencyKey(newIdempotencyKey());
      setPreview(nextPreview);
    } catch {
      setMessage(
        'Preview unavailable. Review the address and cart. Regional payments require the local stub; Stripe supports US/USD only.',
      );
    } finally {
      setPreviewPending(false);
    }
  }
  async function submit() {
    if (!preview || !etag || state === 'submitting' || targetMarket || cart?.hasUnavailableItems)
      return;
    attempt.current ??= {
      body: JSON.stringify(checkoutRequestBody(address, customerEmail, preview, choice)),
      etag,
      key: idempotencyKey,
    };
    const currentAttempt = attempt.current;
    setRetryLocked(true);
    setState('submitting');
    setMessage('');
    try {
      const response = await fetch(`${API_ORIGIN}/api/v1/checkouts`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'If-Match': currentAttempt.etag,
          'Idempotency-Key': currentAttempt.key,
        },
        body: currentAttempt.body,
      });
      const payload = (await response.json().catch(() => ({}))) as CheckoutResult & {
        detail?: string;
        code?: string;
      };
      if (!response.ok) {
        if (checkoutRequiresNewPreview(response.status, payload.code)) {
          attempt.current = null;
          setRetryLocked(false);
          setPreview(null);
          setIdempotencyKey(newIdempotencyKey());
          await load();
          setMessage('Checkout was rejected. Review a new authoritative total.');
          return;
        }
        throw new Error(
          'The outcome is uncertain or temporarily unavailable. Retry the same order; keep this page open.',
        );
      }
      setResult(payload);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The outcome is uncertain. Retry the same order; keep this page open.',
      );
    } finally {
      setState('ready');
    }
  }
  if (state === 'loading')
    return (
      <main className="catalog-shell">
        <p className="state" role="status">
          Loading checkout…
        </p>
      </main>
    );
  if (
    returnedFromPayment ||
    paymentSubmitted ||
    (result?.paymentProvider === 'stripe' && !result.paymentConfiguration)
  )
    return (
      <main className="catalog-shell">
        <section className="state" aria-live="polite">
          <p className="eyebrow">
            {result?.orderReference ? `Order ${result.orderReference}` : 'Payment return'}
          </p>
          <h1>Payment verification pending.</h1>
          <p>
            {returnedFromPayment
              ? 'The browser returned from the secure payment flow. This return is not payment evidence.'
              : 'The test payment was submitted for server verification.'}{' '}
            The order will be confirmed only after the server verifies webhook or reconciliation
            evidence.
          </p>
          <p className="detail-note">
            Do not submit another order while verification is in progress.
          </p>
          {result ? (
            <Link
              href={guestOrderUrl(result.orderReference, result.guestOrderAccessToken)}
              className="text-link"
            >
              View order status →
            </Link>
          ) : null}
          <Link
            href={marketUrl('/catalog', result?.market ?? cart?.market ?? 'US')}
            className="text-link"
          >
            Return to catalog →
          </Link>
        </section>
      </main>
    );
  if (result?.paymentProvider === 'stripe' && result.paymentConfiguration)
    return (
      <main className="catalog-shell">
        <StripePaymentStep
          publishableKey={result.paymentConfiguration.publishableKey}
          clientSecret={result.paymentConfiguration.clientSecret}
          orderReference={result.orderReference}
          guestOrderAccessToken={result.guestOrderAccessToken}
          onSubmitted={() => {
            setResult((current) =>
              current ? { ...current, paymentConfiguration: undefined } : current,
            );
            setPaymentSubmitted(true);
          }}
        />
      </main>
    );
  if (result)
    return (
      <main className="catalog-shell">
        <section className="state" aria-live="polite">
          <p className="eyebrow">Order {result.orderReference}</p>
          <h1>
            {result.checkoutStatus === 'confirmed' ? 'Order confirmed.' : 'Payment declined.'}
          </h1>
          <p>
            {result.checkoutStatus === 'confirmed'
              ? 'The local demo payment succeeded and inventory is allocated.'
              : 'No payment was taken. Your cart is open so you can choose again.'}
          </p>
          <Link
            href={guestOrderUrl(result.orderReference, result.guestOrderAccessToken)}
            className="text-link"
          >
            View order timeline →
          </Link>
          <Link
            href={marketUrl('/catalog', result?.market ?? cart?.market ?? 'US')}
            className="text-link"
          >
            Continue shopping →
          </Link>
        </section>
      </main>
    );
  return (
    <StorefrontShell>
      <main className={styles.page}>
        <header className={styles.header}>
          <Link href="/cart" className={styles.backLink}>
            ← Back to cart
          </Link>
          <p className="eyebrow">Guest checkout / {cart ? MARKET_LABELS[cart.market] : ''}</p>
          <h1>Checkout</h1>
          <p className="detail-note">
            {preview?.paymentProvider === 'stripe'
              ? 'Stripe test-mode card payment. Simulated tax is not tax advice.'
              : 'Demo-only payment choices. Simulated tax is not tax advice.'}
          </p>
        </header>
        {message ? (
          <p className="cart-message state-error" role="alert">
            {message}
          </p>
        ) : null}
        {targetMarket && etag ? (
          <CartMarketReview
            market={targetMarket}
            etag={etag}
            onCancel={() => {
              setTargetMarket(null);
              setPreview(null);
              void load();
            }}
            onConfirmed={(next, nextEtag) => {
              window.history.replaceState(
                null,
                '',
                marketUrl(window.location.pathname + window.location.search, next.market),
              );
              setCart(next);
              setEtag(nextEtag);
              setTargetMarket(null);
              setPreview(null);
              setIdempotencyKey(newIdempotencyKey());
              setMessage('Market changed. Preview the authoritative total again.');
            }}
          />
        ) : null}
        {retryLocked ? (
          <p role="status">
            Keep this page open. Delivery and payment choices are locked until the same order has a
            known outcome.
          </p>
        ) : null}
        <div className="cart-layout">
          <form className="cart-summary" onSubmit={(event) => void requestPreview(event)}>
            <h2>Shipping address</h2>
            <fieldset
              disabled={
                retryLocked || state === 'submitting' || previewPending || targetMarket !== null
              }
            >
              <legend>Delivery details</legend>
              <label className="quantity-control">
                Destination country
                <select
                  aria-label="Destination country"
                  value={address.countryCode}
                  onChange={(event) => update('countryCode', event.target.value as Destination)}
                >
                  {Object.entries(DESTINATIONS).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="quantity-control">
                Email for order confirmation
                <input
                  required
                  type="email"
                  autoComplete="email"
                  maxLength={255}
                  value={customerEmail}
                  onChange={(event) => {
                    setCustomerEmail(event.target.value);
                    setIdempotencyKey(newIdempotencyKey());
                  }}
                />
              </label>
              {(['fullName', 'line1', 'line2', 'city', 'state', 'postalCode'] as const).map(
                (field) => (
                  <label className="quantity-control" key={field}>
                    {field === 'line1'
                      ? 'Address'
                      : field === 'line2'
                        ? 'Address line 2 (optional)'
                        : field === 'fullName'
                          ? 'Full name'
                          : field === 'postalCode'
                            ? 'Postal code'
                            : field[0].toUpperCase() + field.slice(1)}
                    <input
                      required={
                        field !== 'line2' && (field !== 'state' || address.countryCode === 'US')
                      }
                      maxLength={
                        field === 'state' && address.countryCode === 'US'
                          ? 2
                          : field === 'postalCode'
                            ? 16
                            : 160
                      }
                      value={address[field]}
                      onChange={(event) => update(field, event.target.value)}
                    />
                  </label>
                ),
              )}
              <p>
                State is required for US destinations and optional elsewhere. Postal code must match
                the selected country. Address checks do not verify deliverability.
              </p>
              <button type="submit">
                {previewPending ? 'Calculating…' : 'Preview authoritative total'}
              </button>
            </fieldset>
          </form>
          <aside className="cart-summary">
            <p className="eyebrow">Authoritative total</p>
            {preview ? (
              <>
                <p>Merchandise: {formatMoney(preview.subtotalMinor, preview.currency)}</p>
                <p>Shipping: {formatMoney(preview.shippingMinor, preview.currency)}</p>
                <p>Simulated tax: {formatMoney(preview.taxMinor, preview.currency)}</p>
                <h2>{formatMoney(preview.totalMinor, preview.currency)}</h2>
                <p className="detail-note">{preview.taxNotice}</p>
                {preview.paymentProvider === 'stub' ? (
                  <fieldset disabled={retryLocked || state === 'submitting'}>
                    <legend>Demo payment result</legend>
                    <label>
                      <input
                        type="radio"
                        checked={choice === 'stub-success'}
                        onChange={() => {
                          setChoice('stub-success');
                          setIdempotencyKey(newIdempotencyKey());
                        }}
                      />{' '}
                      Success
                    </label>
                    <label>
                      <input
                        type="radio"
                        checked={choice === 'stub-decline'}
                        onChange={() => {
                          setChoice('stub-decline');
                          setIdempotencyKey(newIdempotencyKey());
                        }}
                      />{' '}
                      Decline
                    </label>
                  </fieldset>
                ) : (
                  <p className="payment-provider-note">
                    Secure card fields open after the server reserves inventory and prepares the
                    test PaymentIntent.
                  </p>
                )}
                <button
                  type="button"
                  disabled={
                    state === 'submitting' || targetMarket !== null || cart?.hasUnavailableItems
                  }
                  onClick={() => void submit()}
                >
                  {state === 'submitting'
                    ? 'Preparing…'
                    : retryLocked
                      ? 'Retry same order'
                      : preview.paymentProvider === 'stripe'
                        ? 'Continue to secure payment'
                        : 'Place demo order'}
                </button>
              </>
            ) : (
              <p>
                Prices exclude simulated tax. Enter a supported address to calculate server-owned
                totals.
              </p>
            )}{' '}
            {cart?.hasUnavailableItems ? (
              <p className="availability unavailable">
                Return to the cart and resolve unavailable items.
              </p>
            ) : null}
          </aside>
        </div>
      </main>
    </StorefrontShell>
  );
}
