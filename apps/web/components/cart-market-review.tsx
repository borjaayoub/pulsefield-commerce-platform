'use client';

import type { InternationalMarketCode } from '@pulse-field/contracts';
import { useEffect, useState } from 'react';
import { cartUrl, type Cart } from '../app/cart/cart-types';
import { formatMoney, MARKET_LABELS } from '../lib/market';

export function CartMarketReview({
  market,
  etag,
  onConfirmed,
  onCancel,
}: Readonly<{
  market: InternationalMarketCode;
  etag: string;
  onConfirmed: (cart: Cart, etag: string) => void;
  onCancel: () => void;
}>) {
  const [preview, setPreview] = useState<{ cart: Cart; pricingFingerprint: string } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError('');
    void fetch(`${cartUrl()}/market-preview`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify({ market }),
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('Unable to reprice. Cancel and refresh the cart before trying again.');
        const value = (await response.json()) as { cart: Cart; pricingFingerprint: string };
        if (!cancelled) setPreview(value);
      })
      .catch(() => {
        if (!cancelled)
          setError('Market preview unavailable. Cancel and refresh before trying again.');
      });
    return () => {
      cancelled = true;
    };
  }, [market, etag]);
  async function confirm() {
    if (!preview || pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`${cartUrl()}/market`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag },
        body: JSON.stringify({ market, pricingFingerprint: preview.pricingFingerprint }),
      });
      const nextEtag = response.headers.get('etag');
      if (!response.ok || !nextEtag) throw new Error('STALE');
      onConfirmed((await response.json()) as Cart, nextEtag);
    } catch {
      setPreview(null);
      setError(
        'The cart or prices changed, or confirmation could not be verified. Cancel and refresh before reviewing again.',
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="cart-summary" aria-label="Review market change" aria-live="polite">
      <h2>Review market change</h2>
      <p>{MARKET_LABELS[market]}</p>
      <p>
        Prices exclude simulated tax. Confirm to change your cart; unavailable lines remain for
        removal.
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : preview ? (
        <>
          <ul>
            {preview.cart.items.map((item) => (
              <li key={item.id}>
                {item.productName} · {item.name} · {item.quantity} ×{' '}
                {item.currentUnitPriceMinor === null
                  ? 'Unpriced'
                  : formatMoney(item.currentUnitPriceMinor, item.currency)}{' '}
                ·{' '}
                {item.currentLinePriceMinor === null
                  ? 'Unavailable'
                  : formatMoney(item.currentLinePriceMinor, item.currency)}
                {!item.purchasable ? ' · Unavailable for checkout' : ''}
              </li>
            ))}
          </ul>
          <p>
            Merchandise:{' '}
            {preview.cart.subtotalMinor === null
              ? 'Unavailable'
              : formatMoney(preview.cart.subtotalMinor, preview.cart.currency)}
          </p>
          <button type="button" disabled={pending} onClick={() => void confirm()}>
            {pending ? 'Confirming…' : 'Confirm market change'}
          </button>
        </>
      ) : (
        <p role="status">Loading repriced cart…</p>
      )}
      <button type="button" disabled={pending} onClick={onCancel}>
        Cancel market change
      </button>
    </section>
  );
}
