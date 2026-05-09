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

/** Helper — value is "present" iff it's a non-empty string / non-null /
 *  non-undefined / non-empty array. Mirrors iOS `hasValue`. */
function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0;
  return true;
}

export class FieldSourceTracker {
  private readonly fieldSources = new Map<string, FieldSource>();
  private readonly thisTurnRegexWrites = new Set<string>();

  /** Walk a JobDetail and record every populated field as `'preExisting'`.
   *  Call once at session start before any regex/Sonnet writes can land. */
  seedFromJob(job: JobDetail): void {
    const seedSection = (prefix: string, section: Record<string, unknown> | undefined): void => {
      if (!section) return;
      for (const [key, value] of Object.entries(section)) {
        if (hasValue(value)) {
          this.fieldSources.set(`${prefix}.${key}`, 'preExisting');
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
    const src = this.fieldSources.get(key);
    return src === undefined || src === 'regex';
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
    this.fieldSources.set(key, 'regex');
    this.thisTurnRegexWrites.add(key);
  }

  recordSonnetWrite(key: string): void {
    this.fieldSources.set(key, 'sonnet');
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

  /** Test seam — peek the source of a key without mutation. */
  getSource(key: string): FieldSource | undefined {
    return this.fieldSources.get(key);
  }
}
