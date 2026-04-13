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
import { toast } from 'sonner';
import { useJobContext } from '../layout';
import { useRecording } from '@/hooks/use-recording';
import { api } from '@/lib/api-client';
import { applyDefaultsToCircuits } from '@/lib/apply-defaults';
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
  SlidersHorizontal,
  FileDown,
  Scan,
  FileSearch,
  Camera,
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
      <span key={key++} className="text-green-400 font-semibold">
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
            isRecording ? (isSpeaking ? 'bg-green-400' : 'bg-gray-400') : 'bg-gray-300'
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
        <div className="absolute h-5 w-5 rounded-full bg-green-400/30 animate-ping" />
      )}
      {/* Inner dot */}
      <div
        className={cn(
          'h-3 w-3 rounded-full transition-colors duration-200',
          !isRecording && 'bg-gray-400',
          isRecording && !isSpeaking && 'bg-yellow-400',
          isRecording && isSpeaking && 'bg-green-400'
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
      ? 'bg-green-500/20 text-green-400 border-green-500/30'
      : state === 'connecting' || state === 'reconnecting'
        ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
        : 'bg-gray-500/20 text-gray-400 border-gray-500/30';

  const icon =
    state === 'connected' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />;

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
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
      <div className="flex items-center gap-1 text-blue-400">
        <Zap className="h-3 w-3" />
        <span>{regexCount} regex</span>
      </div>
      <div className="flex items-center gap-1 text-purple-400">
        <Brain className="h-3 w-3" />
        <span>{sonnetCount} sonnet</span>
      </div>
      {discrepancies > 0 && (
        <div className="flex items-center gap-1 text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          <span>{discrepancies}</span>
        </div>
      )}
      <div className="flex items-center gap-1 text-green-400">
        <span>${cost.toFixed(3)}</span>
      </div>
      <div className="flex items-center gap-1 text-gray-400">
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
  const now = Date.now();
  const filledCount = fields.filter((f) => data?.[f.key]).length;

  return (
    <div className="rounded-lg border border-gray-700/50 bg-gray-800/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-gray-300 hover:bg-gray-700/30"
      >
        <span>
          {title}{' '}
          <span className="text-gray-500">
            ({filledCount}/{fields.length})
          </span>
        </span>
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 px-3 pb-2">
          {fields.map((f) => {
            const val = data?.[f.key] as string | undefined;
            const fieldKey = `${title.toLowerCase().replace(/\s/g, '')}.${f.key}`;
            const isRecent = recentlyUpdated[fieldKey] && now - recentlyUpdated[fieldKey] < 2000;
            return (
              <div
                key={f.key}
                className={cn(
                  'flex items-baseline gap-1 py-0.5 rounded px-1 transition-colors duration-300',
                  isRecent && 'bg-blue-500/20'
                )}
              >
                <span className="text-[10px] text-gray-500 w-24 shrink-0 text-right">
                  {f.label}
                </span>
                <span
                  className={cn(
                    'text-[11px] font-mono truncate',
                    val ? 'text-gray-200' : 'text-gray-600'
                  )}
                >
                  {val || '—'}
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
  const ccuInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const obsInputRef = useRef<HTMLInputElement>(null);
  // Value badge: flash last confirmed extraction value for 1.5s (mirrors iOS transcript capsule)
  const [valueBadge, setValueBadge] = useState<string | null>(null);
  const prevHighlightsLen = useRef(0);

  // Auto-scroll transcript to show newest content
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    // Use requestAnimationFrame so the DOM has updated before we measure scrollWidth
    requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth;
    });
  }, [state.transcript, state.interimTranscript]);

  // Flash value badge when new Sonnet highlights arrive
  useEffect(() => {
    if (state.highlights.length > prevHighlightsLen.current) {
      const newest = state.highlights[state.highlights.length - 1];
      if (newest) {
        setValueBadge(newest.value);
        const t = setTimeout(() => setValueBadge(null), 1500);
        prevHighlightsLen.current = state.highlights.length;
        return () => clearTimeout(t);
      }
    }
    prevHighlightsLen.current = state.highlights.length;
  }, [state.highlights]);

  const highlightedText = useMemo(
    () => buildHighlightedSpans(state.transcript, state.highlights),
    [state.transcript, state.highlights]
  );

  const handleStart = useCallback(() => {
    actions.startRecording().catch((err: unknown) => {
      console.error('[RecordPage] startRecording failed:', err);
    });
  }, [actions]);
  const handleStop = useCallback(() => {
    if (window.confirm('End this recording session?')) {
      actions.stopRecording();
    }
  }, [actions]);

  // iOS-parity: Open defaults page in new tab
  const handleDefaults = useCallback(() => {
    if (!job) return;
    window.open(`/job/${job.id}/defaults`, '_blank');
  }, [job]);

  // iOS-parity: Apply user defaults to all circuits (only-fill-empty strategy)
  const handleApplyDefaults = useCallback(async () => {
    if (!user || !job) return;
    try {
      const defaults = await api.getUserDefaults(user.id);
      if (!defaults || Object.keys(defaults).length === 0) {
        toast.info('No defaults configured. Set them in the Defaults tab.');
        return;
      }
      const updated = applyDefaultsToCircuits(job.circuits || [], defaults);
      updateJob({ circuits: updated });
      toast.success('Defaults applied to all circuits');
    } catch {
      toast.error('Failed to load defaults');
    }
  }, [user, job, updateJob]);

  // iOS-parity: CCU board photo capture & analysis
  const handleCcuFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      toast.info('Analyzing CCU photo...');
      try {
        const result = await api.analyzeCcu(file);
        if (result.circuits?.length) {
          const existing = job?.circuits || [];
          const mapped = result.circuits.map((c, i) => ({
            circuit_ref: String(c.circuit_number || existing.length + i + 1),
            circuit_designation: c.label || `Circuit ${existing.length + i + 1}`,
            ocpd_type: c.ocpd_type || undefined,
            ocpd_rating_a: c.ocpd_rating_a || undefined,
            ocpd_bs_en: c.ocpd_bs_en || undefined,
            ocpd_breaking_capacity_ka: c.ocpd_breaking_capacity_ka || undefined,
            rcd_bs_en: c.rcd_bs_en || undefined,
            rcd_operating_current_ma: c.rcd_rating_ma || undefined,
          }));
          updateJob({ circuits: [...existing, ...mapped] });
          toast.success(
            `Found ${result.circuits.length} circuit${result.circuits.length !== 1 ? 's' : ''} from CCU`
          );
        } else {
          toast.info('No circuits detected in photo');
        }
      } catch {
        toast.error('CCU analysis failed');
      }
      e.target.value = '';
    },
    [job, updateJob]
  );

  // iOS-parity: Observation photo upload
  const handleObsFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !user || !job) return;
      try {
        await api.uploadJobPhoto(user.id, job.id, file);
        toast.success('Observation photo uploaded');
      } catch {
        toast.error('Photo upload failed');
      }
      e.target.value = '';
    },
    [user, job]
  );

  // iOS-parity: Document photo extraction
  const handleDocFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !user || !job) return;
      try {
        await api.uploadJobPhoto(user.id, job.id, file);
        toast.success('Document photo uploaded');
      } catch {
        toast.error('Document upload failed');
      }
      e.target.value = '';
    },
    [user, job]
  );

  return (
    <div className="flex flex-col h-full bg-gray-900 text-white">
      {/* ──────────── Top: Transcript Bar ──────────── */}
      <div className="flex-shrink-0 border-b border-gray-700/50 bg-gray-800/80 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-4 py-2">
          {/* VAD / connection dot — pulses green when speaking (mirrors iOS pulsing dot on TranscriptStripView) */}
          <div className="relative flex items-center justify-center shrink-0">
            {state.isRecording && state.isSpeaking && (
              <div className="absolute h-4 w-4 rounded-full bg-green-400/30 animate-ping" />
            )}
            <div
              className={cn(
                'h-2 w-2 rounded-full',
                state.connectionState === 'connected' && state.isSpeaking && 'bg-green-400',
                state.connectionState === 'connected' && !state.isSpeaking && 'bg-green-600',
                (state.connectionState === 'connecting' ||
                  state.connectionState === 'reconnecting') &&
                  'bg-yellow-400 animate-pulse',
                state.connectionState === 'disconnected' && 'bg-gray-500'
              )}
            />
          </div>

          {/* Transcript text - horizontally scrolling single line */}
          <div
            ref={transcriptScrollRef}
            className="flex-1 overflow-x-auto whitespace-nowrap text-sm [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarWidth: 'none' }}
          >
            {state.transcript ? (
              <>
                {highlightedText}
                {state.interimTranscript && (
                  <span className="italic text-gray-500"> {state.interimTranscript}</span>
                )}
              </>
            ) : state.isRecording ? (
              <span className="text-gray-500">Listening...</span>
            ) : (
              <span className="text-gray-600">Press the mic button to start recording</span>
            )}
          </div>

          {/* Value badge — flashes confirmed extraction value for 1.5s (mirrors iOS capsule badge) */}
          {valueBadge && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-green-500/20 border border-green-500/40 px-2 py-0.5 text-[10px] font-semibold text-green-400 animate-in fade-in duration-150">
              ✓ {valueBadge}
            </span>
          )}

          {/* Processing badge — pulsing orange when Sonnet is active (mirrors iOS ProcessingBadgeView) */}
          {state.isRecording && state.sonnetCallCount > 0 && !valueBadge && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-orange-500/20 border border-orange-500/30 px-2 py-0.5 text-[10px] font-medium text-orange-400">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-400 animate-pulse" />
              {state.sonnetCallCount}
            </span>
          )}

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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <LiveDataCard
              title="Installation"
              data={job.installation_details as unknown as Record<string, unknown>}
              fields={installationFields}
              recentlyUpdated={state.recentlyUpdatedFields}
            />
            <LiveDataCard
              title="Supply"
              data={job.supply_characteristics as unknown as Record<string, unknown>}
              fields={supplyFields}
              recentlyUpdated={state.recentlyUpdatedFields}
            />
            <LiveDataCard
              title="Board"
              data={job.board_info as unknown as Record<string, unknown>}
              fields={boardFields}
              recentlyUpdated={state.recentlyUpdatedFields}
            />
          </div>
        )}

        {/* Live circuit grid */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-400">
              Circuits <span className="text-gray-600">({job.circuits?.length || 0})</span>
            </h3>
            <button
              onClick={() => setShowSections(!showSections)}
              className="text-[10px] text-gray-500 hover:text-gray-300"
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

      {/* Hidden file inputs for CCU, Doc, Obs photo capture */}
      <input
        ref={ccuInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleCcuFile}
        className="hidden"
      />
      <input
        ref={docInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleDocFile}
        className="hidden"
      />
      <input
        ref={obsInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleObsFile}
        className="hidden"
      />

      {/* ──────────── Bottom: Control Bar — iOS-parity with all buttons ──────────── */}
      <div className="flex-shrink-0 sticky bottom-0 z-10 border-t border-gray-700/50 bg-gray-800/90 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 py-2">
          {/* Left: Status indicators */}
          <div className="flex items-center gap-3">
            <VADIndicator isSpeaking={state.isSpeaking} isRecording={state.isRecording} />
            <WaveformBars isSpeaking={state.isSpeaking} isRecording={state.isRecording} />
            <ConnectionBadge state={state.connectionState} />
            {state.isRecording && (
              <span className="text-sm font-mono text-gray-400">
                {formatDuration(state.sessionDuration)}
              </span>
            )}
            {state.error && (
              <span className="text-xs text-red-400 truncate max-w-[180px]">{state.error}</span>
            )}
          </div>

          <div className="flex-1" />

          {/* Right: iOS-parity action buttons — Defaults, Apply, CCU, Doc, Obs, End, Record */}
          <div className="flex items-center gap-1.5">
            {/* Web-only: Debug toggle (small, secondary) */}
            <button
              onClick={() => setShowDebug(!showDebug)}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 rounded-xl h-14 w-14 transition-colors',
                showDebug
                  ? 'bg-red-500/20 text-red-400'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/50'
              )}
              title="Debug Dashboard"
            >
              <Activity className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">Debug</span>
            </button>

            {/* Web-only: Companion mic link */}
            <a
              href="/mic"
              target="_blank"
              className="flex flex-col items-center justify-center gap-0.5 rounded-xl h-14 w-14 text-gray-500 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors"
              title="Open phone companion mic"
            >
              <Smartphone className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">Phone</span>
            </a>

            {/* Divider between web-only and iOS-parity buttons */}
            <div className="w-px h-8 bg-gray-700/50 mx-1" />

            {/* Defaults — purple, matches iOS slider.horizontal.3 */}
            <button
              onClick={handleDefaults}
              className="flex flex-col items-center justify-center gap-0.5 rounded-full h-14 w-14 bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 transition-colors"
              title="Open defaults settings"
            >
              <SlidersHorizontal className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">Defaults</span>
            </button>

            {/* Apply — green, matches iOS arrow.down.doc */}
            <button
              onClick={handleApplyDefaults}
              className="flex flex-col items-center justify-center gap-0.5 rounded-full h-14 w-14 bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 transition-colors"
              title="Apply defaults to all circuits"
            >
              <FileDown className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">Apply</span>
            </button>

            {/* CCU — orange, matches iOS camera.viewfinder */}
            <button
              onClick={() => ccuInputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-0.5 rounded-full h-14 w-14 bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30 transition-colors"
              title="Capture CCU board photo"
            >
              <Scan className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">CCU</span>
            </button>

            {/* Doc — cyan, matches iOS doc.text.viewfinder */}
            <button
              onClick={() => docInputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-0.5 rounded-full h-14 w-14 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors"
              title="Extract data from document photo"
            >
              <FileSearch className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">Doc</span>
            </button>

            {/* Obs — blue, matches iOS camera.fill */}
            <button
              onClick={() => obsInputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-0.5 rounded-full h-14 w-14 bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-colors"
              title="Capture observation photo"
            >
              <Camera className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">Obs</span>
            </button>

            {/* End Session — red, always visible; disabled when not recording */}
            <button
              onClick={handleStop}
              disabled={!state.isRecording}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 rounded-full h-14 w-14 border transition-colors',
                state.isRecording
                  ? 'bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/30'
                  : 'bg-gray-700/20 text-gray-600 border-gray-700/30 opacity-40 cursor-not-allowed'
              )}
              title="End recording session"
            >
              <Square className="h-5 w-5" />
              <span className="text-[9px] font-medium leading-none">End</span>
            </button>

            {/* Main Record/Pause button — large, green/orange gradient */}
            <button
              onClick={state.isRecording ? handleStop : handleStart}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 rounded-full h-16 w-16 transition-all duration-200 shadow-lg ml-1',
                state.isRecording
                  ? 'bg-gradient-to-br from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 shadow-red-500/25'
                  : 'bg-gradient-to-br from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 shadow-green-500/25'
              )}
            >
              {state.isRecording ? (
                <Pause className="h-6 w-6 text-white" />
              ) : (
                <Mic className="h-6 w-6 text-white" />
              )}
              <span className="text-[9px] font-medium leading-none text-white/90">
                {state.isRecording ? 'Pause' : 'Rec'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
