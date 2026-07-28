/**
 * A2-multiboard item 7, round-2 REACHABILITY LOCK (2026-07-28).
 *
 * ── What round 2 asked, and what the answer turned out to be ───────────────
 *
 * Round 2 required that web's circuit-0 APPEND/MERGE branches honour
 * `replaces_cleared`: a FLAGGED reading must REPLACE, never append. Those two
 * branches are
 *
 *   - the EIC divert-to-comments branch  (web/src/lib/recording/apply-extraction.ts,
 *     `reading.field === 'comments'` → `current + "\n" + delta`), and
 *   - the narrative branch               (same file, `NARRATIVE_FIELDS` →
 *     `mergeNarrativeValue`, which appends with a ". " joiner).
 *
 * The plan attached an explicit escape hatch: *"if `clear_reading` cannot
 * target circuit-0 narrative/comments fields, VERIFY at execution and declare
 * these branches out of scope with that stated reason instead."* Verified at
 * execution: the branches are UNREACHABLE by any same-turn collapse, on BOTH
 * clear channels, and the implementation was correctly deferred.
 *
 *   CIRCUIT channel — `clear_reading`'s enum is `circuit_fields` minus
 *   {circuit_ref, is_distribution_circuit, feeds_board_id} (28 members today).
 *   None of `comments` / `general_condition` /
 *   `general_condition_of_installation` / `reason_for_report` is a
 *   `circuit_fields` key at all, so no `clear_reading` can name one and the
 *   P5 circuit collapse can never stamp one.
 *
 *   BOARD channel — `comments` and `general_condition` ARE members of
 *   `CLEAR_BOARD_READING_FIELD_ENUM` (78 members). They are nevertheless
 *   unreachable for a SECOND, independent reason: `BOARD_CLEAR_SCOPE_MAP` is
 *   A1a's deliberately MINIMAL classification ({ze, pfc, manufacturer}), and
 *   an UNCLASSIFIED field (a) is denied by `classifyBoardClear`
 *   (`board_clear_scope_unclassified`, fail-closed — the clear never mutates)
 *   and (b) is stamped with NO `EFFECTIVE_BOARD_SLOT` Symbol on the write side
 *   (`stage6-dispatchers-board.js:446-458`), so mechanism B's collapse
 *   predicate has no slot to match on even if a clear did land.
 *
 * ── Why this file exists rather than a prose note ──────────────────────────
 *
 * That unreachability is CONTINGENT, not structural. A1b's job is to classify
 * the full 78-member board-clear enum. The moment A1b classifies `comments` or
 * `general_condition` as 'global' or 'board', both guarantees fall at once:
 * the clear commits, the write gets a slot Symbol, mechanism B collapses the
 * pair, `replaces_cleared` is stamped, the shadow harness folds it to
 * `circuit: 0`, and web APPENDS the replacement onto the value it was supposed
 * to replace — the inspector hears "recorded as X" and the cell reads
 * "<old>. X". That is the ordering-wipe defect P5 exists to prevent, wearing a
 * different hat.
 *
 * So the deferral is only safe if it is LOUD when it expires. This suite is
 * that alarm: it reddens the instant an append/merge field becomes
 * collapse-reachable, with a message naming the work that must then ship.
 * Same fail-CLOSED idiom `CLEAR_BOARD_READING_FIELD_ENUM` already uses (a new
 * schema key grows the derived enum, the pinned literal does not, the suite
 * reddens until a human classifies it).
 *
 * The web-side field list is PARSED FROM THE WEB SOURCE rather than mirrored
 * as a hand-maintained literal — a mirror is one more thing that can drift
 * silently, and drift here is exactly the failure this file is guarding.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CLEAR_READING_FIELD_ENUM,
  CLEAR_BOARD_READING_FIELD_ENUM,
} from '../extraction/stage6-tool-schemas.js';
import { BOARD_CLEAR_SCOPE_MAP } from '../extraction/stage6-dispatchers-board.js';
import { FIELD_CORRECTIONS } from '../extraction/field-name-corrections.js';

const APPLY_EXTRACTION_PATH = fileURLToPath(
  new URL('../../web/src/lib/recording/apply-extraction.ts', import.meta.url)
);

/**
 * Extract `NARRATIVE_FIELDS`' members from the web source.
 *
 * Deliberately strict: if the declaration is renamed, reshaped, or moved, the
 * throw below fails the suite rather than silently yielding an empty set and
 * asserting nothing (an empty set would make every assertion below trivially
 * pass — the exact silent-pass this file must not have).
 */
function parseNarrativeFieldsFromWebSource() {
  const source = readFileSync(APPLY_EXTRACTION_PATH, 'utf8');
  const decl = /const NARRATIVE_FIELDS:\s*ReadonlySet<string>\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
    source
  );
  if (!decl) {
    throw new Error(
      `NARRATIVE_FIELDS declaration not found in ${APPLY_EXTRACTION_PATH}. ` +
        'This lock parses it from source on purpose; if the declaration moved, ' +
        're-point this parser rather than pasting a mirrored literal.'
    );
  }
  const members = [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (members.length === 0) {
    throw new Error('NARRATIVE_FIELDS parsed as EMPTY — the parser is wrong, not the source.');
  }
  return members;
}

/**
 * Every field whose web circuit-0 apply arm APPENDS or MERGES rather than
 * SETS. A `replaces_cleared` write reaching any of these would be appended to
 * the value it was meant to replace.
 */
function appendMergeFields() {
  // 'comments' is the EIC divert-to-comments branch; the rest are the
  // `mergeNarrativeValue` branch.
  return [...new Set(['comments', ...parseNarrativeFieldsFromWebSource()])];
}

const REMEDY =
  'If this field is now genuinely clearable, item 7 round 2 has come due: the ' +
  'web circuit-0 apply arm (and its iOS mirror) must REPLACE on a ' +
  '`replaces_cleared` reading instead of appending/merging, with positive and ' +
  'negative legs. Do NOT silence this test by trimming the field list.';

describe('A2-multiboard item 7 round 2 — append/merge fields are collapse-UNREACHABLE', () => {
  test('the web source still declares a non-empty NARRATIVE_FIELDS (parser sanity)', () => {
    const fields = appendMergeFields();
    expect(fields).toContain('comments');
    expect(fields.length).toBeGreaterThan(1);
  });

  test.each(appendMergeFields())(
    'CIRCUIT channel: `clear_reading` cannot target %s, so P5 can never flag it',
    (field) => {
      expect(CLEAR_READING_FIELD_ENUM).not.toContain(field);
    }
  );

  test.each(appendMergeFields())(
    'BOARD channel: %s is not collapse-capable (absent from the clear enum, or UNCLASSIFIED in BOARD_CLEAR_SCOPE_MAP)',
    (field) => {
      const canonical = FIELD_CORRECTIONS[field] ?? field;
      const scope = BOARD_CLEAR_SCOPE_MAP[canonical];
      const classified = scope === 'global' || scope === 'board';
      const clearable = CLEAR_BOARD_READING_FIELD_ENUM.includes(field);

      // Reachable ⟺ the model can clear it AND the write side stamps a slot
      // Symbol for it. Either half missing makes mechanism B a no-op.
      // Jest's `expect` takes no message argument, so the diagnosis rides in
      // the asserted VALUE — a failure prints the remedy instead of a bare
      // `true !== false`.
      const verdict =
        clearable && classified
          ? `COLLAPSE-REACHABLE: ${field} (clearable=${clearable}, scope=${String(scope)}). ${REMEDY}`
          : 'unreachable';
      expect(verdict).toBe('unreachable');
    }
  );

  test('BOARD_CLEAR_SCOPE_MAP is still A1a-minimal — a widened map is the tripwire for the above', () => {
    // Not a style pin: every entry ADDED here is a field that becomes
    // collapse-capable, so this is the single place a reviewer can see the
    // blast radius of A1b's classification sweep. If A1b widens the map, this
    // expectation is meant to be updated DELIBERATELY, after re-running the
    // per-field checks above.
    expect(Object.keys(BOARD_CLEAR_SCOPE_MAP).sort()).toEqual(['manufacturer', 'pfc', 'ze']);
  });
});
