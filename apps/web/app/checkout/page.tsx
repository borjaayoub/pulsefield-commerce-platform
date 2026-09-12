'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { API_ORIGIN } from '../catalog/catalog-types';
import { cartUrl, formatUsd, type Cart } from '../cart/cart-types';

type Preview = {
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  pricingFingerprint: string;
  taxNotice: string;
};
type Result = Preview & {
  orderReference: string;
  checkoutStatus: 'confirmed' | 'payment_failed' | 'pending_payment';
};
const blankAddress = {
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
  const [cart, setCart] = useState<Cart | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [address, setAddress] = useState(blankAddress);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choice, setChoice] = useState<'stub-success' | 'stub-decline'>('stub-success');
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [state, setState] = useState<'loading' | 'ready' | 'submitting' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(cartUrl(), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('CART');
      setCart((await response.json()) as Cart);
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
  const update = (key: keyof typeof blankAddress, value: string) => {
    setAddress((current) => ({ ...current, [key]: key === 'state' ? value.toUpperCase() : value }));
    setPreview(null);
    setIdempotencyKey(newIdempotencyKey());
  };
  async function requestPreview(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    if (!etag) {
      setMessage('Refresh the current cart before previewing checkout.');
      return;
    }
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
      if (!response.ok) throw new Error('PREVIEW');
      const nextPreview = (await response.json()) as Preview;
      if (preview?.pricingFingerprint !== nextPreview.pricingFingerprint)
        setIdempotencyKey(newIdempotencyKey());
      setPreview(nextPreview);
    } catch {
      setMessage('Review the US address and try the authoritative preview again.');
    }
  }
  async function submit() {
    if (!preview || !etag || state === 'submitting') return;
    setState('submitting');
    setMessage('');
    try {
      const response = await fetch(`${API_ORIGIN}/api/v1/checkouts`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'If-Match': etag,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          shippingAddress: address,
          pricingFingerprint: preview.pricingFingerprint,
          paymentMethodReference: choice,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as Result & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? 'CHECKOUT');
      setResult(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Checkout could not be completed.');
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
          <Link href="/catalog" className="text-link">
            Continue shopping →
          </Link>
        </section>
      </main>
    );
  return (
    <main className="catalog-shell">
      <nav className="catalog-nav" aria-label="Primary navigation">
        <Link href="/" className="wordmark">
          PULSE//FIELD
        </Link>
        <Link href="/cart" className="text-link">
          Back to cart
        </Link>
      </nav>
      <header className="catalog-header">
        <p className="eyebrow">Guest checkout / United States · USD</p>
        <h1>Checkout.</h1>
        <p className="detail-note">Demo-only payment choices. Simulated tax is not tax advice.</p>
      </header>
      {message ? (
        <p className="cart-message state-error" role="alert">
          {message}
        </p>
      ) : null}
      <div className="cart-layout">
        <form className="cart-summary" onSubmit={(event) => void requestPreview(event)}>
          <h2>US shipping address</h2>
          {(['fullName', 'line1', 'line2', 'city', 'state', 'postalCode'] as const).map((field) => (
            <label className="quantity-control" key={field}>
              {field === 'line1'
                ? 'Address'
                : field === 'line2'
                  ? 'Address line 2 (optional)'
                  : field === 'fullName'
                    ? 'Full name'
                    : field[0].toUpperCase() + field.slice(1)}
              <input
                required={field !== 'line2'}
                maxLength={field === 'state' ? 2 : 160}
                value={address[field]}
                onChange={(event) => update(field, event.target.value)}
              />
            </label>
          ))}
          <button type="submit">Preview authoritative total</button>
        </form>
        <aside className="cart-summary">
          <p className="eyebrow">Authoritative total</p>
          {preview ? (
            <>
              <p>Merchandise: {formatUsd(preview.subtotalMinor)}</p>
              <p>Shipping: {formatUsd(preview.shippingMinor)}</p>
              <p>Simulated tax: {formatUsd(preview.taxMinor)}</p>
              <h2>{formatUsd(preview.totalMinor)}</h2>
              <p className="detail-note">{preview.taxNotice}</p>
              <fieldset>
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
              <button type="button" disabled={state === 'submitting'} onClick={() => void submit()}>
                {state === 'submitting' ? 'Submitting…' : 'Place demo order'}
              </button>
            </>
          ) : (
            <p>Enter a US address to calculate server-owned totals.</p>
          )}{' '}
          {cart?.hasUnavailableItems ? (
            <p className="availability unavailable">
              Return to the cart and resolve unavailable items.
            </p>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
