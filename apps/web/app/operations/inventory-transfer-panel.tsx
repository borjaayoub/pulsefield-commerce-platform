'use client';
import { useState } from 'react';
import type { InventoryCommandRunner } from './use-inventory-command';
type Row = Record<string, unknown>;
type Session = { csrfToken: string };
type Receipt = { received: string; damaged: string; lost: string };
const emptyReceipt = (): Receipt => ({ received: '', damaged: '', lost: '' });
const receiptKey = (transferId: string, variantId: string) => `${transferId}:${variantId}`;
function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function InventoryTransferPanel({
  apiOrigin,
  rows,
  refresh,
  command,
}: {
  apiOrigin: string;
  session: Session;
  rows: Row[];
  refresh: () => void;
  command: InventoryCommandRunner;
}) {
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [variant, setVariant] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [lines, setLines] = useState<Array<{ variantId: string; quantity: string }>>([]);
  const [receipt, setReceipt] = useState<Record<string, Receipt>>({});
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = busy || command.busy || command.pending !== null;
  async function create() {
    const sourceId = source.trim().toLowerCase();
    const destinationId = destination.trim().toLowerCase();
    const transferLines = lines.length
      ? lines.map((line) => ({
          variantId: line.variantId.trim().toLowerCase(),
          quantity: line.quantity.trim(),
        }))
      : [{ variantId: variant.trim().toLowerCase(), quantity }];
    const ids = transferLines.map((line) => line.variantId);
    if (
      !uuid.test(sourceId) ||
      !uuid.test(destinationId) ||
      sourceId === destinationId ||
      !reason.trim() ||
      transferLines.length < 1 ||
      transferLines.length > 50 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !uuid.test(id)) ||
      transferLines.some(
        (line) =>
          !line.quantity.trim() ||
          !Number.isSafeInteger(Number(line.quantity)) ||
          Number(line.quantity) < 1 ||
          Number(line.quantity) > 1_000_000,
      )
    ) {
      setNotice(
        'Enter distinct valid warehouse and variant UUIDs, bounded quantities, and an operator reason.',
      );
      return;
    }
    setBusy(true);
    const ok = await command.run({
      url: `${apiOrigin}/api/v1/staff/inventory/transfers`,
      key: crypto.randomUUID(),
      body: JSON.stringify({
        sourceWarehouseId: sourceId,
        destinationWarehouseId: destinationId,
        lines: transferLines.map((line) => ({
          variantId: line.variantId,
          quantity: Number(line.quantity),
        })),
        reason: reason.trim(),
      }),
    });
    setBusy(false);
    if (ok) {
      setReason('');
      refresh();
    }
  }
  async function transition(row: Row, targetStatus: 'IN_TRANSIT' | 'CANCELLED') {
    const id = asString(row.id);
    const version = row.version;
    if (!id || typeof version !== 'number' || blocked || !reason.trim()) {
      setNotice('Enter an operator reason and resolve any pending command first.');
      return;
    }
    setBusy(true);
    const ok = await command.run({
      url: `${apiOrigin}/api/v1/staff/inventory/transfers/${id}/transitions`,
      key: crypto.randomUUID(),
      ifMatch: `"transfer-${version}"`,
      body: JSON.stringify({ targetStatus, reason: reason.trim() }),
    });
    setBusy(false);
    if (ok) refresh();
  }
  async function receive(row: Row) {
    const id = asString(row.id);
    const version = row.version;
    const rawLines = Array.isArray(row.lines) ? (row.lines as Row[]) : [];
    if (!id || typeof version !== 'number' || !reason.trim() || rawLines.length === 0 || blocked) {
      setNotice('Enter a reason and complete every receipt line.');
      return;
    }
    const receiptLines = rawLines.map((line) => {
      const variantId = asString(line.variantId);
      const value = receipt[receiptKey(id, variantId)] ?? emptyReceipt();
      const raw = [value.received.trim(), value.damaged.trim(), value.lost.trim()];
      const parsed = raw.map((entry) => Number(entry));
      return {
        variantId,
        received: parsed[0],
        damaged: parsed[1],
        lost: parsed[2],
        quantity: Number(line.quantity),
        valid:
          raw.every((entry) => entry.length > 0) &&
          parsed.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000_000),
      };
    });
    if (
      receiptLines.some(
        (line) =>
          !line.variantId ||
          !line.valid ||
          line.received + line.damaged + line.lost !== line.quantity,
      )
    ) {
      setNotice('Each receipt line must conserve its transfer quantity; blank values are invalid.');
      return;
    }
    setBusy(true);
    const ok = await command.run({
      url: `${apiOrigin}/api/v1/staff/inventory/transfers/${id}/transitions`,
      key: crypto.randomUUID(),
      ifMatch: `"transfer-${version}"`,
      body: JSON.stringify({
        targetStatus: 'RECEIVED',
        reason: reason.trim(),
        lines: receiptLines.map((line) => ({
          variantId: line.variantId,
          received: line.received,
          damaged: line.damaged,
          lost: line.lost,
        })),
      }),
    });
    setBusy(false);
    if (ok) refresh();
  }
  return (
    <section aria-label="Transfer controls">
      <fieldset disabled={blocked}>
        <legend>Create transfer</legend>
        <label>
          Source warehouse ID
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
        <label>
          Destination warehouse ID
          <input value={destination} onChange={(e) => setDestination(e.target.value)} />
        </label>
        <label>
          Variant UUID
          <input value={variant} onChange={(e) => setVariant(e.target.value)} />
        </label>
        <label>
          Quantity
          <input
            type="number"
            min={1}
            max={1000000}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={blocked || lines.length >= 50}
          onClick={() => {
            if (
              variant.trim() &&
              uuid.test(variant.trim()) &&
              quantity.trim() &&
              Number.isSafeInteger(Number(quantity)) &&
              Number(quantity) >= 1 &&
              Number(quantity) <= 1000000
            ) {
              setLines((current) => [
                ...current,
                { variantId: variant.trim().toLowerCase(), quantity },
              ]);
              setVariant('');
              setQuantity('1');
            }
          }}
        >
          Add line
        </button>
        {lines.map((line, index) => (
          <div key={`${line.variantId}-${index}`}>
            {line.variantId} · {line.quantity}
            <button
              type="button"
              disabled={blocked}
              onClick={() => setLines((current) => current.filter((_, item) => item !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        <label>
          Operator reason
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="button" disabled={blocked} onClick={() => void create()}>
          Request transfer
        </button>
      </fieldset>
      {rows.map((row) => {
        const id = asString(row.id);
        const status = row.status;
        const rawLines = Array.isArray(row.lines) ? (row.lines as Row[]) : [];
        const sourceWarehouse = row.sourceWarehouse as Row | undefined;
        const destinationWarehouse = row.destinationWarehouse as Row | undefined;
        return (
          <details key={id} className="operations-row">
            <summary>
              {String(status)} · version {String(row.version)} ·{' '}
              {asString(sourceWarehouse?.code ?? row.sourceWarehouseCode)} →{' '}
              {asString(destinationWarehouse?.code ?? row.destinationWarehouseCode)}
            </summary>
            {status === 'REQUESTED' ? (
              <>
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => void transition(row, 'IN_TRANSIT')}
                >
                  Dispatch
                </button>
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => void transition(row, 'CANCELLED')}
                >
                  Cancel
                </button>
              </>
            ) : null}
            {status === 'REQUESTED' ||
            status === 'IN_TRANSIT' ||
            status === 'RECEIVED' ||
            status === 'CANCELLED' ? (
              <div>
                <h4>Transfer {id} details</h4>
                {rawLines.map((line) => {
                  const variantData = line.variant as Row | undefined;
                  const variantId = asString(line.variantId);
                  const key = receiptKey(id, variantId);
                  const value = receipt[key] ?? emptyReceipt();
                  return (
                    <fieldset key={key} disabled={blocked || status !== 'IN_TRANSIT'}>
                      <legend>
                        {asString(variantData?.sku ?? line.sku) || variantId} · quantity{' '}
                        {String(line.quantity)} · received {String(line.received ?? '—')} · damaged{' '}
                        {String(line.damaged ?? '—')} · lost {String(line.lost ?? '—')}
                      </legend>
                      {status === 'IN_TRANSIT'
                        ? (['received', 'damaged', 'lost'] as const).map((field) => (
                            <label key={field}>
                              {field}
                              <input
                                type="number"
                                min={0}
                                max={1000000}
                                step={1}
                                value={value[field]}
                                onChange={(event) =>
                                  setReceipt((current) => ({
                                    ...current,
                                    [key]: { ...value, [field]: event.target.value },
                                  }))
                                }
                              />
                            </label>
                          ))
                        : null}
                    </fieldset>
                  );
                })}
                {status === 'IN_TRANSIT' ? (
                  <button type="button" disabled={blocked} onClick={() => void receive(row)}>
                    Complete receipt
                  </button>
                ) : null}
              </div>
            ) : null}
          </details>
        );
      })}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
