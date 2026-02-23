"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type CellContext,
  type RowData,
} from "@tanstack/react-table";
import type { Circuit } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TableMeta<TData extends RowData> {
    updateData: (rowIndex: number, columnId: string, value: string) => void;
    editingCell: { row: number; col: number } | null;
    setEditingCell: (cell: { row: number; col: number } | null) => void;
  }
}

const CIRCUIT_COLUMNS: { key: keyof Circuit; label: string; width: number; group: string }[] = [
  // Circuit Details
  { key: "circuit_ref", label: "Ref", width: 50, group: "Circuit Details" },
  { key: "circuit_designation", label: "Designation", width: 150, group: "Circuit Details" },
  { key: "wiring_type", label: "Wiring", width: 60, group: "Circuit Details" },
  { key: "ref_method", label: "Ref Method", width: 70, group: "Circuit Details" },
  { key: "number_of_points", label: "Points", width: 55, group: "Circuit Details" },
  { key: "live_csa_mm2", label: "Live mm\u00B2", width: 65, group: "Circuit Details" },
  { key: "cpc_csa_mm2", label: "CPC mm\u00B2", width: 65, group: "Circuit Details" },
  { key: "max_disconnect_time_s", label: "Max Disc", width: 65, group: "Circuit Details" },
  // OCPD
  { key: "ocpd_bs_en", label: "OCPD BS", width: 70, group: "OCPD" },
  { key: "ocpd_type", label: "Type", width: 55, group: "OCPD" },
  { key: "ocpd_rating_a", label: "Rating A", width: 65, group: "OCPD" },
  { key: "ocpd_breaking_capacity_ka", label: "Break kA", width: 65, group: "OCPD" },
  { key: "ocpd_max_zs_ohm", label: "Max Zs", width: 65, group: "OCPD" },
  // RCD
  { key: "rcd_bs_en", label: "RCD BS", width: 65, group: "RCD" },
  { key: "rcd_type", label: "RCD Type", width: 70, group: "RCD" },
  { key: "rcd_operating_current_ma", label: "RCD mA", width: 60, group: "RCD" },
  // Ring Final
  { key: "ring_r1_ohm", label: "r1", width: 50, group: "Ring Final" },
  { key: "ring_rn_ohm", label: "rn", width: 50, group: "Ring Final" },
  { key: "ring_r2_ohm", label: "r2", width: 50, group: "Ring Final" },
  // Continuity
  { key: "r1_r2_ohm", label: "R1+R2", width: 60, group: "Continuity" },
  { key: "r2_ohm", label: "R2", width: 50, group: "Continuity" },
  // Insulation Resistance
  { key: "ir_test_voltage_v", label: "IR V", width: 55, group: "IR" },
  { key: "ir_live_live_mohm", label: "IR L-L", width: 60, group: "IR" },
  { key: "ir_live_earth_mohm", label: "IR L-E", width: 60, group: "IR" },
  // Test Results
  { key: "polarity_confirmed", label: "Pol", width: 50, group: "Test Results" },
  { key: "measured_zs_ohm", label: "Zs", width: 55, group: "Test Results" },
  { key: "rcd_time_ms", label: "RCD ms", width: 60, group: "Test Results" },
  { key: "rcd_button_confirmed", label: "RCD Btn", width: 60, group: "Test Results" },
  { key: "afdd_button_confirmed", label: "AFDD", width: 55, group: "Test Results" },
];

// Sticky offsets for first two columns
const STICKY_COL_1_LEFT = 0;
const STICKY_COL_2_LEFT = CIRCUIT_COLUMNS[0].width;

interface CircuitTableProps {
  circuits: Circuit[];
  onChange: (circuits: Circuit[]) => void;
}

function EditableCell({ getValue, row, column, table }: CellContext<Circuit, unknown>) {
  const initialValue = (getValue() as string) || "";
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const colIndex = table.getAllColumns().findIndex((c) => c.id === column.id);
  const meta = table.options.meta!;
  const isEditing =
    meta.editingCell?.row === row.index && meta.editingCell?.col === colIndex;

  // Sync value if data changes externally
  useEffect(() => {
    setValue((getValue() as string) || "");
  }, [getValue]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commit = useCallback(() => {
    meta.setEditingCell(null);
    if (value !== initialValue) {
      meta.updateData(row.index, column.id, value);
    }
  }, [value, initialValue, meta, row.index, column.id]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const totalCols = table.getAllColumns().length;
      const totalRows = table.getRowModel().rows.length;

      if (e.key === "Tab") {
        e.preventDefault();
        commit();
        const nextCol = e.shiftKey ? colIndex - 1 : colIndex + 1;
        if (nextCol >= 0 && nextCol < totalCols) {
          meta.setEditingCell({ row: row.index, col: nextCol });
        } else if (!e.shiftKey && row.index + 1 < totalRows) {
          meta.setEditingCell({ row: row.index + 1, col: 0 });
        } else if (e.shiftKey && row.index > 0) {
          meta.setEditingCell({ row: row.index - 1, col: totalCols - 1 });
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit();
        if (row.index + 1 < totalRows) {
          meta.setEditingCell({ row: row.index + 1, col: colIndex });
        }
      } else if (e.key === "Escape") {
        setValue(initialValue);
        meta.setEditingCell(null);
      } else if (e.key === "ArrowDown" && !isEditing) {
        e.preventDefault();
        if (row.index + 1 < totalRows) {
          meta.setEditingCell({ row: row.index + 1, col: colIndex });
        }
      } else if (e.key === "ArrowUp" && !isEditing) {
        e.preventDefault();
        if (row.index > 0) {
          meta.setEditingCell({ row: row.index - 1, col: colIndex });
        }
      }
    },
    [commit, colIndex, row.index, table, meta, initialValue, isEditing],
  );

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className="h-8 text-sm p-1 rounded-none border-0 border-b-2 border-brand-blue focus-visible:ring-0 bg-blue-50"
      />
    );
  }

  return (
    <div
      onClick={() => meta.setEditingCell({ row: row.index, col: colIndex })}
      className="cursor-pointer min-h-[36px] flex items-center px-1.5 hover:bg-blue-50/50 text-sm"
    >
      {value || <span className="text-gray-300">-</span>}
    </div>
  );
}

export function CircuitTable({ circuits, onChange }: CircuitTableProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);

  // Track scroll position
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

    handleScroll();
    const resizeObserver = new ResizeObserver(handleScroll);
    resizeObserver.observe(container);
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
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
    [],
  );

  const updateData = useCallback(
    (rowIndex: number, columnId: string, value: string) => {
      const updated = circuits.map((row, index) =>
        index === rowIndex ? { ...row, [columnId]: value } : row,
      );
      onChange(updated);
    },
    [circuits, onChange],
  );

  const table = useReactTable({
    data: circuits,
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: { updateData, editingCell, setEditingCell },
  });

  // Build column group headers
  const groupHeaders = useMemo(() => {
    const groups: { name: string; span: number }[] = [];
    let lastGroup = "";
    for (const col of CIRCUIT_COLUMNS) {
      if (col.group !== lastGroup) {
        groups.push({ name: col.group, span: 1 });
        lastGroup = col.group;
      } else {
        groups[groups.length - 1].span++;
      }
    }
    return groups;
  }, []);

  if (circuits.length === 0) {
    return (
      <div className="border rounded-lg bg-white dark:bg-gray-900 dark:border-gray-700 p-8 text-center text-gray-500 dark:text-gray-400">
        No circuits yet. Click &quot;Add Circuit&quot; to get started.
      </div>
    );
  }

  return (
    <div className="border rounded-lg bg-white dark:bg-gray-900 dark:border-gray-700 relative">
      {/* Scroll progress bar */}
      <div className="h-1 bg-gray-200 rounded-t-lg overflow-hidden">
        <div
          className="h-full bg-brand-blue transition-all duration-150 ease-out"
          style={{ width: "20%", marginLeft: `${scrollProgress * 80}%` }}
        />
      </div>

      <div ref={scrollContainerRef} className="overflow-x-auto relative">
        {/* Right scroll shadow */}
        <div
          className={cn(
            "pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-200/80 to-transparent z-30 transition-opacity duration-200",
            canScrollRight ? "opacity-100" : "opacity-0",
          )}
        />

        <table className="w-full text-sm border-collapse">
          <thead>
            {/* Group header row */}
            <tr className="bg-gray-100 border-b">
              {groupHeaders.map((group, gIdx) => {
                const startIdx = CIRCUIT_COLUMNS.findIndex(
                  (_, i) =>
                    CIRCUIT_COLUMNS.slice(0, i + 1).filter((c) => c.group === group.name)
                      .length === 1 &&
                    CIRCUIT_COLUMNS[i].group === group.name,
                );
                const isFirstTwoSticky = startIdx < 2;
                return (
                  <th
                    key={`${group.name}-${gIdx}`}
                    colSpan={group.span}
                    className={cn(
                      "px-2 py-1 text-center text-xs font-medium text-gray-500 border-r last:border-r-0",
                      isFirstTwoSticky && "sticky left-0 z-20 bg-gray-100",
                    )}
                  >
                    {group.name}
                  </th>
                );
              })}
            </tr>
            {/* Column header row */}
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="bg-gray-50 border-b">
                {headerGroup.headers.map((header, idx) => (
                  <th
                    key={header.id}
                    className={cn(
                      "px-1.5 py-2 text-left font-medium text-gray-700 whitespace-nowrap border-r last:border-r-0",
                      idx < 2 && "sticky bg-gray-50 z-20",
                      idx === 1 && "border-r-2 border-gray-300",
                    )}
                    style={{
                      width: header.getSize(),
                      minWidth: header.getSize(),
                      left: idx === 0 ? STICKY_COL_1_LEFT : idx === 1 ? STICKY_COL_2_LEFT : undefined,
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
                  "border-b hover:bg-blue-50/30",
                  rowIdx % 2 === 0 ? "bg-white" : "bg-gray-50/30",
                )}
              >
                {row.getVisibleCells().map((cell, idx) => (
                  <td
                    key={cell.id}
                    className={cn(
                      "px-0 py-0 border-r last:border-r-0",
                      idx < 2 && "sticky z-10",
                      idx === 0 && "font-medium",
                      idx === 1 && "border-r-2 border-gray-300",
                      idx < 2 && (rowIdx % 2 === 0 ? "bg-white" : "bg-gray-50/30"),
                    )}
                    style={{
                      width: cell.column.getSize(),
                      minWidth: cell.column.getSize(),
                      left: idx === 0 ? STICKY_COL_1_LEFT : idx === 1 ? STICKY_COL_2_LEFT : undefined,
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
