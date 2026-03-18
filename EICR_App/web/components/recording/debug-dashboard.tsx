"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { RecordingState } from "@/hooks/use-recording";

interface DebugDashboardProps {
  state: RecordingState;
}

type TabId = "stats" | "fields" | "transcript" | "log";

export function DebugDashboard({ state }: DebugDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>("stats");
  const [isExpanded, setIsExpanded] = useState(false);

  if (!state.isRecording && !state.transcript) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      {/* Toggle header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        <span>Debug Dashboard</span>
        <span className="text-gray-400">{isExpanded ? "\u25B2" : "\u25BC"}</span>
      </button>

      {isExpanded && (
        <>
          {/* Tab bar */}
          <div className="flex border-b border-gray-100">
            {(["stats", "fields", "transcript"] as TabId[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-4 py-2 text-xs font-medium capitalize",
                  activeTab === tab
                    ? "border-b-2 border-blue-500 text-blue-600"
                    : "text-gray-500 hover:text-gray-700",
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-4">
            {activeTab === "stats" && <StatsPanel state={state} />}
            {activeTab === "fields" && <FieldsPanel state={state} />}
            {activeTab === "transcript" && <TranscriptPanel state={state} />}
          </div>
        </>
      )}
    </div>
  );
}

function StatsPanel({ state }: { state: RecordingState }) {
  return (
    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      <StatItem
        label="Regex Matches"
        value={state.regexMatchCount}
        color="text-blue-600"
      />
      <StatItem
        label="Sonnet Calls"
        value={state.sonnetCallCount}
        color="text-purple-600"
      />
      <StatItem
        label="Sonnet Cost"
        value={`$${state.sonnetCostUSD.toFixed(4)}`}
        color="text-green-600"
      />
      <StatItem
        label="Discrepancies"
        value={state.discrepancyCount}
        color="text-amber-600"
      />
      <StatItem
        label="Connection"
        value={state.connectionState}
        color={
          state.connectionState === "connected"
            ? "text-green-600"
            : "text-gray-500"
        }
      />
      <StatItem
        label="Speaking"
        value={state.isSpeaking ? "Yes" : "No"}
        color={state.isSpeaking ? "text-green-600" : "text-gray-400"}
      />
      <StatItem
        label="TTS Active"
        value={state.isTTSSpeaking ? "Yes" : "No"}
        color={state.isTTSSpeaking ? "text-amber-600" : "text-gray-400"}
      />
      <StatItem
        label="Alert Queue"
        value={state.alertQueueCount}
        color="text-red-600"
      />
    </div>
  );
}

function StatItem({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div className="rounded-md border border-gray-100 p-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={cn("text-sm font-medium", color)}>{value}</div>
    </div>
  );
}

function FieldsPanel({ state }: { state: RecordingState }) {
  const entries = Object.entries(state.fieldSources);
  if (entries.length === 0) {
    return <p className="text-sm text-gray-400">No fields captured yet.</p>;
  }

  return (
    <div className="max-h-[200px] overflow-y-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100 text-left text-gray-500">
            <th className="pb-1 pr-4">Field</th>
            <th className="pb-1">Source</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, source]) => (
            <tr key={key} className="border-b border-gray-50">
              <td className="py-1 pr-4 font-mono text-gray-700">{key}</td>
              <td className="py-1">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs font-medium",
                    source === "regex" && "bg-blue-100 text-blue-700",
                    source === "sonnet" && "bg-purple-100 text-purple-700",
                    source === "preExisting" &&
                      "bg-gray-100 text-gray-600",
                  )}
                >
                  {source}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TranscriptPanel({ state }: { state: RecordingState }) {
  return (
    <div className="max-h-[200px] overflow-y-auto">
      <pre className="whitespace-pre-wrap text-xs text-gray-700">
        {state.transcript || "No transcript yet."}
      </pre>
    </div>
  );
}
