'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MARKETS, MARKET_LABELS, marketUrl, parseMarket } from '../lib/market';
import { useEffect, useRef, useState } from 'react';
import styles from './storefront-header.module.css';

const primaryLinks = [
  { href: '/catalog', label: 'Shop' },
  { href: '/catalog?category=running', label: 'Running' },
  { href: '/catalog?category=trail', label: 'Trail' },
  { href: '/catalog?category=training', label: 'Training' },
];

export function StorefrontHeader() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const market = parseMarket(searchParams.get('market'));
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsMenuOpen(false);
      menuButtonRef.current?.focus();
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isMenuOpen]);

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link className={styles.wordmark} href={marketUrl('/', market)}>
          PULSE//FIELD
        </Link>
        <nav aria-label="Storefront" className={styles.desktopNav}>
          {primaryLinks.map((link) => (
            <Link href={marketUrl(link.href, market)} key={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <form action="/catalog" className={styles.search} role="search">
          <label className="sr-only" htmlFor="storefront-search">
            Search products
          </label>
          <input type="hidden" name="market" value={market} />
          <input id="storefront-search" name="search" placeholder="Search products" type="search" />
        </form>
        <div className={styles.actions}>
          <label className={styles.market}>
            Market
            <select
              aria-label="Browsing market"
              value={market}
              onChange={(event) =>
                router.push(
                  marketUrl(
                    pathname.startsWith('/catalog') || pathname === '/'
                      ? pathname + '?' + searchParams.toString()
                      : '/catalog',
                    parseMarket(event.target.value),
                  ),
                )
              }
            >
              {MARKETS.map((code) => (
                <option key={code} value={code}>
                  {MARKET_LABELS[code]}
                </option>
              ))}
            </select>
          </label>
          <Link className={styles.cartLink} href={marketUrl('/cart', market)}>
            Cart
          </Link>
          <button
            aria-controls="storefront-mobile-navigation"
            aria-expanded={isMenuOpen}
            className={styles.menuToggle}
            onClick={() => setIsMenuOpen((open) => !open)}
            ref={menuButtonRef}
            type="button"
          >
            Menu
          </button>
        </div>
      </div>
      <nav
        aria-label="Storefront mobile"
        className={styles.mobileNav}
        hidden={!isMenuOpen}
        id="storefront-mobile-navigation"
      >
        {primaryLinks.map((link) => (
          <Link
            href={marketUrl(link.href, market)}
            key={link.href}
            onClick={() => setIsMenuOpen(false)}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
