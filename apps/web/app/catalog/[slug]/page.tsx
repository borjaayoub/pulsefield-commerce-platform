'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { StorefrontShell } from '../../../components/storefront-shell';
import {
  API_ORIGIN,
  CATALOG_SLUG_PATTERN,
  CatalogProduct,
  CatalogVariant,
  formatUsd,
} from '../catalog-types';
import styles from './page.module.css';

function variantLabel(variant: CatalogVariant): string {
  return Object.values(variant.optionValues).join(' / ');
}

export default function ProductPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [cartMessage, setCartMessage] = useState<string | null>(null);
  const [pendingVariantId, setPendingVariantId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setProduct(null);
    setSelectedVariantId(null);
    void fetch(`${API_ORIGIN}/api/v1/catalog/products/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
    })
      .then((response) => {
        if (!response.ok) throw new Error('PRODUCT_UNAVAILABLE');
        return response
          .json()
          .then((result) => ({ product: result as CatalogProduct, finalUrl: response.url }));
      })
      .then(({ product: result, finalUrl }) => {
        if (cancelled) return;
        setProduct(result);
        setSelectedVariantId(
          result.variants.find((variant) => variant.inStock)?.id ?? result.variants[0]?.id ?? null,
        );
        const canonicalSlug = canonicalSlugFromRedirect(finalUrl);
        if (canonicalSlug && canonicalSlug !== slug)
          window.history.replaceState(null, '', `/catalog/${canonicalSlug}`);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const selectedVariant = useMemo(
    () => product?.variants.find((variant) => variant.id === selectedVariantId) ?? null,
    [product, selectedVariantId],
  );

  async function addToCart(): Promise<void> {
    if (!selectedVariant || pendingVariantId) return;
    setPendingVariantId(selectedVariant.id);
    setCartMessage(null);
    try {
      let cartResponse = await fetch(`${API_ORIGIN}/api/v1/cart`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!cartResponse.ok) throw new Error('CART_UNAVAILABLE');
      let etag = cartResponse.headers.get('etag');
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

  if (state === 'loading')
    return (
      <StorefrontShell>
        <main className={styles.page}>
          <div className={styles.loading} role="status" aria-live="polite">
            Loading product…
          </div>
        </main>
      </StorefrontShell>
    );
  if (state === 'error' || !product)
    return (
      <StorefrontShell>
        <main className={styles.page}>
          <section className={styles.state} role="alert">
            <p className={styles.eyebrow}>Product status</p>
            <h1>Product unavailable</h1>
            <p>This product may have been archived or the local API is unavailable.</p>
            <Link href="/catalog">Back to catalog</Link>
          </section>
        </main>
      </StorefrontShell>
    );

  const media = product.media[0];
  const selectedPrice = selectedVariant ? formatUsd(selectedVariant.priceMinor) : null;
  return (
    <StorefrontShell>
      <main className={styles.page}>
        <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
          <Link href="/">Home</Link>
          <span>/</span>
          <Link href="/catalog">Shop</Link>
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
            <p className={styles.description}>{product.description}</p>
            <p className={product.inStock ? styles.stock : styles.outOfStock}>
              {product.inStock ? 'In stock in the US' : 'Currently unavailable in the US'}
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
                    <strong>{formatUsd(variant.priceMinor)}</strong>
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
                  disabled={!selectedVariant?.inStock || pendingVariantId !== null}
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
                disabled={!selectedVariant?.inStock || pendingVariantId !== null}
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
                <strong>US catalog</strong>
                <span>Availability is shown from the active warehouse.</span>
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

function canonicalSlugFromRedirect(finalUrl: string): string | null {
  try {
    const resolved = new URL(finalUrl);
    const apiOrigin = new URL(API_ORIGIN);
    const prefix = '/api/v1/catalog/products/';
    if (resolved.origin !== apiOrigin.origin || !resolved.pathname.startsWith(prefix)) return null;
    const candidate = decodeURIComponent(resolved.pathname.slice(prefix.length));
    return CATALOG_SLUG_PATTERN.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
