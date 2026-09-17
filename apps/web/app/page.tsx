import { StorefrontShell } from '../components/storefront-shell';
import { HomepageStorefront } from '../components/homepage-storefront';

export default function HomePage() {
  return (
    <StorefrontShell>
      <HomepageStorefront />
    </StorefrontShell>
  );
}
