'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import styles from './storefront-header.module.css';

const primaryLinks = [
  { href: '/catalog', label: 'Shop' },
  { href: '/catalog?category=running', label: 'Running' },
  { href: '/catalog?category=trail', label: 'Trail' },
  { href: '/catalog?category=training', label: 'Training' },
];

export function StorefrontHeader() {
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
        <Link className={styles.wordmark} href="/">
          PULSE//FIELD
        </Link>
        <nav aria-label="Storefront" className={styles.desktopNav}>
          {primaryLinks.map((link) => (
            <Link href={link.href} key={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <form action="/catalog" className={styles.search} role="search">
          <label className="sr-only" htmlFor="storefront-search">
            Search products
          </label>
          <input id="storefront-search" name="search" placeholder="Search products" type="search" />
        </form>
        <div className={styles.actions}>
          <Link className={styles.cartLink} href="/cart">
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
          <Link href={link.href} key={link.href} onClick={() => setIsMenuOpen(false)}>
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
