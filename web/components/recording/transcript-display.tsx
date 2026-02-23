"use client";

import { useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";

interface TranscriptDisplayProps {
  transcript: string;
  interimTranscript: string;
  isRecording: boolean;
  fieldSources: Record<string, "regex" | "sonnet" | "preExisting">;
}

/** Keywords that should be highlighted blue in the transcript */
const HIGHLIGHT_KEYWORDS = [
  "Ze",
  "Zs",
  "PFC",
  "R1",
  "R2",
  "Rn",
  "RCD",
  "MCB",
  "RCBO",
  "AFDD",
  "IR",
  "CPC",
  "insulation resistance",
  "ring continuity",
  "loop impedance",
  "polarity",
  "trip time",
  "cable size",
  "wiring type",
  "ref method",
  "reference method",
  "number of points",
  "circuit",
  "bonding",
  "earthing",
  "earth rod",
  "client",
  "customer",
  "address",
  "postcode",
];

/**
 * Build highlighted spans from the visible tail of the transcript.
 * Keywords are blue, numeric values after keywords are green.
 */
function buildHighlightedText(text: string): React.ReactNode[] {
  if (!text) return [];

  // Show last 300 chars for performance
  const visible = text.length > 300 ? text.slice(-300) : text;
  const nodes: React.ReactNode[] = [];
  let remaining = visible;
  let key = 0;

  while (remaining.length > 0) {
    let earliestMatch: { index: number; length: number; type: "keyword" | "value" } | null = null;

    // Find earliest keyword match
    for (const kw of HIGHLIGHT_KEYWORDS) {
      const idx = remaining.toLowerCase().indexOf(kw.toLowerCase());
      if (idx !== -1 && (!earliestMatch || idx < earliestMatch.index)) {
        earliestMatch = { index: idx, length: kw.length, type: "keyword" };
      }
    }

    if (!earliestMatch) {
      nodes.push(<span key={key++}>{remaining}</span>);
      break;
    }

    // Text before match
    if (earliestMatch.index > 0) {
      nodes.push(<span key={key++}>{remaining.slice(0, earliestMatch.index)}</span>);
    }

    // The keyword
    const matchText = remaining.slice(
      earliestMatch.index,
      earliestMatch.index + earliestMatch.length,
    );
    nodes.push(
      <span key={key++} className="text-blue-600 font-medium">
        {matchText}
      </span>,
    );

    // Check for numeric value immediately after keyword
    const afterKeyword = remaining.slice(
      earliestMatch.index + earliestMatch.length,
    );
    const valueMatch = afterKeyword.match(
      /^(\s+(?:is\s+)?)(>?\d+\.?\d*(?:\s*(?:M\u03A9|\u03A9|mA|ms|mm\u00B2|ohms|megohms))?)/i,
    );
    if (valueMatch) {
      // Whitespace/connector
      nodes.push(<span key={key++}>{valueMatch[1]}</span>);
      // Value in green
      nodes.push(
        <span key={key++} className="text-green-600 font-medium">
          {valueMatch[2]}
        </span>,
      );
      remaining = afterKeyword.slice(valueMatch[0].length);
    } else {
      remaining = afterKeyword;
    }
  }

  return nodes;
}

export function TranscriptDisplay({
  transcript,
  interimTranscript,
  isRecording,
  fieldSources,
}: TranscriptDisplayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new transcript
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript, interimTranscript]);

  const highlightedText = useMemo(
    () => buildHighlightedText(transcript),
    [transcript],
  );

  const sourceCount = Object.keys(fieldSources).length;
  const regexCount = Object.values(fieldSources).filter(
    (s) => s === "regex",
  ).length;
  const sonnetCount = Object.values(fieldSources).filter(
    (s) => s === "sonnet",
  ).length;

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
          "overflow-y-auto px-4 py-3 text-sm leading-relaxed",
          isRecording ? "min-h-[120px] max-h-[200px]" : "min-h-[80px] max-h-[300px]",
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
          <span className="text-gray-400">
            Press Start Recording to begin voice capture.
          </span>
        )}
      </div>
    </div>
  );
}
