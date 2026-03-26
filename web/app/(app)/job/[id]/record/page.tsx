'use client';

/**
 * Recording Page — Full voice-powered certificate data capture.
 *
 * Mirrors the iOS recording experience:
 * - Glassmorphic control bar at bottom with mic button, VAD indicator, waveform
 * - Live transcript bar with green value highlighting
 * - Real-time circuit grid with colored column groups and flash animations
 * - Non-blocking validation alerts
 * - Live section cards for installation, supply, and board data
 * - Debug dashboard (collapsible)
 *
 * Uses the existing useRecording hook which orchestrates:
 *   AudioCapture → Deepgram Nova-3 → NumberNormaliser →
 *   TranscriptFieldMatcher (regex) → Claude Sonnet (extraction) → AlertManager
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJobContext } from '../layout';
import { useRecording } from '@/hooks/use-recording';
import { LiveCircuitGrid } from '@/components/recording/live-circuit-grid';
import { AlertCard } from '@/components/recording/alert-card';
import { DebugDashboard } from '@/components/recording/debug-dashboard';
import { cn } from '@/lib/utils';
import type { TranscriptHighlight } from '@/hooks/use-recording';
import {
  Mic,
  MicOff,
  Square,
  Pause,
  Play,
  Wifi,
  WifiOff,
  Activity,
  Clock,
  Zap,
  Brain,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Smartphone,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Build highlighted transcript spans — green for Sonnet-confirmed values.
 */
function buildHighlightedSpans(text: string, highlights: TranscriptHighlight[]): React.ReactNode[] {
  if (!text) return [];

  const visible = text.length > 500 ? text.slice(-500) : text;
  if (highlights.length === 0) return [<span key={0}>{visible}</span>];

  const lowerVisible = visible.toLowerCase();
  const ranges: { start: number; end: number }[] = [];

  for (const h of highlights) {
    const lv = h.value.toLowerCase();
    if (!lv) continue;
    let lastIdx = -1;
    let from = 0;
    while (from < lowerVisible.length) {
      const idx = lowerVisible.indexOf(lv, from);
      if (idx === -1) break;
      const before = idx > 0 ? lowerVisible[idx - 1] : ' ';
      const after = idx + lv.length < lowerVisible.length ? lowerVisible[idx + lv.length] : ' ';
      if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) lastIdx = idx;
      from = idx + 1;
    }
    if (lastIdx >= 0) ranges.push({ start: lastIdx, end: lastIdx + lv.length });
  }

  if (ranges.length === 0) return [<span key={0}>{visible}</span>];

  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    if (ranges[i].start <= prev.end) prev.end = Math.max(prev.end, ranges[i].end);
    else merged.push(ranges[i]);
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const range of merged) {
    if (cursor < range.start)
      nodes.push(<span key={key++}>{visible.slice(cursor, range.start)}</span>);
    nodes.push(
      <span key={key++} className="text-status-green font-semibold">
        {visible.slice(range.start, range.end)}
      </span>
    );
    cursor = range.end;
  }
  if (cursor < visible.length) nodes.push(<span key={key++}>{visible.slice(cursor)}</span>);
  return nodes;
}

/* ------------------------------------------------------------------ */
/*  Audio Waveform Visualizer                                          */
/* ------------------------------------------------------------------ */

function WaveformBars({ isSpeaking, isRecording }: { isSpeaking: boolean; isRecording: boolean }) {
  const [bars, setBars] = useState([0.3, 0.5, 0.7, 0.5, 0.3]);

  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => {
      if (isSpeaking) {
        setBars(Array.from({ length: 5 }, () => 0.3 + Math.random() * 0.7));
      } else {
        setBars(Array.from({ length: 5 }, () => 0.15 + Math.random() * 0.15));
      }
    }, 150);
    return () => clearInterval(interval);
  }, [isSpeaking, isRecording]);

  return (
    <div className="flex items-end gap-[2px] h-6">
      {bars.map((h, i) => (
        <div
          key={i}
          className={cn(
            'w-[3px] rounded-full transition-all duration-150',
            isRecording
              ? isSpeaking
                ? 'bg-status-green'
                : 'bg-muted-foreground'
              : 'bg-muted-foreground/50'
          )}
          style={{ height: `${h * 24}px` }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  VAD Indicator                                                      */
/* ------------------------------------------------------------------ */

function VADIndicator({ isSpeaking, isRecording }: { isSpeaking: boolean; isRecording: boolean }) {
  return (
    <div className="relative flex items-center justify-center">
      {/* Outer pulse ring */}
      {isRecording && isSpeaking && (
        <div className="absolute h-5 w-5 rounded-full bg-status-green/30 animate-ping" />
      )}
      {/* Inner dot */}
      <div
        className={cn(
          'h-3 w-3 rounded-full transition-colors duration-200',
          !isRecording && 'bg-muted-foreground',
          isRecording && !isSpeaking && 'bg-status-amber',
          isRecording && isSpeaking && 'bg-status-green'
        )}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Connection Status Badge                                            */
/* ------------------------------------------------------------------ */

function ConnectionBadge({ state }: { state: string }) {
  const color =
    state === 'connected'
      ? 'bg-status-green/20 text-status-green border-status-green/30'
      : state === 'connecting' || state === 'reconnecting'
        ? 'bg-status-amber/20 text-status-amber border-status-amber/30'
        : 'bg-L3 text-muted-foreground border-white/10';

  const icon =
    state === 'connected' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />;

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        color
      )}
    >
      {icon}
      <span className="capitalize">{state}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stats Bar                                                          */
/* ------------------------------------------------------------------ */

function StatsBar({
  regexCount,
  sonnetCount,
  cost,
  discrepancies,
  duration,
}: {
  regexCount: number;
  sonnetCount: number;
  cost: number;
  discrepancies: number;
  duration: number;
}) {
  return (
    <div className="flex items-center gap-3 text-[11px]">
      <div className="flex items-center gap-1 text-brand-blue">
        <Zap className="h-3 w-3" />
        <span>{regexCount} regex</span>
      </div>
      <div className="flex items-center gap-1 text-status-fi">
        <Brain className="h-3 w-3" />
        <span>{sonnetCount} sonnet</span>
      </div>
      {discrepancies > 0 && (
        <div className="flex items-center gap-1 text-status-amber">
          <AlertTriangle className="h-3 w-3" />
          <span>{discrepancies}</span>
        </div>
      )}
      <div className="flex items-center gap-1 text-status-green">
        <span>${cost.toFixed(3)}</span>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Live Data Cards (Installation, Supply, Board)                      */
/* ------------------------------------------------------------------ */

function LiveDataCard({
  title,
  data,
  fields,
  recentlyUpdated,
}: {
  title: string;
  data: Record<string, unknown> | undefined;
  fields: { key: string; label: string }[];
  recentlyUpdated: Record<string, number>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const filledCount = fields.filter((f) => data?.[f.key]).length;

  useEffect(() => {
    setNow(Date.now());
  }, [data]);

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-foreground hover:bg-white/5 transition-colors"
      >
        <span>
          {title}{' '}
          <span className="text-muted-foreground">
            ({filledCount}/{fields.length})
          </span>
        </span>
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 px-4 pb-3">
          {fields.map((f) => {
            const val = data?.[f.key] as string | undefined;
            const fieldKey = `${title.toLowerCase().replace(/\s/g, '')}.${f.key}`;
            const isRecent = recentlyUpdated[fieldKey] && now - recentlyUpdated[fieldKey] < 2000;
            return (
              <div
                key={f.key}
                className={cn(
                  'flex items-baseline gap-1 py-0.5 rounded px-1 transition-colors duration-300',
                  isRecent && 'bg-brand-blue/15'
                )}
              >
                <span className="text-[11px] text-muted-foreground w-24 shrink-0 text-right">
                  {f.label}
                </span>
                <span
                  className={cn(
                    'text-[11px] font-mono truncate',
                    val ? 'text-foreground' : 'text-muted-foreground/40'
                  )}
                >
                  {val || '\u2014'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section field definitions                                          */
/* ------------------------------------------------------------------ */

const installationFields = [
  { key: 'client_name', label: 'Client' },
  { key: 'address', label: 'Address' },
  { key: 'postcode', label: 'Postcode' },
  { key: 'premises_description', label: 'Premises' },
  { key: 'next_inspection_years', label: 'Next Insp' },
  { key: 'agreed_limitations', label: 'Limitations' },
];

const supplyFields = [
  { key: 'earthing_arrangement', label: 'Earthing' },
  { key: 'live_conductors', label: 'Conductors' },
  { key: 'nominal_voltage_u', label: 'Voltage U' },
  { key: 'nominal_voltage_uo', label: 'Voltage Uo' },
  { key: 'prospective_fault_current', label: 'PFC' },
  { key: 'earth_loop_impedance_ze', label: 'Ze' },
];

const boardFields = [
  { key: 'manufacturer', label: 'Make' },
  { key: 'location', label: 'Location' },
  { key: 'phases', label: 'Phases' },
  { key: 'zs_at_db', label: 'Zs at DB' },
  { key: 'ze', label: 'Ze' },
  { key: 'ipf_at_db', label: 'Ipf at DB' },
];

/* ------------------------------------------------------------------ */
/*  Main Recording Page                                                */
/* ------------------------------------------------------------------ */

export default function RecordPage() {
  const { job, updateJob, user } = useJobContext();
  const [state, actions] = useRecording(job, updateJob);
  const [showDebug, setShowDebug] = useState(false);
  const [showSections, setShowSections] = useState(true);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollLeft = transcriptScrollRef.current.scrollWidth;
    }
  }, [state.transcript, state.interimTranscript]);

  const highlightedText = useMemo(
    () => buildHighlightedSpans(state.transcript, state.highlights),
    [state.transcript, state.highlights]
  );

  const handleStart = useCallback(() => actions.startRecording(), [actions]);
  const handleStop = useCallback(() => {
    if (window.confirm('End this recording session?')) {
      actions.stopRecording();
    }
  }, [actions]);

  return (
    <div className="flex flex-col h-full bg-L0 circuit-grid-bg text-foreground">
      {/* ──────────── Top: Transcript Bar ──────────── */}
      <div className="flex-shrink-0 border-b border-white/5 glass-bg">
        <div className="flex items-center gap-3 px-4 py-2">
          {/* Connection dot */}
          <div
            className={cn(
              'h-2 w-2 rounded-full shrink-0',
              state.connectionState === 'connected' && 'bg-status-green',
              (state.connectionState === 'connecting' ||
                state.connectionState === 'reconnecting') &&
                'bg-status-amber animate-pulse',
              state.connectionState === 'disconnected' && 'bg-muted-foreground'
            )}
          />

          {/* Transcript text - horizontally scrolling single line */}
          <div
            ref={transcriptScrollRef}
            className="flex-1 overflow-x-auto whitespace-nowrap text-sm scrollbar-none"
          >
            {state.transcript ? (
              <>
                {highlightedText}
                {state.interimTranscript && (
                  <span className="italic text-muted-foreground"> {state.interimTranscript}</span>
                )}
              </>
            ) : state.isRecording ? (
              <span className="text-muted-foreground">Listening...</span>
            ) : (
              <span className="text-muted-foreground/50">
                Press the mic button to start recording
              </span>
            )}
          </div>

          {/* Stats */}
          {state.isRecording && (
            <StatsBar
              regexCount={state.regexMatchCount}
              sonnetCount={state.sonnetCallCount}
              cost={state.sonnetCostUSD}
              discrepancies={state.discrepancyCount}
              duration={state.sessionDuration}
            />
          )}
        </div>
      </div>

      {/* ──────────── Alert overlay ──────────── */}
      {state.currentAlert && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4 animate-in slide-in-from-top duration-300">
          <AlertCard
            alert={state.currentAlert}
            queueCount={state.alertQueueCount}
            onAccept={() => actions.handleAlertResponse(true)}
            onReject={() => actions.handleAlertResponse(false)}
            onDismiss={actions.dismissAlert}
          />
        </div>
      )}

      {/* ──────────── Main Content Area ──────────── */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Section data cards */}
        {showSections && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 stagger-in">
            <div className="animate-stagger-in">
              <LiveDataCard
                title="Installation"
                data={job.installation_details as unknown as Record<string, unknown>}
                fields={installationFields}
                recentlyUpdated={state.recentlyUpdatedFields}
              />
            </div>
            <div className="animate-stagger-in">
              <LiveDataCard
                title="Supply"
                data={job.supply_characteristics as unknown as Record<string, unknown>}
                fields={supplyFields}
                recentlyUpdated={state.recentlyUpdatedFields}
              />
            </div>
            <div className="animate-stagger-in">
              <LiveDataCard
                title="Board"
                data={job.board_info as unknown as Record<string, unknown>}
                fields={boardFields}
                recentlyUpdated={state.recentlyUpdatedFields}
              />
            </div>
          </div>
        )}

        {/* Live circuit grid */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Circuits{' '}
              <span className="text-muted-foreground/50">({job.circuits?.length || 0})</span>
            </h3>
            <button
              onClick={() => setShowSections(!showSections)}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showSections ? 'Hide' : 'Show'} sections
            </button>
          </div>
          <LiveCircuitGrid
            circuits={job.circuits || []}
            recentlyUpdatedFields={state.recentlyUpdatedFields}
          />
        </div>

        {/* Debug dashboard */}
        {showDebug && <DebugDashboard state={state} />}
      </div>

      {/* ──────────── Bottom: Control Bar (Glass) ──────────── */}
      <div className="flex-shrink-0 border-t border-white/5 glass-bg">
        <div className="flex items-center gap-4 px-4 py-3">
          {/* Left: VAD + Waveform */}
          <div className="flex items-center gap-3">
            <VADIndicator isSpeaking={state.isSpeaking} isRecording={state.isRecording} />
            <WaveformBars isSpeaking={state.isSpeaking} isRecording={state.isRecording} />
          </div>

          {/* Center: Status + Connection */}
          <div className="flex-1 flex items-center justify-center gap-3">
            <ConnectionBadge state={state.connectionState} />
            {state.isRecording && (
              <span className="text-sm font-mono text-muted-foreground">
                {formatDuration(state.sessionDuration)}
              </span>
            )}
            {state.error && (
              <span className="text-xs text-status-red truncate max-w-[200px]">{state.error}</span>
            )}
          </div>

          {/* Right: Action buttons */}
          <div className="flex items-center gap-2">
            {/* Debug toggle */}
            <button
              onClick={() => setShowDebug(!showDebug)}
              className={cn(
                'rounded-full p-2 text-xs transition-colors',
                showDebug
                  ? 'bg-status-red/20 text-status-red border border-status-red/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-L3'
              )}
              title="Debug Dashboard"
              aria-label={showDebug ? 'Hide debug dashboard' : 'Show debug dashboard'}
            >
              <Activity className="h-4 w-4" />
            </button>

            {/* Companion mic link */}
            <a
              href="/mic"
              target="_blank"
              className="rounded-full p-2 text-muted-foreground hover:text-brand-blue hover:bg-brand-blue/10 transition-colors"
              title="Open phone companion mic"
              aria-label="Open phone companion mic"
            >
              <Smartphone className="h-4 w-4" />
            </a>

            {/* Stop button (only when recording) */}
            {state.isRecording && (
              <button
                onClick={handleStop}
                className="flex items-center gap-1.5 rounded-full bg-status-red/20 border border-status-red/30 px-3 py-2 text-xs font-medium text-status-red hover:bg-status-red/30 transition-colors"
                aria-label="End recording"
              >
                <Square className="h-3.5 w-3.5" />
                End
              </button>
            )}

            {/* Main record button */}
            <button
              onClick={state.isRecording ? handleStop : handleStart}
              aria-label={state.isRecording ? 'Stop recording' : 'Start recording'}
              className={cn(
                'flex items-center justify-center rounded-full transition-all duration-200 shadow-lg',
                state.isRecording
                  ? 'h-14 w-14 bg-gradient-to-br from-status-amber to-status-red hover:opacity-90 shadow-status-red/25'
                  : 'h-14 w-14 bg-gradient-to-br from-brand-green to-status-green hover:opacity-90 shadow-brand-green/25'
              )}
            >
              {state.isRecording ? (
                <Pause className="h-6 w-6 text-white" />
              ) : (
                <Mic className="h-6 w-6 text-white" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
