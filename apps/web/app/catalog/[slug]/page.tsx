'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_ORIGIN, CATALOG_SLUG_PATTERN, CatalogProduct, formatUsd } from '../catalog-types';

export default function ProductPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cartMessage, setCartMessage] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [pendingVariantId, setPendingVariantId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    void fetch(`${API_ORIGIN}/api/v1/catalog/products/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
    })
      .then((response) => {
        if (!response.ok) throw new Error('PRODUCT_UNAVAILABLE');
        return response.json().then((result) => ({
          product: result as CatalogProduct,
          finalUrl: response.url,
        }));
      })
      .then(({ product: result, finalUrl }) => {
        if (!cancelled) {
          setProduct(result);
          const canonicalSlug = canonicalSlugFromRedirect(finalUrl);
          if (canonicalSlug && canonicalSlug !== slug) {
            window.history.replaceState(null, '', `/catalog/${canonicalSlug}`);
          }
          setState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function addToCart(variantId: string, quantity: number): Promise<void> {
    if (pendingVariantId) return;
    setPendingVariantId(variantId);
    setCartMessage(null);
    try {
      let cartResponse = await fetch(`${API_ORIGIN}/api/v1/cart`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!cartResponse.ok) throw new Error('CART_UNAVAILABLE');
      let etag = cartResponse.headers.get('etag');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${API_ORIGIN}/api/v1/cart/items/${variantId}`, {
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
        const problem = (await response.json().catch(() => ({}))) as {
          availableQuantity?: number;
        };
        if (response.status === 409 && problem.availableQuantity !== undefined) {
          setCartMessage(`Only ${problem.availableQuantity} units are currently available.`);
        } else if (response.status === 409 || response.status === 428) {
          setCartMessage('The cart changed in another tab. Refresh the page and try again.');
        } else {
          setCartMessage('Unable to update the cart. Try again.');
        }
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
      <main className="catalog-shell">
        <p className="state" role="status" aria-live="polite">
          Loading product…
        </p>
      </main>
    );
  if (state === 'error' || !product)
    return (
      <main className="catalog-shell">
        <section className="state state-error" role="alert">
          <h1>Product unavailable</h1>
          <p>This product may have been archived or the local API is unavailable.</p>
          <Link href="/catalog" className="text-link">
            Back to catalog
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
        <span className="detail-actions">
          <Link href="/catalog" className="text-link">
            Back to catalog
          </Link>
          <Link href="/cart" className="text-link">
            Cart
          </Link>
        </span>
      </nav>
      <div className="product-detail">
        <div className="detail-media">
          {product.media.map((media) => (
            <img
              key={media.url}
              src={media.url}
              alt={media.altText}
              width={media.width}
              height={media.height}
            />
          ))}
        </div>
        <div className="detail-copy">
          <p className="eyebrow">
            {product.categories.map((category) => category.name).join(' / ')}
          </p>
          <h1>{product.name}</h1>
          <p className="detail-description">{product.description}</p>
          <p className="detail-availability">
            {product.inStock
              ? `${product.available} units available in the US`
              : 'Currently unavailable in the US'}
          </p>
          <div className="variant-list" aria-label="Available variants">
            {product.variants.map((variant) => (
              <div className="variant-row" key={variant.id}>
                <span>{Object.values(variant.optionValues).join(' / ')}</span>
                <strong>{formatUsd(variant.priceMinor)}</strong>
                <span className={variant.inStock ? 'availability' : 'availability unavailable'}>
                  {variant.inStock ? 'Available' : 'Unavailable'}
                </span>
                <label className="quantity-control">
                  <span>Quantity</span>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, variant.available)}
                    value={quantities[variant.id] ?? 1}
                    disabled={!variant.inStock || pendingVariantId !== null}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (Number.isSafeInteger(parsed)) {
                        setQuantities((current) => ({
                          ...current,
                          [variant.id]: Math.min(
                            Math.max(1, parsed),
                            Math.max(1, variant.available),
                          ),
                        }));
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={!variant.inStock || pendingVariantId !== null}
                  aria-busy={pendingVariantId === variant.id}
                  onClick={() => void addToCart(variant.id, quantities[variant.id] ?? 1)}
                >
                  {pendingVariantId === variant.id ? 'Adding…' : 'Add to cart'}
                </button>
              </div>
            ))}
          </div>
          {cartMessage ? (
            <p className="cart-message" role="status">
              {cartMessage}
            </p>
          ) : null}
          <p className="detail-note">Checkout is available from your cart.</p>
        </div>
      </div>
    </main>
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
