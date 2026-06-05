'use client';

/**
 * Desktop circuits schedule — full-width replacement for the sticky
 * table on viewports ≥ 1280 px. Designed for inspectors who spend long
 * stretches in this tab editing 30+ circuits at once.
 *
 * Differences from `circuits-sticky-table.tsx`:
 *   - Cells are tap-target-sized (min 44 px tall) instead of the
 *     compact 12 px grid the table uses.
 *   - Enum fields render an inline dropdown popover on click. The
 *     option lists live in `lib/constants/circuit-field-options.ts`
 *     (mirrors iOS `Constants.swift` and `field_schema.json`).
 *   - Column headers are clickable. Clicking opens a bulk-fill popover
 *     letting the inspector apply one value to every visible circuit
 *     (with an optional "Skip spare circuits" toggle).
 *   - Ref + Designation columns stay `position: sticky` so the schedule
 *     remains usable on 1280-1600 px screens where 28 columns still
 *     overflow horizontally.
 *
 * Action toolbar (Add / Delete / Defaults / Reverse / Calculate / CCU)
 * is rendered by `page.tsx` above this component on desktop — keeping
 * the action surface out of this file means the row of pill buttons
 * stays a single render path shared with mobile.
 */

import * as React from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import {
  CIRCUIT_FIELD_OPTIONS,
  isSpareCircuit,
  type CircuitFieldKey,
} from '@/lib/constants/circuit-field-options';
import { applyDefaultsToCircuit } from '@certmate/shared-utils';

type CircuitLike = { id: string; [key: string]: unknown };

interface ColumnSpec {
  key: string;
  label: string;
  width: number;
  kind: 'text' | 'numeric' | 'options';
  inputMode?: 'decimal' | 'numeric' | 'text';
}

// Column order mirrors iOS landscape schedule (CircuitsTab.swift L565-L600)
// and the existing sticky table for parity. Widths are wider than the
// sticky table — desktop inspectors want comfortable tap targets, not
// information density.
const COLUMNS: ColumnSpec[] = [
  { key: 'wiring_type', label: 'Wiring', width: 84, kind: 'options' },
  { key: 'ref_method', label: 'Ref Method', width: 96, kind: 'options' },
  { key: 'number_of_points', label: 'Points', width: 76, kind: 'numeric', inputMode: 'numeric' },
  { key: 'live_csa_mm2', label: 'Live mm²', width: 88, kind: 'numeric', inputMode: 'decimal' },
  { key: 'cpc_csa_mm2', label: 'CPC mm²', width: 88, kind: 'numeric', inputMode: 'decimal' },
  {
    key: 'max_disconnect_time_s',
    label: 'Max Disc',
    width: 84,
    kind: 'numeric',
    inputMode: 'decimal',
  },
  { key: 'ocpd_bs_en', label: 'OCPD BS/EN', width: 156, kind: 'options' },
  { key: 'ocpd_type', label: 'Type', width: 84, kind: 'options' },
  { key: 'ocpd_rating_a', label: 'A', width: 72, kind: 'numeric', inputMode: 'decimal' },
  {
    key: 'ocpd_breaking_capacity_ka',
    label: 'kA',
    width: 72,
    kind: 'numeric',
    inputMode: 'decimal',
  },
  { key: 'ocpd_max_zs_ohm', label: 'Max Zs', width: 88, kind: 'numeric', inputMode: 'decimal' },
  { key: 'rcd_bs_en', label: 'RCD BS/EN', width: 156, kind: 'options' },
  { key: 'rcd_type', label: 'RCD Type', width: 92, kind: 'options' },
  {
    key: 'rcd_operating_current_ma',
    label: 'IΔn mA',
    width: 84,
    kind: 'numeric',
    inputMode: 'decimal',
  },
  { key: 'rcd_rating_a', label: 'RCD A', width: 80, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ring_r1_ohm', label: 'r1', width: 76, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ring_rn_ohm', label: 'rn', width: 76, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ring_r2_ohm', label: 'r2', width: 76, kind: 'numeric', inputMode: 'decimal' },
  { key: 'r1_r2_ohm', label: 'R1+R2', width: 92, kind: 'numeric', inputMode: 'decimal' },
  { key: 'r2_ohm', label: 'R2', width: 80, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ir_test_voltage_v', label: 'IR V', width: 72, kind: 'numeric', inputMode: 'numeric' },
  { key: 'ir_live_live_mohm', label: 'IR L-L', width: 84, kind: 'numeric', inputMode: 'decimal' },
  { key: 'ir_live_earth_mohm', label: 'IR L-E', width: 84, kind: 'numeric', inputMode: 'decimal' },
  { key: 'polarity_confirmed', label: 'Polarity', width: 92, kind: 'options' },
  { key: 'measured_zs_ohm', label: 'Meas Zs', width: 92, kind: 'numeric', inputMode: 'decimal' },
  { key: 'rcd_time_ms', label: 'RCD ms', width: 84, kind: 'numeric', inputMode: 'decimal' },
  { key: 'rcd_button_confirmed', label: 'RCD Btn', width: 88, kind: 'options' },
  { key: 'afdd_button_confirmed', label: 'AFDD Btn', width: 96, kind: 'options' },
];

const REF_WIDTH = 64;
const DESIGNATION_WIDTH = 240;
const DELETE_WIDTH = 56;
const ROW_HEIGHT = 52;
/** Debounce window for auto-defaults after the inspector stops typing
 *  in the designation cell. 600ms is comfortably past human typing
 *  cadence (~150ms / keystroke for a fluent typist) without feeling
 *  laggy. Blur triggers the same path immediately. */
const DEFAULTS_DEBOUNCE_MS = 600;
/** How long the brand-blue cell flash plays. Mirrors the keyframe in
 *  globals.css `.cm-cell-flash`. We remove the className after this
 *  delay so a subsequent auto-fill of the same cell can re-trigger. */
const FLASH_DURATION_MS = 1400;

export interface CircuitsScheduleDesktopProps {
  circuits: CircuitLike[];
  onPatch: (id: string, patch: Record<string, string>) => void;
  onBulkPatch: (field: string, value: string, options: { skipSpare: boolean }) => void;
  onRemove: (id: string) => void;
}

export function CircuitsScheduleDesktop({
  circuits,
  onPatch,
  onBulkPatch,
  onRemove,
}: CircuitsScheduleDesktopProps) {
  // Active inline popover: one cell at a time, keyed by `${rowId}::${colKey}`.
  const [activeCell, setActiveCell] = React.useState<string | null>(null);
  // Active header popover: column key for which the bulk-fill UI is open.
  const [activeHeader, setActiveHeader] = React.useState<string | null>(null);
  // Cells that should currently play the brand-blue auto-fill flash.
  // Keys are `${rowId}::${field}`; tick state forces a re-render when the
  // same key fires twice in a row (since the Set identity stays stable).
  const [flashed, setFlashed] = React.useState<Set<string>>(() => new Set());
  const containerRef = React.useRef<HTMLDivElement>(null);
  const flashTimers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Debounced auto-defaults timer per circuit id — fires DEFAULTS_DEBOUNCE_MS
  // after the last designation keystroke. iOS leaves defaults manual (the
  // Apply Defaults rail button); the desktop schedule fires it eagerly so a
  // designer entering "Lighting" / "Cooker" sees the row light up with the
  // matching cable / OCPD presets the moment they pause typing.
  const defaultsTimers = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  React.useEffect(() => {
    // Clean any pending timers when the component unmounts. The Map's
    // stored timeout ids are individually cleared because clearTimeout
    // on a stale id is a no-op but the closure over `circuits` would
    // otherwise leak across the unmount boundary.
    const flash = flashTimers.current;
    const defaults = defaultsTimers.current;
    return () => {
      flash.forEach(clearTimeout);
      defaults.forEach(clearTimeout);
    };
  }, []);

  const markFlashed = React.useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setFlashed((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
    keys.forEach((k) => {
      const existing = flashTimers.current.get(k);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        setFlashed((prev) => {
          if (!prev.has(k)) return prev;
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
        flashTimers.current.delete(k);
      }, FLASH_DURATION_MS);
      flashTimers.current.set(k, t);
    });
  }, []);

  // Designation → defaults pipeline. Looks up the per-type defaults via
  // `applyDefaultsToCircuit`, builds a patch of only the newly-filled
  // fields (so React still receives an additive patch, not a wholesale
  // replacement), and triggers the flash for those fields.
  const applyDesignationDefaults = React.useCallback(
    (circuit: CircuitLike) => {
      // Coerce the loose `CircuitLike` shape into something
      // `applyDefaultsToCircuit` can accept — it expects a plain
      // string-valued Circuit subset.
      const stringy: Record<string, string> = {};
      for (const [k, val] of Object.entries(circuit)) {
        if (typeof val === 'string') stringy[k] = val;
      }
      const { circuit: filled, filledFields } = applyDefaultsToCircuit(stringy);
      if (filledFields === 0) return;
      const patch: Record<string, string> = {};
      const flashKeys: string[] = [];
      for (const [k, v] of Object.entries(filled)) {
        if (k === 'id' || k === 'circuit_designation' || k === 'circuit_ref') continue;
        if (typeof v !== 'string' || v.trim() === '') continue;
        if (stringy[k] !== v) {
          patch[k] = v;
          flashKeys.push(`${circuit.id}::${k}`);
        }
      }
      if (Object.keys(patch).length === 0) return;
      onPatch(circuit.id, patch);
      markFlashed(flashKeys);
    },
    [onPatch, markFlashed]
  );

  const scheduleDesignationDefaults = React.useCallback(
    (circuit: CircuitLike) => {
      const existing = defaultsTimers.current.get(circuit.id);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        defaultsTimers.current.delete(circuit.id);
        applyDesignationDefaults(circuit);
      }, DEFAULTS_DEBOUNCE_MS);
      defaultsTimers.current.set(circuit.id, t);
    },
    [applyDesignationDefaults]
  );

  const flushDesignationDefaults = React.useCallback(
    (circuit: CircuitLike) => {
      const existing = defaultsTimers.current.get(circuit.id);
      if (existing) {
        clearTimeout(existing);
        defaultsTimers.current.delete(circuit.id);
      }
      applyDesignationDefaults(circuit);
    },
    [applyDesignationDefaults]
  );

  // Click-outside closes any open popover. Without this an open dropdown
  // would stay anchored even after the inspector moved on to a different
  // cell — particularly painful when scrolling the table horizontally.
  React.useEffect(() => {
    if (!activeCell && !activeHeader) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current?.contains(target)) {
        // Click inside table — handled by the cell/header onClick.
        // We close on Escape and outside clicks only.
        return;
      }
      setActiveCell(null);
      setActiveHeader(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeCell, activeHeader]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveCell(null);
        setActiveHeader(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-[0_2px_12px_rgba(0,0,0,0.18)]"
      data-testid="circuits-schedule-desktop"
    >
      <table
        className="w-max text-[13px] text-[var(--color-text-primary)]"
        style={{ borderCollapse: 'separate', borderSpacing: 0 }}
      >
        <thead>
          <tr className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--color-text-secondary)]">
            <th
              className="sticky left-0 z-20 border-b border-r border-[var(--color-border-subtle)] px-3 py-3 text-left"
              style={{
                width: REF_WIDTH,
                minWidth: REF_WIDTH,
                background:
                  'linear-gradient(180deg, color-mix(in srgb, var(--color-brand-blue) 14%, var(--color-surface-2)) 0%, var(--color-surface-2) 100%)',
              }}
              scope="col"
            >
              Ref
            </th>
            <th
              className="sticky z-20 border-b border-r border-[var(--color-border-subtle)] px-3 py-3 text-left"
              style={{
                left: REF_WIDTH,
                width: DESIGNATION_WIDTH,
                minWidth: DESIGNATION_WIDTH,
                background:
                  'linear-gradient(180deg, color-mix(in srgb, var(--color-brand-blue) 14%, var(--color-surface-2)) 0%, var(--color-surface-2) 100%)',
              }}
              scope="col"
            >
              Designation
            </th>
            {COLUMNS.map((col) => (
              <HeaderCell
                key={col.key}
                column={col}
                isActive={activeHeader === col.key}
                onToggle={() => {
                  setActiveHeader((prev) => (prev === col.key ? null : col.key));
                  setActiveCell(null);
                }}
                onApply={(value, skipSpare) => {
                  onBulkPatch(col.key, value, { skipSpare });
                  setActiveHeader(null);
                }}
                onClose={() => setActiveHeader(null)}
              />
            ))}
            <th
              className="border-b border-[var(--color-border-subtle)] px-2 py-3 text-right"
              style={{ width: DELETE_WIDTH, minWidth: DELETE_WIDTH }}
              scope="col"
            >
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {circuits.map((c, idx) => (
            <Row
              key={c.id}
              circuit={c}
              rowIndex={idx}
              onPatch={onPatch}
              onRemove={onRemove}
              activeCell={activeCell}
              setActiveCell={setActiveCell}
              flashed={flashed}
              onDesignationChange={scheduleDesignationDefaults}
              onDesignationBlur={flushDesignationDefaults}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeaderCell({
  column,
  isActive,
  onToggle,
  onApply,
  onClose,
}: {
  column: ColumnSpec;
  isActive: boolean;
  onToggle: () => void;
  onApply: (value: string, skipSpare: boolean) => void;
  onClose: () => void;
}) {
  return (
    <th
      className="relative border-b border-[var(--color-border-subtle)] px-0 py-0 text-left"
      style={{ width: column.width, minWidth: column.width }}
      scope="col"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={isActive}
        className={`flex w-full items-center justify-between gap-1 px-2 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.04em] transition hover:bg-[var(--color-surface-3)] ${
          isActive
            ? 'bg-[var(--color-surface-3)] text-[var(--color-brand-blue)]'
            : 'text-[var(--color-text-tertiary)]'
        }`}
      >
        <span className="truncate">{column.label}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-60" aria-hidden />
      </button>
      {isActive ? <ColumnFillPopover column={column} onApply={onApply} onClose={onClose} /> : null}
    </th>
  );
}

function ColumnFillPopover({
  column,
  onApply,
  onClose,
}: {
  column: ColumnSpec;
  onApply: (value: string, skipSpare: boolean) => void;
  onClose: () => void;
}) {
  const presetOptions =
    column.kind === 'options' && column.key in CIRCUIT_FIELD_OPTIONS
      ? CIRCUIT_FIELD_OPTIONS[column.key as CircuitFieldKey]
      : null;
  const [value, setValue] = React.useState<string>(presetOptions?.[0] ?? '');
  const [skipSpare, setSkipSpare] = React.useState(true);

  return (
    <div
      role="dialog"
      aria-label={`Fill ${column.label} column`}
      className="cm-popover-in absolute left-0 top-full z-30 mt-2 w-72 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4 text-left text-[12px] font-normal normal-case tracking-normal text-[var(--color-text-primary)] shadow-[0_16px_40px_rgba(0,0,0,0.55)] backdrop-blur-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.04em] text-[var(--color-text-tertiary)]">
        <span>Fill {column.label.toLowerCase()}</span>
        <span className="rounded-full bg-[var(--color-brand-blue)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-brand-blue)]">
          column
        </span>
      </div>
      {presetOptions ? (
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Preset value for ${column.label}`}
          className="mb-3 block w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-[13px] focus:border-[var(--color-brand-blue)] focus:outline-none"
        >
          {presetOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
          <option value="">— Clear —</option>
        </select>
      ) : (
        <input
          type="text"
          inputMode={column.inputMode}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Fill value for ${column.label}`}
          placeholder="Type a value"
          className="mb-3 block w-full rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 py-2 text-[13px] focus:border-[var(--color-brand-blue)] focus:outline-none"
          autoFocus
        />
      )}
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
        <input
          type="checkbox"
          checked={skipSpare}
          onChange={(e) => setSkipSpare(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-[var(--color-brand-blue)]"
        />
        Skip spare circuits
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-transparent px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-surface-2)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onApply(value, skipSpare)}
          className="rounded-[var(--radius-sm)] bg-[var(--color-brand-blue)] px-3 py-1.5 text-[12px] font-semibold text-white transition hover:opacity-90"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function Row({
  circuit,
  rowIndex,
  onPatch,
  onRemove,
  activeCell,
  setActiveCell,
  flashed,
  onDesignationChange,
  onDesignationBlur,
}: {
  circuit: CircuitLike;
  rowIndex: number;
  onPatch: (id: string, patch: Record<string, string>) => void;
  onRemove: (id: string) => void;
  activeCell: string | null;
  setActiveCell: (next: string | null) => void;
  flashed: Set<string>;
  onDesignationChange: (circuit: CircuitLike) => void;
  onDesignationBlur: (circuit: CircuitLike) => void;
}) {
  const v = (k: string): string | undefined => {
    const val = circuit[k];
    return typeof val === 'string' ? val : undefined;
  };
  const ref = v('circuit_ref') ?? '';
  const spare = isSpareCircuit(circuit);
  // Zebra striping. Spare rows have a stronger tint and reduced text
  // contrast so the eye can skim past them when scanning a schedule of
  // 30+ circuits. Odd rows pick up a 3% surface-3 wash; even rows stay
  // at surface-1 so the schedule reads like a paper EICR form.
  const baseTint = spare
    ? 'bg-[color-mix(in_srgb,var(--color-status-pending)_8%,var(--color-surface-1))] text-[var(--color-text-tertiary)]'
    : rowIndex % 2 === 0
      ? 'bg-[var(--color-surface-1)]'
      : 'bg-[color-mix(in_srgb,var(--color-surface-2)_55%,var(--color-surface-1))]';

  const stickyAccent =
    'linear-gradient(90deg, color-mix(in srgb, var(--color-brand-blue) 10%, transparent) 0%, transparent 60%)';

  const flashClass = (field: string) =>
    flashed.has(`${circuit.id}::${field}`) ? 'cm-cell-flash' : '';

  return (
    <tr
      className={`group transition-colors duration-150 ${baseTint} hover:bg-[color-mix(in_srgb,var(--color-brand-blue)_6%,var(--color-surface-2))]`}
      style={{ height: ROW_HEIGHT }}
    >
      <td
        className="sticky left-0 z-10 border-b border-r border-[var(--color-border-subtle)] bg-inherit px-2 py-1 font-semibold text-[var(--color-text-secondary)]"
        style={{
          width: REF_WIDTH,
          minWidth: REF_WIDTH,
          backgroundImage: stickyAccent,
        }}
      >
        <CellInput
          id={circuit.id}
          colKey="circuit_ref"
          value={v('circuit_ref')}
          onPatch={onPatch}
          ariaLabel={`Circuit ${ref} reference`}
          align="center"
          weight="semibold"
        />
      </td>
      <td
        className="sticky z-10 border-b border-r border-[var(--color-border-subtle)] bg-inherit px-2 py-1"
        style={{
          left: REF_WIDTH,
          width: DESIGNATION_WIDTH,
          minWidth: DESIGNATION_WIDTH,
          backgroundImage: stickyAccent,
        }}
      >
        <CellInput
          id={circuit.id}
          colKey="circuit_designation"
          value={v('circuit_designation')}
          onPatch={(id, patch) => {
            onPatch(id, patch);
            // Schedule the debounced auto-defaults pipeline. We pass the
            // *patched* shape so `inferCircuitType` sees the freshest
            // designation when the timer fires.
            onDesignationChange({ ...circuit, ...patch });
          }}
          onBlur={() => onDesignationBlur(circuit)}
          ariaLabel={`Circuit ${ref} designation`}
        />
      </td>
      {COLUMNS.map((col) => {
        const cellKey = `${circuit.id}::${col.key}`;
        return (
          <td
            key={col.key}
            className={`relative border-b border-[var(--color-border-subtle)] px-1 py-1 ${flashClass(col.key)}`}
            style={{ width: col.width, minWidth: col.width }}
          >
            <CellField
              id={circuit.id}
              column={col}
              value={v(col.key)}
              onPatch={onPatch}
              circuitRef={ref}
              isOpen={activeCell === cellKey}
              onOpen={() => setActiveCell(cellKey)}
              onClose={() => setActiveCell(null)}
            />
          </td>
        );
      })}
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
  isOpen,
  onOpen,
  onClose,
}: {
  id: string;
  column: ColumnSpec;
  value: string | undefined;
  onPatch: (id: string, patch: Record<string, string>) => void;
  circuitRef: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const ariaLabel = `Circuit ${circuitRef} ${column.label}`;
  if (column.kind === 'options' && column.key in CIRCUIT_FIELD_OPTIONS) {
    const options = CIRCUIT_FIELD_OPTIONS[column.key as CircuitFieldKey];
    return (
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (isOpen) onClose();
            else onOpen();
          }}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={ariaLabel}
          className={`flex h-10 w-full items-center justify-between rounded-[var(--radius-sm)] border px-2 text-[13px] transition-all duration-150 ${
            isOpen
              ? 'border-[var(--color-brand-blue)] bg-[var(--color-surface-2)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-brand-blue)_25%,transparent)]'
              : 'border-transparent hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-2)]'
          }`}
        >
          <span className={value ? 'font-medium' : 'opacity-50'}>{value || '—'}</span>
          <ChevronDown
            className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${
              isOpen ? 'rotate-180 text-[var(--color-brand-blue)]' : 'opacity-60'
            }`}
            aria-hidden
          />
        </button>
        {isOpen ? (
          <ul
            role="listbox"
            aria-label={ariaLabel}
            className="cm-popover-in absolute left-0 top-full z-30 mt-1 max-h-64 min-w-full overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] py-1 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
            onClick={(e) => e.stopPropagation()}
          >
            <li>
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => {
                  onPatch(id, { [column.key]: '' });
                  onClose();
                }}
                className="block w-full px-3 py-2 text-left text-[13px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-2)]"
              >
                — Clear —
              </button>
            </li>
            {options.map((opt) => (
              <li key={opt}>
                <button
                  type="button"
                  role="option"
                  aria-selected={value === opt}
                  onClick={() => {
                    onPatch(id, { [column.key]: opt });
                    onClose();
                  }}
                  className={`block w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--color-surface-2)] ${
                    value === opt
                      ? 'bg-[var(--color-surface-2)] text-[var(--color-brand-blue)]'
                      : 'text-[var(--color-text-primary)]'
                  }`}
                >
                  {opt}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
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
  onBlur,
  inputMode,
  ariaLabel,
  align,
  weight,
}: {
  id: string;
  colKey: string;
  value: string | undefined;
  onPatch: (id: string, patch: Record<string, string>) => void;
  onBlur?: () => void;
  inputMode?: 'decimal' | 'numeric' | 'text';
  ariaLabel: string;
  align?: 'center' | 'left';
  weight?: 'normal' | 'semibold';
}) {
  const alignClass = align === 'center' ? 'text-center' : 'text-left';
  const weightClass = weight === 'semibold' ? 'font-semibold' : '';
  return (
    <input
      type="text"
      inputMode={inputMode}
      value={value ?? ''}
      onChange={(e) => onPatch(id, { [colKey]: e.target.value })}
      onBlur={onBlur}
      aria-label={ariaLabel}
      className={`h-10 w-full rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 text-[13px] transition-colors duration-150 hover:border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-2)] focus:border-[var(--color-brand-blue)] focus:bg-[var(--color-surface-2)] focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-brand-blue)_25%,transparent)] focus:outline-none ${alignClass} ${weightClass}`}
    />
  );
}
