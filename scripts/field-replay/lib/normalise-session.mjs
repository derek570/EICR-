/**
 * normalise-session.mjs — shared normalisation layer with the TWO source
 * adapters (plan Item 1): (a) flat iOS `debug_log.jsonl` ({event, category,
 * data} records), (b) backend CloudWatch `session_full.jsonl` (mixed backend
 * rows + nested `Client log batch entry`.`client_log` envelopes). NET-NEW —
 * only the event-grouping CONCEPTS of scripts/pwa-replay/convert-session.mjs
 * are reused.
 *
 * Load-bearing rules (all pinned by tests):
 *   - CloudWatch timestamps are timezone-free second-resolution strings and
 *     are parsed as UTC (host-timezone parsing changes correlation across
 *     machines; vectors run under TZ=UTC and TZ=Europe/London incl. DST).
 *   - Every normalized event retains a stable source identity +
 *     manifest-defined source_priority (cloudwatch=0, ios=1, debug_report=2)
 *     and source_row_index. The TOTAL ordering key is
 *     (timestamp_ms, source_priority, source_row_index,
 *     private_source_fingerprint) — the first three alone are not total:
 *     multiple same-type sources (e.g. five debug reports) share a priority
 *     and can tie on local row index, leaving CLI-argument-order dependence.
 *     The fingerprint stays private; byte-identical duplicate sources are
 *     REJECTED.
 *   - Chime evidence: in the reference capture the chime is a TOP-LEVEL
 *     `message:"Client diagnostic"` row with `category:"chime_invoke"` — NOT
 *     a nested client_log event. The adapter maps that exact shape to
 *     `chime_observed` provenance (retaining `branch`).
 *   - Fallback chime→turn correlation: join by session + utterance/
 *     generation identifier when available; otherwise pair a chime with the
 *     NEXT final transcript in the same session ONLY when it precedes
 *     another chime AND falls within CHIME_CORRELATION_MAX_MS. The interval
 *     bound is EXCLUSIVE — a final transcript at exactly the bound does NOT
 *     correlate (equality goes to the non-correlating side, mirroring the
 *     at_ms_after_ask timeout-wins convention). Multiple candidates, missing
 *     boundaries, or ask-answer ambiguity = a CONVERSION FAILURE requiring a
 *     human-selected mapping recorded in the private manifest.
 */

import { rawSha256 } from './canonical-crypto.mjs';

/** Pinned (plan decision (ii)): observed chime→final-transcript gaps in the
 *  reference capture run 2–9s; 15s covers slow turns without bridging
 *  adjacent turns. Executor re-verified against the actual session before
 *  freezing fixtures (see docs/reference/field-replay-corpus.md). */
export const CHIME_CORRELATION_MAX_MS = 15000;

/** Source-type table: priority + which kinds are parsed vs hash-bound-only. */
export const SOURCE_TYPES = Object.freeze({
  cloudwatch: Object.freeze({ priority: 0, parsed: true }),
  ios: Object.freeze({ priority: 1, parsed: true }),
  debug_report: Object.freeze({ priority: 2, parsed: true }),
});

/** Parse a timezone-free second-resolution timestamp AS UTC. Accepts
 *  `YYYY-MM-DD HH:MM:SS(.mmm)?` and ISO strings with explicit zone (used
 *  as-is). Returns epoch ms or null. */
export function parseUtcTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const s = String(value).trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  // Explicit zone → trust it.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  // Timezone-free: normalize the separator and pin UTC.
  const iso = s.replace(' ', 'T');
  const t = Date.parse(`${iso}Z`);
  return Number.isNaN(t) ? null : t;
}

let nextSourceOrdinal = 0;

/**
 * Wrap one raw source file's bytes for normalisation. `fingerprint` is the
 * PRIVATE SHA-256 of the bytes (never committed — it is the 4th total-
 * ordering component and the duplicate-rejection key).
 */
export function makeSource({ type, role, path, bytes }) {
  if (!SOURCE_TYPES[type]) throw new Error(`unknown source type "${type}"`);
  return {
    type,
    role,
    path,
    bytes,
    fingerprint: rawSha256(bytes),
    priority: SOURCE_TYPES[type].priority,
    ordinal: nextSourceOrdinal++, // CLI arg order — deliberately NOT an ordering component
  };
}

function parseJsonl(bytes) {
  const rows = [];
  const text = bytes.toString('utf8');
  let i = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    i += 1;
    if (!trimmed) continue;
    try {
      rows.push({ line: i, value: JSON.parse(trimmed) });
    } catch {
      rows.push({ line: i, value: null, unparseable: true });
    }
  }
  return rows;
}

/** Adapter (b): backend CloudWatch session_full.jsonl. */
function normaliseCloudWatchRow(row) {
  const v = row.value;
  if (!v || typeof v !== 'object') return null;
  const ts = parseUtcTimestamp(v.timestamp ?? v.time ?? v['@timestamp']);
  // Chime evidence: TOP-LEVEL "Client diagnostic" + category chime_invoke.
  if (v.message === 'Client diagnostic' && v.category === 'chime_invoke') {
    return {
      kind: 'chime',
      timestamp_ms: ts,
      session_id: v.sessionId ?? v.session_id ?? null,
      utterance_id: v.utteranceId ?? v.utterance_id ?? null,
      generation_id: v.generationId ?? v.generation_id ?? null,
      branch: v.branch ?? v.data?.branch ?? null,
      raw: v,
    };
  }
  // Nested client-log envelope.
  if (v.message === 'Client log batch entry' && v.client_log && typeof v.client_log === 'object') {
    const cl = v.client_log;
    if (cl.category === 'chime_invoke' || cl.event === 'chime_invoke') {
      return {
        kind: 'chime',
        timestamp_ms: ts,
        session_id: v.sessionId ?? v.session_id ?? null,
        utterance_id: cl.data?.utteranceId ?? null,
        generation_id: cl.data?.generationId ?? null,
        branch: cl.data?.branch ?? null,
        raw: v,
      };
    }
    return {
      kind: 'client_event',
      timestamp_ms: ts,
      session_id: v.sessionId ?? v.session_id ?? null,
      category: cl.category ?? null,
      event: cl.event ?? null,
      data: cl.data ?? null,
      raw: v,
    };
  }
  // Backend rows (transcripts, tool calls, extractions, asks…).
  return {
    kind: 'backend',
    timestamp_ms: ts,
    session_id: v.sessionId ?? v.session_id ?? null,
    message: v.message ?? null,
    utterance_id: v.utteranceId ?? v.utterance_id ?? null,
    generation_id: v.generationId ?? v.generation_id ?? null,
    data: v,
    raw: v,
  };
}

/** Adapter (a): flat iOS debug_log.jsonl ({event, category, data}). The
 *  accepted filename set is documented in field-replay-corpus.md; the S3
 *  capture some docs call `ln` uses this same flat-JSONL format. */
function normaliseIosRow(row) {
  const v = row.value;
  if (!v || typeof v !== 'object') return null;
  const ts = parseUtcTimestamp(v.timestamp ?? v.data?.timestamp ?? v.at ?? null);
  const kind =
    v.category === 'chime_invoke' || v.event === 'chime_invoke' ? 'chime' : 'client_event';
  return {
    kind,
    timestamp_ms: ts,
    session_id: v.sessionId ?? v.data?.sessionId ?? null,
    utterance_id: v.data?.utteranceId ?? null,
    generation_id: v.data?.generationId ?? null,
    category: v.category ?? null,
    event: v.event ?? null,
    branch: v.data?.branch ?? null,
    data: v.data ?? null,
    raw: v,
  };
}

/** Adapter for a dr_*.json debug report (single JSON object per file). */
function normaliseDebugReport(bytes, source) {
  let v = null;
  try {
    v = JSON.parse(bytes.toString('utf8'));
  } catch {
    return [];
  }
  return [
    {
      kind: 'debug_report',
      timestamp_ms: parseUtcTimestamp(v.timestamp ?? v.created_at ?? null),
      description: v.description ?? v.issue ?? null,
      report_source: v.source ?? null,
      data: v,
      raw: v,
      source_type: source.type,
      source_priority: source.priority,
      source_fingerprint: source.fingerprint,
      source_row_index: 0,
      source_path: source.path,
    },
  ];
}

/**
 * Normalise + totally order events from ALL sources.
 * Throws on byte-identical duplicate sources. Ordering key:
 * (timestamp_ms, source_priority, source_row_index, source_fingerprint) —
 * NEVER CLI argument order (a regression supplies two same-type
 * equal-timestamp equal-row sources in both CLI orders).
 */
export function normaliseSources(sources) {
  const seen = new Map();
  for (const s of sources) {
    if (seen.has(s.fingerprint)) {
      throw new Error(
        `duplicate source rejected: ${s.path} is byte-identical to ${seen.get(s.fingerprint)}`,
      );
    }
    seen.set(s.fingerprint, s.path);
  }

  const events = [];
  for (const source of sources) {
    if (source.type === 'debug_report') {
      events.push(...normaliseDebugReport(source.bytes, source));
      continue;
    }
    const rows = parseJsonl(source.bytes);
    let rowIndex = -1;
    for (const row of rows) {
      rowIndex += 1;
      if (row.unparseable) continue;
      const ev =
        source.type === 'cloudwatch' ? normaliseCloudWatchRow(row) : normaliseIosRow(row);
      if (!ev) continue;
      ev.source_type = source.type;
      ev.source_priority = source.priority;
      ev.source_fingerprint = source.fingerprint;
      ev.source_row_index = rowIndex;
      ev.source_path = source.path;
      events.push(ev);
    }
  }

  events.sort((a, b) => {
    const ta = a.timestamp_ms ?? 0;
    const tb = b.timestamp_ms ?? 0;
    if (ta !== tb) return ta - tb;
    if (a.source_priority !== b.source_priority) return a.source_priority - b.source_priority;
    if (a.source_row_index !== b.source_row_index) return a.source_row_index - b.source_row_index;
    return a.source_fingerprint < b.source_fingerprint
      ? -1
      : a.source_fingerprint > b.source_fingerprint
        ? 1
        : 0;
  });
  return events;
}

/** Final-transcript predicate over normalized backend events. */
function isFinalTranscript(ev) {
  if (ev.kind !== 'backend') return false;
  const m = `${ev.message ?? ''}`;
  return (
    m === 'transcript' ||
    m === 'Transcript received' ||
    m === 'stage6_transcript' ||
    ev.data?.type === 'transcript' ||
    ev.data?.event === 'final_transcript'
  );
}

/**
 * Correlate chimes to turns. Identifier join FIRST (session + utterance/
 * generation id); the interval fallback only when no identifier exists.
 *
 * The fallback ORDERING conditions use the TOTAL ORDER of `events` (chime <
 * next final transcript < following chime — positions, not raw timestamps:
 * second-resolution captures put a chime and its transcript in the SAME
 * second, where row order is the only truth). The ±999ms quantisation
 * uncertainty is absorbed by the interval BOUND, never by reordering; the
 * bound itself compares timestamps and is EXCLUSIVE.
 *
 * Returns { correlations, failures } — a failure is a CONVERSION FAILURE
 * needing a human-selected mapping in the private manifest, never a guess.
 */
export function correlateChimes(events, { maxIntervalMs = CHIME_CORRELATION_MAX_MS } = {}) {
  const position = new Map(events.map((e, i) => [e, i]));
  const chimes = events.filter((e) => e.kind === 'chime');
  const transcripts = events.filter(isFinalTranscript);
  const correlations = [];
  const failures = [];

  for (const chime of chimes) {
    const chimePos = position.get(chime);
    // 1) Identifier join.
    if (chime.utterance_id || chime.generation_id) {
      const hit = transcripts.find(
        (t) =>
          (chime.utterance_id && t.utterance_id === chime.utterance_id) ||
          (chime.generation_id && t.generation_id === chime.generation_id),
      );
      if (hit) {
        correlations.push({ chime, transcript: hit, method: 'identifier', branch: chime.branch });
        continue;
      }
    }
    // 2) Interval fallback: total-order `chime < transcript < following
    //    chime`, timestamp gap strictly under the EXCLUSIVE bound. Same-
    //    session only. Final chime: bounded by the interval alone.
    const nextChimePos = chimes
      .filter(
        (c) =>
          c !== chime &&
          (c.session_id ?? null) === (chime.session_id ?? null) &&
          position.get(c) > chimePos,
      )
      .reduce((min, c) => Math.min(min, position.get(c)), Infinity);
    const candidates = transcripts.filter((t) => {
      if ((t.session_id ?? null) !== (chime.session_id ?? null)) return false;
      const tPos = position.get(t);
      if (!(tPos > chimePos)) return false;
      if (!(tPos < nextChimePos)) return false;
      // EXCLUSIVE timestamp bound: a transcript at exactly the bound does
      // NOT correlate (equality goes to the non-correlating side).
      if (!(t.timestamp_ms - chime.timestamp_ms < maxIntervalMs)) return false;
      return true;
    });
    if (candidates.length === 1) {
      correlations.push({
        chime,
        transcript: candidates[0],
        method: 'interval',
        branch: chime.branch,
      });
    } else {
      failures.push({
        chime,
        reason: candidates.length === 0 ? 'no_candidate' : 'ambiguous_candidates',
        candidate_count: candidates.length,
      });
    }
  }
  return { correlations, failures };
}

/** Test-only: reset the CLI-order ordinal counter. */
export function _resetSourceOrdinals() {
  nextSourceOrdinal = 0;
}
