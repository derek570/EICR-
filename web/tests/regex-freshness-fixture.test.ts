/**
 * A02D — shared raw-final vectors fixture `config/regex-freshness-vectors.json`
 * (RegexFreshOccurrenceV1 + FinalWindowV1 + held-fragment clarification).
 *
 * (1) Byte pin: the fixture's SHA-256 is pinned here; iOS pins the same
 *     bytes and `scripts/check-regex-freshness-fixture-sync.sh` fails closed
 *     on drift. Change the fixture → update BOTH pins in the same commit.
 * (2) Source-of-truth equality: field labels and clarification templates in
 *     the web source are byte-equal to the fixture.
 * (3) Executable vectors, through the REAL matcher, the REAL apply layer and
 *     the real freshness/hold logic, in BOTH lanes (hints ON: job writes;
 *     hints OFF: `computeFreshRegexWrites` + shadow, zero job writes).
 * (4) FinalWindowV1 confirmation-rule vectors through `SpeechOnsetTracker`.
 * (5) Normalisation source-map vectors through the matcher's own normaliser.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  AdmittedBuffer,
  DESTINATION_FIELD_LABELS,
  OccurrenceFreshnessStore,
  applyOccurrenceFreshness,
  describeDestination,
  destinationKeyFromChangedKey,
  normaliseWindowWithSourceMap,
  type OccurrenceCandidate,
} from '@/lib/recording/regex-fresh-occurrence';
import {
  ONSET_CONFIRMATION_WINDOW_MS,
  SpeechOnsetTracker,
  buildFinalWindow,
  resolveWindowEnd,
  type FinalWindowV1,
} from '@/lib/recording/final-window';
import {
  HELD_FRAGMENT_CLARIFICATION_MANY_TEXT,
  HELD_FRAGMENT_CLARIFICATION_NAMED_TEMPLATE,
  renderHeldFragmentClarification,
} from '@/lib/recording/held-fragment-clarification';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import {
  applyRegexMatchToJob,
  computeFreshRegexWrites,
  shadowBaselineReader,
} from '@/lib/recording/apply-regex-match';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
import { normalise as normaliseTranscriptText } from '@/lib/recording/number-normaliser';
import type { ConnectionEpoch } from '@/lib/recording/uplink-scope-allocator';
import type { JobDetail, CircuitRow } from '@/lib/types';

const require = createRequire(import.meta.url);
const FIXTURE_PATH = require.resolve('../../config/regex-freshness-vectors.json');
export const REGEX_FRESHNESS_FIXTURE_SHA256 =
  'd0f71c86b9f0b1838ac5be387ca3fce96e64f5783052224bc06ed0b6d8c2661b';

interface FixtureJob {
  circuits: Array<{ ref: string; designation: string; board_id?: string }>;
  boards?: Array<{ id: string; designation: string; slug: string }>;
}
interface FinalStep {
  kind: 'final';
  id: string;
  text: string;
  epoch: number;
  speech_start: number | null;
  window_end: number | null;
  session?: string;
  expect: {
    admitted: boolean;
    held: boolean;
    writes: Array<{ destination: string; value: string }>;
    clarification: string | null;
    job_value?: Record<string, string | null>;
    occurrence_fragments?: Record<string, string[]>;
    ask_pending?: boolean;
    bounded?: boolean;
  };
}
type Step =
  | FinalStep
  | {
      kind: 'manual_clear' | 'manual_replace' | 'rejected_clear';
      destination: string;
      epoch: number;
      dispatched_offset: number;
      value?: string;
    }
  | {
      kind: 'server_clear' | 'server_replace';
      destination: string;
      causative: string;
      value?: string;
      expect?: { buffer_cutoff?: string };
    }
  | { kind: 'reconnect'; epoch: number }
  | { kind: 'new_session'; session: string; epoch: number }
  | { kind: 'bypass_final'; text: string }
  | { kind: 'open_ask'; question: string };
interface Sequence {
  id: string;
  description: string;
  job: FixtureJob;
  steps: Step[];
  lanes: Array<'hints_on' | 'hints_off'>;
}
interface Fixture {
  version: number;
  constants: Record<string, number>;
  field_labels: Record<string, Record<string, string>>;
  clarification_templates: { named: string; many: string };
  clarification_render_vectors: Array<{ destinations: string[]; expected: string }>;
  normalisation_source_map_vectors: Array<{
    id: string;
    raw: string;
    raw_value_text: string;
    normalised_value: string;
    ambiguous: boolean;
  }>;
  final_window_vectors: Array<{
    id: string;
    onset: { at_ms: number; dispatched_offset: number };
    events: Array<
      | { at_ms: number; kind: 'start_of_turn' | 'silence' }
      | { at_ms: number; kind: 'interim'; text: string }
      | { at_ms: number; kind: 'onset'; dispatched_offset: number }
      | { at_ms: number; kind: 'end_of_turn'; window_end_s: number }
    >;
    expect_speech_start: number | null;
    expect_window_end: number | null;
  }>;
  freshness_sequences: Sequence[];
}

const bytes = readFileSync(FIXTURE_PATH);
const fixture: Fixture = JSON.parse(bytes.toString('utf8'));

// ── job + destination helpers ────────────────────────────────────────────

function buildJob(fj: FixtureJob): JobDetail {
  const circuits: CircuitRow[] = fj.circuits.map((c) => ({
    id: `row_${c.ref}${c.board_id ? `_${c.board_id}` : ''}`,
    circuit_ref: c.ref,
    circuit_designation: c.designation,
    ...(c.board_id ? { board_id: c.board_id } : {}),
  }));
  return {
    id: 'job_a02d',
    job_id: 'job_a02d',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits,
    boards: fj.boards ?? undefined,
    supply_characteristics: {},
    board_info: {},
    installation_details: {},
  } as unknown as JobDetail;
}

/** `circuit:<ref>:<field>[@<board_slug>]` | `supply:<f>` | `board:<f>` | `install:<f>` → tracker key. */
function destinationKey(dest: string, job: JobDetail): string {
  const [scope, ...rest] = dest.split(':');
  if (scope !== 'circuit') return `${scope}.${rest.join(':')}`;
  const [ref, fieldAndBoard] = rest;
  const [field, boardSlug] = fieldAndBoard.split('@');
  const rows = (job.circuits ?? []).filter((c) => c.circuit_ref === ref);
  let row = rows[0];
  if (boardSlug) {
    const board = (job.boards ?? []).find((b) => (b as { slug?: string }).slug === boardSlug);
    row =
      rows.find((c) => (c as { board_id?: string }).board_id === (board as { id?: string })?.id) ??
      row;
  }
  if (!row) throw new Error(`no circuit row for ${dest}`);
  return `circuit.${row.id}.${field}`;
}

const SECTION: Record<string, keyof JobDetail> = {
  supply: 'supply_characteristics',
  board: 'board_info',
  install: 'installation_details',
};

function readDestination(job: JobDetail, key: string): string | null {
  if (key.startsWith('circuit.')) {
    const rest = key.slice('circuit.'.length);
    const dot = rest.lastIndexOf('.');
    const row = (job.circuits ?? []).find((c) => c.id === rest.slice(0, dot));
    const v = row ? (row as Record<string, unknown>)[rest.slice(dot + 1)] : undefined;
    return v == null || v === '' ? null : String(v);
  }
  const dot = key.indexOf('.');
  const section = job[SECTION[key.slice(0, dot)]] as Record<string, unknown> | undefined;
  const v = section?.[key.slice(dot + 1)];
  return v == null || v === '' ? null : String(v);
}

function writeDestination(job: JobDetail, key: string, value: string | null): JobDetail {
  if (key.startsWith('circuit.')) {
    const rest = key.slice('circuit.'.length);
    const dot = rest.lastIndexOf('.');
    const rowId = rest.slice(0, dot);
    const field = rest.slice(dot + 1);
    return {
      ...job,
      circuits: (job.circuits ?? []).map((c) =>
        c.id === rowId ? { ...c, [field]: value ?? '' } : c
      ),
    };
  }
  const dot = key.indexOf('.');
  const sectionName = SECTION[key.slice(0, dot)];
  const section = { ...((job[sectionName] as Record<string, unknown>) ?? {}) };
  section[key.slice(dot + 1)] = value ?? '';
  return { ...job, [sectionName]: section } as JobDetail;
}

// ── the module-level runner (real matcher + real apply layer) ────────────

/** Hints-OFF companion of a boundary (mirrors `noteShadowBoundaryRef` in
 *  recording-context): forget a cleared destination, adopt a replacement. */
function noteShadow(shadow: Map<string, unknown>, key: string, value: string | null): void {
  if (value == null || value === '') shadow.delete(key);
  else shadow.set(key, value);
}

function runSequence(seq: Sequence, lane: 'hints_on' | 'hints_off'): void {
  const baseJob = buildJob(seq.job);
  let job = baseJob;
  let matcher = new TranscriptFieldMatcher();
  let buffer = new AdmittedBuffer();
  let store = new OccurrenceFreshnessStore();
  let tracker = new FieldSourceTracker();
  tracker.seedFromJob(job);
  let shadow = new Map<string, unknown>();
  let sequence = 0;
  let currentEpoch = 1;
  let session = 'S1';
  const seqById = new Map<string, number>();
  const finalById = new Map<string, FinalWindowV1>();
  let askPending = false;
  const trace: string[] = [];

  for (const step of seq.steps) {
    const at = `${seq.id}/${lane}/${'id' in step ? step.id : step.kind}`;
    switch (step.kind) {
      case 'final': {
        const admitted = step.epoch === currentEpoch && (step.session ?? session) === session;
        expect(admitted, `${at} admitted`).toBe(step.expect.admitted);
        if (!admitted) break;
        const final = buildFinalWindow({
          recordingSessionId: session,
          epoch: step.epoch as ConnectionEpoch,
          finalSequence: ++sequence,
          speechStart: step.speech_start,
          windowEnd: step.window_end,
        });
        store.recordFinal(final);
        seqById.set(step.id, final.finalSequence);
        finalById.set(step.id, final);
        const hold = store.holdDecision([final]);
        expect(hold.held, `${at} held`).toBe(step.expect.held);
        if (hold.held) {
          expect(renderHeldFragmentClarification(hold.destinations), `${at} clarification`).toBe(
            step.expect.clarification
          );
          if (step.expect.ask_pending !== undefined)
            expect(askPending, `${at} ask`).toBe(step.expect.ask_pending);
          break;
        }
        expect(step.expect.clarification, `${at} no clarification`).toBeNull();
        store.noteAccepted([final]);
        if (askPending) askPending = false;
        if (step.expect.ask_pending !== undefined)
          expect(askPending, `${at} ask`).toBe(step.expect.ask_pending);
        const text = normaliseTranscriptText(step.text);
        const fragment = buffer.append(text, [final], final.epoch);
        const raw = matcher.match(buffer.text, job);
        const fresh = applyOccurrenceFreshness(raw, buffer, fragment, job, store);
        const writes: Array<{ destination: string; value: string }> = [];
        if (lane === 'hints_on') {
          const applied = applyRegexMatchToJob(job, fresh.result, tracker);
          tracker.consumeTurnWrites();
          if (applied) {
            const merged = { ...job, ...(applied.patch as Partial<JobDetail>) } as JobDetail;
            for (const changed of applied.changedKeys) {
              const key = destinationKeyFromChangedKey(changed);
              if (!key) continue;
              writes.push({ destination: key, value: readDestination(merged, key) ?? '' });
            }
            job = merged;
          }
        } else {
          const candidates = computeFreshRegexWrites(
            job,
            fresh.result,
            tracker,
            shadowBaselineReader(shadow)
          );
          for (const c of candidates) {
            shadow.set(c.trackerKey, c.value);
            writes.push({ destination: c.trackerKey, value: String(c.value) });
          }
          expect(job, `${at} hints-off never writes the job`).toBe(job);
        }
        const expected = step.expect.writes
          .map((w) => ({ destination: destinationKey(w.destination, job), value: w.value }))
          .sort((a, b) => a.destination.localeCompare(b.destination));
        writes.sort((a, b) => a.destination.localeCompare(b.destination));
        expect(writes, `${at} writes (decisions: ${JSON.stringify([...fresh.decisions])})`).toEqual(
          expected
        );
        if (step.expect.job_value && lane === 'hints_on') {
          for (const [dest, value] of Object.entries(step.expect.job_value)) {
            expect(readDestination(job, destinationKey(dest, job)), `${at} job value ${dest}`).toBe(
              value
            );
          }
        }
        if (step.expect.occurrence_fragments) {
          for (const [dest, finalIds] of Object.entries(step.expect.occurrence_fragments)) {
            const key = destinationKey(dest, job);
            const candidate = fresh.candidates.find(
              (c: OccurrenceCandidate) => c.destination === key
            );
            expect(candidate, `${at} candidate ${dest}`).toBeDefined();
            const contributing = candidate!.finals.map((f) => f.finalSequence).sort();
            const expectedSeqs = finalIds.map((id) => seqById.get(id)!).sort();
            expect(contributing, `${at} contributing finals`).toEqual(expectedSeqs);
          }
        }
        const trimmed = buffer.trimIfNeeded();
        if (trimmed > 0) {
          matcher.shiftProcessedOffset(trimmed);
          const retained = buffer.fragments;
          store.evict(
            buffer.baseOffset,
            retained.length ? Math.min(...retained.map((f) => f.finalSequence)) : null,
            new Set<ConnectionEpoch>([
              ...retained.map((f) => f.epoch),
              currentEpoch as ConnectionEpoch,
            ])
          );
        }
        if (step.expect.bounded) {
          expect(buffer.text.length, `${at} buffer bounded`).toBeLessThanOrEqual(2400);
          expect(store.retainedRecordCount, `${at} records bounded`).toBeLessThanOrEqual(
            3 * sequence + 8
          );
        }
        trace.push(`${step.id}:${writes.length}`);
        break;
      }
      case 'manual_clear':
      case 'manual_replace': {
        const key = destinationKey(step.destination, job);
        const next = writeDestination(
          job,
          key,
          step.kind === 'manual_clear' ? null : (step.value ?? null)
        );
        const label = describeDestination(key, next) ?? describeDestination(key, job) ?? key;
        store.recordManualCutoff(key, label, {
          epoch: step.epoch as ConnectionEpoch,
          dispatchedOffset: step.dispatched_offset,
          bufferOffset: buffer.head,
          bufferFinalSequence: sequence > 0 ? sequence : null,
        });
        job = next;
        noteShadow(shadow, key, readDestination(job, key));
        break;
      }
      case 'rejected_clear':
        break;
      case 'server_clear':
      case 'server_replace': {
        const key = destinationKey(step.destination, job);
        const causative = seqById.get(step.causative) ?? null;
        store.recordUtteranceCutoff(key, causative);
        job = writeDestination(
          job,
          key,
          step.kind === 'server_clear' ? null : (step.value ?? null)
        );
        noteShadow(shadow, key, readDestination(job, key));
        if (step.expect?.buffer_cutoff) {
          expect(store.bufferCutoffFor(key), `${at} buffer cutoff`).toBe(
            seqById.get(step.expect.buffer_cutoff)
          );
        }
        break;
      }
      case 'reconnect':
        currentEpoch = step.epoch;
        break;
      case 'new_session':
        session = step.session;
        currentEpoch = step.epoch;
        store = new OccurrenceFreshnessStore();
        buffer = new AdmittedBuffer();
        matcher = new TranscriptFieldMatcher();
        tracker = new FieldSourceTracker();
        tracker.seedFromJob(job);
        shadow = new Map();
        sequence = 0;
        break;
      case 'bypass_final':
        buffer.resetText();
        matcher.reset();
        shadow = new Map();
        break;
      case 'open_ask':
        askPending = true;
        break;
    }
  }
}

// ── tests ────────────────────────────────────────────────────────────────

describe('config/regex-freshness-vectors.json — byte pin and source equality', () => {
  it('pins the fixture bytes (update the iOS copy and this pin together)', () => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(digest).toBe(REGEX_FRESHNESS_FIXTURE_SHA256);
    expect(fixture.version).toBe(1);
  });

  it('field labels are byte-equal to DESTINATION_FIELD_LABELS', () => {
    expect(fixture.field_labels).toEqual(DESTINATION_FIELD_LABELS);
  });

  it('clarification templates and constants match the web source', () => {
    expect(fixture.clarification_templates.named).toBe(HELD_FRAGMENT_CLARIFICATION_NAMED_TEMPLATE);
    expect(fixture.clarification_templates.many).toBe(HELD_FRAGMENT_CLARIFICATION_MANY_TEXT);
    expect(fixture.constants.onset_confirmation_window_ms).toBe(ONSET_CONFIRMATION_WINDOW_MS);
    expect(fixture.constants.clarification_max_named_destinations).toBe(3);
  });

  it('renders every clarification vector exactly', () => {
    for (const v of fixture.clarification_render_vectors) {
      expect(renderHeldFragmentClarification(v.destinations), v.destinations.join('|')).toBe(
        v.expected
      );
    }
  });
});

describe('normalisation source map — shared vectors', () => {
  for (const v of fixture.normalisation_source_map_vectors) {
    it(v.id, () => {
      const sm = normaliseWindowWithSourceMap(v.raw);
      const idx = sm.normalised.indexOf(v.normalised_value);
      expect(idx, `normalised "${sm.normalised}" contains "${v.normalised_value}"`).toBeGreaterThan(
        -1
      );
      const mapped = sm.mapSpan(idx, idx + v.normalised_value.length);
      expect(mapped.ambiguous).toBe(v.ambiguous);
      const rawText = v.raw.slice(mapped.rawStart, mapped.rawEnd);
      expect(rawText, `raw span "${rawText}"`).toContain(v.raw_value_text);
      // Unique origin inside the raw window (adjacent changed tokens may
      // widen the span — e.g. "thirty two milliseconds" → "32 ms" — but it
      // never spills outside the window).
      expect(mapped.rawStart).toBeGreaterThanOrEqual(0);
      expect(mapped.rawEnd).toBeLessThanOrEqual(v.raw.length);
    });
  }
});

describe('FinalWindowV1 — onset confirmation vectors', () => {
  for (const v of fixture.final_window_vectors) {
    it(v.id, () => {
      const tracker = new SpeechOnsetTracker();
      tracker.onOnset(v.onset.dispatched_offset, v.onset.at_ms);
      let speechStart: number | null | undefined;
      let windowEnd: number | null | undefined;
      for (const e of v.events) {
        if (e.kind === 'start_of_turn') tracker.onProviderSpeechEvidence(e.at_ms);
        else if (e.kind === 'interim') {
          if (e.text !== '') tracker.onProviderSpeechEvidence(e.at_ms);
        } else if (e.kind === 'silence') tracker.onSilence();
        else if (e.kind === 'onset') tracker.onOnset(e.dispatched_offset, e.at_ms);
        else if (e.kind === 'end_of_turn') {
          speechStart = tracker.currentSpeechStart(e.at_ms);
          windowEnd = resolveWindowEnd(e.window_end_s, 0);
        }
      }
      expect(speechStart).toBe(v.expect_speech_start);
      expect(windowEnd).toBe(v.expect_window_end);
    });
  }
});

describe('freshness sequences — real matcher + real apply layer, both lanes', () => {
  for (const seq of fixture.freshness_sequences) {
    for (const lane of seq.lanes) {
      it(`${seq.id} [${lane}]`, () => {
        runSequence(seq, lane);
      });
    }
  }
});
