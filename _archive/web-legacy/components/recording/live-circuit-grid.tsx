'use client';

/**
 * LiveCircuitGrid — Real-time circuit data table for the recording session.
 *
 * Mirrors the iOS LiveCircuitGrid with colored column group headers,
 * horizontally scrollable table, and animated field updates.
 * Each cell that receives a new value flashes blue briefly.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { Circuit } from '@/lib/types';

/* ------------------------------------------------------------------ */
/*  Column definitions                                                 */
/* ------------------------------------------------------------------ */

interface ColumnDef {
  key: string;
  label: string;
  abbr: string;
  width: number; // px
}

interface ColumnGroup {
  name: string;
  color: string; // tailwind bg class
  textColor: string; // tailwind text class
  columns: ColumnDef[];
}

const columnGroups: ColumnGroup[] = [
  {
    name: 'Circuit',
    color: 'bg-slate-600',
    textColor: 'text-white',
    columns: [
      { key: 'circuit_ref', label: 'Ref', abbr: '#', width: 36 },
      { key: 'circuit_designation', label: 'Designation', abbr: 'Desig', width: 100 },
    ],
  },
  {
    name: 'Conductors',
    color: 'bg-gray-500',
    textColor: 'text-white',
    columns: [
      { key: 'wiring_type', label: 'Wiring Type', abbr: 'WT', width: 36 },
      { key: 'ref_method', label: 'Ref Method', abbr: 'RM', width: 36 },
      { key: 'number_of_points', label: 'Points', abbr: 'Pts', width: 36 },
      { key: 'live_csa_mm2', label: 'Live CSA', abbr: 'L', width: 36 },
      { key: 'cpc_csa_mm2', label: 'CPC CSA', abbr: 'C', width: 36 },
    ],
  },
  {
    name: 'Disconnect',
    color: 'bg-gray-500',
    textColor: 'text-white',
    columns: [{ key: 'max_disconnect_time_s', label: 'Max Time', abbr: 'Dt', width: 36 }],
  },
  {
    name: 'OCPD',
    color: 'bg-orange-500',
    textColor: 'text-white',
    columns: [
      { key: 'ocpd_bs_en', label: 'BS EN', abbr: 'BS', width: 52 },
      { key: 'ocpd_type', label: 'Type', abbr: 'Ty', width: 32 },
      { key: 'ocpd_rating_a', label: 'Rating', abbr: 'A', width: 36 },
      { key: 'ocpd_breaking_capacity_ka', label: 'Break Cap', abbr: 'kA', width: 32 },
      { key: 'ocpd_max_zs_ohm', label: 'Max Zs', abbr: 'Zs', width: 40 },
    ],
  },
  {
    name: 'RCD',
    color: 'bg-purple-500',
    textColor: 'text-white',
    columns: [
      { key: 'rcd_bs_en', label: 'BS EN', abbr: 'BS', width: 52 },
      { key: 'rcd_type', label: 'Type', abbr: 'Ty', width: 32 },
      { key: 'rcd_operating_current_ma', label: 'mA', abbr: 'mA', width: 36 },
    ],
  },
  {
    name: 'Ring',
    color: 'bg-green-600',
    textColor: 'text-white',
    columns: [
      { key: 'ring_r1_ohm', label: 'r1', abbr: 'r1', width: 40 },
      { key: 'ring_rn_ohm', label: 'rn', abbr: 'rn', width: 40 },
      { key: 'ring_r2_ohm', label: 'r2', abbr: 'r2', width: 40 },
    ],
  },
  {
    name: 'Continuity',
    color: 'bg-teal-500',
    textColor: 'text-white',
    columns: [
      { key: 'r1_r2_ohm', label: 'R1+R2', abbr: 'R1', width: 44 },
      { key: 'r2_ohm', label: 'R2', abbr: 'R2', width: 44 },
    ],
  },
  {
    name: 'Insulation',
    color: 'bg-yellow-500',
    textColor: 'text-gray-900',
    columns: [
      { key: 'ir_test_voltage_v', label: 'Test V', abbr: 'V', width: 36 },
      { key: 'ir_live_live_mohm', label: 'L-L', abbr: 'LL', width: 40 },
      { key: 'ir_live_earth_mohm', label: 'L-E', abbr: 'LE', width: 40 },
    ],
  },
  {
    name: 'Test Results',
    color: 'bg-red-500',
    textColor: 'text-white',
    columns: [
      { key: 'polarity_confirmed', label: 'Polarity', abbr: 'P', width: 32 },
      { key: 'measured_zs_ohm', label: 'Meas Zs', abbr: 'Zs', width: 44 },
      { key: 'rcd_time_ms', label: 'RCD Time', abbr: 'ms', width: 40 },
      { key: 'rcd_button_confirmed', label: 'RCD Btn', abbr: 'Rc', width: 32 },
      { key: 'afdd_button_confirmed', label: 'AFDD Btn', abbr: 'Af', width: 32 },
    ],
  },
];

const allColumns = columnGroups.flatMap((g) => g.columns);

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface LiveCircuitGridProps {
  circuits: Circuit[];
  /** Map of "circuit.{ref}.{field}" → timestamp for flash effect */
  recentlyUpdatedFields?: Record<string, number>;
}

export function LiveCircuitGrid({ circuits, recentlyUpdatedFields = {} }: LiveCircuitGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [flashingCells, setFlashingCells] = useState<Set<string>>(new Set());

  // Detect newly-updated fields and flash them
  useEffect(() => {
    const now = Date.now();
    const newFlashing = new Set<string>();
    for (const [key, ts] of Object.entries(recentlyUpdatedFields)) {
      if (now - ts < 2000) {
        newFlashing.add(key);
      }
    }
    setFlashingCells(newFlashing);

    // Clear flash after 2s
    if (newFlashing.size > 0) {
      const timer = setTimeout(() => setFlashingCells(new Set()), 2000);
      return () => clearTimeout(timer);
    }
  }, [recentlyUpdatedFields]);

  if (circuits.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400">
        <div className="mb-2 text-3xl">📋</div>
        <p className="text-sm">No circuits yet. Start recording to capture circuit data.</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-max border-collapse">
        {/* Group header row */}
        <thead>
          <tr>
            {columnGroups.map((group) => (
              <th
                key={group.name}
                colSpan={group.columns.length}
                className={cn(
                  'px-1 py-0.5 text-center text-[10px] font-semibold tracking-wide uppercase',
                  group.color,
                  group.textColor
                )}
              >
                {group.name}
              </th>
            ))}
          </tr>

          {/* Column header row */}
          <tr className="bg-gray-100">
            {allColumns.map((col) => (
              <th
                key={col.key}
                className="px-1 py-1 text-center text-[10px] font-medium text-gray-600 border-b border-gray-200"
                style={{ width: col.width, minWidth: col.width }}
                title={col.label}
              >
                {col.abbr}
              </th>
            ))}
          </tr>
        </thead>

        {/* Data rows */}
        <tbody>
          {circuits.map((circuit, rowIdx) => (
            <tr
              key={circuit.circuit_ref}
              className={cn(
                'border-b border-gray-50 transition-colors',
                rowIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
              )}
            >
              {allColumns.map((col) => {
                const value = circuit[col.key] || '';
                const cellKey = `circuit.${circuit.circuit_ref}.${col.key}`;
                const isFlashing = flashingCells.has(cellKey);
                const isRef = col.key === 'circuit_ref';
                const isDesig = col.key === 'circuit_designation';

                return (
                  <td
                    key={col.key}
                    className={cn(
                      'px-1 py-0.5 text-[11px] font-mono transition-all duration-300',
                      isRef && 'font-bold text-gray-900 text-center',
                      isDesig && 'text-left text-gray-700 truncate max-w-[100px]',
                      !isRef && !isDesig && 'text-center',
                      !value && !isRef && 'text-gray-300',
                      isFlashing && 'bg-blue-100 text-blue-800 font-semibold'
                    )}
                    style={{ width: col.width, minWidth: col.width }}
                    title={value ? `${col.label}: ${value}` : col.label}
                  >
                    {value || (isRef ? '' : '—')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
