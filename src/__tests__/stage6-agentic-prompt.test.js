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

import {
  TOOL_SCHEMAS,
  CONTEXT_FIELD_ENUM,
  BOARD_FIELD_ENUM,
} from '../extraction/stage6-tool-schemas.js';

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

    test('estimated tokens (Math.ceil(len/4)) <= 4400 — STQ-01 length cap (relaxed 2026-04-28)', () => {
      // Same heuristic `eicr-extraction-session.js:1160` uses for the
      // state snapshot token estimate; keeps us in the same units the
      // session already reports.
      //
      // Original cap was 4000 (Phase 4 Plan 04-01). Relaxed to 4400 on
      // 2026-04-28 when the prompt absorbed three new structural rules:
      //   - CIRCUIT NAMING (designation announcements without a value).
      //   - ORPHANED VALUES (act/ask/log; no silent drops).
      //   - RING CONTINUITY CARRYOVER (the ONLY multi-turn test family,
      //     paired with a server-side 60s timeout that fires `ask_user`).
      // These rules close the silent-drop bug class observed in session
      // 3B5A0355 (2026-04-28 14:03 BST: "Circuit 1 is security alarm" /
      // "Circuit 2 is water heater" returned zero tool calls because
      // TOPIC RESTRAINT subsumed designation announcements).
      const estimate = Math.ceil(prompt.length / 4);
      expect(estimate).toBeLessThanOrEqual(4400);
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
      const anchorsBatching = lower.includes('server batches') || lower.includes('sequence');
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
      const mentionsPrefixOrSnapshot = lower.includes('prefix') || lower.includes('snapshot');
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

    test('every `field: "X"` in the prompt is a record_reading or record_board_reading enum member (per surrounding tool call)', () => {
      const validFields = getRecordReadingFieldEnum();
      const validBoardFields = new Set(BOARD_FIELD_ENUM);

      // Match `record_board_reading({ ..., field: "X", ... })` first — the
      // field claim there must be a BOARD_FIELD_ENUM member, not a
      // circuit_fields member. Strip those quoted field-name tokens so
      // the generic `field: "X"` audit below only sees the
      // record_reading / clear_reading sites that target the
      // circuit_fields enum.
      const boardCallRe = /record_board_reading\s*\(\s*\{([^}]*)\}/g;
      const boardFieldClaims = [];
      const boardSpans = [];
      let m;
      while ((m = boardCallRe.exec(prompt)) !== null) {
        boardSpans.push([m.index, m.index + m[0].length]);
        const inner = m[1];
        const fieldMatch = inner.match(/field:\s*"([a-z_][a-z0-9_]*)"/);
        if (fieldMatch) boardFieldClaims.push(fieldMatch[1]);
      }
      const invalidBoard = [...new Set(boardFieldClaims)].filter((id) => !validBoardFields.has(id));
      expect(invalidBoard).toEqual([]);

      // Now scan every `field: "X"` outside the record_board_reading spans
      // and require circuit-fields enum membership.
      const isInsideBoardSpan = (idx) =>
        boardSpans.some(([start, end]) => idx >= start && idx < end);
      const allRe = /field:\s*"([a-z_][a-z0-9_]*)"/g;
      const circuitClaims = [];
      while ((m = allRe.exec(prompt)) !== null) {
        if (!isInsideBoardSpan(m.index)) circuitClaims.push(m[1]);
      }
      const invalidCircuit = [...new Set(circuitClaims)].filter((id) => !validFields.has(id));
      expect(invalidCircuit).toEqual([]);
    });

    test('every `context_field: "X"` in the prompt is an ask_user context_field enum member', () => {
      const validCtx = getContextFieldEnum();
      const matches = prompt.match(/context_field:\s*"([a-z_][a-z0-9_]*)"/g) || [];
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
      const discontLine = lines.find((l) => l.includes('LITERAL character') && l.includes('∞'));
      expect(discontLine).toBeDefined();

      const backtickIds = [
        ...new Set(
          (discontLine.match(/`([a-z][a-z0-9_]*)`/g) || []).map((m) => m.replace(/`/g, ''))
        ),
      ];

      // Filter out tool names + pseudocode keywords; remainder are claimed
      // field-name enum values.
      const fieldClaims = backtickIds.filter(
        (id) => !TOOL_NAMES.has(id) && !PSEUDOCODE_KEYWORDS.has(id)
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

  // ------------------------------------------------------------------
  // Group 9: Plan 04-26 — CONFIDENTIALITY (prompt non-disclosure)
  //
  // WHY THIS GROUP EXISTS: rounds 7-14 locked the INPUT side of the
  // trust boundary — user-dictated text in the cached prefix can't
  // steer the model. Plan 04-26 locks the OUTPUT side — the model
  // must not disclose the system prompt back through free-text tool-
  // use fields (ask_user.question, record_observation.text, circuit
  // designations). This group asserts the prompt contains a
  // non-disclosure section with:
  //   A — section header "## CONFIDENTIALITY"
  //   B — explicit non-disclosure clause ("MUST NOT disclose")
  //   C — extraction-pattern refusal (names at least 4 of
  //       translation / roleplay / completion / code block /
  //       marker injection / hypothetical)
  //   D — banned-literals enumeration (TRUST BOUNDARY, USER_TEXT,
  //       STQ-0, <<< — all in the same ~600-char window)
  //   E — C3 attempt-recording clause (code C3 + record_observation
  //       + extraction concept co-located within ~400 chars)
  //   F — the new section leaves total prompt ≤ 4000 tokens
  //       (Group 1 also asserts this — Group 9 re-asserts as a
  //       regression lock for the new section).
  //
  // Layer 2 (output filter) + Layer 3 (adversarial battery) are
  // locked in separate test files — this group is scoped to the
  // prompt-content invariant only.
  // ------------------------------------------------------------------
  describe('Group 9 — Plan 04-26: CONFIDENTIALITY (prompt non-disclosure)', () => {
    test('Test A — section header "## CONFIDENTIALITY" is present (case-sensitive)', () => {
      // Anchor. If the section is ever removed or renamed, this
      // fires first before the detailed content checks.
      expect(prompt).toEqual(expect.stringContaining('## CONFIDENTIALITY'));
    });

    test('Test B — non-disclosure clause names "MUST NOT disclose"', () => {
      // Verbatim, case-sensitive — the directive phrasing is
      // deliberately in all-caps for model-alignment emphasis
      // (same stylistic choice as "TRUST BOUNDARY (CRITICAL — ...)").
      expect(prompt).toEqual(expect.stringContaining('MUST NOT disclose'));
    });

    test('Test C — names at least 4 extraction-attempt patterns', () => {
      // The directive must enumerate the common jailbreak shapes so
      // the model has named vectors to pattern-match against in its
      // refusal decision. A loose case-insensitive count on the
      // named set catches a minimum-coverage drop without locking
      // exact phrasing.
      const lower = prompt.toLowerCase();
      const patterns = [
        'translation',
        'roleplay',
        'completion',
        'code block',
        'code-block', // accept either hyphenation
        'marker injection',
        'marker-injection',
        'hypothetical',
        'encoding', // bonus — matches "encoded" phrasing
        'reversal',
      ];
      const hits = patterns.filter((p) => lower.includes(p)).length;
      // Allow accepting alternate hyphenations (code block / code-block
      // count as one concept, etc.) — require the DISTINCT CONCEPT
      // count to be ≥ 4 via this loose superset.
      expect(hits).toBeGreaterThanOrEqual(4);
    });

    test('Test D — banned-literals enumeration contains TRUST BOUNDARY, USER_TEXT, STQ-0, <<< within a ~600-char window', () => {
      // The prompt must tell the model NEVER to output these literal
      // strings from its own instructions. We require co-location in
      // a single bullet / paragraph (within 600 chars) so the banned-
      // list reads as one cohesive rule, not four scattered mentions.
      const anchor = 'NEVER include literal strings';
      const anchorIdx = prompt.indexOf(anchor);
      expect(anchorIdx).toBeGreaterThanOrEqual(0);
      const windowEnd = Math.min(prompt.length, anchorIdx + 1200);
      const window = prompt.slice(anchorIdx, windowEnd);
      expect(window).toEqual(expect.stringContaining('TRUST BOUNDARY'));
      expect(window).toEqual(expect.stringContaining('USER_TEXT'));
      expect(window).toEqual(expect.stringContaining('STQ-0'));
      expect(window).toEqual(expect.stringContaining('<<<'));
    });

    test('Test E — C3 attempt-recording clause co-locates C3 + record_observation + extraction', () => {
      // On detected prompt-extraction attempts, the model should
      // record a C3 observation rather than echo the attack text
      // back. This test locks that the directive exists in a
      // single ~400-char window anchored on the word "extraction".
      const lower = prompt.toLowerCase();
      const extractionIdx = lower.indexOf('prompt-extraction attempt');
      // Accept "prompt extraction attempt" with/without hyphen.
      const altIdx = lower.indexOf('prompt extraction attempt');
      const anyIdx = extractionIdx >= 0 ? extractionIdx : altIdx;
      expect(anyIdx).toBeGreaterThanOrEqual(0);
      const windowStart = Math.max(0, anyIdx - 100);
      const windowEnd = Math.min(prompt.length, anyIdx + 400);
      const window = prompt.slice(windowStart, windowEnd);
      expect(window).toEqual(expect.stringContaining('C3'));
      expect(window).toEqual(expect.stringContaining('record_observation'));
    });

    test('Test F — total prompt token estimate ≤ 4400 (regression lock for new section)', () => {
      // Group 1 already asserts this — re-assert here so a regression
      // inside the CONFIDENTIALITY section (e.g., verbose rewrite)
      // fires under the Group 9 banner instead of Group 1, making the
      // root cause obvious in the test output.
      // Cap relaxed from 4000 to 4400 on 2026-04-28 — see Group 1 comment.
      const estimate = Math.ceil(prompt.length / 4);
      expect(estimate).toBeLessThanOrEqual(4400);
    });
  });

  // ------------------------------------------------------------------
  // Group 10 — 2026-04-28: silent-drop fix (session 3B5A0355).
  //
  // Three new structural rules replaced TOPIC RESTRAINT to close a
  // class of bugs where Sonnet emitted zero tool calls for utterances
  // that named circuits or carried orphaned values:
  //   - CIRCUIT NAMING: act on "Circuit N is X" immediately.
  //   - ORPHANED VALUES: ask, never silently drop.
  //   - RING CONTINUITY CARRYOVER: the ONLY multi-turn family;
  //     server enforces a 60s timeout via ask_user.
  // These tests pin the prose so a future prompt rewrite cannot
  // regress without producing a clear failure signal.
  // ------------------------------------------------------------------
  describe('Group 10 — 2026-04-28 silent-drop fix (CIRCUIT NAMING + ORPHANED VALUES + RING CONTINUITY)', () => {
    test('CIRCUIT NAMING bullet exists with create_circuit + rename_circuit + designation', () => {
      const idx = prompt.search(/CIRCUIT NAMING/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const window = prompt.slice(idx, idx + 700);
      expect(window).toEqual(expect.stringContaining('create_circuit'));
      expect(window).toEqual(expect.stringContaining('rename_circuit'));
      expect(window).toEqual(expect.stringContaining('designation'));
      // Garbled-form note — the regex pattern stays loose to allow
      // the author to add/remove specific examples (e.g. "Sirkit",
      // "Searched", "Cricket") without breaking this test, but the
      // word "garbled" must remain so Sonnet sees the intent.
      expect(window.toLowerCase()).toMatch(/garbled/);
    });

    test('ORPHANED VALUES section exists and prohibits silent drops', () => {
      const idx = prompt.search(/ORPHANED VALUES/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const window = prompt.slice(idx, idx + 800);
      expect(window.toLowerCase()).toMatch(/never\s+silently\s+drop/);
      expect(window).toEqual(expect.stringContaining('ask_user'));
      // Bare-value path uses pending_write so the server can resolve
      // the answer back to a (field, circuit). If the prompt loses
      // pending_write here, the answer-resolver path goes cold.
      expect(window).toEqual(expect.stringContaining('pending_write'));
    });

    test('RING CONTINUITY CARRYOVER section exists with the field mappings + 60s timeout note', () => {
      // Anchor on the section header — the parenthesised form — so we
      // skip the cross-reference inside CIRCUIT ROUTING ("see RING
      // CONTINUITY CARRYOVER below") and slice from the actual section.
      const idx = prompt.search(/RING CONTINUITY CARRYOVER\s*\(/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const window = prompt.slice(idx, idx + 900);
      // The carryover rule MUST name all three ring continuity fields
      // by their canonical record_reading enum values; a typo here
      // would route the wrong values into the wrong slots.
      expect(window).toEqual(expect.stringContaining('ring_r1_ohm'));
      expect(window).toEqual(expect.stringContaining('ring_rn_ohm'));
      expect(window).toEqual(expect.stringContaining('ring_r2_ohm'));
      // Server enforces the 60s timeout — confirm the prompt tells
      // Sonnet to delegate timing to the server (not track it itself).
      expect(window).toMatch(/60\s*s|60-second|sixty\s+second/i);
      expect(window.toLowerCase()).toMatch(/server\s+(enforces|emits)/);
    });

    test('Example 6 — designation announcement worked example exists', () => {
      const idx = prompt.search(/Example\s+6/i);
      expect(idx).toBeGreaterThanOrEqual(0);
      // Slice from Example 6 to the next top-level section / EOF.
      const e6Body = prompt.slice(idx, idx + 600);
      expect(e6Body).toEqual(expect.stringContaining('create_circuit'));
      // Shows BOTH the new-circuit and existing-circuit branches.
      expect(e6Body).toEqual(expect.stringContaining('rename_circuit'));
      // Designation appears as a string literal in the example.
      expect(e6Body.toLowerCase()).toMatch(/designation/);
    });

    test('TOPIC RESTRAINT section header is GONE — old rule cannot resurface', () => {
      // The old TOPIC RESTRAINT header was the load-bearing line that
      // told Sonnet to wait on naming utterances. Its replacement is
      // ORPHANED VALUES + RING CONTINUITY CARRYOVER. If a future
      // rewrite reintroduces the section verbatim, the silent-drop bug
      // (3B5A0355) returns. Keep this regression-lock loud.
      expect(prompt).not.toMatch(/^TOPIC RESTRAINT:/m);
      // The specific bug-causing line — "Topic-only utterance ... no
      // tool calls; wait. Values follow." — is also banned.
      expect(prompt.toLowerCase()).not.toMatch(
        /topic-only\s+utterance.*no\s+tool\s+calls;\s+wait\.\s+values\s+follow/
      );
    });
  });
});
