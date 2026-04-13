'use client';

import { memo, useMemo, useEffect, useRef, type ReactNode } from 'react';

interface Highlight {
  keyword: string;
  value: string;
  fieldKey: string;
  keywordCandidates: string[];
}

interface TranscriptBarProps {
  transcript: string;
  interimTranscript: string;
  highlight: Highlight | null;
  isRecording: boolean;
  sleepState: 'active' | 'dozing' | 'sleeping';
}

function buildHighlightedText(text: string, highlight: Highlight | null): ReactNode[] {
  if (!highlight || !text) return [text];

  const { keywordCandidates, value } = highlight;

  // Build match entries: [{start, end, type}]
  type Match = { start: number; end: number; type: 'keyword' | 'value' };
  const matches: Match[] = [];

  // Find keyword candidate matches
  for (const candidate of keywordCandidates) {
    if (!candidate) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, type: 'keyword' });
    }
  }

  // Find value matches
  if (value) {
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, type: 'value' });
    }
  }

  if (matches.length === 0) return [text];

  // Sort by start position, resolve overlaps (first match wins)
  matches.sort((a, b) => a.start - b.start);
  const resolved: Match[] = [];
  for (const m of matches) {
    const last = resolved[resolved.length - 1];
    if (!last || m.start >= last.end) {
      resolved.push(m);
    }
  }

  // Build React nodes
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (let i = 0; i < resolved.length; i++) {
    const m = resolved[i];
    if (cursor < m.start) {
      nodes.push(text.slice(cursor, m.start));
    }
    const span = text.slice(m.start, m.end);
    const cls =
      m.type === 'keyword' ? 'text-blue-400 font-semibold' : 'text-green-400 font-semibold';
    nodes.push(
      <span key={`hl-${i}`} className={cls}>
        {span}
      </span>
    );
    cursor = m.end;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

// Wrapped in memo so the bar only re-renders when its own props change,
// not on every unrelated store update (e.g. processingCount, cost, etc.).
export const TranscriptBar = memo(function TranscriptBar({
  transcript,
  interimTranscript,
  highlight,
  isRecording,
  sleepState,
}: TranscriptBarProps) {
  const visibleText = useMemo(() => transcript.slice(-200), [transcript]);

  // Ref for the scrollable text container — used to auto-scroll to newest text.
  const scrollRef = useRef<HTMLSpanElement>(null);

  // Auto-scroll to end whenever displayed content changes.
  // Mirrors iOS `.truncationMode(.head)` — always shows the rightmost (newest) text.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [visibleText, interimTranscript]);

  const highlighted = useMemo(
    () => buildHighlightedText(visibleText, highlight),
    [visibleText, highlight]
  );

  // Dozing / sleeping states
  if (sleepState === 'dozing') {
    return (
      <div className="h-11 bg-zinc-900/90 border-t border-zinc-800 flex items-center px-4 gap-2 overflow-hidden">
        <span className="w-2 h-2 rounded-full bg-zinc-500 shrink-0" />
        <span className="text-sm text-zinc-500">Saving power...</span>
      </div>
    );
  }

  if (sleepState === 'sleeping') {
    return (
      <div className="h-11 bg-zinc-900/90 border-t border-zinc-800 flex items-center px-4 gap-2 overflow-hidden">
        <span className="w-2 h-2 rounded-full bg-zinc-600 shrink-0" />
        <span className="text-sm text-zinc-500">Paused &mdash; speak to resume</span>
      </div>
    );
  }

  // Active state
  return (
    <div className="h-11 bg-zinc-900/90 border-t border-zinc-800 flex items-center px-4 gap-2 overflow-hidden">
      {isRecording && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />}

      {/* overflow-x-scroll + scrollbar hidden: allows programmatic scrollLeft while
          showing no scrollbar UI. Auto-scroll to right mirrors iOS truncationMode(.head). */}
      <span
        ref={scrollRef}
        className="text-sm text-zinc-300 flex-1 min-w-0 overflow-x-scroll whitespace-nowrap [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {highlighted}
        {interimTranscript && <span className="text-zinc-500 italic"> {interimTranscript}</span>}
      </span>

      {highlight && highlight.fieldKey && highlight.value && (
        <span className="bg-green-600/20 border border-green-600/40 rounded px-2 py-0.5 text-xs text-green-400 font-mono shrink-0">
          {highlight.fieldKey}: {highlight.value}
        </span>
      )}
    </div>
  );
});
