'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { RecordingState } from '@/hooks/use-recording';

interface DebugDashboardProps {
  state: RecordingState;
}

type TabId = 'stats' | 'fields' | 'transcript' | 'slp';

export function DebugDashboard({ state }: DebugDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('stats');
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
        <span className="text-gray-400">{isExpanded ? '\u25B2' : '\u25BC'}</span>
      </button>

      {isExpanded && (
        <>
          {/* Tab bar */}
          <div className="flex border-b border-gray-100">
            {(['stats', 'fields', 'transcript', 'slp'] as TabId[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'px-4 py-2 text-xs font-medium uppercase',
                  activeTab === tab
                    ? 'border-b-2 border-blue-500 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-4">
            {activeTab === 'stats' && <StatsPanel state={state} />}
            {activeTab === 'fields' && <FieldsPanel state={state} />}
            {activeTab === 'transcript' && <TranscriptPanel state={state} />}
            {activeTab === 'slp' && <SleepPanel state={state} />}
          </div>
        </>
      )}
    </div>
  );
}

function StatsPanel({ state }: { state: RecordingState }) {
  return (
    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
      <StatItem label="Regex Matches" value={state.regexMatchCount} color="text-blue-600" />
      <StatItem label="Sonnet Calls" value={state.sonnetCallCount} color="text-purple-600" />
      <StatItem
        label="Sonnet Cost"
        value={`$${state.sonnetCostUSD.toFixed(4)}`}
        color="text-green-600"
      />
      <StatItem label="Discrepancies" value={state.discrepancyCount} color="text-amber-600" />
      <StatItem
        label="Connection"
        value={state.connectionState}
        color={state.connectionState === 'connected' ? 'text-green-600' : 'text-gray-500'}
      />
      <StatItem
        label="Speaking"
        value={state.isSpeaking ? 'Yes' : 'No'}
        color={state.isSpeaking ? 'text-green-600' : 'text-gray-400'}
      />
      <StatItem
        label="TTS Active"
        value={state.isTTSSpeaking ? 'Yes' : 'No'}
        color={state.isTTSSpeaking ? 'text-amber-600' : 'text-gray-400'}
      />
      <StatItem label="Alert Queue" value={state.alertQueueCount} color="text-red-600" />
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
      <div className={cn('text-sm font-medium', color)}>{value}</div>
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
                    'rounded px-1.5 py-0.5 text-xs font-medium',
                    source === 'regex' && 'bg-blue-100 text-blue-700',
                    source === 'sonnet' && 'bg-purple-100 text-purple-700',
                    source === 'preExisting' && 'bg-gray-100 text-gray-600'
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
        {state.transcript || 'No transcript yet.'}
      </pre>
    </div>
  );
}

const SLEEP_EVENT_STYLES: Record<string, { bg: string; text: string }> = {
  STARTED: { bg: 'bg-blue-100', text: 'text-blue-700' },
  ENTER_DOZING: { bg: 'bg-amber-100', text: 'text-amber-700' },
  ENTER_SLEEPING: { bg: 'bg-red-100', text: 'text-red-700' },
  WAKE: { bg: 'bg-green-100', text: 'text-green-700' },
  VAD_WAKE: { bg: 'bg-green-100', text: 'text-green-700' },
  TTS_WAKE: { bg: 'bg-green-100', text: 'text-green-700' },
  WAKE_FOR_QUESTION: { bg: 'bg-green-100', text: 'text-green-700' },
  TTS_STARTED: { bg: 'bg-purple-100', text: 'text-purple-700' },
  QUESTION_ASKED: { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  DOZE_BLOCKED: { bg: 'bg-amber-100', text: 'text-amber-700' },
  DG_DISCONNECTED: { bg: 'bg-red-100', text: 'text-red-600' },
  STOPPED: { bg: 'bg-gray-100', text: 'text-gray-600' },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function SleepPanel({ state }: { state: RecordingState }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.sleepEvents.length]);

  if (!state.sleepEvents || state.sleepEvents.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            state.sleepState === 'active' ? 'bg-green-500' : 'bg-amber-500 animate-pulse'
          )}
        />
        {state.isRecording
          ? `Sleep detector ${state.sleepState} — no transitions yet.`
          : 'Start recording to see sleep detector events.'}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Current state indicator */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            state.sleepState === 'active' && 'bg-green-500',
            state.sleepState === 'dozing' && 'bg-amber-500 animate-pulse',
            state.sleepState === 'sleeping' && 'bg-red-400 animate-pulse'
          )}
        />
        Current: {state.sleepState}
      </div>

      {/* Event log */}
      <div ref={scrollRef} className="max-h-[200px] overflow-y-auto space-y-1">
        {state.sleepEvents.map((evt, i) => {
          const style = SLEEP_EVENT_STYLES[evt.event] ?? {
            bg: 'bg-gray-100',
            text: 'text-gray-600',
          };
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="shrink-0 font-mono text-gray-400">{formatTime(evt.timestamp)}</span>
              <span
                className={cn('shrink-0 rounded px-1.5 py-0.5 font-medium', style.bg, style.text)}
              >
                {evt.event}
              </span>
              {evt.detail && <span className="truncate text-gray-500">{evt.detail}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
