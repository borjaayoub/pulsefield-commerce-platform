import type { ReactNode } from 'react';
import { StorefrontFooter } from './storefront-footer';
import { StorefrontHeader } from './storefront-header';
import styles from './storefront-shell.module.css';

export function StorefrontShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className={styles.shell}>
      <StorefrontHeader />
      {children}
      <StorefrontFooter />
    </div>
  );
}
