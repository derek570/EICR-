'use client';

import { useEffect, useRef, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { TranscriptHighlight } from '@/hooks/use-recording';

interface TranscriptDisplayProps {
  transcript: string;
  interimTranscript: string;
  isRecording: boolean;
  fieldSources: Record<string, 'regex' | 'sonnet' | 'preExisting'>;
  /** Highlights from Sonnet extraction — values confirmed into the UI. */
  highlights: TranscriptHighlight[];
}

/**
 * Build highlighted spans from the visible tail of the transcript.
 * Only values that have been confirmed by Sonnet extraction and entered into
 * the UI are colored green. No static keyword highlighting — this ensures the
 * user sees color only for values guaranteed to be in the system.
 */
function buildHighlightedText(text: string, highlights: TranscriptHighlight[]): React.ReactNode[] {
  if (!text || highlights.length === 0) {
    // No highlights — return plain text (last 300 chars for performance)
    const visible = text.length > 300 ? text.slice(-300) : text;
    return visible ? [<span key={0}>{visible}</span>] : [];
  }

  // Show last 300 chars for performance
  const visible = text.length > 300 ? text.slice(-300) : text;
  const lowerVisible = visible.toLowerCase();

  // Build a list of character ranges to highlight (value matches)
  const ranges: { start: number; end: number }[] = [];

  for (const highlight of highlights) {
    const lowerValue = highlight.value.toLowerCase();
    if (!lowerValue) continue;

    // Find the LAST word-boundary occurrence of the value in the visible text
    let lastIdx = -1;
    let searchFrom = 0;
    while (searchFrom < lowerVisible.length) {
      const idx = lowerVisible.indexOf(lowerValue, searchFrom);
      if (idx === -1) break;

      // Word boundary check
      const before = idx > 0 ? lowerVisible[idx - 1] : ' ';
      const after =
        idx + lowerValue.length < lowerVisible.length ? lowerVisible[idx + lowerValue.length] : ' ';
      const isWordBound = !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);

      if (isWordBound) {
        lastIdx = idx;
      }
      searchFrom = idx + 1;
    }

    if (lastIdx >= 0) {
      ranges.push({ start: lastIdx, end: lastIdx + lowerValue.length });
    }
  }

  if (ranges.length === 0) {
    return [<span key={0}>{visible}</span>];
  }

  // Sort ranges by start position, merge overlaps
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    if (ranges[i].start <= prev.end) {
      prev.end = Math.max(prev.end, ranges[i].end);
    } else {
      merged.push(ranges[i]);
    }
  }

  // Build spans: plain text between highlights, green for highlighted values
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const range of merged) {
    if (cursor < range.start) {
      nodes.push(<span key={key++}>{visible.slice(cursor, range.start)}</span>);
    }
    nodes.push(
      <span key={key++} className="text-green-600 font-medium">
        {visible.slice(range.start, range.end)}
      </span>
    );
    cursor = range.end;
  }

  if (cursor < visible.length) {
    nodes.push(<span key={key++}>{visible.slice(cursor)}</span>);
  }

  return nodes;
}

export function TranscriptDisplay({
  transcript,
  interimTranscript,
  isRecording,
  fieldSources,
  highlights,
}: TranscriptDisplayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new transcript
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript, interimTranscript]);

  const highlightedText = useMemo(
    () => buildHighlightedText(transcript, highlights),
    [transcript, highlights]
  );

  const sourceCount = Object.keys(fieldSources).length;
  const regexCount = Object.values(fieldSources).filter((s) => s === 'regex').length;
  const sonnetCount = Object.values(fieldSources).filter((s) => s === 'sonnet').length;

  return (
    <div className="flex flex-col rounded-lg border border-gray-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
        <h3 className="text-sm font-medium text-gray-700">Transcript</h3>
        {isRecording && sourceCount > 0 && (
          <div className="flex gap-3 text-xs text-gray-500">
            <span>
              Fields: <span className="font-medium text-gray-700">{sourceCount}</span>
            </span>
            <span>
              Regex: <span className="font-medium text-blue-600">{regexCount}</span>
            </span>
            <span>
              Sonnet: <span className="font-medium text-purple-600">{sonnetCount}</span>
            </span>
          </div>
        )}
      </div>

      {/* Transcript body */}
      <div
        ref={scrollRef}
        className={cn(
          'overflow-y-auto px-4 py-3 text-sm leading-relaxed',
          isRecording ? 'min-h-[120px] max-h-[200px]' : 'min-h-[80px] max-h-[300px]'
        )}
      >
        {transcript ? (
          <>
            {highlightedText}
            {interimTranscript && (
              <span className="italic text-gray-400"> {interimTranscript}</span>
            )}
          </>
        ) : isRecording ? (
          <span className="text-gray-400">Listening...</span>
        ) : (
          <span className="text-gray-400">Press Start Recording to begin voice capture.</span>
        )}
      </div>
    </div>
  );
}
