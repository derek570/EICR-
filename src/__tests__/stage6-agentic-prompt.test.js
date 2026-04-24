/**
 * Stage 6 Phase 4 Plan 04-01 — content invariants for
 * `config/prompts/sonnet_agentic_system.md`.
 *
 * This test locks the prose deliverable of the agentic extraction
 * prompt so future edits cannot silently drop a directive, an
 * example, or the TRUST BOUNDARY section. It is deliberately
 * tolerant on wording where it can be (so the author picks the
 * phrasing) and strict on the one sentence REQUIREMENTS.md STQ-05
 * pins verbatim.
 *
 * Structure (7 groups, ~19 assertions):
 *   1. File existence + token budget — STQ-01 length cap.
 *   2. STQ-01 agentic directives (5 tests).
 *   3. TRUST BOUNDARY port — Phase 3 r20 regression lock
 *      (commit b339527). Must survive every Phase 4+ rewrite.
 *   4. STQ-02 — four worked examples, in order.
 *   5. STQ-05 — restraint section + verbatim sentence.
 *   6. Tool-call-only contract — no references to legacy
 *      `questions_for_user` / `extracted_readings` JSON fields
 *      (STQ-04 deletes that path in Plan 04-03; the new prompt
 *      must never mention it).
 *   7. STS-09 — prompt acknowledges cached prefix as state surface.
 *
 * The prompt is inert in this plan — Plan 04-02 wires it into
 * EICRExtractionSession. This file only asserts content invariants.
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_SCHEMAS, CONTEXT_FIELD_ENUM } from '../extraction/stage6-tool-schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'config',
  'prompts',
  'sonnet_agentic_system.md'
);

// STQ-05 VERBATIM sentence. Emdash character (U+2014), not double-hyphen.
// If the author edits a single character of this sentence, the test
// breaks — which is precisely what we want: this is the contract.
const STQ_05_VERBATIM =
  'If you have already asked about field F for circuit C this session and did not get a clear answer, do not ask again — write what you believe and move on. The user will correct you if wrong.';

describe('sonnet_agentic_system.md — STQ-01/02/05 content invariants', () => {
  let prompt;

  beforeAll(() => {
    prompt = fssync.readFileSync(PROMPT_PATH, 'utf8');
  });

  // ------------------------------------------------------------------
  // Group 1: file existence + token budget
  // ------------------------------------------------------------------
  describe('Group 1 — file + token budget', () => {
    test('loads the prompt file without throwing (UTF-8 readable)', () => {
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    test('estimated tokens (Math.ceil(len/4)) <= 4000 — STQ-01 length cap', () => {
      // Same heuristic `eicr-extraction-session.js:1160` uses for the
      // state snapshot token estimate; keeps us in the same units the
      // session already reports.
      const estimate = Math.ceil(prompt.length / 4);
      expect(estimate).toBeLessThanOrEqual(4000);
    });
  });

  // ------------------------------------------------------------------
  // Group 2: STQ-01 agentic directives (5 tests)
  // ------------------------------------------------------------------
  describe('Group 2 — STQ-01 agentic directives', () => {
    test('names all seven tools verbatim (record_reading, clear_reading, create_circuit, rename_circuit, record_observation, delete_observation, ask_user)', () => {
      // Case-sensitive substring match — these are the API-level names
      // declared in stage6-tool-schemas.js and must match exactly.
      expect(prompt).toEqual(expect.stringContaining('record_reading'));
      expect(prompt).toEqual(expect.stringContaining('clear_reading'));
      expect(prompt).toEqual(expect.stringContaining('create_circuit'));
      expect(prompt).toEqual(expect.stringContaining('rename_circuit'));
      expect(prompt).toEqual(expect.stringContaining('record_observation'));
      expect(prompt).toEqual(expect.stringContaining('delete_observation'));
      expect(prompt).toEqual(expect.stringContaining('ask_user'));
    });

    test('contains a "prefer silent writes" directive (STQ-01 #2)', () => {
      // Lock the phrase the author uses. "silent writes" is the stable
      // keyword drawn straight from REQUIREMENTS.md STQ-01.
      expect(prompt.toLowerCase()).toEqual(expect.stringContaining('silent writes'));
    });

    test('describes corrections as writes — clear_reading + record_reading within one section (STQ-01 #3)', () => {
      // All three substrings must appear within a ~500-char window to
      // prove they are co-located in a single section (not just
      // scattered through the prompt).
      const lower = prompt.toLowerCase();
      const correctionIdx = lower.indexOf('correction');
      expect(correctionIdx).toBeGreaterThanOrEqual(0);
      const windowStart = Math.max(0, correctionIdx - 250);
      const windowEnd = Math.min(prompt.length, correctionIdx + 500);
      const section = prompt.slice(windowStart, windowEnd);
      expect(section).toEqual(expect.stringContaining('clear_reading'));
      expect(section).toEqual(expect.stringContaining('record_reading'));
    });

    test('contains the utterance-batching restraint (STQ-01 #4)', () => {
      // Loose AND match — the MODEL must know it is not allowed to
      // ask mid-sequence because the server batches utterances.
      const lower = prompt.toLowerCase();
      // Either "server batches" or "sequence" anchors the batching idea.
      const anchorsBatching =
        lower.includes('server batches') || lower.includes('sequence');
      expect(anchorsBatching).toBe(true);
      // Plus an explicit prohibition on asking mid-utterance.
      expect(lower).toEqual(expect.stringContaining('do not ask before'));
    });

    test('contains the out_of_range_circuit guidance (STQ-01 #5)', () => {
      expect(prompt).toEqual(expect.stringContaining('out_of_range_circuit'));
      // And names creation as part of the guidance (either "create" or
      // "create_circuit" — both satisfy the requirement).
      expect(prompt.toLowerCase()).toEqual(expect.stringContaining('create'));
    });
  });

  // ------------------------------------------------------------------
  // Group 3: TRUST BOUNDARY port (Phase 3 r20 lineage)
  // ------------------------------------------------------------------
  describe('Group 3 — TRUST BOUNDARY port (Phase 3 r20 lineage, commit b339527)', () => {
    test('contains header "TRUST BOUNDARY" exactly', () => {
      // The existing stage6-prompt-trust-boundary.test.js pins the
      // same header on the legacy prompts; the agentic prompt must
      // continue the lineage or the regression lock re-opens.
      expect(prompt).toEqual(expect.stringContaining('TRUST BOUNDARY'));
    });

    test('names untrusted_user_text verbatim (the field-name contract)', () => {
      expect(prompt).toEqual(expect.stringContaining('untrusted_user_text'));
    });

    test('prohibits treating untrusted_user_text as a directive or instruction', () => {
      // Lock the prohibition concept — same assertion family as the
      // existing trust-boundary test on the legacy prompts.
      expect(prompt.toLowerCase()).toMatch(/never\s+as\s+(a\s+)?(directive|instruction)/);
      // And also names the canonical prompt-injection string so the
      // directive is unambiguous.
      expect(prompt.toLowerCase()).toEqual(expect.stringContaining('ignore previous instructions'));
    });
  });

  // ------------------------------------------------------------------
  // Group 4: Four STQ-02 worked examples
  // ------------------------------------------------------------------
  describe('Group 4 — four STQ-02 worked examples (in order)', () => {
    test('Example 1 — routine capture has record_reading', () => {
      expect(prompt).toMatch(/Example\s+1/i);
      // Slice the prompt at Example 1 and look for record_reading
      // before Example 2 — ensures the tool-call is inside the example.
      const e1Idx = prompt.search(/Example\s+1/i);
      const e2Idx = prompt.search(/Example\s+2/i);
      expect(e1Idx).toBeGreaterThanOrEqual(0);
      expect(e2Idx).toBeGreaterThan(e1Idx);
      const e1Body = prompt.slice(e1Idx, e2Idx);
      expect(e1Body).toEqual(expect.stringContaining('record_reading'));
    });

    test('Example 2 — correction has BOTH clear_reading AND record_reading', () => {
      expect(prompt).toMatch(/Example\s+2/i);
      const e2Idx = prompt.search(/Example\s+2/i);
      const e3Idx = prompt.search(/Example\s+3/i);
      expect(e2Idx).toBeGreaterThanOrEqual(0);
      expect(e3Idx).toBeGreaterThan(e2Idx);
      const e2Body = prompt.slice(e2Idx, e3Idx);
      expect(e2Body).toEqual(expect.stringContaining('clear_reading'));
      expect(e2Body).toEqual(expect.stringContaining('record_reading'));
    });

    test('Example 3 — ambiguous circuit has ask_user AND create_circuit', () => {
      expect(prompt).toMatch(/Example\s+3/i);
      const e3Idx = prompt.search(/Example\s+3/i);
      const e4Idx = prompt.search(/Example\s+4/i);
      expect(e3Idx).toBeGreaterThanOrEqual(0);
      expect(e4Idx).toBeGreaterThan(e3Idx);
      const e3Body = prompt.slice(e3Idx, e4Idx);
      expect(e3Body).toEqual(expect.stringContaining('ask_user'));
      expect(e3Body).toEqual(expect.stringContaining('create_circuit'));
    });

    test('Example 4 — batched readings mentions record_reading at least twice', () => {
      expect(prompt).toMatch(/Example\s+4/i);
      const e4Idx = prompt.search(/Example\s+4/i);
      expect(e4Idx).toBeGreaterThanOrEqual(0);
      // Example 4 is the last example — slice to end of prompt (or to
      // the next top-level section, whichever comes first; in practice
      // end-of-file is fine — we only need to confirm ≥2 hits occur
      // AFTER the Example 4 header).
      const e4Body = prompt.slice(e4Idx);
      const matches = e4Body.match(/record_reading/g) || [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ------------------------------------------------------------------
  // Group 5: STQ-05 restraint section
  // ------------------------------------------------------------------
  describe('Group 5 — STQ-05 restraint section', () => {
    test('contains a section header matching /RESTRAINT/i', () => {
      expect(prompt).toMatch(/RESTRAINT/i);
    });

    test('contains the STQ-05 verbatim sentence (emdash character, not double-hyphen)', () => {
      // Single-pass indexOf — character-for-character match.
      expect(prompt.includes(STQ_05_VERBATIM)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 6: tool-call-only contract
  // ------------------------------------------------------------------
  describe('Group 6 — tool-call-only contract (STQ-04 legacy JSON paths absent)', () => {
    test('does NOT contain the substring "questions_for_user"', () => {
      // STQ-04: legacy JSON field is deleted in Plan 04-03. The new
      // prompt must never reference it — that path is extinct.
      expect(prompt.includes('questions_for_user')).toBe(false);
    });

    test('does NOT contain the substring "extracted_readings"', () => {
      // Same reasoning as above — writes are tool calls, not JSON.
      expect(prompt.includes('extracted_readings')).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Group 7: STS-09 cached-prefix acknowledgement
  // ------------------------------------------------------------------
  describe('Group 7 — STS-09 cached-prefix acknowledgement', () => {
    test('prompt describes the cached prefix / snapshot as the state read surface', () => {
      const lower = prompt.toLowerCase();
      expect(lower).toEqual(expect.stringContaining('cached'));
      const mentionsPrefixOrSnapshot =
        lower.includes('prefix') || lower.includes('snapshot');
      expect(mentionsPrefixOrSnapshot).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 8: Plan 04-07 r1 — field-name audit against schema enum.
  //
  // WHY THIS GROUP EXISTS: Codex STG r1 (2026-04-23) flagged the
  // `r1_plus_r2` vs `r1_r2_ohm` typo on prompt line 159. Cross-check
  // expanded the audit and found 11 distinct field-name mismatches
  // across every worked example. Under strict:true tool schemas
  // (STS-08), any of these would cause the Anthropic API to reject
  // the tool call at dispatch. This group locks the prompt's field
  // names against the CANONICAL SOURCE (stage6-tool-schemas.js at
  // test-time), so the prompt cannot silently drift from the enum
  // ever again — a future phase that widens the enum auto-updates
  // this test; a future prompt edit that invents a new alias breaks
  // this test loudly.
  //
  // AUDIT SCOPE: three surfaces in the prompt, all derived from the
  // same enum sources:
  //   1. `field: "X"` patterns inside worked-example pseudocode.
  //      Must be a member of record_reading.field enum.
  //   2. `context_field: "X"` patterns inside ask_user pseudocode.
  //      Must be a member of ask_user.context_field enum (circuit
  //      fields + sentinels).
  //   3. Backtick-quoted field names on the EDGE CASES discontinuous-
  //      continuity line — explicit enumeration of ring/continuity
  //      field keys where the model is told to write "∞".
  // ------------------------------------------------------------------
  describe('Group 8 — Plan 04-07 r1: field-name audit (Codex MAJOR #1)', () => {
    function getRecordReadingFieldEnum() {
      const tool = TOOL_SCHEMAS.find((t) => t.name === 'record_reading');
      if (!tool) throw new Error('record_reading schema not found');
      return new Set(tool.input_schema.properties.field.enum);
    }

    function getContextFieldEnum() {
      // ask_user.context_field accepts circuit_fields keys + sentinels + null.
      // CONTEXT_FIELD_ENUM is the exported single source of truth.
      // Filter out null (not a quoted string), stringify the rest for lookup.
      return new Set(CONTEXT_FIELD_ENUM.filter((v) => typeof v === 'string'));
    }

    test('record_reading enum is non-empty and correctly codegenned', () => {
      const validFields = getRecordReadingFieldEnum();
      // Sanity: the enum must exist and contain the canonical Zs field.
      // If this fails, something is wrong with the test setup — the
      // field-name audit below would otherwise return false positives.
      expect(validFields.size).toBeGreaterThan(0);
      expect(validFields.has('measured_zs_ohm')).toBe(true);
      expect(validFields.has('r1_r2_ohm')).toBe(true);
      expect(validFields.has('polarity_confirmed')).toBe(true);
      expect(validFields.has('ir_live_live_mohm')).toBe(true);
      expect(validFields.has('ir_live_earth_mohm')).toBe(true);
    });

    test('every `field: "X"` in the prompt is a record_reading enum member', () => {
      const validFields = getRecordReadingFieldEnum();
      // Match `field: "snake_case_identifier"` — quoted values inside
      // worked-example pseudocode. Double-quoted form only; the prompt
      // uses "..." around pseudocode values throughout.
      const matches = prompt.match(/field:\s*"([a-z_][a-z0-9_]*)"/g) || [];
      const ids = [...new Set(matches.map((m) => m.match(/"([^"]+)"/)[1]))];

      const invalid = ids.filter((id) => !validFields.has(id));
      expect(invalid).toEqual([]);
    });

    test('every `context_field: "X"` in the prompt is an ask_user context_field enum member', () => {
      const validCtx = getContextFieldEnum();
      const matches =
        prompt.match(/context_field:\s*"([a-z_][a-z0-9_]*)"/g) || [];
      const ids = [...new Set(matches.map((m) => m.match(/"([^"]+)"/)[1]))];

      const invalid = ids.filter((id) => !validCtx.has(id));
      expect(invalid).toEqual([]);
    });

    test('every backticked field name on the EDGE CASES discontinuous-continuity line is a record_reading enum member', () => {
      // Locate the EDGE CASES discontinuous-continuity line. The prompt
      // line shape (post-fix) is: "Discontinuous continuity: emit the
      // LITERAL character "∞" (U+221E) as the `value` for `FIELD1`,
      // `FIELD2`, ... and call `record_observation`...".
      //
      // We extract all backtick-quoted tokens on the line and filter
      // out tool names / pseudocode keywords (value, record_observation,
      // etc.), leaving only identifiers that are claimed to be
      // record_reading field names.
      const validFields = getRecordReadingFieldEnum();
      const TOOL_NAMES = new Set(TOOL_SCHEMAS.map((t) => t.name));
      const PSEUDOCODE_KEYWORDS = new Set(['value', 'tool_result', 'code']);

      // Find the Discontinuous continuity bullet. Accept either heading
      // convention in case a future edit rewords "Discontinuous continuity"
      // slightly — we look for the "LITERAL character ∞" anchor which
      // is stable across edits.
      const lines = prompt.split(/\r?\n/);
      const discontLine = lines.find(
        (l) => l.includes('LITERAL character') && l.includes('∞'),
      );
      expect(discontLine).toBeDefined();

      const backtickIds = [
        ...new Set(
          (discontLine.match(/`([a-z][a-z0-9_]*)`/g) || []).map((m) =>
            m.replace(/`/g, ''),
          ),
        ),
      ];

      // Filter out tool names + pseudocode keywords; remainder are claimed
      // field-name enum values.
      const fieldClaims = backtickIds.filter(
        (id) => !TOOL_NAMES.has(id) && !PSEUDOCODE_KEYWORDS.has(id),
      );

      // There SHOULD be at least one field claim on this line (otherwise
      // the prompt has dropped the explicit enumeration and the test is
      // vacuous). Lock that.
      expect(fieldClaims.length).toBeGreaterThan(0);

      const invalid = fieldClaims.filter((id) => !validFields.has(id));
      expect(invalid).toEqual([]);
    });

    test('prompt does NOT contain the broken `r1_plus_r2` alias (Codex MAJOR #1 direct regression lock)', () => {
      // Direct regression lock on the specific typo Codex flagged. If a
      // future refactor re-introduces this string, this test fires loudly
      // rather than waiting for the full-enum audit to catch it.
      expect(prompt.includes('r1_plus_r2')).toBe(false);
    });

    test('prompt does NOT reference `address`/`client_address` as a record_reading field or ask_user context_field', () => {
      // Plan 04-07 decision: Circuit-0 installation-level write surface
      // is a pre-existing design gap — `address`/`client_address` are
      // NOT in the strict enum, so the model cannot write them via
      // record_reading today. Remove the dead disambiguation language
      // rather than paper-over. Deferred to follow-up plan.
      //
      // Lock: neither identifier appears as a `field: "..."` nor
      // `context_field: "..."` in the prompt pseudocode.
      expect(prompt).not.toMatch(/field:\s*"address"/);
      expect(prompt).not.toMatch(/field:\s*"client_address"/);
      expect(prompt).not.toMatch(/context_field:\s*"address"/);
      expect(prompt).not.toMatch(/context_field:\s*"client_address"/);
    });
  });
});
