'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_ORIGIN, formatUsd } from '../../catalog/catalog-types';
import {
  accessTokenFromFragment,
  guestOrderSessionKey,
  type OrderTimeline,
} from './order-timeline';

export default function OrderTimelinePage() {
  const { reference } = useParams<{ reference: string }>();
  const [timeline, setTimeline] = useState<OrderTimeline | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const storageKey = guestOrderSessionKey(reference);
    const fragmentToken = accessTokenFromFragment(window.location.hash);
    const token = fragmentToken ?? sessionStorage.getItem(storageKey) ?? undefined;
    if (!token) {
      setState('error');
      return;
    }
    if (!fragmentToken) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}#access=${encodeURIComponent(token)}`,
      );
      sessionStorage.removeItem(storageKey);
    }
    const controller = new AbortController();
    void fetch(`${API_ORIGIN}/api/v1/orders/${encodeURIComponent(reference)}/timeline`, {
      headers: { Accept: 'application/json', Authorization: `Guest ${token}` },
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('ORDER_UNAVAILABLE');
        setTimeline((await response.json()) as OrderTimeline);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setState('error');
      });
    return () => controller.abort();
  }, [reference]);

  if (state === 'loading')
    return (
      <main className="catalog-shell">
        <p className="state" role="status">
          Loading order status…
        </p>
      </main>
    );
  if (state === 'error' || !timeline)
    return (
      <main className="catalog-shell">
        <section className="state" role="alert">
          <p className="eyebrow">Guest order access</p>
          <h1>This order link is unavailable.</h1>
          <p>Use the complete link supplied after checkout. It may have expired or been revoked.</p>
          <Link href="/catalog" className="text-link">
            Return to catalog →
          </Link>
        </section>
      </main>
    );

  return (
    <main className="catalog-shell order-timeline-shell">
      <nav className="catalog-nav" aria-label="Primary navigation">
        <Link href="/" className="wordmark">
          PULSE//FIELD
        </Link>
        <Link href="/catalog" className="text-link">
          Shop
        </Link>
      </nav>
      <header className="catalog-header">
        <p className="eyebrow">Order {timeline.orderReference}</p>
        <h1>Your order.</h1>
        <p className="detail-note">
          Live server-verified status · access expires{' '}
          {new Date(timeline.accessExpiresAt).toLocaleDateString('en-US')}
        </p>
      </header>
      <div className="cart-layout">
        <section className="cart-summary" aria-labelledby="progress-heading">
          <h2 id="progress-heading">Progress</h2>
          <ol className="order-timeline">
            {timeline.events.map((event, index) => (
              <li key={`${event.type}-${event.occurredAt}-${index}`}>
                <strong>{event.label}</strong>
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleString('en-US')}
                </time>
              </li>
            ))}
          </ol>
        </section>
        <aside className="cart-summary">
          <p className="eyebrow">Order summary</p>
          {timeline.lines.map((line, index) => (
            <div className="order-line" key={`${line.productName}-${line.variantName}-${index}`}>
              <span>
                {line.productName} · {line.variantName} × {line.quantity}
              </span>
              <strong>{formatUsd(line.lineTotalMinor)}</strong>
            </div>
          ))}
          <hr />
          <p>Merchandise: {formatUsd(timeline.subtotalMinor)}</p>
          <p>Shipping: {formatUsd(timeline.shippingMinor)}</p>
          <p>Simulated tax: {formatUsd(timeline.taxMinor)}</p>
          <p className="cart-total">Total: {formatUsd(timeline.totalMinor)}</p>
        </aside>
      </div>
    </main>
  );
}
