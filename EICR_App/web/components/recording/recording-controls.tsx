"use client";

import { cn } from "@/lib/utils";
import type { DeepgramConnectionState } from "@/lib/deepgram";

interface RecordingControlsProps {
  isRecording: boolean;
  connectionState: DeepgramConnectionState;
  isSpeaking: boolean;
  sessionDuration: number;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function connectionLabel(state: DeepgramConnectionState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return "Reconnecting...";
    case "disconnected":
      return "Disconnected";
  }
}

function connectionColor(state: DeepgramConnectionState): string {
  switch (state) {
    case "connected":
      return "bg-green-500";
    case "connecting":
    case "reconnecting":
      return "bg-yellow-500";
    case "disconnected":
      return "bg-gray-400";
  }
}

export function RecordingControls({
  isRecording,
  connectionState,
  isSpeaking,
  sessionDuration,
  error,
  onStart,
  onStop,
}: RecordingControlsProps) {
  return (
    <div className="flex items-center gap-4">
      {/* Record/Stop button */}
      <button
        onClick={isRecording ? onStop : onStart}
        className={cn(
          "flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-white transition-colors",
          isRecording
            ? "bg-red-600 hover:bg-red-700"
            : "bg-blue-600 hover:bg-blue-700",
        )}
      >
        {isRecording ? (
          <>
            <span className="h-3 w-3 rounded-sm bg-white" />
            Stop Recording
          </>
        ) : (
          <>
            <span className="h-3 w-3 rounded-full bg-white" />
            Start Recording
          </>
        )}
      </button>

      {/* Connection status */}
      {isRecording && (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              connectionColor(connectionState),
              connectionState === "connected" && isSpeaking && "animate-pulse",
            )}
          />
          <span>{connectionLabel(connectionState)}</span>
          <span className="text-gray-400">|</span>
          <span className="font-mono">{formatDuration(sessionDuration)}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <span className="text-sm text-red-600">{error}</span>
      )}
    </div>
  );
}
