'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { StorefrontShell } from '../../components/storefront-shell';
import {
  Cart,
  canAdjustCartQuantity,
  cartQuantityLimit,
  cartUrl,
  clampCartQuantity,
} from './cart-types';
import styles from './page.module.css';
import { MARKETS, MARKET_LABELS, formatMoney, marketUrl } from '../../lib/market';
import type { InternationalMarketCode } from '@pulse-field/contracts';
import { CartMarketReview } from '../../components/cart-market-review';

export default function CartPage() {
  const [targetMarket, setTargetMarket] = useState<InternationalMarketCode | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [pendingVariantId, setPendingVariantId] = useState<string | null>(null);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<string | null> => {
    setState('loading');
    try {
      const response = await fetch(cartUrl(), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('CART_UNAVAILABLE');
      const nextCart = (await response.json()) as Cart;
      setCart(nextCart);
      setQuantityDrafts(
        Object.fromEntries(nextCart.items.map((item) => [item.variantId, String(item.quantity)])),
      );
      setEtag(response.headers.get('etag'));
      setState('ready');
      return response.headers.get('etag');
    } catch {
      setState('error');
      return null;
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function remove(variantId: string) {
    if (!etag || pendingVariantId) return;
    setPendingVariantId(variantId);
    setMessage(null);
    try {
      const response = await fetch(`${cartUrl()}/items/${variantId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json', 'If-Match': etag },
      });
      if (response.status === 204) {
        setEtag(response.headers.get('etag'));
        await load();
        return;
      }
      setMessage(
        response.status === 409
          ? 'This cart changed in another tab. Refreshing…'
          : 'Unable to update the cart.',
      );
      await load();
    } catch {
      setMessage('Unable to update the cart. Try again.');
    } finally {
      setPendingVariantId(null);
    }
  }

  async function updateQuantity(variantId: string): Promise<void> {
    if (!etag || pendingVariantId || !cart) return;
    const item = cart.items.find((candidate) => candidate.variantId === variantId);
    if (!item || !canAdjustCartQuantity(item)) return;
    const quantity = clampCartQuantity(Number(quantityDrafts[variantId]), item.available);
    if (quantity === null) {
      setMessage('Enter a whole-number quantity between 1 and the available stock.');
      return;
    }
    setQuantityDrafts((current) => ({ ...current, [variantId]: String(quantity) }));
    setPendingVariantId(variantId);
    setMessage(null);
    let currentEtag = etag;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${cartUrl()}/items/${variantId}`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'If-Match': currentEtag,
          },
          body: JSON.stringify({ quantity }),
        });
        if (response.ok) {
          const nextCart = (await response.json()) as Cart;
          setCart(nextCart);
          setQuantityDrafts((current) => ({
            ...current,
            [variantId]: String(
              nextCart.items.find((line) => line.variantId === variantId)?.quantity ?? quantity,
            ),
          }));
          setEtag(response.headers.get('etag'));
          setMessage('Cart updated.');
          return;
        }
        if ((response.status === 409 || response.status === 428) && attempt === 0) {
          currentEtag = (await load()) ?? currentEtag;
          continue;
        }
        const problem = (await response.json().catch(() => ({}))) as {
          availableQuantity?: number;
        };
        if (response.status === 409 && typeof problem.availableQuantity === 'number') {
          setMessage(
            `Only ${problem.availableQuantity} units are currently available. Quantity was not changed.`,
          );
        } else if (response.status === 409 || response.status === 428) {
          setMessage('The cart changed in another tab. Please review the refreshed cart.');
        } else {
          setMessage('Unable to update the cart. Try again.');
        }
        await load();
        return;
      }
    } catch {
      setMessage('Unable to update the cart. Try again.');
    } finally {
      setPendingVariantId(null);
    }
  }

  if (state === 'loading')
    return (
      <StorefrontShell>
        <main className={styles.page}>
          <p className="state" role="status">
            Loading cart…
          </p>
        </main>
      </StorefrontShell>
    );
  if (state === 'error')
    return (
      <StorefrontShell>
        <main className={styles.page}>
          <section className="state state-error" role="alert">
            <h1>Cart unavailable</h1>
            <p>Start the local API and try again.</p>
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </section>
        </main>
      </StorefrontShell>
    );

  return (
    <StorefrontShell>
      <main className={styles.page}>
        <header className={styles.header}>
          <Link href={marketUrl('/catalog', cart?.market ?? 'US')} className={styles.backLink}>
            ← Continue shopping
          </Link>
          <p className={styles.eyebrow}>
            Your selection / {cart ? MARKET_LABELS[cart.market] : ''}
          </p>
          <h1>Your cart</h1>
          {cart?.items.length ? (
            <p>
              {cart.items.length} {cart.items.length === 1 ? 'item' : 'items'} ready to review.
            </p>
          ) : null}
        </header>
        {message ? (
          <p id="cart-status" className="state-error cart-message" role="status" aria-live="polite">
            {message}
          </p>
        ) : null}
        {cart && etag ? (
          <>
            <label>
              Cart market{' '}
              <select
                aria-label="Cart market"
                value={targetMarket ?? cart.market}
                disabled={pendingVariantId !== null || targetMarket !== null}
                onChange={(event) => setTargetMarket(event.target.value as InternationalMarketCode)}
              >
                {MARKETS.map((market) => (
                  <option key={market} value={market}>
                    {MARKET_LABELS[market]}
                  </option>
                ))}
              </select>
            </label>
            <p>Prices exclude simulated tax.</p>
            {targetMarket ? (
              <CartMarketReview
                market={targetMarket}
                etag={etag}
                onCancel={() => {
                  setTargetMarket(null);
                  void load();
                }}
                onConfirmed={(next, nextEtag) => {
                  setTargetMarket(null);
                  window.history.replaceState(
                    null,
                    '',
                    marketUrl(window.location.pathname + window.location.search, next.market),
                  );
                  setCart(next);
                  setEtag(nextEtag);
                  setQuantityDrafts(
                    Object.fromEntries(
                      next.items.map((item) => [item.variantId, String(item.quantity)]),
                    ),
                  );
                }}
              />
            ) : null}
          </>
        ) : null}
        {!cart || cart.items.length === 0 ? (
          <section className="state">
            <h2>Your cart is clear.</h2>
            <p>Choose a piece from the local catalog to begin.</p>
            <Link href={marketUrl('/catalog', cart?.market ?? 'US')} className="text-link">
              Browse catalog →
            </Link>
          </section>
        ) : (
          <section className="cart-layout" aria-label="Shopping cart">
            <div className="cart-items">
              {cart.items.map((item) => (
                <article className="cart-item" key={item.id}>
                  <div className={styles.itemMedia}>
                    {item.media ? (
                      <img src={item.media.url} alt={item.media.altText} />
                    ) : (
                      <span aria-hidden="true">PULSE//FIELD</span>
                    )}
                  </div>
                  <div>
                    <p className="product-category">
                      {Object.values(item.optionValues).join(' / ')}
                    </p>
                    <h2>{item.productName}</h2>
                    <p>
                      {item.name} · {item.available} currently available
                    </p>
                    <div className="cart-quantity-control">
                      <label className="quantity-control" htmlFor={`quantity-${item.variantId}`}>
                        <span>Quantity</span>
                      </label>
                      <div className="quantity-actions">
                        <input
                          id={`quantity-${item.variantId}`}
                          type="number"
                          min={1}
                          max={Math.max(1, cartQuantityLimit(item.available))}
                          value={quantityDrafts[item.variantId] ?? String(item.quantity)}
                          aria-describedby={message ? 'cart-status' : undefined}
                          disabled={
                            !canAdjustCartQuantity(item) ||
                            pendingVariantId !== null ||
                            targetMarket !== null
                          }
                          onChange={(event) =>
                            setQuantityDrafts((current) => ({
                              ...current,
                              [item.variantId]: event.target.value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          disabled={
                            !canAdjustCartQuantity(item) ||
                            pendingVariantId !== null ||
                            targetMarket !== null
                          }
                          onClick={() => void updateQuantity(item.variantId)}
                        >
                          {pendingVariantId === item.variantId ? 'Updating…' : 'Update'}
                        </button>
                      </div>
                      {!item.purchasable && canAdjustCartQuantity(item) ? (
                        <span className="availability unavailable">
                          Reduce to {item.available} or less to continue.
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="cart-item-price">
                    {item.currentLinePriceMinor === null ? (
                      <span className="availability unavailable">Unavailable</span>
                    ) : (
                      formatMoney(item.currentLinePriceMinor, item.currency)
                    )}
                    <button
                      type="button"
                      disabled={pendingVariantId !== null || targetMarket !== null}
                      onClick={() => void remove(item.variantId)}
                    >
                      {pendingVariantId === item.variantId ? 'Updating…' : 'Remove'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <aside className="cart-summary">
              <p className="eyebrow">Server total</p>
              <h2>
                {cart.totalMinor === null ? '—' : formatMoney(cart.totalMinor, cart.currency)}
              </h2>
              {cart.hasUnavailableItems ? (
                <p className="availability unavailable">
                  Remove unavailable items before checkout becomes available.
                </p>
              ) : null}
              <Link
                href={marketUrl('/checkout', cart.market)}
                className="text-link"
                aria-disabled={cart.hasUnavailableItems || targetMarket !== null}
                onClick={(event) => {
                  if (cart.hasUnavailableItems || targetMarket) event.preventDefault();
                }}
              >
                Continue to checkout →
              </Link>
              <p className="detail-note">
                Taxes are simulated for this local demo and are not tax advice.
              </p>
            </aside>
          </section>
        )}
      </main>
    </StorefrontShell>
  );
}
