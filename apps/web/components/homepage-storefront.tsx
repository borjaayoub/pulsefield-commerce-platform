'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  API_ORIGIN,
  type CatalogList,
  type CatalogProduct,
  formatUsd,
} from '../app/catalog/catalog-types';
import styles from './homepage-storefront.module.css';

const PURPOSES = [
  {
    name: 'Training',
    description: 'Build strength for what is next.',
    href: '/catalog?category=training',
    image: '/storefront/home/purpose-training-v1.png',
    alt: 'Athlete completing a barbell squat in a training studio.',
  },
  {
    name: 'Running',
    description: 'Find the rhythm that carries you forward.',
    href: '/catalog?category=running',
    image: '/storefront/home/purpose-running-v1.png',
    alt: 'Runner in black performance apparel moving through a concrete setting.',
  },
  {
    name: 'Trail',
    description: 'Move farther when the ground changes.',
    href: '/catalog?category=trail',
    image: '/storefront/home/purpose-trail-v1.png',
    alt: 'Trail runner crossing a rocky mountain ridge.',
  },
] as const;

function productPrice(product: CatalogProduct): string {
  const lowestPrice = product.variants.reduce(
    (lowest, variant) => Math.min(lowest, variant.priceMinor),
    Number.POSITIVE_INFINITY,
  );

  return Number.isFinite(lowestPrice) ? formatUsd(lowestPrice) : 'Price unavailable';
}

function ProductCard({ product }: Readonly<{ product: CatalogProduct }>) {
  const primaryMedia = product.media[0];
  const categoryName = product.categories[0]?.name ?? 'Performance gear';

  return (
    <article className={styles.productCard}>
      <Link href={`/catalog/${product.slug}`} className={styles.productImageLink}>
        {primaryMedia ? (
          <img src={primaryMedia.url} alt={primaryMedia.altText} className={styles.productImage} />
        ) : (
          <div className={styles.productFallback} aria-hidden="true">
            PULSE//FIELD
          </div>
        )}
      </Link>
      <div className={styles.productDetails}>
        <p className={styles.productCategory}>{categoryName}</p>
        <h3>
          <Link href={`/catalog/${product.slug}`}>{product.name}</Link>
        </h3>
        <p className={styles.productPrice}>{productPrice(product)}</p>
      </div>
    </article>
  );
}

function ProductLoadingGrid() {
  return (
    <div className={styles.productGrid} role="status" aria-label="Loading current products">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className={styles.productSkeleton} aria-hidden="true" />
      ))}
    </div>
  );
}

export function HomepageStorefront() {
  const [catalog, setCatalog] = useState<CatalogList | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadCatalog() {
      try {
        const response = await fetch(
          `${API_ORIGIN}/api/v1/catalog/products?pageSize=12&sort=newest`,
          {
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error('Catalog request failed');
        }

        setCatalog((await response.json()) as CatalogList);
      } catch (error) {
        if ((error as DOMException).name !== 'AbortError') {
          setLoadError(true);
        }
      }
    }

    void loadCatalog();
    return () => controller.abort();
  }, []);

  const currentSelection = catalog?.items.slice(0, 4) ?? [];
  const featuredProduct = catalog?.items.find((product) => product.inStock) ?? catalog?.items[0];

  return (
    <main>
      <section className={styles.hero} aria-labelledby="homepage-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>PULSE//FIELD performance gear</p>
          <h1 id="homepage-title">Built for the work between goals.</h1>
          <p>Technical essentials designed for movement, repetition, and everyday performance.</p>
          <div className={styles.heroActions}>
            <Link href="/catalog?sort=newest" className={styles.primaryAction}>
              Shop new arrivals <span aria-hidden="true">→</span>
            </Link>
            <Link href="/catalog?category=training" className={styles.secondaryAction}>
              Explore training
            </Link>
          </div>
        </div>
        <img
          src="/storefront/home/hero-runner-v1.png"
          alt="Runner in black performance apparel moving through a sunlit concrete setting."
          className={styles.heroImage}
        />
      </section>

      <section className={styles.section} aria-labelledby="arrivals-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Current selection</p>
            <h2 id="arrivals-heading">New arrivals</h2>
          </div>
          <Link href="/catalog?sort=newest" className={styles.textAction}>
            View all <span aria-hidden="true">→</span>
          </Link>
        </div>
        {catalog ? (
          currentSelection.length > 0 ? (
            <div className={styles.productGrid}>
              {currentSelection.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          ) : (
            <p className={styles.catalogMessage}>No products are available yet.</p>
          )
        ) : loadError ? (
          <p className={styles.catalogMessage}>
            The catalog is unavailable right now. <Link href="/catalog">Browse the catalog</Link>.
          </p>
        ) : (
          <ProductLoadingGrid />
        )}
      </section>

      <section className={styles.section} aria-labelledby="purpose-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Choose the work</p>
            <h2 id="purpose-heading">Shop by purpose</h2>
          </div>
        </div>
        <div className={styles.purposeGrid}>
          {PURPOSES.map((purpose) => (
            <Link href={purpose.href} key={purpose.name} className={styles.purposeCard}>
              <img src={purpose.image} alt={purpose.alt} />
              <span className={styles.purposeOverlay}>
                <span>
                  <strong>{purpose.name}</strong>
                  <small>{purpose.description}</small>
                </span>
                <span aria-hidden="true" className={styles.purposeArrow}>
                  →
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className={styles.featured} aria-labelledby="featured-heading">
        <div className={styles.featuredCopy}>
          <p className={styles.eyebrow}>Designed around movement</p>
          <h2 id="featured-heading">Gear that keeps pace with the day.</h2>
          <p>
            From training sessions to the commute home, every piece is selected for a focused,
            capable routine.
          </p>
          <Link href="/catalog" className={styles.secondaryAction}>
            Explore the collection <span aria-hidden="true">→</span>
          </Link>
        </div>
        {featuredProduct ? (
          <article className={styles.featuredProduct}>
            {featuredProduct.media[0] ? (
              <img
                src={featuredProduct.media[0].url}
                alt={featuredProduct.media[0].altText}
                className={styles.featuredImage}
              />
            ) : (
              <div className={styles.featuredFallback} aria-hidden="true">
                PULSE//FIELD
              </div>
            )}
            <div className={styles.featuredProductDetails}>
              <p className={styles.eyebrow}>Featured product</p>
              <h3>{featuredProduct.name}</h3>
              <p>{productPrice(featuredProduct)}</p>
              <Link href={`/catalog/${featuredProduct.slug}`} className={styles.textAction}>
                View product <span aria-hidden="true">→</span>
              </Link>
            </div>
          </article>
        ) : (
          <div className={styles.featuredPlaceholder} aria-hidden="true" />
        )}
      </section>
    </main>
  );
}
