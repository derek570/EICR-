'use client';

import { useState, useCallback } from 'react';
import { useJob } from '../layout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, Camera } from 'lucide-react';
import { BoardInfo, Board, Circuit } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CCUUpload } from '@/components/recording/ccu-upload';

function createEmptyBoard(index: number): Board {
  return {
    id: `board_${index}`,
    designation: index === 1 ? 'Main Board' : `Sub-Board ${index - 1}`,
    location: '',
    board_info: {
      name: index === 1 ? 'DB-1' : `DB-${index}`,
      location: '',
      manufacturer: '',
      phases: '1',
      earthing_arrangement: '',
      ze: '',
      zs_at_db: '',
      ipf_at_db: '',
    },
    circuits: [],
  };
}

function ensureBoards(job: {
  board_info: BoardInfo;
  boards?: Board[];
  circuits: import('@/lib/api').Circuit[];
}): Board[] {
  if (job.boards && job.boards.length > 0) {
    return job.boards;
  }
  // Backward compat: wrap single board_info + circuits into boards[0]
  return [
    {
      id: 'board_1',
      designation: 'Main Board',
      location: job.board_info.location || '',
      board_info: { ...job.board_info },
      circuits: job.circuits || [],
    },
  ];
}

export default function BoardPage() {
  const { job, updateJob } = useJob();
  const [activeBoardIndex, setActiveBoardIndex] = useState(0);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [showCCUUpload, setShowCCUUpload] = useState(false);

  const handleCCUAnalysis = useCallback(
    (analysis: Record<string, unknown>) => {
      // Apply CCU analysis results to the job
      const updates: Partial<typeof job> = {};

      // Apply circuits if present
      if (Array.isArray(analysis.circuits) && analysis.circuits.length > 0) {
        updates.circuits = analysis.circuits as Circuit[];
      }

      // Apply board info if present
      if (analysis.board_info && typeof analysis.board_info === 'object') {
        updates.board_info = { ...job.board_info, ...(analysis.board_info as BoardInfo) };
      }

      // Apply supply characteristics if present
      if (analysis.supply_characteristics && typeof analysis.supply_characteristics === 'object') {
        updates.supply_characteristics = {
          ...(job.supply_characteristics ?? {
            earthing_arrangement: '',
            live_conductors: '',
            number_of_supplies: '',
            nominal_voltage_u: '',
            nominal_voltage_uo: '',
            nominal_frequency: '',
          }),
          ...(analysis.supply_characteristics as Record<string, string>),
        };
      }

      updateJob(updates);
    },
    [job, updateJob]
  );

  const boards = ensureBoards(job);
  const activeBoard = boards[activeBoardIndex] || boards[0];

  const updateBoards = useCallback(
    (newBoards: Board[]) => {
      // Always keep flat board_info and circuits in sync for backward compat
      const primary = newBoards[0];
      const updates: Partial<typeof job> = { boards: newBoards };
      if (primary) {
        updates.board_info = primary.board_info;
        if (newBoards.length === 1) {
          updates.circuits = primary.circuits;
        }
      }
      updateJob(updates);
    },
    [updateJob]
  );

  const updateBoardField = (field: keyof BoardInfo, value: string) => {
    const newBoards = boards.map((b, i) =>
      i === activeBoardIndex ? { ...b, board_info: { ...b.board_info, [field]: value } } : b
    );
    updateBoards(newBoards);
  };

  const updateBoardMeta = (field: 'designation' | 'location', value: string) => {
    const newBoards = boards.map((b, i) => {
      if (i !== activeBoardIndex) return b;
      if (field === 'location') {
        // Keep board_info.location in sync
        return { ...b, [field]: value, board_info: { ...b.board_info, location: value } };
      }
      return { ...b, [field]: value };
    });
    updateBoards(newBoards);
  };

  const addBoard = () => {
    const nextIndex = boards.length + 1;
    const newBoard = createEmptyBoard(nextIndex);
    const newBoards = [...boards, newBoard];
    updateBoards(newBoards);
    setActiveBoardIndex(newBoards.length - 1);
  };

  const removeBoard = () => {
    if (boards.length <= 1) return;
    const newBoards = boards.filter((_, i) => i !== activeBoardIndex);
    // Re-index board IDs
    const reindexed = newBoards.map((b, i) => ({
      ...b,
      id: `board_${i + 1}`,
    }));
    updateBoards(reindexed);
    setActiveBoardIndex(Math.max(0, activeBoardIndex - 1));
    setShowRemoveConfirm(false);
  };

  const board = activeBoard.board_info;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Board Information</h2>
        <div className="flex gap-2">
          {boards.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRemoveConfirm(true)}
              className="text-red-600 hover:text-red-700"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Remove Board
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={addBoard}>
            <Plus className="h-4 w-4 mr-1" />
            Add Board
          </Button>
        </div>
      </div>

      {/* Remove confirmation */}
      {showRemoveConfirm && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="py-3 flex items-center justify-between">
            <p className="text-sm text-red-800">
              Remove &quot;{activeBoard.designation}&quot; and all its circuits? This cannot be
              undone.
            </p>
            <div className="flex gap-2 ml-4">
              <Button size="sm" variant="outline" onClick={() => setShowRemoveConfirm(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={removeBoard}>
                Remove
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Board selector tabs */}
      {boards.length > 1 && (
        <div className="flex overflow-x-auto border rounded-lg bg-card">
          {boards.map((b, index) => (
            <button
              key={b.id}
              onClick={() => {
                setActiveBoardIndex(index);
                setShowRemoveConfirm(false);
              }}
              className={cn(
                'shrink-0 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
                index === activeBoardIndex
                  ? 'border-primary text-primary bg-blue-50'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              {b.designation}
            </button>
          ))}
        </div>
      )}

      {/* Board designation and location */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Board Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="designation">Designation</Label>
              <Input
                id="designation"
                value={activeBoard.designation}
                onChange={(e) => updateBoardMeta('designation', e.target.value)}
                placeholder="e.g., Main Board, Sub-Board 1"
              />
            </div>
            <div>
              <Label htmlFor="board-location">Location</Label>
              <Input
                id="board-location"
                value={activeBoard.location}
                onChange={(e) => updateBoardMeta('location', e.target.value)}
                placeholder="e.g., Under stairs, Garage"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Board info form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="name">Board Name</Label>
              <Input
                id="name"
                value={board.name || ''}
                onChange={(e) => updateBoardField('name', e.target.value)}
                placeholder="e.g., Main CU, DB-1"
              />
            </div>
            <div>
              <Label htmlFor="manufacturer">Manufacturer</Label>
              <Input
                id="manufacturer"
                value={board.manufacturer || ''}
                onChange={(e) => updateBoardField('manufacturer', e.target.value)}
                placeholder="e.g., Hager, MK, Wylex"
              />
            </div>
            <div>
              <Label htmlFor="phases">Phases</Label>
              <select
                id="phases"
                value={board.phases || '1'}
                onChange={(e) => updateBoardField('phases', e.target.value)}
                className="w-full h-10 rounded-md border border-input px-3"
              >
                <option value="1">Single Phase</option>
                <option value="3">Three Phase</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Earthing &amp; Supply</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="earthing">Earthing Arrangement</Label>
              <select
                id="earthing"
                value={board.earthing_arrangement || ''}
                onChange={(e) => updateBoardField('earthing_arrangement', e.target.value)}
                className="w-full h-10 rounded-md border border-input px-3"
              >
                <option value="">Select...</option>
                <option value="TN-C-S">TN-C-S (PME)</option>
                <option value="TN-S">TN-S</option>
                <option value="TT">TT</option>
              </select>
            </div>
            <div>
              <Label htmlFor="ze">Ze (ohm)</Label>
              <Input
                id="ze"
                value={board.ze || ''}
                onChange={(e) => updateBoardField('ze', e.target.value)}
                placeholder="e.g., 0.35"
              />
            </div>
            <div>
              <Label htmlFor="zs">Zs at DB (ohm)</Label>
              <Input
                id="zs"
                value={board.zs_at_db || ''}
                onChange={(e) => updateBoardField('zs_at_db', e.target.value)}
                placeholder="e.g., 0.45"
              />
            </div>
            <div>
              <Label htmlFor="ipf">Ipf at DB (kA)</Label>
              <Input
                id="ipf"
                value={board.ipf_at_db || ''}
                onChange={(e) => updateBoardField('ipf_at_db', e.target.value)}
                placeholder="e.g., 2.5"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {boards.length > 1 && (
        <p className="text-sm text-muted-foreground">
          This job has {boards.length} distribution boards. Use the tabs above to switch between
          them. Each board has its own circuits on the Circuits tab.
        </p>
      )}

      {/* CCU Photo Analysis */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Consumer Unit Photo Analysis</CardTitle>
            <Button variant="outline" size="sm" onClick={() => setShowCCUUpload(!showCCUUpload)}>
              <Camera className="h-4 w-4 mr-1" />
              {showCCUUpload ? 'Hide' : 'Analyse Photo'}
            </Button>
          </div>
        </CardHeader>
        {showCCUUpload && (
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Upload a photo of the consumer unit label to automatically extract circuit data, board
              info, and supply details.
            </p>
            <CCUUpload onAnalysisComplete={handleCCUAnalysis} />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
