'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowUpDown, MoreHorizontal, Copy, Trash2, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Job } from '@/lib/types';
import { api } from '@/lib/api-client';
import { getUser } from '@/lib/auth';

interface JobTableProps {
  jobs: Job[];
  onRefresh: () => void;
  onJobDeleted: (jobId: string) => void;
}

export function JobTable({ jobs, onRefresh, onJobDeleted }: JobTableProps) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (job: Job) => {
    const user = getUser();
    if (!user) return;
    if (!confirm(`Delete "${job.address || job.id}"? This cannot be undone.`)) return;

    setDeletingId(job.id);
    try {
      await api.deleteJob(user.id, job.id);
      toast.success('Job deleted');
      onJobDeleted(job.id);
    } catch {
      toast.error('Failed to delete job');
    } finally {
      setDeletingId(null);
    }
  };

  const handleClone = async (job: Job) => {
    const user = getUser();
    if (!user) return;

    try {
      const result = await api.cloneJob(user.id, job.id, `${job.address} (copy)`, false);
      toast.success('Job cloned');
      router.push(`/job/${result.jobId}`);
    } catch {
      toast.error('Failed to clone job');
    }
  };

  const columns = useMemo<ColumnDef<Job>[]>(
    () => [
      {
        accessorKey: 'address',
        header: ({ column }) => (
          <button
            className="flex items-center gap-1 hover:text-white"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Address
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
        ),
        cell: ({ row }) => (
          <span className="font-medium text-white">{row.getValue('address') || 'Untitled'}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <button
            className="flex items-center gap-1 hover:text-white"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Status
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
        ),
        cell: ({ row }) => {
          const status = row.getValue('status') as string;
          const colors: Record<string, string> = {
            done: 'bg-green-500/15 text-green-400 border border-green-500/20',
            processing: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
            pending: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/20',
            failed: 'bg-red-500/15 text-red-400 border border-red-500/20',
          };
          return (
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || 'bg-white/5 text-gray-400 border border-white/10'}`}
            >
              {status === 'processing' && <RefreshCw className="h-3 w-3 animate-spin" />}
              {status}
            </span>
          );
        },
      },
      {
        accessorKey: 'certificate_type',
        header: 'Type',
        cell: ({ row }) => {
          const type = (row.getValue('certificate_type') as string) || 'EICR';
          return (
            <span
              className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${
                type === 'EIC'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                  : 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
              }`}
            >
              {type}
            </span>
          );
        },
      },
      {
        accessorKey: 'created_at',
        header: ({ column }) => (
          <button
            className="flex items-center gap-1 hover:text-white"
            onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          >
            Created
            <ArrowUpDown className="h-3.5 w-3.5" />
          </button>
        ),
        cell: ({ row }) => {
          const date = new Date(row.getValue('created_at') as string);
          return (
            <span className="text-gray-400">
              {date.toLocaleDateString()}{' '}
              {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          );
        },
      },
      {
        id: 'actions',
        cell: ({ row }) => {
          const job = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-gray-400 hover:text-white"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-[#1e293b] border-white/10">
                <DropdownMenuItem
                  className="text-gray-300 hover:text-white focus:text-white focus:bg-white/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClone(job);
                  }}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Clone
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-white/10" />
                <DropdownMenuItem
                  className="text-red-400 focus:text-red-400 focus:bg-red-500/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(job);
                  }}
                  disabled={deletingId === job.id}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [deletingId]
  );

  const table = useReactTable({
    data: jobs,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
        <Input
          placeholder="Search jobs..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-gray-500"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-white/8 bg-[#1e293b] overflow-hidden">
        <table className="w-full">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-white/8 bg-white/[0.03]">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-4 py-3 text-left text-sm font-medium text-gray-400"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-gray-500">
                  No jobs found.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                  onClick={() => router.push(`/job/${row.original.id}`)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 text-sm">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="text-sm text-gray-500">
        {table.getFilteredRowModel().rows.length} job
        {table.getFilteredRowModel().rows.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
