import Link from 'next/link';
import styles from './storefront-footer.module.css';

const shopLinks = [
  { href: '/catalog', label: 'Shop all' },
  { href: '/catalog?category=running', label: 'Running' },
  { href: '/catalog?category=trail', label: 'Trail' },
  { href: '/catalog?category=training', label: 'Training' },
];

export function StorefrontFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div>
          <Link className={styles.wordmark} href="/">
            PULSE//FIELD
          </Link>
          <p>Built for the work between goals.</p>
        </div>
        <nav aria-label="Footer storefront navigation" className={styles.links}>
          {shopLinks.map((link) => (
            <Link href={link.href} key={link.href}>
              {link.label}
            </Link>
          ))}
          <Link href="/cart">Cart</Link>
        </nav>
      </div>
      <p className={styles.copyright}>© 2026 PULSE//FIELD. Local demonstration profile.</p>
    </footer>
  );
}
