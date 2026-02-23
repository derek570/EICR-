"use client";

import { useState, useCallback } from "react";
import { useJobContext } from "../layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import type { BoardInfo, Board, Circuit, SupplyCharacteristics, JobDetail, CCUAnalysisResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EARTHING_ARRANGEMENTS } from "@/lib/constants";
import { CCUUpload } from "@/components/ccu/ccu-upload";
import { CCUResults } from "@/components/ccu/ccu-results";
import { toast } from "sonner";

function createEmptyBoard(index: number): Board {
  return {
    id: `board_${index}`,
    designation: index === 1 ? "Main Board" : `Sub-Board ${index - 1}`,
    location: "",
    board_info: {
      name: index === 1 ? "DB-1" : `DB-${index}`,
      location: "",
      manufacturer: "",
      phases: "1",
      earthing_arrangement: "",
      ze: "",
      zs_at_db: "",
      ipf_at_db: "",
    },
    circuits: [],
  };
}

function ensureBoards(job: JobDetail): Board[] {
  if (job.boards && job.boards.length > 0) {
    return job.boards;
  }
  // Backward compat: wrap single board_info + circuits into boards[0]
  return [
    {
      id: "board_1",
      designation: "Main Board",
      location: job.board_info?.location || "",
      board_info: { ...job.board_info },
      circuits: job.circuits || [],
    },
  ];
}

export default function BoardPage() {
  const { job, updateJob } = useJobContext();
  const [activeBoardIndex, setActiveBoardIndex] = useState(0);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [ccuResult, setCcuResult] = useState<CCUAnalysisResult | null>(null);

  const boards = ensureBoards(job);
  const activeBoard = boards[activeBoardIndex] || boards[0];

  const updateBoards = useCallback(
    (newBoards: Board[]) => {
      // Always keep flat board_info and circuits in sync for backward compat
      const primary = newBoards[0];
      const updates: Partial<JobDetail> = { boards: newBoards };
      if (primary) {
        updates.board_info = primary.board_info;
        if (newBoards.length === 1) {
          updates.circuits = primary.circuits;
        }
      }
      updateJob(updates);
    },
    [updateJob],
  );

  const updateBoardField = (field: keyof BoardInfo, value: string) => {
    const newBoards = boards.map((b, i) =>
      i === activeBoardIndex
        ? { ...b, board_info: { ...b.board_info, [field]: value } }
        : b,
    );
    updateBoards(newBoards);
  };

  const updateBoardMeta = (field: "designation" | "location", value: string) => {
    const newBoards = boards.map((b, i) => {
      if (i !== activeBoardIndex) return b;
      if (field === "location") {
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
    const reindexed = newBoards.map((b, i) => ({
      ...b,
      id: `board_${i + 1}`,
    }));
    updateBoards(reindexed);
    setActiveBoardIndex(Math.max(0, activeBoardIndex - 1));
    setShowRemoveConfirm(false);
  };

  const applyCcuResults = useCallback(
    (data: {
      circuits: Circuit[];
      boardInfo: Partial<BoardInfo>;
      supply: Partial<SupplyCharacteristics>;
    }) => {
      const newBoards = boards.map((b, i) => {
        if (i !== activeBoardIndex) return b;
        // Merge board info (only set empty fields)
        const mergedBoardInfo = { ...b.board_info };
        for (const [key, value] of Object.entries(data.boardInfo)) {
          if (value && !mergedBoardInfo[key as keyof BoardInfo]) {
            (mergedBoardInfo as Record<string, string>)[key] = value as string;
          }
        }
        return {
          ...b,
          board_info: mergedBoardInfo,
          circuits: data.circuits,
        };
      });

      // Merge supply characteristics (only set empty fields)
      const existingSupply = job.supply_characteristics || {} as SupplyCharacteristics;
      const mergedSupply = { ...existingSupply };
      for (const [key, value] of Object.entries(data.supply)) {
        if (value && !mergedSupply[key as keyof SupplyCharacteristics]) {
          (mergedSupply as Record<string, unknown>)[key] = value;
        }
      }

      const primary = newBoards[0];
      const updates: Partial<JobDetail> = {
        boards: newBoards,
        supply_characteristics: mergedSupply as SupplyCharacteristics,
      };
      if (primary) {
        updates.board_info = primary.board_info;
        updates.circuits = primary.circuits;
      }

      updateJob(updates);
      setCcuResult(null);
      toast.success(
        `Applied ${data.circuits.length} circuits and board/supply data`,
      );
    },
    [boards, activeBoardIndex, job.supply_characteristics, updateJob],
  );

  const board = activeBoard.board_info;

  return (
    <div className="p-6 space-y-6 max-w-4xl">
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

      {/* CCU Photo Analysis */}
      {ccuResult ? (
        <CCUResults
          result={ccuResult}
          onApply={applyCcuResults}
          onDismiss={() => setCcuResult(null)}
        />
      ) : (
        <CCUUpload onAnalysisComplete={setCcuResult} />
      )}

      {/* Remove confirmation */}
      {showRemoveConfirm && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="py-3 flex items-center justify-between">
            <p className="text-sm text-red-800">
              Remove &quot;{activeBoard.designation}&quot; and all its circuits? This cannot be undone.
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
        <div className="flex overflow-x-auto border rounded-lg bg-white">
          {boards.map((b, index) => (
            <button
              key={b.id}
              onClick={() => {
                setActiveBoardIndex(index);
                setShowRemoveConfirm(false);
              }}
              className={cn(
                "shrink-0 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                index === activeBoardIndex
                  ? "border-brand-blue text-brand-blue bg-blue-50"
                  : "border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50",
              )}
            >
              {b.designation}
            </button>
          ))}
        </div>
      )}

      {/* Board Identity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Board Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="designation">Designation</Label>
              <Input
                id="designation"
                value={activeBoard.designation}
                onChange={(e) => updateBoardMeta("designation", e.target.value)}
                placeholder="e.g., Main Board, Sub-Board 1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="board-location">Location</Label>
              <Input
                id="board-location"
                value={activeBoard.location}
                onChange={(e) => updateBoardMeta("location", e.target.value)}
                placeholder="e.g., Under stairs, Garage"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* General */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Board Name</Label>
              <Input
                id="name"
                value={board.name || ""}
                onChange={(e) => updateBoardField("name", e.target.value)}
                placeholder="e.g., Main CU, DB-1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manufacturer">Manufacturer</Label>
              <Input
                id="manufacturer"
                value={board.manufacturer || ""}
                onChange={(e) => updateBoardField("manufacturer", e.target.value)}
                placeholder="e.g., Hager, MK, Wylex"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phases">Phases</Label>
              <select
                id="phases"
                value={board.phases || "1"}
                onChange={(e) => updateBoardField("phases", e.target.value)}
                className="w-full h-10 rounded-md border border-gray-300 px-3 bg-white text-sm"
              >
                <option value="1">Single Phase</option>
                <option value="3">Three Phase</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Earthing & Supply */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Earthing &amp; Supply</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="earthing">Earthing Arrangement</Label>
              <select
                id="earthing"
                value={board.earthing_arrangement || ""}
                onChange={(e) => updateBoardField("earthing_arrangement", e.target.value)}
                className="w-full h-10 rounded-md border border-gray-300 px-3 bg-white text-sm"
              >
                <option value="">Select...</option>
                {EARTHING_ARRANGEMENTS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ze">Ze (ohm)</Label>
              <Input
                id="ze"
                value={board.ze || ""}
                onChange={(e) => updateBoardField("ze", e.target.value)}
                placeholder="e.g., 0.35"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="zs">Zs at DB (ohm)</Label>
              <Input
                id="zs"
                value={board.zs_at_db || ""}
                onChange={(e) => updateBoardField("zs_at_db", e.target.value)}
                placeholder="e.g., 0.45"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ipf">Ipf at DB (kA)</Label>
              <Input
                id="ipf"
                value={board.ipf_at_db || ""}
                onChange={(e) => updateBoardField("ipf_at_db", e.target.value)}
                placeholder="e.g., 2.5"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {boards.length > 1 && (
        <p className="text-sm text-gray-500">
          This job has {boards.length} distribution boards. Use the tabs above to switch between them.
          Each board has its own circuits on the Circuits tab.
        </p>
      )}
    </div>
  );
}
