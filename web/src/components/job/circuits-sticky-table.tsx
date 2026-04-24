'use client';

/**
 * Sticky-column circuits table — mirrors iOS `CircuitsTab.swift:L565-L600`
 * landscape grid. The left two columns (Ref + Designation) are pinned
 * while the right-hand pane scrolls horizontally through the other 27
 * columns.
 *
 * Why a table view in addition to the card list:
 *   - iOS ships a 29-column wide grid for landscape / iPad editors.
 *     Inspectors who came from iOS expect side-by-side scanning when
 *     they're spreadsheeting a batch of circuits.
 *   - The card view still wins on narrow portrait viewports (full-width
 *     sections are easier to thumb through), so we keep both and let
 *     the user pick via a Cards / Table toggle.
 *
 * Implementation notes:
 *   - `position: sticky` + `left: 0` on the first two `<td>` / `<th>`
 *     cells gives native browser sticky behaviour without JS.
 *   - Column widths mirror the portrait iPad widths from
 *     `CircuitsTab.swift:circuitColumnWidths` (the narrower set, since
 *     web targets a range of viewports — landscape desktops and 7"
 *     portrait tablets).
 *   - Each cell is a tiny `<input>` matching the field type; select
 *     fields (polarity / ocpd_type / rcd_type) drop to compact picker
 *     rendering via a shared helper. We reuse `TallyBadge` on the
 *     polarity cell to match the card view's tri-state chip.
 *   - Delete is a single icon button per row — there's no multi-select
 *     mode (simplified from iOS, see parity ledger note).
 */

import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';

type Cell = string | undefined;

type CircuitLike = { id: string; [key: string]: unknown };

/** Field key + label + column type + pixel width. */
interface ColumnSpec {
  key: string;
  label: string;
  width: number;
  kind: 'text' | 'numeric' | 'select';
  options?: readonly string[];
  inputMode?: 'decimal' | 'numeric' | 'text';
}

const POLARITY_OPTS = ['', 'OK', 'Y', 'N'] as const;
const OCPD_TYPE_OPTS = ['', 'B', 'C', 'D', 'gG', 'gM', 'aM', 'HRC', 'Rew', 'N/A'] as const;
const RCD_TYPE_OPTS = ['', 'AC', 'A', 'F', 'B', 'S', 'N/A'] as const;
const BUTTON_CONFIRM_OPTS = ['', 'OK', 'Y', 'N'] as const;

const COLUMNS: ColumnSpec[] = [
  { key: 'wiring_type', label: 'Wiring', width: 60, kind: 'text' },
  { key: 'ref_method', label: 'Ref', width: 60, kind: 'text' },
  { key: 'number_of_points', label: 'Points', width: 60, kind: 'numeric', inputMode: 'numeric' },
  { key: 'live_csa_mm2', label: 'Live mm²', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'cpc_csa_mm2', label: 'CPC mm²', width: 70, kind: 'numeric', inputMode: 'decimal' },
  {
    key: 'max_disconnect_time_s',
    label: 'Max Disc',
    width: 70,
    kind: 'numeric',
    inputMode: 'decimal',
  },
  { key: 'ocpd_bs_en', label: 'OCPD BS/EN', width: 140, kind: 'text' },
  { key: 'ocpd_type', label: 'Type', width: 70, kind: 'select', options: OCPD_TYPE_OPTS },
  { key: 'ocpd_rating_a', label: 'Rating A', width: 70, kind: 'numeric', inputMode: 'decimal' },
  {
    key: 'ocpd_breaking_capacity_ka',
    label: 'kA',
    width: 60,
    kind: 'numeric',
    inputMode: 'decimal',
  },
  { key: 'ocpd_max_zs_ohm', label: 'Max Zs', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'rcd_bs_en', label: 'RCD BS/EN', width: 140, kind: 'text' },
  { key: 'rcd_type', label: 'RCD Type', width: 80, kind: 'select', options: RCD_TYPE_OPTS },
  {
    key: 'rcd_operating_current_ma',
    label: 'IΔn mA',
    width: 70,
    kind: 'numeric',
    inputMode: 'decimal',
  },
  { key: 'rcd_rating_a', label: 'RCD A', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ring_r1_ohm', label: 'r1', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ring_rn_ohm', label: 'rn', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ring_r2_ohm', label: 'r2', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'r1_r2_ohm', label: 'R1+R2', width: 80, kind: 'numeric', inputMode: 'decimal' },
  { key: 'r2_ohm', label: 'R2', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ir_test_voltage_v', label: 'IR V', width: 60, kind: 'numeric', inputMode: 'numeric' },
  { key: 'ir_live_live_mohm', label: 'IR L-L', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ir_live_earth_mohm', label: 'IR L-E', width: 70, kind: 'numeric', inputMode: 'decimal' },
  { key: 'polarity_confirmed', label: 'Pol', width: 70, kind: 'select', options: POLARITY_OPTS },
  { key: 'measured_zs_ohm', label: 'Meas Zs', width: 80, kind: 'numeric', inputMode: 'decimal' },
  { key: 'rcd_time_ms', label: 'RCD ms', width: 70, kind: 'numeric', inputMode: 'decimal' },
  {
    key: 'rcd_button_confirmed',
    label: 'RCD Btn',
    width: 70,
    kind: 'select',
    options: BUTTON_CONFIRM_OPTS,
  },
  {
    key: 'afdd_button_confirmed',
    label: 'AFDD Btn',
    width: 80,
    kind: 'select',
    options: BUTTON_CONFIRM_OPTS,
  },
];

const REF_WIDTH = 56;
const DESIGNATION_WIDTH = 220;
const DELETE_WIDTH = 56;

export interface CircuitsStickyTableProps {
  circuits: CircuitLike[];
  onPatch: (id: string, patch: Record<string, string>) => void;
  onRemove: (id: string) => void;
}

export function CircuitsStickyTable({ circuits, onPatch, onRemove }: CircuitsStickyTableProps) {
  return (
    <div
      className="relative overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)]"
      data-testid="circuits-sticky-table"
    >
      <table
        className="w-max text-[12px] text-[var(--color-text-primary)]"
        style={{ borderCollapse: 'separate', borderSpacing: 0 }}
      >
        <thead>
          <tr className="bg-[var(--color-surface-2)] text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
            <th
              className="sticky left-0 z-20 border-b border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-left"
              style={{ width: REF_WIDTH, minWidth: REF_WIDTH }}
              scope="col"
            >
              Ref
            </th>
            <th
              className="sticky z-20 border-b border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-left"
              style={{
                left: REF_WIDTH,
                width: DESIGNATION_WIDTH,
                minWidth: DESIGNATION_WIDTH,
              }}
              scope="col"
            >
              Designation
            </th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className="border-b border-[var(--color-border-subtle)] px-2 py-2 text-left"
                style={{ width: col.width, minWidth: col.width }}
                scope="col"
              >
                {col.label}
              </th>
            ))}
            <th
              className="border-b border-[var(--color-border-subtle)] px-2 py-2 text-right"
              style={{ width: DELETE_WIDTH, minWidth: DELETE_WIDTH }}
              scope="col"
            >
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {circuits.map((c) => (
            <Row key={c.id} circuit={c} onPatch={onPatch} onRemove={onRemove} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  circuit,
  onPatch,
  onRemove,
}: {
  circuit: CircuitLike;
  onPatch: (id: string, patch: Record<string, string>) => void;
  onRemove: (id: string) => void;
}) {
  const v = (k: string): Cell => {
    const value = circuit[k];
    return typeof value === 'string' ? value : undefined;
  };
  const ref = v('circuit_ref') ?? '';

  return (
    <tr className="group bg-[var(--color-surface-1)] transition hover:bg-[var(--color-surface-2)]">
      <td
        className="sticky left-0 z-10 border-b border-r border-[var(--color-border-subtle)] bg-inherit px-2 py-1"
        style={{ width: REF_WIDTH, minWidth: REF_WIDTH }}
      >
        <CellInput
          id={circuit.id}
          colKey="circuit_ref"
          value={v('circuit_ref')}
          onPatch={onPatch}
          ariaLabel={`Circuit ${ref} reference`}
        />
      </td>
      <td
        className="sticky z-10 border-b border-r border-[var(--color-border-subtle)] bg-inherit px-2 py-1"
        style={{
          left: REF_WIDTH,
          width: DESIGNATION_WIDTH,
          minWidth: DESIGNATION_WIDTH,
        }}
      >
        <CellInput
          id={circuit.id}
          colKey="circuit_designation"
          value={v('circuit_designation')}
          onPatch={onPatch}
          ariaLabel={`Circuit ${ref} designation`}
        />
      </td>
      {COLUMNS.map((col) => (
        <td
          key={col.key}
          className="border-b border-[var(--color-border-subtle)] px-2 py-1"
          style={{ width: col.width, minWidth: col.width }}
        >
          <CellField
            id={circuit.id}
            column={col}
            value={v(col.key)}
            onPatch={onPatch}
            circuitRef={ref}
          />
        </td>
      ))}
      <td
        className="border-b border-[var(--color-border-subtle)] px-2 py-1 text-right"
        style={{ width: DELETE_WIDTH, minWidth: DELETE_WIDTH }}
      >
        <IconButton
          variant="destructive"
          onClick={() => onRemove(circuit.id)}
          aria-label={`Remove circuit ${ref}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </IconButton>
      </td>
    </tr>
  );
}

function CellField({
  id,
  column,
  value,
  onPatch,
  circuitRef,
}: {
  id: string;
  column: ColumnSpec;
  value: Cell;
  onPatch: (id: string, patch: Record<string, string>) => void;
  circuitRef: string;
}) {
  const ariaLabel = `Circuit ${circuitRef} ${column.label}`;
  if (column.kind === 'select') {
    return (
      <select
        value={value ?? ''}
        onChange={(e) => onPatch(id, { [column.key]: e.target.value })}
        aria-label={ariaLabel}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-transparent px-1 py-0.5 text-[12px] focus:border-[var(--color-brand-blue)] focus:outline-none"
      >
        {(column.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt === '' ? '—' : opt}
          </option>
        ))}
      </select>
    );
  }
  return (
    <CellInput
      id={id}
      colKey={column.key}
      value={value}
      onPatch={onPatch}
      inputMode={column.inputMode}
      ariaLabel={ariaLabel}
    />
  );
}

function CellInput({
  id,
  colKey,
  value,
  onPatch,
  inputMode,
  ariaLabel,
}: {
  id: string;
  colKey: string;
  value: Cell;
  onPatch: (id: string, patch: Record<string, string>) => void;
  inputMode?: 'decimal' | 'numeric' | 'text';
  ariaLabel: string;
}) {
  return (
    <input
      type="text"
      inputMode={inputMode}
      value={value ?? ''}
      onChange={(e) => onPatch(id, { [colKey]: e.target.value })}
      aria-label={ariaLabel}
      className="w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-1 py-0.5 text-[12px] focus:border-[var(--color-brand-blue)] focus:outline-none"
    />
  );
}
