'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { API_ORIGIN, CatalogList, formatUsd } from './catalog-types';

async function loadCatalog(
  search: string,
  category: string,
  sort: string,
  page: number,
): Promise<CatalogList> {
  const params = new URLSearchParams({ pageSize: '12', sort, page: String(page) });
  if (search.trim()) params.set('search', search.trim());
  if (category) params.set('category', category);
  const response = await fetch(`${API_ORIGIN}/api/v1/catalog/products?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('CATALOG_UNAVAILABLE');
  return (await response.json()) as CatalogList;
}

export default function CatalogPage() {
  const [catalog, setCatalog] = useState<CatalogList | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    setError(false);
    void loadCatalog(submittedSearch, category, sort, page)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [submittedSearch, category, sort, page]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedSearch(search);
    setPage(1);
  }

  return (
    <main className="catalog-shell">
      <nav className="catalog-nav" aria-label="Primary navigation">
        <Link href="/" className="wordmark">
          PULSE//FIELD
        </Link>
        <span className="detail-actions">
          <span className="market-note">United States · USD</span>
          <Link href="/cart" className="text-link">
            Cart
          </Link>
        </span>
      </nav>
      <header className="catalog-header">
        <p className="eyebrow">Performance system / storefront discovery</p>
        <h1>Move with intent.</h1>
        <p className="lede">
          Original, local-first gear for road, trail, and training. Every price and availability
          signal comes from the server-owned US catalog.
        </p>
      </header>
      <form className="catalog-filters" onSubmit={submit} aria-label="Catalog filters">
        <label>
          <span>Search products</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Try trail or tee"
            maxLength={80}
          />
        </label>
        <label>
          <span>Category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            <option value="running">Running</option>
            <option value="trail">Trail</option>
            <option value="training">Training</option>
          </select>
        </label>
        <label>
          <span>Sort products</span>
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setPage(1);
            }}
          >
            <option value="newest">Newest</option>
            <option value="name">Name</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      {catalog === null && !error ? (
        <p className="state" role="status" aria-live="polite">
          Loading catalog…
        </p>
      ) : null}
      {error ? (
        <section className="state state-error" role="alert">
          <h2>Catalog unavailable</h2>
          <p>Start the local API and try again.</p>
        </section>
      ) : null}
      {catalog && catalog.items.length === 0 ? (
        <section className="state">
          <h2>No matching products</h2>
          <p>Try a broader search or another category.</p>
        </section>
      ) : null}
      {catalog && catalog.items.length > 0 ? (
        <>
          <section className="product-grid" aria-label="Products">
            {catalog.items.map((product) => (
              <article className="product-card" key={product.id}>
                <Link
                  href={`/catalog/${product.slug}`}
                  className="product-image-link"
                  aria-label={`View ${product.name}`}
                >
                  {product.media[0] ? (
                    <img
                      src={product.media[0].url}
                      alt={product.media[0].altText}
                      width={product.media[0].width}
                      height={product.media[0].height}
                    />
                  ) : (
                    <span className="image-placeholder">PULSE//FIELD</span>
                  )}
                </Link>
                <div className="product-card-body">
                  <p className="product-category">{product.categories[0]?.name ?? 'Performance'}</p>
                  <h2>
                    <Link href={`/catalog/${product.slug}`}>{product.name}</Link>
                  </h2>
                  <p className="product-price">
                    From{' '}
                    {formatUsd(Math.min(...product.variants.map((variant) => variant.priceMinor)))}
                  </p>
                  <p className={product.inStock ? 'availability' : 'availability unavailable'}>
                    {product.inStock ? `${product.available} available` : 'Currently unavailable'}
                  </p>
                </div>
              </article>
            ))}
          </section>
          {catalog.totalPages > 1 ? (
            <nav className="catalog-pagination" aria-label="Catalog pagination">
              <button
                type="button"
                onClick={() => setPage((current) => current - 1)}
                disabled={catalog.page <= 1}
              >
                Previous
              </button>
              <span aria-live="polite">
                Page {catalog.page} of {catalog.totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => current + 1)}
                disabled={catalog.page >= catalog.totalPages}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
