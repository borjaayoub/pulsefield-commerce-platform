'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { StorefrontShell } from '../../../components/storefront-shell';
import { API_ORIGIN, CatalogProduct, CatalogVariant } from '../catalog-types';
import styles from './page.module.css';
import { formatMoney, marketUrl } from '../../../lib/market';
import { CartMarketReview } from '../../../components/cart-market-review';
import type { Cart } from '../../cart/cart-types';

function variantLabel(variant: CatalogVariant): string {
  return Object.values(variant.optionValues).join(' / ');
}

export default function ProductClient({ product }: Readonly<{ product: CatalogProduct }>) {
  const market = product.market;
  const [marketEtag, setMarketEtag] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    () =>
      product.variants.find((variant) => variant.inStock)?.id ?? product.variants[0]?.id ?? null,
  );
  const [quantity, setQuantity] = useState(1);
  const [cartMessage, setCartMessage] = useState<string | null>(null);
  const [pendingVariantId, setPendingVariantId] = useState<string | null>(null);

  const selectedVariant = useMemo(
    () => product?.variants.find((variant) => variant.id === selectedVariantId) ?? null,
    [product, selectedVariantId],
  );

  async function addToCart(): Promise<void> {
    if (!selectedVariant || pendingVariantId || marketEtag) return;
    setPendingVariantId(selectedVariant.id);
    setCartMessage(null);
    try {
      let cartResponse = await fetch(`${API_ORIGIN}/api/v1/cart`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!cartResponse.ok) throw new Error('CART_UNAVAILABLE');
      let etag = cartResponse.headers.get('etag');
      const currentCart = (await cartResponse.json()) as Cart;
      if (currentCart.market !== market) {
        setMarketEtag(etag);
        setCartMessage('Review the market change before adding this product.');
        return;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${API_ORIGIN}/api/v1/cart/items/${selectedVariant.id}`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(etag ? { 'If-Match': etag } : {}),
          },
          body: JSON.stringify({ quantity }),
        });
        if (response.ok) {
          setCartMessage('Added to cart.');
          return;
        }
        if ((response.status === 409 || response.status === 428) && attempt === 0) {
          cartResponse = await fetch(`${API_ORIGIN}/api/v1/cart`, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
          });
          if (!cartResponse.ok) throw new Error('CART_UNAVAILABLE');
          etag = cartResponse.headers.get('etag');
          const refreshed = (await cartResponse.json()) as Cart;
          if (refreshed.market !== market) {
            setMarketEtag(etag);
            return;
          }
          continue;
        }
        const problem = (await response.json().catch(() => ({}))) as { availableQuantity?: number };
        setCartMessage(
          response.status === 409 && problem.availableQuantity !== undefined
            ? `Only ${problem.availableQuantity} units are currently available.`
            : response.status === 409 || response.status === 428
              ? 'The cart changed in another tab. Refresh the page and try again.'
              : 'Unable to update the cart. Try again.',
        );
        return;
      }
    } catch {
      setCartMessage('Unable to update the cart. Try again.');
    } finally {
      setPendingVariantId(null);
    }
  }

  const media = product.media[0];
  const selectedPrice = selectedVariant
    ? formatMoney(selectedVariant.priceMinor, selectedVariant.currency)
    : null;
  return (
    <StorefrontShell>
      <main className={styles.page}>
        <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
          <Link href={marketUrl('/', market)}>Home</Link>
          <span>/</span>
          <Link href={marketUrl('/catalog', market)}>Shop</Link>
          <span>/</span>
          <span>{product.name}</span>
        </nav>
        <div className={styles.layout}>
          <section className={styles.media} aria-label={`${product.name} imagery`}>
            {media ? (
              <img src={media.url} alt={media.altText} />
            ) : (
              <div className={styles.mediaPlaceholder} aria-hidden="true">
                PULSE//FIELD
              </div>
            )}
          </section>
          <section className={styles.details} aria-labelledby="product-name">
            <p className={styles.eyebrow}>
              {product.categories.map((category) => category.name).join(' / ')}
            </p>
            <h1 id="product-name">{product.name}</h1>
            <p className={styles.price}>{selectedPrice ?? 'Select a variant'}</p>
            <p>Prices exclude simulated tax.</p>
            {marketEtag ? (
              <CartMarketReview
                market={market}
                etag={marketEtag}
                onCancel={() => setMarketEtag(null)}
                onConfirmed={() => {
                  setMarketEtag(null);
                  setCartMessage('Market changed. Review your selection and add to cart.');
                }}
              />
            ) : null}
            <p className={styles.description}>{product.description}</p>
            <p className={product.inStock ? styles.stock : styles.outOfStock}>
              {product.inStock ? 'In stock in this market' : 'Currently unavailable in this market'}
            </p>
            <fieldset className={styles.variantPicker}>
              <legend>Choose a variant</legend>
              <div>
                {product.variants.map((variant) => (
                  <label
                    key={variant.id}
                    className={variant.inStock ? styles.variant : styles.variantUnavailable}
                  >
                    <input
                      type="radio"
                      name="variant"
                      value={variant.id}
                      checked={selectedVariantId === variant.id}
                      disabled={!variant.inStock || pendingVariantId !== null}
                      onChange={() => {
                        setSelectedVariantId(variant.id);
                        setQuantity(1);
                        setCartMessage(null);
                      }}
                    />
                    <span>{variantLabel(variant)}</span>
                    <strong>{formatMoney(variant.priceMinor, variant.currency)}</strong>
                    {!variant.inStock ? <small>Unavailable</small> : null}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={styles.purchaseRow}>
              <label className={styles.quantity}>
                <span>Quantity</span>
                <input
                  aria-label="Quantity"
                  type="number"
                  min={1}
                  max={Math.max(1, selectedVariant?.available ?? 1)}
                  value={quantity}
                  disabled={
                    !selectedVariant?.inStock || pendingVariantId !== null || marketEtag !== null
                  }
                  onChange={(event) => {
                    const parsed = Number(event.target.value);
                    if (Number.isSafeInteger(parsed))
                      setQuantity(
                        Math.min(Math.max(1, parsed), Math.max(1, selectedVariant?.available ?? 1)),
                      );
                  }}
                />
              </label>
              <button
                type="button"
                className={styles.addButton}
                disabled={
                  !selectedVariant?.inStock || pendingVariantId !== null || marketEtag !== null
                }
                aria-busy={pendingVariantId === selectedVariant?.id}
                onClick={() => void addToCart()}
              >
                {pendingVariantId === selectedVariant?.id ? 'Adding…' : 'Add to cart'}{' '}
                <span aria-hidden="true">→</span>
              </button>
            </div>
            {cartMessage ? (
              <p className={styles.cartMessage} role="status">
                {cartMessage}
              </p>
            ) : null}
            <div className={styles.assurances}>
              <p>
                <strong>Secure checkout</strong>
                <span>Server-owned price and availability at checkout.</span>
              </p>
              <p>
                <strong>Regional catalog</strong>
                <span>Availability follows this market’s configured warehouse route.</span>
              </p>
              <p>
                <strong>Cart first</strong>
                <span>Review your order before checkout.</span>
              </p>
            </div>
          </section>
        </div>
      </main>
    </StorefrontShell>
  );
}
