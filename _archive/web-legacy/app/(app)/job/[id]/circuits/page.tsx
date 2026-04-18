'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useJobContext } from '../layout';
import { CircuitTable } from '@/components/circuits/circuit-table';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Plus, Trash2, Wand2, Loader2, Camera, Calculator, ArrowDownUp } from 'lucide-react';
import type { Circuit, Board, JobDetail, UserDefaults } from '@/lib/types';
import { api } from '@/lib/api-client';
import { applyDefaultsToCircuit, applyDefaultsToCircuits } from '@/lib/apply-defaults';
import { sortCircuitsByRef } from '@/lib/sort-circuits';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

function ensureBoards(job: JobDetail): Board[] {
  if (job.boards && job.boards.length > 0) {
    return job.boards;
  }
  return [
    {
      id: 'board_1',
      designation: 'Main Board',
      location: job.board_info?.location || '',
      board_info: { ...job.board_info },
      circuits: job.circuits || [],
    },
  ];
}

export default function CircuitsPage() {
  const { job, updateJob, user } = useJobContext();
  const [applying, setApplying] = useState(false);
  const [activeBoardIndex, setActiveBoardIndex] = useState(0);

  const boards = ensureBoards(job);
  const hasMultipleBoards = boards.length > 1;
  const activeBoard = boards[activeBoardIndex] || boards[0];
  const activeCircuits = activeBoard.circuits ?? [];

  const updateBoardCircuits = useCallback(
    (circuits: Circuit[]) => {
      if (hasMultipleBoards) {
        const validIndex = Math.min(activeBoardIndex, boards.length - 1);
        const newBoards = boards.map((b, i) => (i === validIndex ? { ...b, circuits } : b));
        const allCircuits = newBoards.flatMap((b) => b.circuits);
        updateJob({ boards: newBoards, circuits: allCircuits });
      } else {
        const newBoards = [{ ...boards[0], circuits }];
        updateJob({ boards: newBoards, circuits });
      }
    },
    [boards, activeBoardIndex, hasMultipleBoards, updateJob]
  );

  // Pre-load user defaults so they can be applied to new circuits instantly
  const defaultsRef = useRef<UserDefaults>({});
  useEffect(() => {
    if (!user) return;
    api
      .getUserDefaults(user.id)
      .then((d) => {
        defaultsRef.current = d;
      })
      .catch(() => {
        /* non-critical */
      });
  }, [user]);

  const addCircuit = () => {
    const nextRef = (activeCircuits.length + 1).toString();
    // Start with minimal scaffold, then apply user defaults (only-fill-empty)
    const scaffold: Circuit = {
      circuit_ref: nextRef,
      circuit_designation: '',
    };
    const newCircuit = applyDefaultsToCircuit(scaffold, defaultsRef.current);
    updateBoardCircuits(sortCircuitsByRef([...activeCircuits, newCircuit]));
  };

  const deleteLastCircuit = () => {
    if (activeCircuits.length === 0) return;
    updateBoardCircuits(activeCircuits.slice(0, -1));
  };

  const applyDefaults = async () => {
    if (!user) {
      toast.error('Not logged in');
      return;
    }
    if (activeCircuits.length === 0) {
      toast.info('No circuits to apply defaults to');
      return;
    }

    setApplying(true);
    try {
      const defaults = await api.getUserDefaults(user.id);
      defaultsRef.current = defaults; // refresh cache
      if (Object.keys(defaults).length === 0) {
        toast.info('No defaults configured. Go to Defaults to set up defaults.');
        return;
      }

      const updatedCircuits = applyDefaultsToCircuits(activeCircuits, defaults);
      updateBoardCircuits(updatedCircuits);
      toast.success('Defaults applied to empty fields');
    } catch (error) {
      console.error('Failed to apply defaults:', error);
      toast.error('Failed to load defaults');
    } finally {
      setApplying(false);
    }
  };

  // iOS-parity: Reverse circuit order
  const reverseCircuits = () => {
    if (activeCircuits.length < 2) return;
    updateBoardCircuits([...activeCircuits].reverse());
    toast.success('Circuit order reversed');
  };

  // iOS-parity: Calculate Zs = Ze + R1+R2 for all circuits
  const calculateZs = () => {
    const ze = parseFloat(
      job.board_info?.ze || job.supply_characteristics?.earth_loop_impedance_ze || ''
    );
    if (isNaN(ze)) {
      toast.error('Ze not set — fill in Supply or Board first');
      return;
    }
    let updated = 0;
    const newCircuits = activeCircuits.map((c) => {
      const r1r2 = parseFloat(c.r1_r2_ohm || '');
      if (isNaN(r1r2)) return c;
      const zs = (ze + r1r2).toFixed(2);
      updated++;
      return { ...c, measured_zs_ohm: zs };
    });
    updateBoardCircuits(newCircuits);
    toast.success(`Calculated Zs for ${updated} circuit${updated !== 1 ? 's' : ''}`);
  };

  // iOS-parity: Calculate R1+R2 = Zs - Ze for all circuits
  const calculateR1R2 = () => {
    const ze = parseFloat(
      job.board_info?.ze || job.supply_characteristics?.earth_loop_impedance_ze || ''
    );
    if (isNaN(ze)) {
      toast.error('Ze not set — fill in Supply or Board first');
      return;
    }
    let updated = 0;
    const newCircuits = activeCircuits.map((c) => {
      const zs = parseFloat(c.measured_zs_ohm || '');
      if (isNaN(zs)) return c;
      const r1r2 = Math.max(0, zs - ze).toFixed(2);
      updated++;
      return { ...c, r1_r2_ohm: r1r2 };
    });
    updateBoardCircuits(newCircuits);
    toast.success(`Calculated R1+R2 for ${updated} circuit${updated !== 1 ? 's' : ''}`);
  };

  const [showCalcMenu, setShowCalcMenu] = useState(false);

  return (
    <div className="p-6 space-y-4">
      {/* Board selector for multi-board jobs */}
      {hasMultipleBoards && (
        <div className="flex overflow-x-auto border border-white/[0.08] rounded-lg bg-card">
          {boards.map((b, index) => (
            <button
              key={b.id}
              onClick={() => setActiveBoardIndex(index)}
              className={cn(
                'shrink-0 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                index === activeBoardIndex
                  ? 'border-brand-blue text-brand-blue bg-brand-blue/10'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-white/[0.04]'
              )}
            >
              {b.designation} ({b.circuits?.length ?? 0})
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">
          {hasMultipleBoards
            ? `${activeBoard.designation} - Circuit Schedule (${activeCircuits.length} circuits)`
            : `Circuit Schedule (${activeCircuits.length} circuits)`}
        </h2>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/job/${job.id}/board`}>
              <Camera className="h-4 w-4 mr-1" />
              CCU Photo
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={applyDefaults} disabled={applying}>
            {applying ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4 mr-1" />
            )}
            Apply Defaults
          </Button>
          {/* iOS-parity: Calculate menu */}
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCalcMenu(!showCalcMenu)}
              disabled={activeCircuits.length === 0}
            >
              <Calculator className="h-4 w-4 mr-1" />
              Calculate
            </Button>
            {showCalcMenu && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-card border border-white/10 rounded-md shadow-lg py-1 min-w-[200px]">
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 transition-colors"
                  onClick={() => {
                    calculateZs();
                    setShowCalcMenu(false);
                  }}
                >
                  Calculate Zs (Ze + R1+R2)
                </button>
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 transition-colors"
                  onClick={() => {
                    calculateR1R2();
                    setShowCalcMenu(false);
                  }}
                >
                  Calculate R1+R2 (Zs − Ze)
                </button>
              </div>
            )}
          </div>
          {/* iOS-parity: Reverse circuits */}
          <Button
            variant="outline"
            size="sm"
            onClick={reverseCircuits}
            disabled={activeCircuits.length < 2}
          >
            <ArrowDownUp className="h-4 w-4 mr-1" />
            Reverse
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={deleteLastCircuit}
            disabled={activeCircuits.length === 0}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Delete Last
          </Button>
          <Button size="sm" onClick={addCircuit}>
            <Plus className="h-4 w-4 mr-1" />
            Add Circuit
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Click any cell to edit. Use Tab to move between cells, Enter to move down.
        {hasMultipleBoards && ' Use the board tabs above to switch between boards.'}
      </p>

      <CircuitTable circuits={activeCircuits} onChange={updateBoardCircuits} />
    </div>
  );
}
