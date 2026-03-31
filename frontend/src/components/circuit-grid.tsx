'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  ColumnDef,
  CellContext,
  RowData,
} from '@tanstack/react-table';
import { Circuit } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    updateData: (rowIndex: number, columnId: string, value: string) => void;
  }
}

const CIRCUIT_COLUMNS: { key: keyof Circuit; label: string; width: number }[] = [
  // Circuit Details (columns 1-8)
  { key: 'circuit_ref', label: 'Ref', width: 50 },
  { key: 'circuit_designation', label: 'Designation', width: 140 },
  { key: 'wiring_type', label: 'Wiring', width: 60 },
  { key: 'ref_method', label: 'Ref Method', width: 70 },
  { key: 'number_of_points', label: 'Points', width: 55 },
  { key: 'live_csa_mm2', label: 'Live mm2', width: 65 },
  { key: 'cpc_csa_mm2', label: 'CPC mm2', width: 65 },
  { key: 'max_disconnect_time_s', label: 'Max Disc', width: 65 },
  // OCPD (columns 9-13)
  { key: 'ocpd_bs_en', label: 'OCPD BS', width: 70 },
  { key: 'ocpd_type', label: 'Type', width: 55 },
  { key: 'ocpd_rating_a', label: 'Rating A', width: 65 },
  { key: 'ocpd_breaking_capacity_ka', label: 'Break kA', width: 65 },
  { key: 'ocpd_max_zs_ohm', label: 'Max Zs', width: 65 },
  // RCD (columns 14-16)
  { key: 'rcd_bs_en', label: 'RCD BS', width: 65 },
  { key: 'rcd_type', label: 'RCD Type', width: 70 },
  { key: 'rcd_operating_current_ma', label: 'RCD mA', width: 60 },
  // Ring Final (columns 17-19)
  { key: 'ring_r1_ohm', label: 'r1', width: 50 },
  { key: 'ring_rn_ohm', label: 'rn', width: 50 },
  { key: 'ring_r2_ohm', label: 'r2', width: 50 },
  // Continuity (columns 20-21)
  { key: 'r1_r2_ohm', label: 'R1+R2', width: 60 },
  { key: 'r2_ohm', label: 'R2', width: 50 },
  // Insulation Resistance (columns 22-24)
  { key: 'ir_test_voltage_v', label: 'IR Test V', width: 65 },
  { key: 'ir_live_live_mohm', label: 'IR L-L', width: 60 },
  { key: 'ir_live_earth_mohm', label: 'IR L-E', width: 60 },
  // Test Results (columns 25-29)
  { key: 'polarity_confirmed', label: 'Polarity', width: 60 },
  { key: 'measured_zs_ohm', label: 'Zs', width: 55 },
  { key: 'rcd_time_ms', label: 'RCD ms', width: 60 },
  { key: 'rcd_button_confirmed', label: 'RCD Btn', width: 60 },
  { key: 'afdd_button_confirmed', label: 'AFDD Btn', width: 65 },
];

// Calculate sticky column offsets
const STICKY_COL_1_LEFT = 0;
const STICKY_COL_2_LEFT = CIRCUIT_COLUMNS[0].width; // 50px

interface CircuitGridProps {
  circuits: Circuit[];
  onChange: (circuits: Circuit[]) => void;
}

function EditableCell({ getValue, row, column, table }: CellContext<Circuit, unknown>) {
  const initialValue = getValue() as string;
  const [value, setValue] = useState(initialValue);
  const [isEditing, setIsEditing] = useState(false);

  const onBlur = () => {
    setIsEditing(false);
    if (value !== initialValue) {
      table.options.meta?.updateData(row.index, column.id, value);
    }
  };

  if (isEditing) {
    return (
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onBlur();
          if (e.key === 'Escape') {
            setValue(initialValue);
            setIsEditing(false);
          }
        }}
        className="h-10 text-sm p-1"
        autoFocus
      />
    );
  }

  return (
    <div
      onClick={() => setIsEditing(true)}
      className="cursor-pointer min-h-[44px] flex items-center px-1 hover:bg-slate-100 rounded"
    >
      {value || <span className="text-slate-300">-</span>}
    </div>
  );
}

export function CircuitGrid({ circuits, onChange }: CircuitGridProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Track scroll position for indicator and shadow
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollLeft, scrollWidth, clientWidth } = container;
      const maxScroll = scrollWidth - clientWidth;

      if (maxScroll > 0) {
        setScrollProgress(scrollLeft / maxScroll);
        setCanScrollRight(scrollLeft < maxScroll - 1);
      } else {
        setScrollProgress(0);
        setCanScrollRight(false);
      }
    };

    // Initial check
    handleScroll();

    // Check on resize
    const resizeObserver = new ResizeObserver(handleScroll);
    resizeObserver.observe(container);

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
  }, [circuits]);

  const columns = useMemo<ColumnDef<Circuit>[]>(
    () =>
      CIRCUIT_COLUMNS.map((col) => ({
        accessorKey: col.key,
        header: col.label,
        size: col.width,
        cell: EditableCell,
      })),
    []
  );

  const updateData = useCallback(
    (rowIndex: number, columnId: string, value: string) => {
      const updated = circuits.map((row, index) =>
        index === rowIndex ? { ...row, [columnId]: value } : row
      );
      onChange(updated);
    },
    [circuits, onChange]
  );

  const table = useReactTable({
    data: circuits,
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: { updateData },
  });

  return (
    <div className="border rounded-lg bg-white relative">
      {/* Scroll indicator bar */}
      <div className="h-1 bg-slate-200 rounded-t-lg overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all duration-150 ease-out"
          style={{
            width: '20%',
            marginLeft: `${scrollProgress * 80}%`,
          }}
        />
      </div>

      {/* Table container with scroll shadow */}
      <div ref={scrollContainerRef} className="overflow-x-auto relative">
        {/* Right scroll shadow overlay */}
        <div
          className={cn(
            'pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-slate-200/80 to-transparent z-30 transition-opacity duration-200',
            canScrollRight ? 'opacity-100' : 'opacity-0'
          )}
        />

        <table className="w-full text-sm">
          <thead className="bg-slate-100 sticky top-0 z-10">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header, idx) => (
                  <th
                    key={header.id}
                    className={cn(
                      'px-2 py-3 text-left font-medium text-slate-700 border-b whitespace-nowrap',
                      idx < 2 && 'sticky bg-slate-100 z-20',
                      idx === 1 && 'border-r border-slate-300'
                    )}
                    style={{
                      width: header.getSize(),
                      minWidth: header.getSize(),
                      left:
                        idx === 0 ? STICKY_COL_1_LEFT : idx === 1 ? STICKY_COL_2_LEFT : undefined,
                    }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, rowIdx) => (
              <tr
                key={row.id}
                className={cn(
                  'border-b hover:bg-slate-50',
                  rowIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'
                )}
              >
                {row.getVisibleCells().map((cell, idx) => (
                  <td
                    key={cell.id}
                    className={cn(
                      'px-1 py-1 border-r last:border-r-0',
                      idx < 2 && 'sticky z-10',
                      idx === 0 && 'font-medium bg-white',
                      idx === 1 && 'bg-white border-r border-slate-300',
                      rowIdx % 2 !== 0 && idx < 2 && 'bg-slate-50/50'
                    )}
                    style={{
                      width: cell.column.getSize(),
                      minWidth: cell.column.getSize(),
                      left:
                        idx === 0 ? STICKY_COL_1_LEFT : idx === 1 ? STICKY_COL_2_LEFT : undefined,
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
