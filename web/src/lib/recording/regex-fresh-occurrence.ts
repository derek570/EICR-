/**
 * RegexFreshOccurrenceV1 (A02D, 2026-09-09) — freshness is a property of
 * TRANSCRIPT OCCURRENCES, never of audio samples and never of field/value
 * output.
 *
 * The client regex matcher deliberately rescans an ~800-character overlap
 * of the cumulative transcript on every final (cross-final completion,
 * ring-continuity carryover). Pre-A02D the apply layer decided freshness by
 * value equality against the job, so a value cleared or corrected AFTER its
 * first match was silently restored by the next unrelated final's rescan
 * (the destination was empty, or held a different value, so the old text
 * "looked fresh"). iOS had the same bug through `applyRegexValue`'s
 * fill-empty rule.
 *
 * This module owns:
 *
 *  - `AdmittedBuffer` — the cumulative matcher text as a list of admitted
 *    FRAGMENTS, each with a stable id, its epoch, its final sequence and its
 *    ABSOLUTE raw span. Absolute positions are session-monotonic: an A02B
 *    bypass reset or a front-trim never reuses a position.
 *  - `normaliseWindowWithSourceMap` — the matcher's normalisation with a
 *    token-aligned SOURCE MAP from every transformed span back to a unique
 *    raw span. An ambiguously mapped span is client-regex-ineligible.
 *  - `OccurrenceFreshnessStore` — settled occurrence identities
 *    (destination + absolute raw span + contributing fragments), destination
 *    cutoffs (utterance-driven buffer cutoffs; manual tap-sampled buffer AND
 *    dispatched-stream cutoffs), the fragment-wide HOLD decision, and the
 *    bounded eviction watermark.
 *
 * Evaluation ORDER is the contract: a candidate is judged settled/stale
 * BEFORE `applyRegexMatchToJob` / `computeFreshRegexWrites` /
 * `valuesEqualAfterTrim` / ownership / empty-destination checks. Only a
 * fresh or newly completed occurrence reaches those gates.
 *
 * Canonical prose: A02D `PLAN-final.md` §§ RegexFreshOccurrenceV1, "Clear and
 * replacement cutoffs", "Forwarding eligibility". Shared executable vectors:
 * `config/regex-freshness-vectors.json` (byte-pinned on both clients).
 */
import type { ConnectionEpoch } from './uplink-scope-allocator';
import type { FinalWindowV1 } from './final-window';
import type { JobDetail } from '../types';
import type { RegexMatchResult, CircuitUpdates } from './regex-match-result';
import { normaliseBeforeMatch, normalizeTranscript } from './transcript-field-matcher';
import { buildSourceMap, type SourceMap } from './normalisation-source-map';
import { resolveRegexDestination, routeSectionField } from './regex-destination-routing';

export type { SourceMap, RawSpanMapping } from './normalisation-source-map';
export type { RawOccurrence } from './regex-match-result';

// ── Admitted buffer ──────────────────────────────────────────────────────

export interface AdmittedFragment {
  readonly id: string;
  readonly epoch: ConnectionEpoch;
  /** The MAX original constituent final sequence when a burst/naming
   *  buffer released several finals as one admitted unit. */
  readonly finalSequence: number;
  /** Absolute raw span in the session's admitted-buffer domain. */
  readonly rawStart: number;
  readonly rawEnd: number;
  /** Every final the fragment was assembled from (single or concatenated). */
  readonly finals: readonly FinalWindowV1[];
}

/** Front-trim threshold/keep sizes — three and one-and-a-half matcher
 *  windows. The matcher's own 800-char overlap plus its 60-char sentence
 *  snap is always inside the retained tail. */
export const ADMITTED_BUFFER_TRIM_THRESHOLD = 2400;
export const ADMITTED_BUFFER_KEEP_CHARS = 1200;

export class AdmittedBuffer {
  private textValue = '';
  private fragmentList: AdmittedFragment[] = [];
  /** Absolute offset of `textValue[0]`. */
  private base = 0;
  private nextFragmentId = 1;

  /** The text the matcher consumes (normalised finals joined by the
   *  dispatch's own separator). */
  get text(): string {
    return this.textValue;
  }
  get baseOffset(): number {
    return this.base;
  }
  /** Absolute position just past the last admitted character. */
  get head(): number {
    return this.base + this.textValue.length;
  }
  get fragments(): readonly AdmittedFragment[] {
    return this.fragmentList;
  }
  get lastFinalSequence(): number | null {
    const last = this.fragmentList[this.fragmentList.length - 1];
    return last ? last.finalSequence : null;
  }

  /** Append one admitted unit. `separator` is what the dispatch itself used
   *  between constituents (' ' for a naming concat, ' ... ' for a burst
   *  concat) — the buffer adds a single ' ' before the unit exactly as the
   *  pre-A02D cumulative string did. */
  append(text: string, finals: readonly FinalWindowV1[], epoch: ConnectionEpoch): AdmittedFragment {
    const sep = this.textValue ? ' ' : '';
    const rawStart = this.head + sep.length;
    this.textValue += sep + text;
    const fragment: AdmittedFragment = {
      id: `frag_${this.nextFragmentId++}`,
      epoch,
      finalSequence: Math.max(...finals.map((f) => f.finalSequence)),
      rawStart,
      rawEnd: rawStart + text.length,
      finals,
    };
    this.fragmentList.push(fragment);
    return fragment;
  }

  /** Fragments overlapping the absolute span `[start, end)`. */
  fragmentsIn(start: number, end: number): AdmittedFragment[] {
    return this.fragmentList.filter((f) => f.rawStart < end && f.rawEnd > start);
  }

  /** A02B bypass boundary / job change: drop the matcher TEXT only. Absolute
   *  positions keep advancing so settled identities never collide. */
  resetText(): void {
    this.base = this.head;
    this.textValue = '';
    this.fragmentList = [];
  }

  /** Front-trim at a fragment boundary once the text outgrows
   *  `ADMITTED_BUFFER_TRIM_THRESHOLD`, keeping at least
   *  `ADMITTED_BUFFER_KEEP_CHARS`. Returns the number of characters removed
   *  (the caller shifts the matcher's cursor by the same amount). */
  trimIfNeeded(): number {
    if (this.textValue.length <= ADMITTED_BUFFER_TRIM_THRESHOLD) return 0;
    const keepFrom = this.head - ADMITTED_BUFFER_KEEP_CHARS;
    // The LAST fragment that starts at or before `keepFrom` becomes the new
    // head of the retained text (so at least KEEP chars survive); everything
    // before it is evicted whole.
    let idx = -1;
    for (let i = 0; i < this.fragmentList.length; i++) {
      if (this.fragmentList[i].rawStart <= keepFrom) idx = i;
      else break;
    }
    if (idx <= 0) return 0;
    const cut = this.fragmentList[idx].rawStart - this.base;
    this.textValue = this.textValue.slice(cut);
    this.fragmentList = this.fragmentList.slice(idx);
    this.base += cut;
    return cut;
  }
}

/** The matcher's exact normalisation (`normaliseBeforeMatch` then
 *  `normalizeTranscript`) plus the source map from the result back to
 *  `window`. Provenance is produced AT normalisation time, never
 *  reconstructed from output. */
export function normaliseWindowWithSourceMap(window: string): SourceMap {
  const normalised = normalizeTranscript(normaliseBeforeMatch(window));
  return buildSourceMap(window, normalised);
}

// ── Destinations and labels ──────────────────────────────────────────────

/** Spoken labels for every regex-writable destination field. Pinned
 *  byte-equal to `config/regex-freshness-vectors.json` `field_labels` by
 *  `web/tests/regex-freshness-fixture.test.ts`. */
export const DESTINATION_FIELD_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    circuit: {
      measured_zs_ohm: 'Zs',
      r1_r2_ohm: 'R1 plus R2',
      ring_r1_ohm: 'ring r1',
      ring_rn_ohm: 'ring rn',
      ring_r2_ohm: 'ring r2',
      ir_live_earth_mohm: 'insulation resistance live to earth',
      ir_live_live_mohm: 'insulation resistance live to live',
      rcd_time_ms: 'RCD trip time',
      ocpd_rating_a: 'OCPD rating',
      ocpd_type: 'OCPD type',
      ocpd_bs_en: 'OCPD BS EN',
      polarity_confirmed: 'polarity',
      rcd_button_confirmed: 'RCD button',
      afdd_button_confirmed: 'AFDD button',
      live_csa_mm2: 'live conductor size',
      cpc_csa_mm2: 'CPC size',
      number_of_points: 'number of points',
      wiring_type: 'wiring type',
      ref_method: 'reference method',
      rcd_type: 'RCD type',
    },
    supply: {
      ze: 'Ze',
      pfc: 'PFC',
      earthing_arrangement: 'earthing arrangement',
      supply_polarity_confirmed: 'supply polarity',
      main_earth_csa: 'main earth size',
      bonding_csa: 'bonding size',
      bonding_water: 'water bonding',
      bonding_gas: 'gas bonding',
      main_bonding_continuity: 'main bonding continuity',
      earth_electrode_type: 'earth electrode type',
      earth_electrode_resistance: 'earth electrode resistance',
      nominal_voltage: 'nominal voltage',
      nominal_frequency: 'nominal frequency',
    },
    board: {
      main_switch_bs_en: 'main switch BS EN',
      main_switch_current: 'main switch rating',
      main_switch_conductor_csa: 'main switch conductor size',
      spd_bs_en: 'SPD BS EN',
      spd_rated_current: 'SPD rated current',
      manufacturer: 'board manufacturer',
      ze_at_db: 'Ze at the board',
    },
    install: {
      client_name: 'client name',
      premises_description: 'premises description',
      next_inspection_years: 'next inspection',
      client_phone: 'client phone',
      client_email: 'client email',
      reason_for_report: 'reason for report',
      occupier_name: 'occupier name',
      date_of_previous_inspection: 'date of previous inspection',
      previous_certificate_number: 'previous certificate number',
      estimated_age_of_installation: 'estimated age',
      general_condition_of_installation: 'general condition',
      date_of_inspection: 'date of inspection',
    },
  };

/** Parse a tracker key (`supply.<f>`, `board.<f>`, `install.<f>`,
 *  `circuit.<rowId>.<f>`). Row ids may contain dots, so the circuit form is
 *  split on the LAST dot. */
export function parseTrackerKey(
  key: string
):
  | { scope: 'supply' | 'board' | 'install'; field: string }
  | { scope: 'circuit'; rowId: string; field: string }
  | null {
  if (key.startsWith('circuit.')) {
    const rest = key.slice('circuit.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) return null;
    return { scope: 'circuit', rowId: rest.slice(0, dot), field: rest.slice(dot + 1) };
  }
  const dot = key.indexOf('.');
  if (dot <= 0) return null;
  const scope = key.slice(0, dot);
  if (scope !== 'supply' && scope !== 'board' && scope !== 'install') return null;
  return { scope, field: key.slice(dot + 1) };
}

/**
 * Labels keyed by the ROUTED (canonical, id-based) tracker key's
 * `<scope>.<fieldKey>`. `DESTINATION_FIELD_LABELS` is keyed by the matcher's
 * own field names (the shared fixture pins those bytes); the apply router
 * stores some of them elsewhere (`supply.main_switch_*` → `board.*`,
 * `install.general_condition_of_installation` → `install.general_condition`),
 * so every consumer that holds a canonical key looks its label up here.
 */
const LABEL_BY_CANONICAL_SECTION_KEY: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const scope of ['supply', 'board', 'install'] as const) {
    for (const [matcherField, label] of Object.entries(DESTINATION_FIELD_LABELS[scope])) {
      out.set(routeSectionField(scope, matcherField).trackerKey, label);
    }
  }
  return out;
})();

/** Canonical section destination keys per scope (for diffing snapshots). */
const CANONICAL_SECTION_FIELDS: Readonly<
  Record<'supply' | 'board' | 'install', readonly string[]>
> = (() => {
  const by: Record<'supply' | 'board' | 'install', string[]> = {
    supply: [],
    board: [],
    install: [],
  };
  for (const key of LABEL_BY_CANONICAL_SECTION_KEY.keys()) {
    const parsed = parseTrackerKey(key);
    if (parsed && parsed.scope !== 'circuit' && !by[parsed.scope].includes(parsed.field))
      by[parsed.scope].push(parsed.field);
  }
  return by;
})();

function labelForCanonical(key: string): string | null {
  const parsed = parseTrackerKey(key);
  if (!parsed) return null;
  if (parsed.scope === 'circuit') return DESTINATION_FIELD_LABELS.circuit[parsed.field] ?? null;
  return LABEL_BY_CANONICAL_SECTION_KEY.get(`${parsed.scope}.${parsed.field}`) ?? null;
}

/** True iff the (canonical, id-based) key names a destination the client
 *  regex can write. */
export function isRegexDestinationKey(key: string): boolean {
  return labelForCanonical(key) !== null;
}

function boardNameFor(job: JobDetail, boardId: unknown): string | null {
  if (typeof boardId !== 'string' || !boardId) return null;
  const boards = job.boards ?? [];
  const board = boards.find((b) => (b as { id?: unknown }).id === boardId);
  if (!board) return null;
  const b = board as Record<string, unknown>;
  const name = b.designation ?? b.name ?? b.slug;
  return typeof name === 'string' && name ? name : null;
}

/** The spoken destination phrase from the client's OWN records: the
 *  canonical field label, the board name when the job has more than one
 *  board, and the stored circuit reference exactly as displayed ("1a"
 *  included). */
export function describeDestination(key: string, job: JobDetail): string | null {
  const parsed = parseTrackerKey(key);
  if (!parsed) return null;
  const label = labelForCanonical(key);
  if (!label) return null;
  if (parsed.scope !== 'circuit') return label;
  const row = (job.circuits ?? []).find((c) => c.id === parsed.rowId);
  if (!row) return null;
  const ref = typeof row.circuit_ref === 'string' && row.circuit_ref ? row.circuit_ref : null;
  if (!ref) return null;
  let phrase = `circuit ${ref} ${label}`;
  if ((job.boards?.length ?? 0) > 1) {
    const boardName = boardNameFor(job, (row as { board_id?: unknown }).board_id);
    if (boardName) phrase += ` on the ${boardName} board`;
  }
  return phrase;
}

/** Diff two job snapshots for regex-destination changes. A destination is
 *  reported when its stored value changed (cleared → `cleared: true`, or
 *  replaced). Rows are matched by stable id; a row present only on one side
 *  is ignored (creation/deletion is not a clear of a reading). */
export function diffRegexDestinations(
  before: JobDetail,
  after: JobDetail
): Array<{ key: string; cleared: boolean }> {
  const out: Array<{ key: string; cleared: boolean }> = [];
  const norm = (v: unknown): string => (v == null ? '' : String(v).trim());
  const sections: Array<['supply' | 'board' | 'install', keyof JobDetail]> = [
    ['supply', 'supply_characteristics'],
    ['board', 'board_info'],
    ['install', 'installation_details'],
  ];
  for (const [scope, section] of sections) {
    const prev = (before[section] as Record<string, unknown> | null | undefined) ?? {};
    const next = (after[section] as Record<string, unknown> | null | undefined) ?? {};
    if (prev === next) continue;
    for (const field of CANONICAL_SECTION_FIELDS[scope]) {
      const a = norm(prev[field]);
      const b = norm(next[field]);
      if (a === b) continue;
      out.push({ key: `${scope}.${field}`, cleared: b === '' });
    }
  }
  const prevRows = new Map<string, Record<string, unknown>>();
  for (const row of before.circuits ?? []) prevRows.set(row.id, row as Record<string, unknown>);
  if ((before.circuits ?? []) !== (after.circuits ?? [])) {
    for (const row of after.circuits ?? []) {
      const prev = prevRows.get(row.id);
      if (!prev || prev === row) continue;
      for (const field of Object.keys(DESTINATION_FIELD_LABELS.circuit)) {
        const a = norm(prev[field]);
        const b = norm((row as Record<string, unknown>)[field]);
        if (a === b) continue;
        out.push({ key: `circuit.${row.id}.${field}`, cleared: b === '' });
      }
    }
  }
  return out;
}

/** Translate a matcher-emitted destination to the id-based tracker key the
 *  rest of the pipeline uses, through the SAME routing the apply layer
 *  applies (`regex-destination-routing.ts`): `circuit.<ref>.<f>` → the row
 *  chosen by board, `supply.main_switch_*` → `board.*`, renamed install
 *  fields. Returns null when the ref has no row (out of scope — exactly
 *  the rows `applyRegexMatchToJob` skips) or the field is not a regex
 *  destination. */
export function canonicalDestinationKey(
  matcherKey: string,
  job: JobDetail,
  activeBoardId: string | null = null
): string | null {
  const route = resolveRegexDestination(matcherKey, job, activeBoardId);
  if (!route) return null;
  return isRegexDestinationKey(route.trackerKey) ? route.trackerKey : null;
}

// ── Occurrence candidates and the freshness store ────────────────────────

export interface OccurrenceCandidate {
  /** Id-based tracker key. */
  readonly destination: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly fragmentIds: readonly string[];
  readonly epoch: ConnectionEpoch;
  readonly maxFinalSequence: number;
  readonly ambiguous: boolean;
  /** Every contributing final's record (for the unbounded check). */
  readonly finals: readonly FinalWindowV1[];
}

export type OccurrenceDecision =
  | 'fresh'
  | 'settled'
  | 'stale_buffer'
  | 'stale_stream'
  | 'ambiguous'
  | 'ineligible_unbounded';

interface SettledOccurrence {
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly maxFinalSequence: number;
  readonly fragmentIds: readonly string[];
}

export interface ManualCutoffSnapshot {
  readonly epoch: ConnectionEpoch;
  /** The emitting epoch's `dispatchedSampleOffset` at the tap. */
  readonly dispatchedOffset: number;
  /** Admitted-buffer head at the tap. */
  readonly bufferOffset: number;
  /** Last admitted final sequence at the tap (null before any final). */
  readonly bufferFinalSequence: number | null;
}

interface ManualCutoffRecord extends ManualCutoffSnapshot {
  readonly destination: string;
  readonly label: string;
  /** The epoch's last ACCEPTED final sequence when the tap happened; the
   *  cutoff "applies" only while that is still the epoch's last accepted. */
  readonly acceptedSequenceAtTap: number | null;
}

export interface HoldDecision {
  readonly held: boolean;
  /** Spoken destination phrases (insertion order, unique). */
  readonly destinations: readonly string[];
}

/** A02D's client-local PRODUCER TABLE, keyed by A01B's `{session_epoch,
 *  mutation_id}` identity as a JOIN key. A01B is not on `main` (verified
 *  2026-09-09: only a shadow-harness mention of `mutation_id`), so nothing
 *  submits `field_commit` receipts yet and the table stays DORMANT: a
 *  producer is recorded only under an identity A01B's `field_commit`
 *  submission supplies — never a locally minted one (Codex diff-review
 *  cycle 1, IMPORTANT 4: synthetic `local_N` rows were unbounded, invisible
 *  to the retention metric and not A01B identities). When the identity is
 *  unavailable the cutoff does not advance across newer finals. Producers
 *  are evicted with their epoch and counted in `retainedRecordCount`. */
export type ProducerRecord =
  | { readonly kind: 'manual'; readonly snapshot: ManualCutoffSnapshot }
  | { readonly kind: 'utterance'; readonly utteranceId: string };

export function producerJoinKey(sessionEpoch: string | number, mutationId: string): string {
  return `${sessionEpoch}:${mutationId}`;
}

export class OccurrenceFreshnessStore {
  private readonly settled = new Map<string, SettledOccurrence[]>();
  /** Utterance-driven and manual BUFFER cutoffs per destination — the
   *  final sequence at or below which fragments are stale for it. */
  private readonly bufferCutoffs = new Map<string, number>();
  /** Manual cutoffs, per epoch, in tap order. */
  private readonly manualCutoffs = new Map<ConnectionEpoch, ManualCutoffRecord[]>();
  /** Per epoch: the last accepted (non-held, admitted) final sequence. */
  private readonly lastAccepted = new Map<ConnectionEpoch, number>();
  /** Final records by sequence — bounded by the eviction watermark. */
  private readonly finals = new Map<number, FinalWindowV1>();
  /** `{session_epoch, mutation_id}` → producer; epoch kept for eviction. */
  private readonly producers = new Map<
    string,
    { readonly epoch: string | number; readonly record: ProducerRecord }
  >();
  private heldCount = 0;

  // ── final records ──

  recordFinal(w: FinalWindowV1): void {
    this.finals.set(w.finalSequence, w);
  }
  getFinal(sequence: number): FinalWindowV1 | undefined {
    return this.finals.get(sequence);
  }
  get finalRecordCount(): number {
    return this.finals.size;
  }

  /** A final that passed the hold and entered the pipeline (forwarded or
   *  locally executed). */
  noteAccepted(finals: readonly FinalWindowV1[]): void {
    for (const f of finals) {
      const prev = this.lastAccepted.get(f.epoch);
      if (prev === undefined || f.finalSequence > prev)
        this.lastAccepted.set(f.epoch, f.finalSequence);
    }
  }

  // ── cutoffs ──

  /** MANUAL boundary: both cutoffs sampled at the tap by the caller. */
  recordManualCutoff(destination: string, label: string, snapshot: ManualCutoffSnapshot): void {
    const record: ManualCutoffRecord = {
      ...snapshot,
      destination,
      label,
      acceptedSequenceAtTap: this.lastAccepted.get(snapshot.epoch) ?? null,
    };
    const list = this.manualCutoffs.get(snapshot.epoch) ?? [];
    list.push(record);
    this.manualCutoffs.set(snapshot.epoch, list);
    if (snapshot.bufferFinalSequence !== null)
      this.raiseBufferCutoff(destination, snapshot.bufferFinalSequence);
    this.settleDestination(destination);
  }

  /** UTTERANCE-DRIVEN boundary: the buffer cutoff is the CAUSATIVE final's
   *  sequence (never the buffer head at arrival). `null` = identity
   *  unavailable → settle but do not advance across newer finals. */
  recordUtteranceCutoff(destination: string, causativeSequence: number | null): void {
    if (causativeSequence !== null) this.raiseBufferCutoff(destination, causativeSequence);
    this.settleDestination(destination);
  }

  bufferCutoffFor(destination: string): number | null {
    return this.bufferCutoffs.get(destination) ?? null;
  }

  private raiseBufferCutoff(destination: string, sequence: number): void {
    const prev = this.bufferCutoffs.get(destination);
    if (prev === undefined || sequence > prev) this.bufferCutoffs.set(destination, sequence);
  }

  /** Settle every occurrence already resolved for `destination` — they are
   *  history now regardless of what value the destination holds later. */
  private settleDestination(destination: string): void {
    // Nothing to do beyond keeping the settled list: settled entries are
    // never un-settled. The buffer cutoff covers in-flight fragments.
    void destination;
  }

  // ── producer table (A01B join) ──

  /** Record a producer at `field_commit` submission time under A01B's OWN
   *  `mutation_id`. Returns the join key. There is no local fallback
   *  identity: without A01B nothing calls this. */
  recordProducer(
    sessionEpoch: string | number,
    mutationId: string,
    producer: ProducerRecord
  ): string {
    const key = producerJoinKey(sessionEpoch, mutationId);
    this.producers.set(key, { epoch: sessionEpoch, record: producer });
    return key;
  }
  /** Resolve an accepted receipt's producer by A01B identity. */
  resolveProducer(sessionEpoch: string | number, mutationId: string): ProducerRecord | null {
    return this.producers.get(producerJoinKey(sessionEpoch, mutationId))?.record ?? null;
  }
  get producerCount(): number {
    return this.producers.size;
  }

  // ── hold decision ──

  /** Manual cutoffs on `epoch` that still APPLY: recorded while the epoch's
   *  last accepted final was the one it still is. */
  private applicableManualCutoffs(epoch: ConnectionEpoch): ManualCutoffRecord[] {
    const list = this.manualCutoffs.get(epoch);
    if (!list || list.length === 0) return [];
    const accepted = this.lastAccepted.get(epoch) ?? null;
    return list.filter((c) => c.acceptedSequenceAtTap === accepted);
  }

  /** ONE raw-final decision for the whole dispatch (every constituent),
   *  taken immediately after FinalWindowV1 resolution and before every
   *  mutation-capable consumer. Conservative: any pre-cutoff constituent
   *  holds the whole dispatch. */
  holdDecision(finals: readonly FinalWindowV1[]): HoldDecision {
    const destinations: string[] = [];
    let held = false;
    for (const f of finals) {
      const cutoffs = this.applicableManualCutoffs(f.epoch);
      if (cutoffs.length === 0) continue;
      const streamCutoff = Math.max(...cutoffs.map((c) => c.dispatchedOffset));
      const stale = f.unbounded || f.speechStart === null || f.speechStart < streamCutoff;
      if (!stale) continue;
      held = true;
      for (const c of cutoffs) if (!destinations.includes(c.label)) destinations.push(c.label);
    }
    if (held) this.heldCount += 1;
    return { held, destinations };
  }

  get heldFinalCount(): number {
    return this.heldCount;
  }

  // ── occurrence evaluation ──

  /**
   * `currentSequence` is the just-admitted fragment's final sequence. A
   * candidate whose raw span lies entirely in OLDER fragments is old overlap
   * — parsing context, never a new write merely because a destination is
   * empty or because later context (an active circuit, a designation
   * lookback) would retarget it. Only a candidate that touches the current
   * fragment (a new reading, or a cross-final completion whose anchor or
   * value arrived now) can be fresh.
   */
  evaluate(candidate: OccurrenceCandidate, currentSequence: number): OccurrenceDecision {
    if (candidate.ambiguous) return 'ambiguous';
    if (candidate.finals.some((f) => f.unbounded)) return 'ineligible_unbounded';
    if (candidate.maxFinalSequence < currentSequence) return 'settled';
    const settledList = this.settled.get(candidate.destination);
    if (settledList) {
      for (const s of settledList) {
        const overlaps = s.rawStart < candidate.rawEnd && s.rawEnd > candidate.rawStart;
        if (overlaps && s.maxFinalSequence >= candidate.maxFinalSequence) return 'settled';
      }
    }
    // Buffer cutoff (utterance-driven or manual): ANY contributing final at
    // or below the cutoff makes the occurrence stale for this destination —
    // a cross-final completion whose anchor arrived before the causative
    // clear must not restore the cleared value just because its value
    // fragment arrived after it (Codex diff-review cycle 1, BLOCKER 0's
    // trigger: F1 "Circuit 3 R1 plus R2 is", the clear, then "nought point
    // two" completing F1).
    const cutoff = this.bufferCutoffs.get(candidate.destination);
    if (cutoff !== undefined && candidate.finals.some((f) => f.finalSequence <= cutoff)) {
      return 'stale_buffer';
    }
    // Manual stream cutoff on a contributing fragment's epoch: a final whose
    // confirmed onset precedes the tap is stale for that destination even
    // if a later fragment completed the reading.
    for (const f of candidate.finals) {
      const cutoffs = this.manualCutoffs.get(f.epoch);
      if (!cutoffs) continue;
      for (const c of cutoffs) {
        if (c.destination !== candidate.destination) continue;
        if (f.finalSequence <= (c.bufferFinalSequence ?? -1)) return 'stale_buffer';
        if (f.speechStart !== null && f.speechStart < c.dispatchedOffset) return 'stale_stream';
      }
    }
    return 'fresh';
  }

  /** Settle a fresh occurrence once it has been EVALUATED (whether or not
   *  the downstream value gate wrote it — the occurrence is history). */
  settle(candidate: OccurrenceCandidate): void {
    const list = this.settled.get(candidate.destination) ?? [];
    list.push({
      rawStart: candidate.rawStart,
      rawEnd: candidate.rawEnd,
      maxFinalSequence: candidate.maxFinalSequence,
      fragmentIds: candidate.fragmentIds,
    });
    this.settled.set(candidate.destination, list);
  }

  settledCount(): number {
    let n = 0;
    for (const list of this.settled.values()) n += list.length;
    return n;
  }

  // ── eviction ──

  /**
   * Bounded retention behind the admitted buffer's front-trim watermark.
   * `retainedFrom` is the absolute raw offset of the first retained
   * character; `retainedEpochs` the epochs still referenced by retained
   * fragments plus the current one. Evicts settled occurrences that end
   * before the watermark (their text can never be rescanned), final records
   * of evicted fragments, and manual cutoff lists of epochs no retained
   * fragment references and that are not current.
   */
  evict(
    retainedFrom: number,
    minRetainedSequence: number | null,
    retainedEpochs: ReadonlySet<ConnectionEpoch>
  ): void {
    for (const [dest, list] of this.settled) {
      const kept = list.filter((s) => s.rawEnd > retainedFrom);
      if (kept.length === 0) this.settled.delete(dest);
      else if (kept.length !== list.length) this.settled.set(dest, kept);
    }
    if (minRetainedSequence !== null) {
      for (const seq of [...this.finals.keys()]) {
        if (seq < minRetainedSequence) this.finals.delete(seq);
      }
    }
    for (const epoch of [...this.manualCutoffs.keys()]) {
      if (!retainedEpochs.has(epoch)) {
        this.manualCutoffs.delete(epoch);
        this.lastAccepted.delete(epoch);
      }
    }
    // Producers ride the same watermark: an epoch no retained fragment
    // references can receive no receipt whose cutoff could still matter.
    for (const [key, entry] of [...this.producers]) {
      if (!retainedEpochs.has(entry.epoch as ConnectionEpoch)) this.producers.delete(key);
    }
  }

  /** Total retained state, for the bounded-growth test. */
  get retainedRecordCount(): number {
    let manual = 0;
    for (const list of this.manualCutoffs.values()) manual += list.length;
    return (
      this.finals.size +
      this.settledCount() +
      manual +
      this.bufferCutoffs.size +
      this.producers.size
    );
  }
}

// ── Gate: occurrence freshness BEFORE the value gates ────────────────────

export interface OccurrenceFreshnessOutcome {
  /** The matcher result restricted to destinations with a FRESH occurrence. */
  readonly result: RegexMatchResult;
  /** Per-destination decisions (id-based keys), for diagnostics and tests. */
  readonly decisions: ReadonlyMap<string, OccurrenceDecision>;
  readonly candidates: readonly OccurrenceCandidate[];
}

/**
 * Resolve every occurrence candidate the matcher emitted for `fragment`'s
 * scan into absolute admitted-buffer spans, evaluate and settle it, and
 * return the result restricted to fresh destinations. Runs BEFORE
 * `applyRegexMatchToJob` / `computeFreshRegexWrites` so a settled or stale
 * candidate never reaches value comparison, ownership or empty-destination
 * checks. Multiple occurrences for one destination collapse to the LAST
 * (the write that survived in the result).
 */
export function applyOccurrenceFreshness(
  result: RegexMatchResult,
  buffer: AdmittedBuffer,
  fragment: AdmittedFragment,
  job: JobDetail,
  store: OccurrenceFreshnessStore,
  /** The active board, so a duplicate circuit ref resolves to the same row
   *  the apply layer will write. */
  activeBoardId: string | null = null
): OccurrenceFreshnessOutcome {
  const decisions = new Map<string, OccurrenceDecision>();
  const candidates: OccurrenceCandidate[] = [];
  const allowedMatcherKeys = new Set<string>();
  const prov = result.provenance;
  if (!prov) {
    // No provenance (the empty result) — nothing can be fresh.
    return { result: restrictResult(result, allowedMatcherKeys), decisions, candidates };
  }
  const lastByDestination = new Map<string, (typeof prov.occurrences)[number]>();
  for (const occ of prov.occurrences) lastByDestination.set(occ.destination, occ);
  for (const occ of lastByDestination.values()) {
    const canonical = canonicalDestinationKey(occ.destination, job, activeBoardId);
    if (!canonical) continue;
    let candidate: OccurrenceCandidate;
    if (occ.normalisedStart < 0 || occ.normalisedEnd <= occ.normalisedStart) {
      candidate = {
        destination: canonical,
        rawStart: fragment.rawStart,
        rawEnd: fragment.rawEnd,
        fragmentIds: [fragment.id],
        epoch: fragment.epoch,
        maxFinalSequence: fragment.finalSequence,
        ambiguous: true,
        finals: fragment.finals,
      };
    } else {
      const mapped = prov.sourceMap.mapSpan(occ.normalisedStart, occ.normalisedEnd);
      const absStart = buffer.baseOffset + prov.windowStart + mapped.rawStart;
      const absEnd = buffer.baseOffset + prov.windowStart + mapped.rawEnd;
      const fragments = mapped.ambiguous ? [fragment] : buffer.fragmentsIn(absStart, absEnd);
      const contributing = fragments.length > 0 ? fragments : [fragment];
      const finals: FinalWindowV1[] = [];
      for (const f of contributing) for (const w of f.finals) finals.push(w);
      candidate = {
        destination: canonical,
        rawStart: absStart,
        rawEnd: absEnd,
        fragmentIds: contributing.map((f) => f.id),
        epoch: contributing[contributing.length - 1].epoch,
        maxFinalSequence: Math.max(...contributing.map((f) => f.finalSequence)),
        ambiguous: mapped.ambiguous,
        finals,
      };
    }
    const decision = store.evaluate(candidate, fragment.finalSequence);
    decisions.set(canonical, decision);
    candidates.push(candidate);
    if (decision === 'fresh') {
      store.settle(candidate);
      allowedMatcherKeys.add(occ.destination);
    }
  }
  return { result: restrictResult(result, allowedMatcherKeys), decisions, candidates };
}

/** Copy `result` keeping only the section writes whose matcher key is in
 *  `allowed`. `new_circuits` and `board_switch` are context, not
 *  destination writes, and pass through unchanged. */
export function restrictResult(
  result: RegexMatchResult,
  allowed: ReadonlySet<string>
): RegexMatchResult {
  const pick = <T extends object>(section: T, prefix: string): T => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(section as Record<string, unknown>)) {
      if (v !== undefined && allowed.has(prefix + k)) out[k] = v;
    }
    return out as T;
  };
  const circuit_updates: Record<string, CircuitUpdates> = {};
  for (const [ref, updates] of Object.entries(result.circuit_updates)) {
    const kept = pick(updates, `circuit.${ref}.`);
    if (Object.keys(kept).length > 0) circuit_updates[ref] = kept;
  }
  const out: RegexMatchResult = {
    supply_updates: pick(result.supply_updates, 'supply.'),
    board_updates: pick(result.board_updates, 'board.'),
    installation_updates: pick(result.installation_updates, 'install.'),
    circuit_updates,
    new_circuits: result.new_circuits,
  };
  if (result.board_switch) out.board_switch = result.board_switch;
  if (result.provenance) {
    Object.defineProperty(out, 'provenance', {
      value: result.provenance,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

/** Map an extraction-apply `changedKeys` entry (`installation.<f>`,
 *  `supply.<f>`, `board.<f>`, `circuit.<rowId>.<f>`) to the tracker-key
 *  destination form, or null when it is not a regex destination. */
export function destinationKeyFromChangedKey(changedKey: string): string | null {
  const key = changedKey.startsWith('installation.')
    ? `install.${changedKey.slice('installation.'.length)}`
    : changedKey;
  return isRegexDestinationKey(key) ? key : null;
}

/** Read a destination's stored value from a job snapshot (null when empty). */
export function readRegexDestinationValue(job: JobDetail, key: string): unknown {
  const parsed = parseTrackerKey(key);
  if (!parsed) return null;
  let value: unknown;
  if (parsed.scope === 'circuit') {
    const row = (job.circuits ?? []).find((c) => c.id === parsed.rowId);
    value = row ? (row as Record<string, unknown>)[parsed.field] : undefined;
  } else {
    const sectionName =
      parsed.scope === 'supply'
        ? 'supply_characteristics'
        : parsed.scope === 'board'
          ? 'board_info'
          : 'installation_details';
    const section = job[sectionName] as Record<string, unknown> | null | undefined;
    value = section?.[parsed.field];
  }
  return value == null || value === '' ? null : value;
}
