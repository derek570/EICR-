/**
 * PLAN-CC (feedback-2026-09-17 wave) — web half of the `ocpd_bs_en`
 * free-text canonicalisation contract.
 *
 * `config/ocpd-bs-suggestions.json` is the NORMATIVE source for the alias
 * table: the rendering in the plan has no independent authority. This file
 * reads the canonical copy directly, asserts the pinned cross-platform digest
 * (the iOS XCTest asserts the SAME hex constant over its byte-identical copy),
 * and drives every accepted and rejected vector through the shared TS
 * canonicaliser comparing returned BYTES.
 *
 * Two obligations, neither substituting for the other:
 *   - `scripts/check-ocpd-bs-fixture-sync.sh` proves the two FILES match.
 *   - The vector loops below prove the PARSERS agree. File sync without output
 *     tests would ship three identical fixtures and three disagreeing parsers.
 *
 * The backend third (`parseOcpdStandard` + its `ocpd-bs-suggestions.test.js`)
 * is PLAN-CS's deliverable — see PLAN-CC § Integration note; the function does
 * not exist in `src/` yet and PLAN-CS ships after this plan.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { OCPD_STANDARD_INPUT_CAP, canonicaliseOcpdStandard } from '@certmate/shared-utils';
import {
  OCPD_BS_INPUT_CAP,
  OCPD_BS_SUGGESTIONS,
  OCPD_BS_SUGGESTIONS_DIGEST,
  OCPD_BS_TIER1,
  OCPD_BS_TIER2,
} from '@/lib/recording/ocpd-bs-suggestions.generated';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', 'config', 'ocpd-bs-suggestions.json');

type Manifest = {
  cap: number;
  tier1: string[];
  tier2: string[];
  accepted_value_vectors: Array<{ input: string; expected: string }>;
  rejected_value_vectors: Array<{ input: string; reason: string; why?: string }>;
};

const manifest = require('../../config/ocpd-bs-suggestions.json') as Manifest;

/** Values accepted when dictated or typed but deliberately offered in NEITHER
 *  suggestion tier — RCD standards that are not OCPD picker material. The
 *  AUTHORITY for the manifest's "accepted, never suggested" class. */
const ACCEPTED_NOT_SUGGESTED = ['BS EN 61008', 'BS 4293', 'BS 7288'] as const;

describe('ocpd-bs-suggestions manifest — cross-platform pins', () => {
  /** Cross-repo contract pin. The iOS repo carries a byte-identical COPY whose
   *  XCTest asserts the SAME hex constant; changing either file alone fails one
   *  side. When the vectors legitimately change: edit the manifest, run
   *  `node scripts/generate-ocpd-bs-suggestions.mjs`,
   *  `shasum -a 256 config/ocpd-bs-suggestions.json`, and update BOTH constants
   *  in the same coordinated change. */
  it('manifest bytes match the pinned cross-platform digest', () => {
    const digest = createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex');
    expect(digest).toBe('68eba79b2f5d58c4fcb898662898bdf11fbd8f6a6798eaf8ca38bec8b3dff0a2');
  });

  /** The generated module is what web actually compiles against; the manifest
   *  is what the gate byte-compares. If the generator was not re-run after a
   *  manifest edit these two diverge and every downstream assertion below would
   *  be testing stale bytes. */
  it('the generated web module carries the manifest bytes and its digest', () => {
    const digest = createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex');
    expect(OCPD_BS_SUGGESTIONS_DIGEST).toBe(digest);
    expect(JSON.parse(JSON.stringify(OCPD_BS_SUGGESTIONS))).toEqual(manifest);
    expect([...OCPD_BS_TIER1]).toEqual(manifest.tier1);
    expect([...OCPD_BS_TIER2]).toEqual(manifest.tier2);
    expect(OCPD_BS_INPUT_CAP).toBe(manifest.cap);
    expect(OCPD_STANDARD_INPUT_CAP).toBe(manifest.cap);
  });

  /** Acceptance 1a(c) — the vector lists are complete and disjoint. */
  it('vector lists are disjoint and every input is unique', () => {
    const accepted = manifest.accepted_value_vectors.map((v) => v.input);
    const rejected = manifest.rejected_value_vectors.map((v) => v.input);
    expect(new Set(accepted).size).toBe(accepted.length);
    expect(new Set(rejected).size).toBe(rejected.length);
    expect(accepted.filter((i) => rejected.includes(i))).toEqual([]);
  });

  /** Acceptance 1a(c), second half, and acceptance 4's authority: an
   *  accepted-but-never-suggested value appears in NEITHER tier. */
  it('accepted-but-never-suggested standards are in neither tier', () => {
    for (const value of ACCEPTED_NOT_SUGGESTED) {
      expect(canonicaliseOcpdStandard(value)).toBe(value);
      expect(manifest.tier1).not.toContain(value);
      expect(manifest.tier2).not.toContain(value);
    }
  });

  it('the two suggestion tiers are disjoint and hold only canonical values', () => {
    expect(manifest.tier1.filter((v) => manifest.tier2.includes(v))).toEqual([]);
    for (const value of [...manifest.tier1, ...manifest.tier2]) {
      expect(canonicaliseOcpdStandard(value)).toBe(value);
    }
  });
});

describe('canonicaliseOcpdStandard — manifest vectors', () => {
  it.each(manifest.accepted_value_vectors)(
    'accepts %#: $input → $expected',
    ({ input, expected }) => {
      expect(canonicaliseOcpdStandard(input)).toBe(expected);
    }
  );

  it.each(manifest.rejected_value_vectors)('misses %#: $input ($reason)', ({ input }) => {
    expect(canonicaliseOcpdStandard(input)).toBeNull();
  });
});

describe('canonicaliseOcpdStandard — plan acceptance item 1', () => {
  const cases: Array<[string, string | null]> = [
    // Alias collapses vs parts that stay distinct.
    ['BS 3871', 'BS 3871'],
    ['b s 3871', 'BS 3871'],
    ['3871', 'BS 3871'],
    ['3871-1', 'BS 3871'],
    ['BS EN 60898-1', 'BS EN 60898'],
    ['60898-1', 'BS EN 60898'],
    ['61009-1', 'BS EN 61009'],
    ['60269-1', 'BS EN 60269-1'],
    ['88-1', 'BS 88-1'],
    ['60947-4-1', 'BS EN 60947-4-1'],
    // Spoken dash / hyphen.
    ['88 dash 2', 'BS 88-2'],
    ['88 dash 3', 'BS 88-3'],
    ['88 hyphen 3', 'BS 88-3'],
    ['88-3', 'BS 88-3'],
    ['88-6', 'BS 88-6'],
    // Parts that stay distinct.
    ['60269-2', 'BS EN 60269-2'],
    ['60269-3', 'BS EN 60269-3'],
    ['60269-4', 'BS EN 60269-4'],
    ['60947-2', 'BS EN 60947-2'],
    ['60947-3', 'BS EN 60947-3'],
    ['1362', 'BS 1362'],
    // The misheard-digit alias. The assertion that matters is that the output
    // is NOT `BS EN 60909`, which is what the grammar produces without step 9.
    ['60909', 'BS EN 61009'],
    ['BS EN 60909', 'BS EN 61009'],
    // Free text the grammar consumes.
    ['BS 9999', 'BS 9999'],
    ['12345', 'BS 12345'],
    ['bs   en   12345', 'BS EN 12345'],
    ['b s en 12345 - 12 - 3', 'BS EN 12345-12-3'],
    ['BS          EN          12345-12-3', 'BS EN 12345-12-3'],
    ['a b s 60898', 'BS EN 60898'],
    ['b. s. e. n. 61009-1', 'BS EN 61009'],
    ['6 zero 8 9 8', 'BS EN 60898'],
    // N/A survives, and is never mangled into `N/`.
    ['N/A', 'N/A'],
    ['n/a', 'N/A'],
    ['not applicable', 'N/A'],
    // Misses.
    ['There is no RCBO', null],
    ['BS 123456', null],
    ['88', null],
    ['bs 88', null],
    ['bs en 88', null],
    // Step 8a is an exclusion by SHAPE, not a blocklist: a suffixed 88 is fine.
    ['88-2', 'BS 88-2'],
  ];

  it.each(cases)('canonicalises %s', (input, expected) => {
    expect(canonicaliseOcpdStandard(input)).toBe(expected);
  });

  it('the 34-character dictated form is written, not refused', () => {
    const dictated = 'BS          EN          12345-12-3';
    expect(dictated).toHaveLength(34);
    const out = canonicaliseOcpdStandard(dictated);
    expect(out).toBe('BS EN 12345-12-3');
    // The grammar bounds the OUTPUT length; the 24-character cap is a property
    // of the picker control alone, so nothing here refuses the dictation.
    expect((out as string).length).toBeLessThanOrEqual(OCPD_STANDARD_INPUT_CAP);
  });

  it('structural non-values miss rather than throwing', () => {
    expect(canonicaliseOcpdStandard('')).toBeNull();
    expect(canonicaliseOcpdStandard('   ')).toBeNull();
    expect(canonicaliseOcpdStandard(null)).toBeNull();
    expect(canonicaliseOcpdStandard(undefined)).toBeNull();
    expect(canonicaliseOcpdStandard(true)).toBeNull();
    expect(canonicaliseOcpdStandard({})).toBeNull();
  });
});
