'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useRealtimeInvalidation } from '../../lib/realtime/use-realtime-invalidation';
import { StorefrontShell } from '../../components/storefront-shell';
import { API_ORIGIN, CatalogList, CatalogProduct } from './catalog-types';
import styles from './page.module.css';
import { formatMoney, marketUrl, parseMarket } from '../../lib/market';
import type { InternationalMarketCode } from '@pulse-field/contracts';

type Availability = '' | 'in-stock' | 'out-of-stock';

async function loadCatalog(
  search: string,
  category: string,
  availability: Availability,
  sort: string,
  page: number,
  market: InternationalMarketCode,
): Promise<CatalogList> {
  const params = new URLSearchParams({ pageSize: '12', sort, page: String(page), market });
  if (search.trim()) params.set('search', search.trim());
  if (category) params.set('category', category);
  if (availability) params.set('availability', availability);
  const response = await fetch(`${API_ORIGIN}/api/v1/catalog/products?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('CATALOG_UNAVAILABLE');
  return (await response.json()) as CatalogList;
}

function ProductCard({ product }: Readonly<{ product: CatalogProduct }>) {
  const media = product.media[0];
  const price = formatMoney(
    Math.min(...product.variants.map((variant) => variant.priceMinor)),
    product.currency,
  );
  return (
    <article className={styles.productCard}>
      <Link
        href={marketUrl(`/catalog/${product.slug}`, product.market)}
        className={styles.productImageLink}
      >
        {media ? (
          <img src={media.url} alt={media.altText} className={styles.productImage} />
        ) : (
          <span className={styles.imagePlaceholder} aria-hidden="true">
            PULSE//FIELD
          </span>
        )}
        <span className={styles.productArrow} aria-hidden="true">
          ↗
        </span>
      </Link>
      <div className={styles.productDetails}>
        <p>{product.categories[0]?.name ?? 'Performance gear'}</p>
        <h2>
          <Link href={marketUrl(`/catalog/${product.slug}`, product.market)}>{product.name}</Link>
        </h2>
        <div className={styles.productMeta}>
          <strong>{price}</strong>
          <span className={product.inStock ? styles.available : styles.unavailable}>
            {product.inStock ? 'In stock' : 'Unavailable'}
          </span>
        </div>
      </div>
    </article>
  );
}

function LoadingGrid() {
  return (
    <div className={styles.productGrid} role="status" aria-label="Loading catalog">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
        <div key={item} className={styles.productSkeleton} aria-hidden="true" />
      ))}
    </div>
  );
}

export default function CatalogPage() {
  const searchParams = useSearchParams();
  const market = parseMarket(searchParams.get('market'));
  const [catalog, setCatalog] = useState<CatalogList | null>(null);
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
  const [submittedSearch, setSubmittedSearch] = useState(() => searchParams.get('search') ?? '');
  const [category, setCategory] = useState(() => searchParams.get('category') ?? '');
  const [availability, setAvailability] = useState<Availability>(
    () => (searchParams.get('availability') as Availability) ?? '',
  );
  const [sort, setSort] = useState(() => searchParams.get('sort') ?? 'newest');
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftCategory, setDraftCategory] = useState(category);
  const [draftAvailability, setDraftAvailability] = useState<Availability>(availability);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLElement>(null);

  const invalidate = useCallback((topics: string[]) => {
    if (topics.includes('catalog')) setRefreshGeneration((value) => value + 1);
  }, []);
  useRealtimeInvalidation('public', invalidate);

  useEffect(() => {
    const nextSearch = searchParams.get('search') ?? '';
    const nextCategory = searchParams.get('category') ?? '';
    const nextAvailability = (searchParams.get('availability') as Availability) ?? '';
    const nextSort = searchParams.get('sort') ?? 'newest';
    setSearch(nextSearch);
    setSubmittedSearch(nextSearch);
    setCategory(nextCategory);
    setDraftCategory(nextCategory);
    setAvailability(nextAvailability);
    setDraftAvailability(nextAvailability);
    setSort(nextSort);
    setPage(1);
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    setError(false);
    void loadCatalog(submittedSearch, category, availability, sort, page, market)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [submittedSearch, category, availability, sort, page, refreshGeneration, market]);

  useEffect(() => {
    if (!filtersOpen) return undefined;
    const panel = filterPanelRef.current;
    const focusable = panel
      ? Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ),
        )
      : [];
    (focusable[0] ?? panel)?.focus();

    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFiltersOpen(false);
        window.requestAnimationFrame(() => filterButtonRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleDialogKey);
    return () => window.removeEventListener('keydown', handleDialogKey);
  }, [filtersOpen]);

  function closeFilters() {
    setFiltersOpen(false);
    window.requestAnimationFrame(() => filterButtonRef.current?.focus());
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedSearch(search);
    setPage(1);
  }
  function applyFilters() {
    setCategory(draftCategory);
    setAvailability(draftAvailability);
    setPage(1);
    closeFilters();
  }
  function clearFilters() {
    setSearch('');
    setSubmittedSearch('');
    setCategory('');
    setAvailability('');
    setDraftCategory('');
    setDraftAvailability('');
    setPage(1);
  }
  const activeFilterCount = Number(Boolean(category)) + Number(Boolean(availability));

  return (
    <StorefrontShell>
      <main className={styles.catalog}>
        <header className={styles.header}>
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            <Link href="/">Home</Link>
            <span aria-hidden="true">/</span>
            <span>Shop</span>
          </nav>
          <p className={styles.eyebrow}>Performance system</p>
          <h1>Move with intent.</h1>
          <p className={styles.intro}>
            Technical essentials for road, trail, and training. Prices exclude simulated tax.
          </p>
        </header>
        <section className={styles.controls} aria-label="Catalog controls">
          <form className={styles.searchForm} onSubmit={submit}>
            <label htmlFor="catalog-search" className={styles.srOnly}>
              Search products
            </label>
            <span aria-hidden="true">⌕</span>
            <input
              id="catalog-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search products"
              maxLength={80}
            />
            <button type="submit">Search</button>
          </form>
          <button
            type="button"
            className={styles.filterButton}
            ref={filterButtonRef}
            onClick={() => {
              setDraftCategory(category);
              setDraftAvailability(availability);
              setFiltersOpen(true);
            }}
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
          >
            Filters{activeFilterCount > 0 ? <span>{activeFilterCount}</span> : null}
          </button>
          <label className={styles.sortControl}>
            <span>Sort</span>
            <select
              aria-label="Sort products"
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
        </section>
        {submittedSearch || category || availability ? (
          <div className={styles.activeFilters} aria-label="Active filters">
            {submittedSearch ? <span>Search: {submittedSearch}</span> : null}
            {category ? <span>{category}</span> : null}
            {availability ? (
              <span>{availability === 'in-stock' ? 'In stock' : 'Out of stock'}</span>
            ) : null}
            <button type="button" onClick={clearFilters}>
              Clear all
            </button>
          </div>
        ) : null}
        <div className={styles.resultsSummary} aria-live="polite">
          {catalog
            ? `${catalog.totalItems} ${catalog.totalItems === 1 ? 'product' : 'products'}`
            : 'Catalog'}
        </div>
        {catalog === null && !error ? <LoadingGrid /> : null}
        {error ? (
          <section className={styles.state} role="alert">
            <p className={styles.eyebrow}>Catalog status</p>
            <h2>Catalog unavailable</h2>
            <p>Start the local API, then refresh this page to browse current products.</p>
          </section>
        ) : null}
        {catalog && catalog.items.length === 0 ? (
          <section className={styles.state}>
            <p className={styles.eyebrow}>No matches</p>
            <h2>Nothing matches this selection.</h2>
            <p>Try a broader search or clear the active filters.</p>
            <button type="button" className={styles.secondaryButton} onClick={clearFilters}>
              Clear filters
            </button>
          </section>
        ) : null}
        {catalog && catalog.items.length > 0 ? (
          <>
            <section className={styles.productGrid} aria-label="Products">
              {catalog.items.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </section>
            {catalog.totalPages > 1 ? (
              <nav className={styles.pagination} aria-label="Catalog pagination">
                <button
                  type="button"
                  onClick={() => setPage((current) => current - 1)}
                  disabled={catalog.page <= 1}
                >
                  Previous
                </button>
                <span>
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
      {filtersOpen ? (
        <div className={styles.filterLayer}>
          <button
            type="button"
            className={styles.filterBackdrop}
            onClick={closeFilters}
            aria-label="Close filters"
          />
          <aside
            className={styles.filterPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="filter-heading"
            ref={filterPanelRef}
            tabIndex={-1}
          >
            <div className={styles.filterPanelHeader}>
              <div>
                <p className={styles.eyebrow}>Catalog controls</p>
                <h2 id="filter-heading">Filters</h2>
              </div>
              <button type="button" onClick={closeFilters} aria-label="Close filters">
                ×
              </button>
            </div>
            <fieldset className={styles.filterGroup}>
              <legend>Category</legend>
              {[
                ['all', 'All categories'],
                ['running', 'Running'],
                ['trail', 'Trail'],
                ['training', 'Training'],
              ].map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="category"
                    checked={draftCategory === (value === 'all' ? '' : value)}
                    onChange={() => setDraftCategory(value === 'all' ? '' : value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <fieldset className={styles.filterGroup}>
              <legend>Availability</legend>
              {[
                ['', 'All availability'],
                ['in-stock', 'In stock'],
                ['out-of-stock', 'Out of stock'],
              ].map(([value, label]) => (
                <label key={value || 'all'}>
                  <input
                    type="radio"
                    name="availability"
                    checked={draftAvailability === value}
                    onChange={() => setDraftAvailability(value as Availability)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className={styles.filterActions}>
              <button type="button" className={styles.secondaryButton} onClick={clearFilters}>
                Clear all
              </button>
              <button type="button" className={styles.primaryButton} onClick={applyFilters}>
                Apply filters
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </StorefrontShell>
  );
}
