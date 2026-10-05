'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { marketUrl, parseMarket } from '../lib/market';
import styles from './storefront-footer.module.css';

const shopLinks = [
  { href: '/catalog', label: 'Shop all' },
  { href: '/catalog?category=running', label: 'Running' },
  { href: '/catalog?category=trail', label: 'Trail' },
  { href: '/catalog?category=training', label: 'Training' },
];

export function StorefrontFooter() {
  const market = parseMarket(useSearchParams().get('market'));
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div>
          <Link className={styles.wordmark} href={marketUrl('/', market)}>
            PULSE//FIELD
          </Link>
          <p>Built for the work between goals.</p>
        </div>
        <nav aria-label="Footer storefront navigation" className={styles.links}>
          {shopLinks.map((link) => (
            <Link href={marketUrl(link.href, market)} key={link.href}>
              {link.label}
            </Link>
          ))}
          <Link href={marketUrl('/cart', market)}>Cart</Link>
        </nav>
      </div>
      <p className={styles.copyright}>© 2026 PULSE//FIELD. Local demonstration profile.</p>
    </footer>
  );
}
