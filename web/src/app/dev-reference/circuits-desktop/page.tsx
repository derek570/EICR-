'use client';

/**
 * Dev-only preview of the new desktop circuits schedule. Mounts
 * `CircuitsScheduleDesktop` against seeded circuits so the layout can
 * be inspected without standing up auth / DB / backend.
 *
 * Public under `PUBLIC_PREFIXES` (web/src/middleware.ts:19). Returns
 * notFound() in production so this never ships externally.
 */

import * as React from 'react';
import { notFound } from 'next/navigation';
import { CircuitsScheduleDesktop } from '@/components/job/circuits-schedule-desktop';
import { isSpareCircuit } from '@/lib/constants/circuit-field-options';

type Circuit = { id: string; [key: string]: string | undefined };

const SEED: Circuit[] = [
  {
    id: 'c1',
    circuit_ref: '1',
    circuit_designation: 'Ring Final - Living Room',
    wiring_type: 'A',
    ref_method: 'C',
    number_of_points: '6',
    live_csa_mm2: '2.5',
    cpc_csa_mm2: '1.5',
    max_disconnect_time_s: '0.4',
    ocpd_bs_en: 'BS EN 60898',
    ocpd_type: 'B',
    ocpd_rating_a: '32',
    ocpd_breaking_capacity_ka: '6',
    ocpd_max_zs_ohm: '1.37',
    rcd_bs_en: 'BS EN 61009',
    rcd_type: 'A',
    rcd_operating_current_ma: '30',
    rcd_rating_a: '32',
    ring_r1_ohm: '0.32',
    ring_rn_ohm: '0.32',
    ring_r2_ohm: '0.52',
    r1_r2_ohm: '0.21',
    r2_ohm: '',
    ir_test_voltage_v: '500',
    ir_live_live_mohm: '200',
    ir_live_earth_mohm: '200',
    polarity_confirmed: 'OK',
    measured_zs_ohm: '0.48',
    rcd_time_ms: '24',
    rcd_button_confirmed: 'OK',
    afdd_button_confirmed: '',
  },
  {
    id: 'c2',
    circuit_ref: '2',
    circuit_designation: 'Sockets - Kitchen Radial',
    wiring_type: 'A',
    ref_method: 'C',
    number_of_points: '4',
    live_csa_mm2: '4',
    cpc_csa_mm2: '1.5',
    max_disconnect_time_s: '0.4',
    ocpd_bs_en: 'BS EN 60898',
    ocpd_type: 'B',
    ocpd_rating_a: '20',
    ocpd_breaking_capacity_ka: '6',
    ocpd_max_zs_ohm: '2.19',
    rcd_bs_en: 'BS EN 61009',
    rcd_type: 'A',
    rcd_operating_current_ma: '30',
    rcd_rating_a: '20',
    ring_r1_ohm: '',
    ring_rn_ohm: '',
    ring_r2_ohm: '',
    r1_r2_ohm: '0.45',
    r2_ohm: '',
    ir_test_voltage_v: '500',
    ir_live_live_mohm: '200',
    ir_live_earth_mohm: '200',
    polarity_confirmed: 'OK',
    measured_zs_ohm: '0.72',
    rcd_time_ms: '21',
    rcd_button_confirmed: 'OK',
  },
  {
    id: 'c3',
    circuit_ref: '3',
    circuit_designation: 'Lighting - Upstairs',
    wiring_type: 'A',
    ref_method: 'C',
    number_of_points: '8',
    live_csa_mm2: '1.5',
    cpc_csa_mm2: '1',
    max_disconnect_time_s: '0.4',
    ocpd_bs_en: 'BS EN 60898',
    ocpd_type: 'B',
    ocpd_rating_a: '6',
    rcd_bs_en: 'BS EN 61008',
    rcd_type: 'AC',
    rcd_operating_current_ma: '30',
    r1_r2_ohm: '0.55',
    ir_test_voltage_v: '500',
    polarity_confirmed: 'OK',
    measured_zs_ohm: '0.78',
  },
  {
    id: 'c4',
    circuit_ref: '4',
    circuit_designation: 'Shower - Ensuite',
    wiring_type: 'A',
    ref_method: 'C',
    number_of_points: '1',
    live_csa_mm2: '10',
    cpc_csa_mm2: '4',
    ocpd_bs_en: 'BS EN 60898',
    ocpd_type: 'B',
    ocpd_rating_a: '40',
    rcd_bs_en: 'BS EN 61008',
    rcd_type: 'A',
    rcd_operating_current_ma: '30',
    r1_r2_ohm: '0.18',
    measured_zs_ohm: '0.41',
  },
  {
    id: 'c5',
    circuit_ref: '5',
    circuit_designation: 'Cooker - Kitchen',
    ocpd_type: 'B',
    ocpd_rating_a: '32',
  },
  {
    id: 'c6',
    circuit_ref: '6',
    circuit_designation: 'Spare',
  },
];

export default function CircuitsDesktopPreview() {
  if (process.env.NODE_ENV === 'production') notFound();
  const [circuits, setCircuits] = React.useState<Circuit[]>(SEED);

  const patch = (id: string, p: Record<string, string>) =>
    setCircuits((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const bulkPatch = (field: string, value: string, options: { skipSpare: boolean }) =>
    setCircuits((prev) =>
      prev.map((c) => (options.skipSpare && isSpareCircuit(c) ? c : { ...c, [field]: value }))
    );

  const remove = (id: string) => setCircuits((prev) => prev.filter((c) => c.id !== id));

  const addRow = () =>
    setCircuits((prev) => [
      ...prev,
      {
        id: `c${prev.length + 1}-${Date.now()}`,
        circuit_ref: String(prev.length + 1),
        circuit_designation: '',
      },
    ]);

  return (
    <div className="mx-auto flex w-full flex-col gap-4 px-4 py-6 md:px-8 md:py-8">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-[22px] font-bold text-[var(--color-text-primary)]">
          Circuits — desktop schedule preview
        </h1>
        <span className="text-[12px] text-[var(--color-text-tertiary)]">
          Resize window to ≥ 1280 px. Seeded data — not persisted.
        </span>
      </header>
      <div className="flex flex-wrap gap-2 text-[12px] text-[var(--color-text-secondary)]">
        <span className="rounded-full bg-[var(--color-surface-2)] px-3 py-1">
          Click any column header for the bulk-fill popover
        </span>
        <span className="rounded-full bg-[var(--color-surface-2)] px-3 py-1">
          Click an enum cell (Wiring, OCPD, RCD, Polarity) for an inline dropdown
        </span>
        <span className="rounded-full bg-[var(--color-surface-2)] px-3 py-1">
          Spare row stays untouched when "Skip spare circuits" is on
        </span>
        <button
          type="button"
          onClick={addRow}
          className="rounded-full bg-[var(--color-brand-blue)] px-3 py-1 font-semibold text-white"
        >
          + Add row
        </button>
      </div>
      <CircuitsScheduleDesktop
        circuits={circuits}
        onPatch={patch}
        onBulkPatch={bulkPatch}
        onRemove={remove}
      />
    </div>
  );
}
