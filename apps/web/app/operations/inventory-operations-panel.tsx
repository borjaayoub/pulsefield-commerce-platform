'use client';

import { useState } from 'react';
import type { InventoryCommandRunner } from './use-inventory-command';

type Balance = {
  id: string;
  version: number;
  onHand: number;
  damaged: number;
  lowStockThreshold: number;
  available: number;
  warehouseCode?: string;
  sku?: string;
  warehouse?: { code?: string; name?: string };
  variant?: { sku?: string; name?: string };
};
type Session = { csrfToken: string };

export function InventoryOperationsPanel({
  apiOrigin,
  rows,
  refresh,
  command,
}: {
  apiOrigin: string;
  session: Session;
  rows: Balance[];
  refresh: () => void;
  command: InventoryCommandRunner;
}) {
  const [reason, setReason] = useState('');
  const [onHandDelta, setOnHandDelta] = useState('');
  const [damagedDelta, setDamagedDelta] = useState('');
  const [threshold, setThreshold] = useState('');
  const [notice, setNotice] = useState('');
  const blocked = command.busy || command.pending !== null;
  async function submit(row: Balance, kind: 'adjustments' | 'thresholds') {
    if (blocked || !reason.trim()) {
      setNotice('Enter an operator reason before submitting.');
      return;
    }
    const onHand = kind === 'adjustments' ? Number(onHandDelta) : 0;
    const damaged = kind === 'adjustments' ? Number(damagedDelta) : 0;
    const value = kind === 'thresholds' ? Number(threshold) : 0;
    if (
      (kind === 'adjustments' && (!onHandDelta.trim() || !damagedDelta.trim())) ||
      (kind === 'thresholds' && !threshold.trim()) ||
      ![onHand, damaged, value].every(Number.isSafeInteger) ||
      onHand < -1_000_000 ||
      onHand > 1_000_000 ||
      damaged < -1_000_000 ||
      damaged > 1_000_000 ||
      value < 0 ||
      value > 1_000_000 ||
      (kind === 'adjustments' && onHand === 0 && damaged === 0)
    ) {
      setNotice('Enter bounded integer values; blank values are invalid.');
      return;
    }
    const body =
      kind === 'adjustments'
        ? { onHandDelta: onHand, damagedDelta: damaged, reason: reason.trim() }
        : { lowStockThreshold: value, reason: reason.trim() };
    const ok = await command.run({
      url: `${apiOrigin}/api/v1/staff/inventory/balances/${row.id}/${kind}`,
      body: JSON.stringify(body),
      key: crypto.randomUUID(),
      ifMatch: `"inventory-${row.version}"`,
    });
    if (ok) {
      setNotice('Inventory command completed.');
      setReason('');
      refresh();
    }
  }
  return (
    <section aria-label="Inventory controls">
      <fieldset disabled={blocked}>
        <legend>Inventory adjustment and threshold controls</legend>
        <label htmlFor="inventory-reason">Operator reason</label>
        <input
          id="inventory-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          required
        />
        <label htmlFor="inventory-on-hand">On-hand delta</label>
        <input
          id="inventory-on-hand"
          type="number"
          min={-1000000}
          max={1000000}
          step={1}
          value={onHandDelta}
          onChange={(e) => setOnHandDelta(e.target.value)}
        />
        <label htmlFor="inventory-damaged">Damaged delta</label>
        <input
          id="inventory-damaged"
          type="number"
          min={-1000000}
          max={1000000}
          step={1}
          value={damagedDelta}
          onChange={(e) => setDamagedDelta(e.target.value)}
        />
        <label htmlFor="inventory-threshold">Low-stock threshold</label>
        <input
          id="inventory-threshold"
          type="number"
          min={0}
          max={1000000}
          step={1}
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
        {rows.map((row) => (
          <div key={row.id} className="operations-row">
            <span>
              {row.warehouse?.code ?? row.warehouseCode ?? row.id} ·{' '}
              {row.variant?.sku ?? row.sku ?? 'SKU unavailable'} · available {row.available} ·
              threshold {row.lowStockThreshold}
            </span>
            <button
              type="button"
              disabled={blocked}
              onClick={() => void submit(row, 'adjustments')}
            >
              Apply adjustment
            </button>
            <button type="button" disabled={blocked} onClick={() => void submit(row, 'thresholds')}>
              Set threshold
            </button>
          </div>
        ))}
      </fieldset>
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
