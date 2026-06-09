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
// 2026-05-02 — the BS 7671 EICR Schedule of Inspections is appended to
// every system prompt at module init in eicr-extraction-session.js. The
// content invariants below run against the BASE markdown so author intent
// stays test-locked, but the token-budget assertion below must reflect
// the COMBINED prompt the model actually sees.
const SCHEDULE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'config',
  'prompts',
  'schedule-of-inspection-bs7671-eicr.md'
);
// 2026-06-03 — WRAG (Wiring Regulations Advisory Group) Q&As are appended
// after the Schedule of Inspections at module init. Same rationale as the
// schedule append: the model needs the gap-fillers for cases BPG4 7.3 is
// silent on, plus the no-direct-match reasoning fallback to prevent the
// default-to-C2 over-coding tendency. Token-budget assertion below
// combines all three (base + schedule + wrag) so the cap reflects what
// the model actually sees.
const WRAG_PATH = path.join(__dirname, '..', '..', 'config', 'prompts', 'wrag-bs7671-eicr.md');

// STQ-05 VERBATIM sentence. Emdash character (U+2014), not double-hyphen.
// If the author edits a single character of this sentence, the test
// breaks — which is precisely what we want: this is the contract.
const STQ_05_VERBATIM =
  'If you have already asked about field F for circuit C this session and did not get a clear answer, do not ask again — write what you believe and move on. The user will correct you if wrong.';

describe('sonnet_agentic_system.md — STQ-01/02/05 content invariants', () => {
  let prompt;
  let schedule;
  let wrag;
  let combinedPrompt;

  beforeAll(() => {
    prompt = fssync.readFileSync(PROMPT_PATH, 'utf8');
    schedule = fssync.readFileSync(SCHEDULE_PATH, 'utf8');
    wrag = fssync.readFileSync(WRAG_PATH, 'utf8');
    // Mirror the concatenation done in eicr-extraction-session.js so the
    // budget check sees the same byte stream the model does.
    combinedPrompt = prompt.trimEnd() + '\n\n' + schedule.trimEnd() + '\n\n' + wrag;
  });

  // ------------------------------------------------------------------
  // Group 1: file existence + token budget
  // ------------------------------------------------------------------
  describe('Group 1 — file + token budget', () => {
    test('loads the prompt file without throwing (UTF-8 readable)', () => {
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    test('loads the BS 7671 schedule appendix without throwing', () => {
      expect(typeof schedule).toBe('string');
      expect(schedule.length).toBeGreaterThan(0);
      // Spot-check a couple of refs that anchor the schedule's structure.
      // Used by future regression detection if the appendix is silently
      // truncated; doesn't pin specific wording.
      expect(schedule).toEqual(expect.stringContaining('5.18'));
      expect(schedule).toEqual(expect.stringContaining('4.5'));
    });

    test('combined prompt + schedule estimated tokens (Math.ceil(len/4)) <= 7500 — STQ-01 length cap (relaxed 2026-05-02)', () => {
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
      //
      // Relaxed to 4500 on 2026-05-01 (am) when the start_dialogue_script
      // entry rule was tightened with the "instance or" garble example.
      //
      // Relaxed to 4700 on 2026-05-01 (pm) when the BPG4 pipeline was
      // restored — adding the SCHEDULE OF INSPECTION block + 8 example
      // mappings to drive iOS's ObservationScheduleLinker.
      //
      // 2026-05-02: example mappings stripped. Field test 2026-05-01
      // (session 0FA1BCA0) showed the model anchoring on "4.5 for damaged
      // enclosure" and applying it to a cracked SOCKET-OUTLET (correct
      // ref: 5.18 — Condition of accessories). Replaced the 8 examples
      // with the COMPLETE BS 7671 EICR Schedule of Inspections (99 items)
      // appended at module init. The cap is now measured against the
      // combined prompt so this test sees what the model sees. Combined
      // ~7012 tokens; cap 7500 leaves ~500-token headroom for future
      // schedule-item refinements while making any unbounded growth in
      // either file fail loudly.
      //
      // 2026-05-04: relaxed to 8100 to absorb the +3 new tools
      // (delete_circuit, calculate_zs, calculate_r1_plus_r2) plus their
      // worked examples. Each tool adds ~100-150 tokens (definition +
      // example + ring-final ask-first rule). Three tools ≈ +500
      // tokens; cap moved by +600 to keep ~100-token headroom. Field
      // test 2026-05-04 session 07635782 surfaced all three.
      // 2026-05-07 (multi-board sprint Phase 7.1): relaxed to 8600 to
      // absorb the new MULTI-BOARD ROUTING block. Three tools
      // (add_board, select_board, mark_distribution_circuit) plus the
      // implicit currentBoardId routing note ≈ +400 tokens; cap moved
      // by +500 to keep ~100-token headroom. PHASE6_PHASE7_AUTONOMOUS.md
      // slice 7.1 specifies the block verbatim from PLAN.md L626-649.
      // 2026-05-08 ("Work on Board" Phase B): relaxed to 8750 to
      // absorb the SINGLE-BOARD FOCUS paragraph. The new paragraph
      // codifies the dispatcher's `wrong_board` rejection so Sonnet
      // does not waste a turn discovering it; ≈ +30 tokens; cap moved
      // by +150 to keep ~100-token headroom.
      // 2026-06-03 (BPG4 7.3 / BS 7671 A4 refresh): bumped to 8850 to
      // absorb the FI "advised not required" wording change and the
      // BPG4 Issue 7.1 → 7.3 reference update. The 7.3 framing of FI
      // is a correctness fix (sole FI no longer auto-Unsatisfactory)
      // and the version anchor lets the model apply the right A4
      // regulation renumbering (414.3(d), 443.4.1 (a)&(c), 543.1.1.1).
      // ≈ +15 tokens; cap moved by +100 to keep ~85-token headroom.
      // 2026-06-03 (WRAG corpus append): the 25 coding-relevant
      // Wiring Regulations Advisory Group Q&As are now appended to the
      // system prompt at module init alongside the Schedule of Inspections.
      // The corpus fills the gaps where BPG4 7.3 is silent and pins the
      // no-direct-match reasoning fallback (default to C3; name the
      // foreseeable event for C2; never cite forum content). Empirical
      // measurement: combined prompt jumps from ~8750 to ~11036 (+2286
      // tokens) because each Q&A carries its own condition-trigger prose
      // (regulation, code-per-condition, applicability test). Cap set to
      // 11200 to keep ~150-token headroom. The agentic prompt is routed
      // to Sonnet on observation turns via the tiered router, so the
      // extra context is amortised against the 5-min prompt cache and
      // adds ~$0.002 per observation turn on cache-read.
      //
      // 2026-06-03 (observation-correctness sprint — Bugs 1a/1c/2):
      // bumped to 12500 to absorb four prompt edits. The plan estimated
      // +705 tokens total but the actual measured growth after Bug 1c
      // + Bug 1a was ~937 tokens (Q-DERIVED entries carry more prose
      // than the per-bullet estimate captured). Re-measured per the
      // plan's mandatory verification step:
      //   - Bug 1a Q-DERIVED.OUTDOOR-LIGHT + COMMIT-FIRST RULE added to
      //     wrag-bs7671-eicr.md (~~250 tokens estimated, more in practice
      //     due to the worked-example prose).
      //   - Bug 1a ONE INTERROGATIVE PER ASK rule body — replaces bare
      //     RULE 5 title in sonnet_agentic_system.md (~80 tokens).
      //   - Bug 1c ASK_USER REASONS subsection added to
      //     sonnet_agentic_system.md after ORPHANED VALUES (~125 tokens).
      //   - Bug 2 FIELD-AMBIGUITY RULE + worked example added to
      //     sonnet_agentic_system.md (~250 tokens).
      // Cap 12500 leaves ~250-token headroom against the expected final
      // ~12250 estimate, matching the plan's "keep the headroom rather
      // than tightening" guidance. Bug 1c's tool-schema description
      // widen (in stage6-tool-schemas.js) is NOT counted — schemas live
      // in the cached prefix and are not measured here.
      //
      // 2026-06-03b (voice-correctness sprint Fix B): bumped to 12950
      // to absorb the SUPPLY vs MAIN SWITCH DISAMBIGUATION block
      // inserted between ZE / ZS DISAMBIGUATION and OBSERVATIONS. Net
      // change combined ~+271 tokens (Fix A's drop-the-menu edit
      // offsets ~10 tokens of the new block). Measured 12771; cap
      // 12950 leaves ~179-token headroom. The new block teaches the
      // model to route "main fuse" / "cutout" → spd_*, reserve
      // main_switch_* for the customer-side isolator, and strip the
      // leading BS prefix before writing to spd_bs_en (prevents the
      // doubled-BS TTS phenomenon "main fuse BS EN BS 1361"). Plan
      // reference: .planning/plan-voice-correctness-2026-06-03b-final.md
      // Fix B "Token-cap re-measurement (load-bearing)" step.
      //
      // 2026-06-04 (Fix 3 — session C0C21546 multi-circuit auto-resolver):
      // bumped to 13350 to absorb three prompt additions in
      // sonnet_agentic_system.md: (a) directive 6 (multi-circuit
      // context_circuits + XOR), (b) Example 5b-recovery block teaching
      // recovery from the legacy bare {answered:true, untrusted_user_text}
      // tool_result body, (c) Example 5c worked example for multi-circuit
      // value/enum asks with resolved_writes fan-out, plus the new
      // orphaned-values cross-reference bullet. Measured 13282; cap
      // 13350 leaves ~68-token headroom. Schema description updates in
      // stage6-tool-schemas.js do NOT count (schemas live in the cached
      // prefix and are not measured here). Plan reference:
      // .planning/plan-session-c0c21546-rcd-tts-wiring-fixes-2026-06-04-final.md
      //
      // 2026-06-04 (PLAN-backend-final.md §2.4 + §4.2): bumped to 14000
      // to absorb the new CLIENT IDENTITY — VOCABULARY block (Phase
      // 2.4, ~120 tokens) AND the CLIENT BILLING ADDRESS — SITE COPY
      // RULE block (Phase 4.2, ~250 tokens including the four-write
      // worked example). Net combined +~580 tokens. Measured 13928;
      // cap 14000 leaves ~72-token headroom. Closes the Marlborough /
      // 71-Hexham-Road class of bugs (Sonnet wrote a postal address
      // into client_name when answering "use this address for the
      // client too" / "Y"). Companion Phase 4.0 added the four
      // client_* slots; Phase 4.3 added the dispatcher guard.
      //
      // 2026-06-04 (PLAN-backend-final.md §8.3): bumped to 14150 to
      // absorb the bulk-subtractive EDGE CASES bullet (apart from /
      // except / excluding / all but → set_field_for_all_circuits
      // with exclude_circuits: [N] + rcd_time_ms worked example).
      // Measured 14071; cap 14150 leaves ~79-token headroom.
      //
      // 2026-06-09 (voice-feedback-cleanup-2026-06-09/PLAN-final.md
      // §Cluster D): bumped to 14300 to absorb the RULE 1 negation-guard
      // sentence (~60 tokens) AND the RULE 2 active-enforcement clause
      // (~90 tokens) — together ~150 tokens. Measured 14240; cap 14300
      // leaves ~60-token headroom. Closes inspector markers 9 + 10 (the
      // "consumer unit is not a C2" recorded-anyway bug + the "limitation"
      // / "smoke alarm" no-trigger observations).
      const estimate = Math.ceil(combinedPrompt.length / 4);
      expect(estimate).toBeLessThanOrEqual(14300);
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
      // and require circuit-fields enum membership. Word-boundary
      // negative-lookbehind keeps `context_field:"none"` (the ask_user
      // sentinel used in the FIELD-AMBIGUITY worked example) out of the
      // record_reading audit — `none` is a legal context_field value,
      // NOT a record_reading field, and is covered by the separate
      // context_field enum test below.
      const isInsideBoardSpan = (idx) =>
        boardSpans.some(([start, end]) => idx >= start && idx < end);
      const allRe = /(?<![a-z_])field:\s*"([a-z_][a-z0-9_]*)"/g;
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
      //
      // 2026-05-04 — `calculate_r1_plus_r2` (the tool name) is permitted;
      // the regression target is the broken FIELD alias `r1_plus_r2`
      // standalone. Strip the tool name before the check so the regression
      // lock stays tight without false-positiving on the new tool.
      const stripped = prompt.replace(/calculate_r1_plus_r2/g, '');
      expect(stripped.includes('r1_plus_r2')).toBe(false);
    });

    test('prompt does NOT reference `address` as a record_reading field or ask_user context_field', () => {
      // Plan 04-07 decision (still standing for `address`): the legacy
      // single `address` slot is reserved for the SITE address, not
      // freely written by the model — keep that identifier out of
      // record_reading field / ask_user context_field positions.
      //
      // Phase 4.0 / 4.2 (2026-06-04 PLAN-backend-final) added the
      // four `client_*` BILLING address slots and the prompt guidance
      // that explicitly writes `field: "client_address"` (alongside
      // _postcode/_town/_county) when the inspector confirms "use
      // site address for client too". The inverted assertion is the
      // companion test below; this one only locks the legacy `address`
      // identifier.
      expect(prompt).not.toMatch(/field:\s*"address"/);
      expect(prompt).not.toMatch(/context_field:\s*"address"/);
    });

    test('prompt DOES reference the client_* address family as record_board_reading fields (Phase 4.2)', () => {
      // PLAN-backend-final.md §4.2 — when the inspector says "use the
      // site address for the client too", Sonnet must emit FOUR
      // record_board_reading writes copying site → client_*. The
      // inverted regression lock: this test would fail if a future
      // edit silently strips the four-field guidance from the prompt.
      // Without it, Sonnet would have no instruction on the copy
      // pattern even though Phase 4.0 made the slots writable, and the
      // 71-Hexham-Road class bug would recur.
      expect(prompt).toMatch(/field:\s*"client_address"/);
      expect(prompt).toMatch(/field:\s*"client_postcode"/);
      expect(prompt).toMatch(/field:\s*"client_town"/);
      expect(prompt).toMatch(/field:\s*"client_county"/);
      // The NEVER-write-address-into-client_name guard is also stated
      // in prose; lock the explicit warning so it can't be deleted
      // without re-introducing the Marlborough-class bug.
      expect(prompt).toMatch(/NEVER.*client_name/i);
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

    test('Test F — base markdown token estimate ≤ 5000 (regression lock for CONFIDENTIALITY section bloat)', () => {
      // Group 1 asserts the COMBINED (base + schedule) cap. This test is
      // narrower — it locks the BASE markdown alone so verbose growth in
      // the CONFIDENTIALITY section (which has historically been the most
      // edit-prone block) fires under Group 9's banner.
      //
      // Cap history (base markdown alone):
      //   - 4000 (Phase 4 Plan 04-01).
      //   - 4400 (2026-04-28: silent-drop fix structural rules).
      //   - 4500 (2026-05-01 am: start_dialogue_script garble example).
      //   - 4700 (2026-05-01 pm: BPG4 pipeline restoration with 8
      //     schedule_item example mappings).
      //   - 5000 (2026-05-02: schedule_item example mappings stripped
      //     from inline prompt and the BPG4 quick-reference replaced
      //     with criteria-style framing — net +~100 tokens. New cap
      //     allows ~125-token headroom for future criteria refinements).
      //   - 5600 (2026-05-04: +3 tools landed — delete_circuit,
      //     calculate_zs, calculate_r1_plus_r2 — with worked examples
      //     and the ring-final ask-first rule. Field test 07635782
      //     surfaced the gaps). Cap mirrors Group 1's +600 bump.
      //   - 6100 (2026-05-07: multi-board sprint Phase 7.1 added the
      //     MULTI-BOARD ROUTING block — 3 tools (add_board, select_board,
      //     mark_distribution_circuit) plus the implicit currentBoardId
      //     routing note. ~+400 tokens; cap moved by +500 mirroring
      //     Group 1's bump.
      //   - 6300 ("Work on Board" Phase B 2026-05-08: SINGLE-BOARD FOCUS
      //     paragraph codifies the dispatcher `wrong_board` rejection so
      //     Sonnet learns the rule from the prompt instead of from a tool
      //     reject. ≈ +85 tokens; cap moved by +200 mirroring Group 1's
      //     bump and keeping ~100-token headroom for future refinements).
      //   - 6400 (BPG4 7.3 / BS 7671 A4 refresh 2026-06-03: FI definition
      //     rewritten to "is advised" with anti-overuse pointer to BPG4 7.3
      //     §6, plus the Issue 7.1 → 7.3 reference change. ≈ +23 tokens;
      //     cap moved by +100 to keep ~75-token headroom.
      //   - 7000 (observation-correctness sprint 2026-06-03 first pass:
      //     three edits touched this file — Bug 1a ONE INTERROGATIVE PER
      //     ASK rule body replacing the bare RULE 5 title (~80 tokens),
      //     Bug 1c ASK_USER REASONS subsection after ORPHANED VALUES
      //     (~125 tokens), Bug 2 FIELD-AMBIGUITY RULE + worked example
      //     (~250 tokens). Plan estimated ~455 tokens; measured 7238
      //     after all four bugs (~853 tokens above the pre-sprint
      //     baseline of 6385) because the FIELD-AMBIGUITY worked example
      //     and the per-bullet ASK_USER REASONS lines were larger than
      //     the per-bullet estimate captured.
      //   - 7500 (observation-correctness sprint 2026-06-03 re-measure):
      //     bumped per the plan's mandatory verification step. Leaves
      //     ~262-token headroom above the measured 7238 estimate.
      //   - 7850 (voice-correctness sprint 2026-06-03b Fix B):
      //     SUPPLY vs MAIN SWITCH DISAMBIGUATION subsection inserted
      //     between ZE / ZS DISAMBIGUATION and OBSERVATIONS. The block
      //     teaches Sonnet to route "main fuse" / "cutout" → spd_*,
      //     reserve main_switch_* for the customer-side isolator, and
      //     strip the leading BS prefix when writing to spd_bs_en
      //     (prevents the doubled-BS TTS leak). Net +425 tokens (Fix
      //     A's menu drop offsets ~10 tokens). Measured 7663; cap
      //     7850 leaves ~187-token headroom for future minor edits.
      //     Field-test repro: session F03B590C turn 9 (2026-06-03
      //     20:04 UTC) emitted main_switch_bs_en for "Main fuse is
      //     BS 1361" — wrong field. The new block fixes the routing.
      //   - 8250 (Fix 3 — session C0C21546 multi-circuit auto-resolver,
      //     2026-06-04): three prompt additions — directive 6 (multi-
      //     circuit context_circuits + XOR with context_circuit),
      //     Example 5b-recovery (handling the legacy bare
      //     {answered:true, untrusted_user_text} tool_result body),
      //     Example 5c (worked multi-circuit value/enum ask with
      //     resolved_writes fan-out), and the new cross-reference
      //     bullet in ORPHANED VALUES. Measured 8174; cap 8250 leaves
      //     ~76-token headroom. Field-test repro: session C0C21546
      //     turn 12 (2026-06-04 05:41:10 UTC) asked "What is the
      //     wiring type for circuits 2 and 3?", inspector replied "A.",
      //     zero record_reading writes followed. The new examples
      //     teach Sonnet the plural-ask shape AND the bare-body
      //     recovery path.
      //   - 8900 (PLAN-backend-final.md §2.4 + §4.2 — field-test
      //     fixes from sessions DC321DBC + 60754E4D, 2026-06-04):
      //     two prompt additions to the BASE markdown — Phase 2.4
      //     CLIENT IDENTITY — VOCABULARY block (~120 tokens; names
      //     every spoken alias for the client_name field and forbids
      //     address-shaped writes against it) and Phase 4.2 CLIENT
      //     BILLING ADDRESS — SITE COPY RULE block (~250 tokens;
      //     four record_board_reading writes for "use site address
      //     for client too" with a worked example pointing at the
      //     71-Hexham-Road session). Measured 8820; cap 8900 leaves
      //     ~80-token headroom. Closes the Marlborough / Hexham
      //     class of bugs where Sonnet wrote
      //     `record_board_reading {field:"client_name", value:"71
      //     Hexham Road, Reading"}`. Phase 4.0 adds the four
      //     client_* slots in field_schema.json; Phase 4.3 adds
      //     the dispatcher guard; Phase 4.4 adds the friendly-name
      //     entry. Without this prompt change those backend pieces
      //     would land with no model-side guidance.
      //   - 9000 (PLAN-backend-final.md §8.3 — bulk-subtractive
      //     EDGE CASES bullet): one new bullet in EDGE CASES teaching
      //     "apart from / except / excluding / all but" → set_field_
      //     for_all_circuits with exclude_circuits: [N]. ~50 tokens.
      //     Measured 8963; cap 9000 leaves ~37-token headroom. Closes
      //     the loop with Phase 8.0 iOS ApplyFieldIntent return-nil-on-
      //     exclude so the exclude path reaches the backend.
      //   - 9200 (voice-feedback-cleanup-2026-06-09/PLAN-final.md
      //     §Cluster D): RULE 1 negation-guard sentence (~60 tokens) +
      //     RULE 2 active-enforcement clause (~90 tokens) = ~150 tokens.
      //     Measured 9132; cap 9200 leaves ~68-token headroom. Closes
      //     inspector markers 9 + 10 (negated bare codes were recorded
      //     anyway, and no-trigger defects implicitly created observations).
      const estimate = Math.ceil(prompt.length / 4);
      expect(estimate).toBeLessThanOrEqual(9200);
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

  // ------------------------------------------------------------------
  // Group 11 — 2026-06-03: WRAG corpus + reasoning fallback append.
  //
  // The Wiring Regulations Advisory Group Q&As (hosted by IET /
  // Electrical Safety First) cover ~25 coding decisions where BPG4 7.3
  // is silent or ambiguous (EV PME, mixed switchgear conditions, PV/V2X
  // bidirectional RCDs, meter-tail >3m, lighting circuit no-CPC, etc.).
  // These pins lock both the corpus presence AND the reasoning fallback
  // that prevents the default-to-C2 over-coding tendency Derek flagged
  // in NAPIT Codebreakers (and that we want to avoid in our own model
  // when it falls back to first-principles reasoning).
  // ------------------------------------------------------------------
  describe('Group 11 — 2026-06-03 WRAG corpus + reasoning fallback', () => {
    test('WRAG corpus is appended to the combined prompt the model sees', () => {
      expect(combinedPrompt).toMatch(/WRAG \(Wiring Regulations Advisory Group\)/);
    });

    test('coding-relevant WRAG Q&As are pinned (Q2.47 EV PME, Q2.66 lighting no-CPC, Q2.63 bidirectional RCD)', () => {
      // Sample three of the highest-value gap-fillers. If a future
      // cleanup strips the corpus, these three break first.
      expect(wrag).toMatch(/Q2\.47/);
      expect(wrag).toMatch(/722\.411\.4\.1/); // EV PME reg
      expect(wrag).toMatch(/Q2\.66/);
      expect(wrag).toMatch(/411\.3\.1\.1/); // lighting CPC reg
      expect(wrag).toMatch(/Q2\.63/);
      expect(wrag).toMatch(/bidirectional/i);
    });

    test('reasoning fallback discipline is pinned (default to C3, name the foreseeable event)', () => {
      // The two load-bearing anti-overcoding pointers. Without these
      // the model regresses to whatever its training-data prior is —
      // which on UK forum content trends toward over-coding C2.
      expect(wrag).toMatch(/Default to C3/i);
      expect(wrag).toMatch(/name the foreseeable event/i);
      expect(wrag).toMatch(/NAPIT Codebreakers.*default.*C2/i);
    });

    test('source-authority hierarchy is named explicitly', () => {
      // Authority order must be present so the model knows what
      // it CAN cite and what it can't. Explicit forum-ban is
      // load-bearing — without it the refinement pass's web search
      // can land on Electricians Forums / Reddit and treat them as
      // sources.
      expect(wrag).toMatch(/Electricians Forums.*Reddit.*blogs|forum posts/i);
      expect(wrag).toMatch(/authority hierarchy/i);
    });

    test('agentic prompt body points to WRAG corpus + reasoning fallback', () => {
      // Without the pointer in the body the model might not realise
      // the appended WRAG section is binding guidance.
      expect(prompt).toMatch(/WRAG Q&As appended/);
      expect(prompt).toMatch(/reasoning fallback/i);
    });
  });

  // ------------------------------------------------------------------
  // Group 12 — 2026-06-03 observation-correctness sprint.
  //
  // Three prompt-side rules landed in this sprint. The tests below pin
  // each rule's presence so a future prompt rewrite cannot silently
  // drop them and regress the field-test failure modes documented in
  // .planning/plan-observation-bugs-2026-06-03-final.md.
  //
  //   - Bug 1c: ASK_USER REASONS section + scoped-regex coverage
  //     against the enum in stage6-enumerations.json. Pre-fix the
  //     prompt named `missing_field_and_circuit` (line 78) and
  //     `missing_value` (line 79) but the enum didn't include them —
  //     every such ask was rejected as invalid_reason. The regex
  //     captures BOTH the new ASK_USER REASONS block and any future
  //     ask_user reason literal that creeps in elsewhere.
  //   - Bug 1a: ONE INTERROGATIVE PER ASK rule body in RULE 5.
  //   - Bug 2: FIELD-AMBIGUITY RULE + the verbatim sentence pinning
  //     the no-magnitude-anchor invariant.
  // ------------------------------------------------------------------
  describe('Group 12 — 2026-06-03 observation-correctness sprint (Bugs 1a/1c/2)', () => {
    test('Bug 1c — ASK_USER REASONS section exists with all nine enum values', () => {
      const idx = prompt.search(/ASK_USER REASONS:/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // Section ends at the next sibling block (RING CONTINUITY
      // CARRYOVER). indexOf-from-idx avoids matching the earlier
      // CIRCUIT ROUTING cross-reference ("see RING CONTINUITY
      // CARRYOVER below") at line ~50.
      const end = prompt.indexOf('RING CONTINUITY CARRYOVER', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      for (const reason of [
        'out_of_range_circuit',
        'ambiguous_circuit',
        'contradiction',
        'observation_confirmation',
        'missing_context',
        'missing_field',
        'missing_value',
        'missing_field_and_circuit',
        'missing_field_and_context',
      ]) {
        expect(block).toEqual(expect.stringContaining(reason));
      }
    });

    test('Bug 1c — every ask_user reason literal in the prompt is in the enum', async () => {
      // Tool-scope-aware regexes — only fire inside ask_user contexts so
      // sibling tools (`clear_reading reason:"user_correction"` at line
      // 136) do not false-positively appear as orphans. Three forms cover
      // the live prompt:
      //   - Block form: `ask_user({...reason:"..."})` within ~400 chars.
      //   - With-connector prose: `emit ask_user with reason=...` or
      //     `` `ask_user` `` with `reason="..."`.
      //   - Connectorless prose: `` `ask_user reason=...` `` — anchored
      //     on the leading backtick so it can't span paragraph breaks.
      // The 400-char block window is a soft limit: the longest existing
      // ask_user worked example is ~280 chars; a wider window risks
      // crossing into a sibling tool block. Skip extraction prompt
      // (sonnet_extraction_system.md) — Stage 2 does NOT drive ask_user
      // through the dispatcher; any reason-shaped strings there are
      // unrelated observation-reasoning prose. If a future sprint extends
      // ask_user to extraction, revisit.
      const askBlockReason = /ask_user\s*[({][^})]{0,400}?reason\s*[:=]\s*["']?([a-z_]+)["']?/g;
      const askProseReasonWith =
        /(?:emit\s+ask_user\s+with\s+|`ask_user`\s+with\s+)reason\s*[:=]\s*["']?([a-z_]+)["']?/g;
      const askProseReasonDirect = /`ask_user\s+reason\s*[:=]\s*["']?([a-z_]+)["']?[`"']?/g;
      const captured = new Set();
      for (const re of [askBlockReason, askProseReasonWith, askProseReasonDirect]) {
        let m;
        while ((m = re.exec(prompt)) !== null) {
          captured.add(m[1]);
        }
      }
      // Acceptance: all five orphan-risk values present in the live
      // prompt are captured. The connectorless regex is essential for
      // lines 78-79 — the very orphans that motivated Bug 1c.
      expect(captured.has('out_of_range_circuit')).toBe(true);
      expect(captured.has('missing_context')).toBe(true);
      expect(captured.has('ambiguous_circuit')).toBe(true);
      expect(captured.has('missing_field_and_circuit')).toBe(true);
      expect(captured.has('missing_value')).toBe(true);
      // Sibling-tool prose must NOT appear — `clear_reading reason:
      // "user_correction"` at line 136 is a `clear_reading_reason`, NOT
      // an `ask_user_reason`. A false-positive here would later trip the
      // enum membership assertion below and re-conflate the two namespaces.
      expect(captured.has('user_correction')).toBe(false);
      // Every captured value must be in the enum — drift fails loudly.
      const enumsPath = path.join(__dirname, '..', '..', 'config', 'stage6-enumerations.json');
      const enums = JSON.parse(fssync.readFileSync(enumsPath, 'utf8'));
      const legal = new Set(enums.ask_user_reason);
      for (const reason of captured) {
        expect(legal.has(reason)).toBe(true);
      }
    });

    test('Bug 1a — RULE 5 has the ONE INTERROGATIVE PER ASK rule body, not a bare title', () => {
      // RULE 5 was a bare title for months ("ONE QUESTION PER OBSERVATION
      // PER TURN.") with no body. Sonnet 4.6 read this as "asking is fine,
      // just not twice for the same observation" and emitted compound asks
      // ("Is this fixed or portable? AND is there a circuit number?") that
      // tripped the overtake classifier — session D7D01509 turn-2 lost a
      // valid answer to user_moved_on because regex hits had no field
      // shape to match the compound ask. The rule body below tells Sonnet
      // exactly when one ask is too many.
      const idx = prompt.search(/RULE 5/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const window = prompt.slice(idx, idx + 1200);
      // Title preserved (the existing anchor) so future renumbering does
      // not silently break this assertion.
      expect(window).toEqual(expect.stringContaining('ONE QUESTION PER OBSERVATION PER TURN'));
      // The new rule body — verbatim string match because the rule's
      // power is in the phrasing the model sees.
      expect(window).toEqual(expect.stringContaining('ONE INTERROGATIVE PER ASK'));
      // Rule body specifics — must explain the contract, not just name it.
      expect(window.toLowerCase()).toMatch(/exactly one interrogative/);
      // Cite the downstream classifier so future authors know why the
      // rule matters and don't relax it without checking.
      expect(window).toEqual(expect.stringContaining('overtake classifier'));
      // Allow-list example is preserved.
      expect(window).toEqual(expect.stringContaining('Which circuit is it'));
    });

    test('Bug 1a — WRAG file contains the COMMIT-FIRST rule + Q-DERIVED.OUTDOOR-LIGHT worked example', () => {
      // The split structure: rule in the reasoning fallback section,
      // examples accumulate as Q-DERIVED.* entries. Both anchors must
      // be present or the rule has no teeth.
      expect(wrag).toEqual(expect.stringContaining('COMMIT-FIRST RULE'));
      expect(wrag).toEqual(expect.stringContaining('Q-DERIVED.OUTDOOR-LIGHT'));
      // The outdoor-light entry must name the C3 default + the reg
      // (411.3.4) + the schedule item (5.12.4) so the model can commit
      // straight from the prompt without inferring.
      const idx = wrag.search(/Q-DERIVED\.OUTDOOR-LIGHT/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const block = wrag.slice(idx, idx + 1200);
      expect(block).toEqual(expect.stringContaining('C3'));
      expect(block).toEqual(expect.stringContaining('411.3.4'));
      expect(block).toEqual(expect.stringContaining('5.12.4'));
      // The DO NOT ASK directives are the load-bearing part of the
      // worked example — without them the model defaults back to
      // interrogating "fixed or portable" and "which circuit".
      expect(block).toMatch(/DO NOT ASK/);
    });

    test('Bug 2 — FIELD-AMBIGUITY RULE section exists with the no-magnitude-anchor invariant', () => {
      // Pre-fix Haiku 4.5 happily committed `record_reading` for bare
      // values when the field could be inferred from value range alone
      // (session 928889F3: "upstairs sockets number 0.6" → r1_r2_ohm).
      // The verbatim sentence below is the prompt's invariant; the
      // dispatcher metric mirrors it. If the wording drifts the model
      // may interpret the rule more permissively — keep both ends
      // aligned.
      const idx = prompt.search(/FIELD-AMBIGUITY RULE/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // Section ends at the next sibling block (RING CONTINUITY
      // CARRYOVER). indexOf-from-idx avoids matching the earlier
      // CIRCUIT ROUTING cross-reference at line ~50.
      const end = prompt.indexOf('RING CONTINUITY CARRYOVER', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      expect(block).toEqual(
        expect.stringContaining('Do NOT treat numeric magnitude alone as a field anchor')
      );
      // ask_user reason cited is missing_field — the new enum value
      // that Bug 1c widened to make legal.
      expect(block).toEqual(expect.stringContaining('missing_field'));
      // Worked example covers the upstairs sockets 0.6 repro.
      expect(block.toLowerCase()).toMatch(/upstairs sockets/);
      // 2026-06-03 voice-correctness Fix A: the FIELD-AMBIGUITY ask
      // must NOT enumerate field options. Session F03B590C turn 8
      // showed the inspector replying "Its main earth." to a 5-field
      // menu (Zs / R1+R2 / IR / polarity / number of points) that
      // contained no board-level fields and only 5 of ~25 circuit
      // fields. The inspector vocabulary is broader than any menu the
      // prompt can list, so the canonical ask shape is now a single
      // open question. Pin the instruction so a future rewrite cannot
      // silently re-introduce the menu.
      expect(block).toEqual(expect.stringContaining('do NOT enumerate field options'));
      // Open-question shape — either the circuit-known form ("For
      // circuit N,") or the bare-value form ("what was that") must be
      // present. Loose so wording polish does not break it.
      expect(block.toLowerCase()).toMatch(/what was that|for circuit n,/);
    });

    test('Bug 2 / voice-correctness 2026-06-03b Fix A — bad menu shape is banned prompt-wide', () => {
      // Regex regression-lock against the known bad menu order. The
      // 5-field menu had two canonical surface forms:
      //   - "Zs, R1+R2, IR, polarity, or number of points"
      //   - "Zs, R1 plus R2, IR, polarity, or number of points"
      // The `R1.*IR` clause matches both (R1+R2 and R1 plus R2 both
      // start with `R1`). Capitalisation is `/i` flag.
      //
      // SCOPE LIMIT: this regex catches the canonical comma-separated
      // order shipped in the prompt before Fix A; it does NOT catch
      // arbitrary re-orderings (e.g. "IR, polarity, Zs, R1+R2, number
      // of points"). A future author who rearranges the menu should
      // be flagged by the `do NOT enumerate field options` assertion
      // above instead — that one names the rule, not a surface form.
      // The regex is a strict improvement over a naive
      // `.not.stringContaining(...)` because the literal form could
      // silently pass on any of the surface variants.
      expect(prompt).not.toMatch(/Zs.*R1.*IR.*polarity.*number of points/i);
    });
  });

  // ------------------------------------------------------------------
  // Group 13 — 2026-06-03b voice-correctness sprint (Fix B).
  //
  // The SUPPLY vs MAIN SWITCH DISAMBIGUATION block teaches Sonnet to
  // route inspector "main fuse" / "supply fuse" / "cutout" terms to
  // the `spd_*` field family (Supply Protective Device — DNO cutout)
  // and reserve `main_switch_*` for the customer-side isolator. Pre-
  // fix, session F03B590C-7BDA-41BB-AD99-5B27A9CBFF76 turn 9 emitted
  // `record_board_reading {field:"main_switch_bs_en", value:"BS
  // 1361"}` when the inspector said "Main fuse is BS 1361" — wrong
  // field. The prompt now names both family vocabularies plus the
  // value-kind mapping (BS → spd_bs_en, amps → spd_rated_current,
  // kA → spd_short_circuit, type-alone → spd_type_supply) plus the
  // BS-prefix strip rule that prevents TTS doubling ("main fuse BS
  // EN BS 1361"). Pin each load-bearing instruction so a future
  // rewrite is forced to consider the routing contract explicitly.
  // ------------------------------------------------------------------
  describe('Group 13 — 2026-06-03b voice-correctness sprint (Fix B)', () => {
    test('Fix B — SUPPLY vs MAIN SWITCH DISAMBIGUATION section exists with both field families', () => {
      const idx = prompt.search(/SUPPLY vs MAIN SWITCH DISAMBIGUATION/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // Section ends at the next sibling block (OBSERVATIONS).
      const end = prompt.indexOf('OBSERVATIONS (six rules)', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      // Inspector vocabulary for the DNO-side device + the canonical
      // field family it routes to. Both must co-occur in the same
      // block or the routing is incomplete.
      expect(block).toEqual(expect.stringContaining('main fuse'));
      expect(block).toEqual(expect.stringContaining('spd_bs_en'));
      // Inspector vocabulary for the customer-side isolator + the
      // canonical field family it routes to.
      expect(block).toEqual(expect.stringContaining('main switch'));
      expect(block).toEqual(expect.stringContaining('main_switch_bs_en'));
      // BS-prefix strip rule prevents the doubled-BS TTS phenomenon
      // (*"main fuse BS EN BS 1361 type 1"*). If this drifts the
      // model may write "BS 1361" verbatim and the friendly-name
      // template will speak the duplicated prefix.
      expect(block).toEqual(expect.stringContaining('Strip the leading'));
      // Other value-kind routings — names the rating / kA / type
      // branches so the model doesn't dump everything into spd_bs_en.
      expect(block).toEqual(expect.stringContaining('spd_rated_current'));
      expect(block).toEqual(expect.stringContaining('spd_short_circuit'));
      expect(block).toEqual(expect.stringContaining('spd_type_supply'));
    });
  });

  describe('Group 14 — 2026-06-09 voice-feedback Cluster D (bare-trigger guards + RULE 2 enforcement)', () => {
    // Source: voice-feedback-cleanup-2026-06-09/PLAN-final.md §Cluster D.
    // Markers 9 + 10 — "the consumer unit is not a C2" was recorded as a C2,
    // and "limitation note" / "smoke alarm" no-trigger utterances created
    // observations anyway. The fix is two-fold:
    //   (D1) RULE 1 must deny bare-code triggers preceded by negation.
    //   (D2) RULE 2 must actively route un-triggered defect detections to
    //        `ask_user`, not implicitly to "do nothing".
    test('D1 — RULE 1 has a negation guard for bare codes (3-token window, named operators)', () => {
      const idx = prompt.search(/RULE 1 — EXPLICIT/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // RULE 1 ends at the next sibling rule (RULE 2 — NO INFERRED OBSERVATIONS).
      const end = prompt.indexOf('RULE 2 — NO INFERRED OBSERVATIONS', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      // Verbatim phrase + window size + named operators. If any single
      // operator gets dropped from the list, the inspector's "is not a C2"
      // would slip through and we'd be back where we started.
      expect(block).toEqual(expect.stringContaining('Bare-code triggers'));
      expect(block).toEqual(expect.stringContaining('preceded within 3 tokens by negation'));
      for (const op of ['"not"', '"isn\'t"', '"wasn\'t"', '"no"', '"never"', '"except"']) {
        expect(block).toEqual(expect.stringContaining(op));
      }
      // Fall-through path is named so the model knows what to do when the
      // guard fires — without this the model would just go silent on every
      // negated bare-code utterance and miss legitimate detections.
      expect(block.toLowerCase()).toMatch(/fall through to rule 2/);
    });

    test('D2 — RULE 2 has an active enforcement clause routing un-triggered defects to ask_user', () => {
      const idx = prompt.search(/RULE 2 — NO INFERRED OBSERVATIONS/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // RULE 2 ends at the next sibling rule (RULE 3 — CODE AUTO-PICK).
      const end = prompt.indexOf('RULE 3 — CODE AUTO-PICK', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      // Active enforcement clause — names the ask_user envelope verbatim
      // (reason + context_field + expected_answer_shape) so the model's
      // ask is dispatchable by the existing validator without rejection.
      expect(block).toEqual(expect.stringContaining('your ONLY allowed action is `ask_user'));
      expect(block).toEqual(expect.stringContaining('reason: "observation_confirmation"'));
      expect(block).toEqual(expect.stringContaining('context_field: "observation_clarify"'));
      expect(block).toEqual(expect.stringContaining('expected_answer_shape: "yes_no"'));
      // Prohibition is explicit — the original "are NOT recorded" was a
      // passive prohibition that Sonnet sometimes routed around by emitting
      // record_observation anyway when it inferred a defect.
      expect(block).toEqual(expect.stringContaining('forbidden'));
    });

    test('D1+D2 — observation_confirmation + observation_clarify remain in their respective enums', () => {
      // The active enforcement clause names two enum values. If either
      // is dropped from its enum, the dispatcher would reject every
      // generated ask_user and the fix would break in production despite
      // the prompt-content tests passing. Lock both.
      const enumsPath = path.join(__dirname, '..', '..', 'config', 'stage6-enumerations.json');
      const enums = JSON.parse(fssync.readFileSync(enumsPath, 'utf8'));
      expect(enums.ask_user_reason).toEqual(expect.arrayContaining(['observation_confirmation']));
      // observation_clarify is a CONTEXT_FIELD_ENUM sentinel — imported
      // at module top.
      expect(CONTEXT_FIELD_ENUM).toEqual(expect.arrayContaining(['observation_clarify']));
    });
  });
});
