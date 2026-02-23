"use client";

import { Mic, Square } from "lucide-react";
import type { DeepgramConnectionState } from "@/lib/recording/deepgram-service";
import type { SleepState } from "@/lib/recording-store";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RecordingControlsProps {
  isRecording: boolean;
  duration: number;
  deepgramState: DeepgramConnectionState;
  serverConnected: boolean;
  sleepState: SleepState;
  cost: { totalJobCost: number } | null;
  onStart: () => void;
  onStop: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatCost(cost: number): string {
  return `\u00A3${cost.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

type DotStatus = "connected" | "connecting" | "disconnected";

function StatusDot({ status, label }: { status: DotStatus; label: string }) {
  const colorClass =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-amber-500 animate-pulse"
        : "bg-red-500";

  return (
    <div className="flex items-center gap-1">
      <div className={`h-1.5 w-1.5 rounded-full ${colorClass}`} />
      <span className="text-[10px] text-zinc-500 uppercase tracking-wide">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecordingControls({
  isRecording,
  duration,
  deepgramState,
  serverConnected,
  sleepState,
  cost,
  onStart,
  onStop,
}: RecordingControlsProps) {
  const dgStatus: DotStatus =
    deepgramState === "connected"
      ? "connected"
      : deepgramState === "connecting" || deepgramState === "reconnecting"
        ? "connecting"
        : "disconnected";

  const aiStatus: DotStatus = serverConnected ? "connected" : "disconnected";

  return (
    <div className="bg-zinc-900/95 border-t border-zinc-800 p-3">
      <div className="flex items-center justify-between max-w-lg mx-auto">
        {/* Left: Status indicators */}
        <div className="flex flex-col gap-1 min-w-[48px]">
          <StatusDot status={dgStatus} label="DG" />
          <StatusDot status={aiStatus} label="AI" />
          {isRecording && sleepState !== "active" && (
            <span className="text-[10px] text-zinc-600">
              {sleepState === "dozing" ? "Saving power..." : "Paused"}
            </span>
          )}
        </div>

        {/* Center: Record / Stop button */}
        <div className="flex items-center justify-center">
          {isRecording ? (
            <button
              onClick={onStop}
              className="relative flex items-center justify-center w-[72px] h-[72px] rounded-full bg-red-600 hover:bg-red-700 transition-colors"
              aria-label="Stop recording"
            >
              <span className="absolute inset-0 rounded-full border-2 border-red-400 animate-pulse" />
              <Square className="h-7 w-7 text-white" fill="white" />
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center justify-center w-[72px] h-[72px] rounded-full bg-red-600 hover:bg-red-700 transition-colors"
              aria-label="Start recording"
            >
              <Mic className="h-7 w-7 text-white" />
            </button>
          )}
        </div>

        {/* Right: Duration + Cost */}
        <div className="flex flex-col items-end gap-0.5 min-w-[48px]">
          <span className="font-mono text-sm text-zinc-200">
            {formatDuration(duration)}
          </span>
          {cost != null && (
            <span className="font-mono text-xs text-zinc-500">
              {formatCost(cost.totalJobCost)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
