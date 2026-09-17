'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';
type Session = { user: { id: string; email: string; roles: string[] }; csrfToken: string };
type Row = Record<string, unknown>;
type Page = { items: Row[]; nextCursor: string | null };
const sections = [
  { key: 'catalog', label: 'Catalog' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'reservations', label: 'Reservations' },
  { key: 'orders', label: 'Orders' },
  { key: 'payments', label: 'Payments' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'fulfillment', label: 'Fulfillment' },
  { key: 'audit', label: 'Audit evidence' },
];

const reconciliationColumns = [
  ['orderReference', 'Order'],
  ['orderStatus', 'Order status'],
  ['paymentStatus', 'Payment status'],
  ['provider', 'Provider'],
  ['providerPaymentReference', 'Payment reference'],
  ['failureCode', 'Payment failure'],
  ['amountMinor', 'Amount (minor)'],
  ['currency', 'Currency'],
  ['attentionCategory', 'Attention'],
  ['compensation', 'Compensation'],
  ['createdAt', 'Created'],
  ['updatedAt', 'Updated'],
] as const;

function reconciliationValue(row: Row, key: string): string {
  if (key !== 'compensation') return value(row, key).replaceAll('_', ' ');
  const compensation = row.compensation;
  if (!compensation || typeof compensation !== 'object') return 'None';
  const detail = compensation as Record<string, unknown>;
  return [detail.status, detail.reason, detail.failureCode, detail.providerReference]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join(' · ')
    .replaceAll('_', ' ');
}

function value(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' || typeof v === 'number'
    ? String(v)
    : v === null
      ? '—'
      : JSON.stringify(v);
}

export default function OperationsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [section, setSection] = useState('catalog');
  const [page, setPage] = useState<Page | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/v1/auth/sessions/current`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error('SESSION');
        return r.json() as Promise<Session>;
      })
      .then(setSession)
      .catch(() => setError('Your staff session is missing or expired.'));
  }, []);
  useEffect(() => {
    const fulfillerOnly =
      session?.user.roles.includes('FULFILLER') && !session.user.roles.includes('ADMINISTRATOR');
    const effectiveSection = fulfillerOnly ? 'fulfillment' : section;
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const qs = new URLSearchParams({ pageSize: '25' });
    if (cursor) qs.set('cursor', cursor);
    void fetch(`${API_ORIGIN}/api/v1/staff/operations/${effectiveSection}?${qs}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (r) => {
        if (r.status === 401) throw new Error('SESSION');
        if (!r.ok) throw new Error('LOAD');
        return r.json() as Promise<Page>;
      })
      .then((result) => {
        if (!cancelled) setPage(result);
      })
      .catch((e: Error) => {
        if (!cancelled)
          setError(
            e.message === 'SESSION'
              ? 'Your staff session is missing or expired.'
              : 'This view requires a recent MFA-authenticated staff session.',
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, section, cursor, refreshNonce]);
  function changeSection(next: string) {
    setSection(next);
    setCursor(undefined);
    setPage(null);
  }
  async function logout() {
    if (!session) return;
    await fetch(`${API_ORIGIN}/api/v1/auth/sessions/current`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-CSRF-Token': session.csrfToken },
    });
    window.location.assign('/operations/sign-in');
  }
  if (!session && !error)
    return (
      <main className="operations-shell">
        <p className="state" role="status">
          Loading staff session…
        </p>
      </main>
    );
  if (error && !session)
    return (
      <main className="operations-shell">
        <section className="state state-error">
          <h1>Staff access required</h1>
          <p>{error}</p>
          <Link href="/operations/sign-in" className="text-link">
            Sign in
          </Link>
        </section>
      </main>
    );
  const admin = session?.user.roles.includes('ADMINISTRATOR') ?? false;
  const visibleSections = admin ? sections : sections.filter((item) => item.key === 'fulfillment');
  const effectiveSection = admin ? section : 'fulfillment';
  const columns =
    effectiveSection === 'reconciliation'
      ? reconciliationColumns.map(([key]) => key)
      : page?.items[0]
        ? Object.keys(page.items[0])
        : [];
  const fulfiller = session?.user.roles.includes('FULFILLER') ?? false;
  const nextStatus: Record<string, string> = {
    ALLOCATED: 'PICKING',
    PICKING: 'PACKED',
    PACKED: 'SHIPPED',
    SHIPPED: 'DELIVERED',
  };
  async function advance(row: Row) {
    if (
      !session ||
      typeof row.id !== 'string' ||
      typeof row.status !== 'string' ||
      typeof row.version !== 'number'
    )
      return;
    const targetStatus = nextStatus[row.status];
    if (!targetStatus) return;
    const response = await fetch(
      `${API_ORIGIN}/api/v1/staff/fulfillment-groups/${row.id}/transitions`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
          'If-Match': `"fulfillment-${row.version}"`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          targetStatus,
          reason: `Advance fulfillment to ${targetStatus.toLowerCase()}.`,
          ...(targetStatus === 'SHIPPED'
            ? {
                carrierCode: 'UPS',
                trackingReference: `PF${Date.now().toString(36).toUpperCase()}01`,
              }
            : {}),
        }),
      },
    );
    if (!response.ok) {
      setError(
        response.status === 401 || response.status === 403
          ? 'Your staff session expired or needs recent MFA reauthentication.'
          : 'The transition was rejected; refresh the queue and try again.',
      );
      return;
    }
    setPage(null);
    setRefreshNonce((current) => current + 1);
  }
  return (
    <main className="operations-shell">
      <nav className="catalog-nav">
        <Link href="/" className="wordmark">
          PULSE//FIELD
        </Link>
        <span className="detail-actions">
          <span className="market-note">
            {session?.user.email} · {admin ? 'Administrator' : 'Fulfiller'}
          </span>
          <button type="button" className="text-button" onClick={() => void logout()}>
            Log out
          </button>
        </span>
      </nav>
      <header className="operations-header">
        <p className="eyebrow">Protected operations</p>
        <h1>Control room.</h1>
        <p className="lede">
          Read-only operational projections keep customer, payment, and audit data deliberately
          small.
        </p>
      </header>
      <div className="operations-layout">
        <aside className="operations-menu" aria-label="Operations views">
          {visibleSections.map((item) => (
            <button
              key={item.key}
              type="button"
              className={effectiveSection === item.key ? 'active' : ''}
              onClick={() => changeSection(item.key)}
            >
              {item.label}
            </button>
          ))}
        </aside>
        <section aria-labelledby="operations-view-heading" className="operations-view">
          <h2 id="operations-view-heading">
            {sections.find((item) => item.key === effectiveSection)?.label}
          </h2>
          {effectiveSection === 'reconciliation' ? (
            <p className="lede operations-read-only-note">
              Read-only payment and recovery evidence. Provider references are masked; no payment
              action can be performed here.
            </p>
          ) : null}
          {loading ? (
            <p role="status" className="state">
              Loading…
            </p>
          ) : null}
          {!loading && error ? (
            <p role="alert" className="cart-message">
              {error}
            </p>
          ) : null}
          {!loading && !error && page?.items.length === 0 ? (
            <p className="state">No records in this view.</p>
          ) : null}
          {page?.items.length ? (
            <div className="operations-table-wrap">
              <table className="operations-table">
                <caption className="sr-only">
                  {sections.find((item) => item.key === effectiveSection)?.label}
                </caption>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column} scope="col">
                        {effectiveSection === 'reconciliation'
                          ? reconciliationColumns.find(([key]) => key === column)?.[1]
                          : column}
                      </th>
                    ))}
                    {fulfiller && effectiveSection === 'fulfillment' ? (
                      <th scope="col">Action</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((row, index) => (
                    <tr key={value(row, 'id') || index}>
                      {columns.map((column) => (
                        <td key={column}>
                          {effectiveSection === 'reconciliation'
                            ? reconciliationValue(row, column)
                            : value(row, column)}
                        </td>
                      ))}
                      {fulfiller && effectiveSection === 'fulfillment' ? (
                        <td>
                          <button
                            type="button"
                            onClick={() => void advance(row)}
                            disabled={!nextStatus[String(row.status)]}
                          >
                            Advance
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <nav className="catalog-pagination" aria-label="Operations pagination">
            <button
              type="button"
              disabled={!cursor}
              onClick={() => {
                setCursor(undefined);
                setPage(null);
              }}
            >
              First page
            </button>
            <button
              type="button"
              disabled={!page?.nextCursor}
              onClick={() => {
                setCursor(page?.nextCursor ?? undefined);
                setPage(null);
              }}
            >
              Next page
            </button>
          </nav>
        </section>
      </div>
    </main>
  );
}
