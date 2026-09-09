/**
 * FieldSourceTracker — 3-tier priority bookkeeping for the iOS-parity
 * pre-extraction pipeline.
 *
 * Mirrors iOS `DeepgramRecordingViewModel` lines 116-134 + 5379-5447
 * enforcement. Tracks who last wrote each field key so:
 *   - Regex never overwrites Sonnet OR pre-existing values
 *   - Sonnet may supersede pre-existing iff the new value differs
 *
 * **Field-priority rule (codex review finding D corrected the intuition):**
 *
 * | Writer       | Allowed targets                                      |
 * |--------------|------------------------------------------------------|
 * | Pre-existing | seed-time only — read from job at session start      |
 * | Regex        | empty fields, OR fields whose source is `'regex'`    |
 * | Sonnet       | any field — supersedes pre-existing on different val |
 *
 * Field-key convention (locked in `live-fill-state.ts` doc):
 *   - Scalar section field : `section.field`     e.g. "supply.ze"
 *   - Circuit cell         : `circuit.{id}.field` e.g. "circuit.c-abc.zs"
 *     where {id} is the row UUID, NOT circuit_ref. Matcher output uses
 *     circuit_ref ("1", "2"); the apply layer maps ref→UUID before
 *     calling recordRegexWrite.
 *   - Board field          : `board.field`        e.g. "board.manufacturer"
 *   - Installation field   : `install.field`      e.g. "install.postcode"
 */

export type FieldSource = 'regex' | 'sonnet' | 'preExisting';

import type { JobDetail } from '@/lib/types';
import { SECTION_FIELD_ALIASES } from './regex-destination-routing';

/** Helper — value is "present" iff it's a non-empty string / non-null /
 *  non-undefined / non-empty array. Mirrors iOS `hasValue`. */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
  return true;
}

/**
 * A01P (2026-09-08) — ALIAS FAMILIES tracked together. Supply Ze lives under
 * two client spellings (`supply.ze` wire / `supply.earth_loop_impedance_ze`
 * PWA column) that the apply path materialises as ONE value; ownership is
 * therefore one decision per family: seeding either marks both, a regex or
 * Sonnet write on either records both, `forget` releases both, and
 * `canRegexWrite` refuses when ANY member is owned by a higher tier. Never
 * inferred from value equality — provenance is recorded at the write.
 */
// A02D — ONE alias table for every consumer: the families come from
// `regex-destination-routing.ts` (`supply.ze`/`earth_loop_impedance_ze`,
// `supply.pfc`/`prospective_fault_current`,
// `install.general_condition`/`general_condition_of_installation`).
const TRACKER_SCOPE: Record<keyof typeof SECTION_FIELD_ALIASES, string> = {
  supply_characteristics: 'supply',
  board_info: 'board',
  installation_details: 'install',
};
const ALIAS_FAMILIES: ReadonlyArray<readonly string[]> = (
  Object.keys(SECTION_FIELD_ALIASES) as Array<keyof typeof SECTION_FIELD_ALIASES>
).flatMap((target) =>
  Object.values(SECTION_FIELD_ALIASES[target]).map((family) =>
    family.map((alias) => `${TRACKER_SCOPE[target]}.${alias}`)
  )
);

function familyOf(key: string): readonly string[] {
  for (const family of ALIAS_FAMILIES) {
    if (family.includes(key)) return family;
  }
  return [key];
}

export class FieldSourceTracker {
  private readonly fieldSources = new Map<string, FieldSource>();
  private readonly thisTurnRegexWrites = new Set<string>();

  /** Walk a JobDetail and record every populated field as `'preExisting'`.
   *  Call once at session start before any regex/Sonnet writes can land. */
  seedFromJob(job: JobDetail): void {
    const seedSection = (
      prefix: string,
      section: Record<string, unknown> | null | undefined
    ): void => {
      if (!section) return;
      for (const [key, value] of Object.entries(section)) {
        if (hasValue(value)) {
          for (const member of familyOf(`${prefix}.${key}`)) {
            this.fieldSources.set(member, 'preExisting');
          }
        }
      }
    };
    seedSection('supply', job.supply_characteristics);
    seedSection('board', job.board_info);
    seedSection('install', job.installation_details);

    // Circuits — keyed by row UUID for stability across renames.
    for (const row of job.circuits ?? []) {
      const id = row.id;
      if (!id) continue;
      for (const [key, value] of Object.entries(row)) {
        if (key === 'id') continue;
        if (hasValue(value)) {
          this.fieldSources.set(`circuit.${id}.${key}`, 'preExisting');
        }
      }
    }
  }

  /** Regex may write only when the field is unset OR its current source
   *  is also `'regex'` (regex-overwrite-regex is fine — last hit wins). */
  canRegexWrite(key: string): boolean {
    return familyOf(key).every((member) => {
      const src = this.fieldSources.get(member);
      return src === undefined || src === 'regex';
    });
  }

  /**
   * Sonnet may write whenever the new value differs from the current.
   * Mirrors iOS DeepgramRecordingViewModel:5425-5447: a Sonnet reading is
   * blocked only when its `value` is byte-identical to the value already
   * present (avoids redundant re-emit churn). Different value → write
   * proceeds even when the source is `'preExisting'`.
   */
  canSonnetWrite(_key: string, newValue: unknown, currentValue: unknown): boolean {
    if (!hasValue(newValue)) return false;
    if (currentValue === undefined || currentValue === null) return true;
    return String(newValue) !== String(currentValue);
  }

  /** Mark a regex write — also adds to the per-turn set consumed by
   *  `buildRegexSummary` to build the `regexResults` wire payload. */
  recordRegexWrite(key: string): void {
    for (const member of familyOf(key)) this.fieldSources.set(member, 'regex');
    this.thisTurnRegexWrites.add(key);
  }

  recordSonnetWrite(key: string): void {
    for (const member of familyOf(key)) this.fieldSources.set(member, 'sonnet');
  }

  /** PLAN-C Codex cycle 3 — EVIDENCE without OWNERSHIP.
   *
   *  The closed-enum guard refuses to WRITE an off-list regex value, but
   *  the matcher still MATCHED — and that match is what the pre-LLM
   *  forward-gate reads (`gateRegexHit`, recording-context.tsx:2065) and
   *  what the backend receives as `regexResults` context for Sonnet.
   *  Dropping the candidate outright therefore did two things nobody
   *  asked for: it changed the WS frame (iOS still sends the hint), and
   *  — far worse — it could flip a short utterance from gate-PASS to
   *  gate-REJECT, so "the breaker on circuit 3 is an MCB" would be
   *  silently discarded before the model ever saw it and the inspector
   *  would hear nothing at all. That is the Audio-First failure this
   *  plan exists to prevent, re-introduced one layer up.
   *
   *  So a suppressed value joins the per-turn set — the hint goes out,
   *  the gate stays open, the server re-asks — but NOT `fieldSources`:
   *  claiming regex ownership of a column we did not write would make
   *  `canRegexWrite` reject the correct value arriving moments later. */
  recordRegexHintOnly(key: string): void {
    this.thisTurnRegexWrites.add(key);
  }

  /** Freshness shadow for guard-suppressed values. The matcher runs on a
   *  CUMULATIVE window, so the same bad match recurs every turn. A
   *  written value goes non-fresh because the job now holds it; a
   *  suppressed one never lands anywhere, so without this it would emit
   *  a fresh hint (and hold the gate open) on every subsequent
   *  utterance. Keyed by value so a genuine correction is still fresh. */
  private readonly suppressedRegexValues = new Map<string, string>();

  noteSuppressedRegexValue(key: string, value: string): void {
    this.suppressedRegexValues.set(key, value);
  }

  isRepeatSuppressedRegexValue(key: string, value: string): boolean {
    return this.suppressedRegexValues.get(key) === value;
  }

  /** Atomic read-and-clear of this turn's regex writes. Mirrors iOS's
   *  `thisTurnRegexWrites` (DeepgramRecordingViewModel:125-129) which is
   *  cleared at the START of every regex apply pass and harvested at the
   *  end via buildRegexSummary. Returning + clearing in one call keeps
   *  the next turn empty. */
  consumeTurnWrites(): string[] {
    const out = Array.from(this.thisTurnRegexWrites);
    this.thisTurnRegexWrites.clear();
    return out;
  }

  /**
   * A1b (2026-07-29) — release ownership of cleared slots. A board/supply
   * clear empties the visible cell; keeping the `preExisting` claim would
   * make `canRegexWrite` reject the inspector's NEXT dictation into that
   * empty cell. Clears both the source map and the per-turn regex set.
   */
  forget(keys: readonly string[]): void {
    for (const key of keys) {
      for (const member of familyOf(key)) {
        this.fieldSources.delete(member);
        this.thisTurnRegexWrites.delete(member);
        // A cleared cell forgets its suppression shadow too, or a re-dictation
        // of the same off-list value into the emptied slot would be judged a
        // stale repeat and lose its gate evidence.
        this.suppressedRegexValues.delete(member);
      }
    }
  }

  /** Test seam — peek the source of a key without mutation. */
  getSource(key: string): FieldSource | undefined {
    return this.fieldSources.get(key);
  }
}
