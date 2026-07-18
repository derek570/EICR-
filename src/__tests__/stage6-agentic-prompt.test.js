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
  // Group 0b — marker-② Phase-4 steer consistency (2026-07-18).
  // The bare value-less "Zs for circuit N" contract must be INTERNALLY
  // consistent: cycle-2 Codex review found CORE DIRECTIVE 4 + the
  // EXTRACTION RULES incomplete-reading line both said WAIT on a
  // value-less "Zs...", directly contradicting the new Example 8 ask
  // rule — a contradiction the model resolves unpredictably.
  // ------------------------------------------------------------------
  describe('Group 0b — calculate_zs intent steer consistency (marker-② Phase 4)', () => {
    test('the old unconditional WAIT-on-value-less-reading rule is GONE', () => {
      expect(prompt).not.toContain(
        'If a reading is incomplete ("Zs..." with no value), WAIT for the next utterance.'
      );
    });
    test('the field+circuit-no-value shape asks once (all three sites agree)', () => {
      // CORE DIRECTIVE 4 carve-out.
      expect(prompt).toContain(
        'A field+circuit mention with NO value ("Zs for circuit 4.") is a FINISHED utterance'
      );
      // EXTRACTION RULES carve-out — field-only fragments still WAIT.
      expect(prompt).toContain('If a reading is incomplete with FIELD ONLY');
      expect(prompt).toContain(
        'Field AND circuit present but NO value ("Zs for circuit 4.") is NOT a wait'
      );
      // Example 8 ask contract with real enum members.
      expect(prompt).toContain('reason:"missing_value"');
      expect(prompt).toContain('expected_answer_shape:"number"');
      // The explicit-compute path is preserved.
      expect(prompt).toContain('calculate_zs({circuit_ref:2, all:false})');
    });
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
      // 2026-06-05 (PLAN voice-feedback Group I — W1.7): bumped to
      // 14250 to absorb the combustible-CU C3 worked example added
      // to the OBSERVATION CODES section. The example carries the
      // BS 7671:2018+A2 §421.1.201 cite and the "C3, NOT C2" ruling
      // so the model picks C3 even without consulting WRAG.
      // Measured 14201; cap 14250 leaves ~49-token headroom.
      //
      // 2026-06-05 (PLAN voice-feedback Group H — W1.6): bumped to
      // 15000 to absorb the CLIENT BILLING ADDRESS — SITE COPY RULE
      // rewrite (one-shot ask per job with ambiguous-slot default,
      // four-write copy pattern, two worked examples). ~+250 tokens
      // over the prior block, plus the symmetric direction text.
      // Measured 14926; cap 15000 leaves ~74-token headroom.
      //
      // 2026-06-12 (field session 15B88D6B voice-feedback fixes): bumped
      // to 15301 to absorb (a) the MAIN PROTECTIVE BONDING section
      // (PASS/FAIL/LIM/N-A check-field values + per-service PASS writes,
      // voiceFeedbackId 21) and (b) the MERGED / STUTTERED NAMING rule
      // (restart-glued "Circuit 1 is circuit 2 is X" must not become
      // rename_circuit(1->2), voiceFeedbackId 22), on top of the merged
      // 2026-06-05 W1.6/W1.7 additions. Measured 15201; cap 15301 leaves ~100-token headroom.
      //
      // 2026-06-16 (field session F1AC26FB voice-feedback fixes): bumped to
      // 15700 to absorb three steering additions — SWAP/REORDER DESIGNATIONS
      // (#5.1, stop scratch-circuit-999), TAILS→main_switch_conductor_csa
      // (#2.1, stop sub_main misroute), and the earthing head/value garble
      // line (#1.4). Measured 15606; cap 15700 leaves ~94-token headroom.
      //
      // 2026-06-17 (surge-protection-box, rebased onto F1AC26FB): bumped to
      // 16030 to absorb the SURGE vs SUPPLY-FUSE DISAMBIGUATION block (routes
      // "surge protection"/"Type N surge"/"SPD status" → surge_* while keeping
      // "main fuse"/"cutout" → spd_*) ON TOP of the F1AC26FB additions.
      // Measured 15930; cap 16030 leaves ~100-token headroom.
      //
      // 2026-06-18 (readback-correction-optionb §3.2 + §3.3, rebased onto the
      // surge-protection + F1AC26FB additions above): bumped to 17150 to absorb
      // (a) the CONFIDENCE SCORING rewrite to diagnostic-only (structurally
      // complete readings WRITE at any confidence — no silent drop); (b) the
      // Directive-3 + RESTRAINT bare-negation exceptions (ask once, never
      // clear_reading); (c) the RECENT CONTEXT = transient-anaphora-memory
      // sentence reconciling the cached-prefix source-of-truth; (d) the BARE
      // NEGATION AFTER A READ-BACK behaviour block + Example 10. Measured 17060
      // on the MERGED prompt; cap 17150 leaves ~90-token headroom.
      //
      // 2026-06-19 (field session AD0AE9FA #35 — observation not landing,
      // recurring): bumped to 17550 to absorb the OBSERVATIONS RULE 1a
      // ("observation note …" lead-in is ALWAYS an observation, never no-op,
      // even when the text references circuits / sounds compliant) + Example 11
      // (the exact "Observation note RCD protection for circuits 1 and 2."
      // session case). Measured 17453; cap 17550 leaves ~97-token headroom.
      //
      // 2026-06-23 (field session DFCE2145, obs-#49 + #55 + #53): bumped to
      // 18250 to absorb OBSERVATIONS RULE 0 (EIC has no observations → graceful
      // comments ask) + the #55 no-CPC clarifying-ask steering (base prompt +
      // WRAG Q2.66) + the #53 bare-observation deterministic ask. The combined
      // prompt includes the appended WRAG, so the #55 WRAG edit counts here.
      // #51 RULE 7 (rationale clause) added in the same sprint. Measured 18218;
      // cap 18400 leaves ~182-token headroom.
      //
      // 2026-07-14 (field session 6B6FE011, feedback wave): bumped to 20100
      // to absorb §C1 designation-outranks-ambient + no-phantom-circuit
      // steering, §C2 garbled-ref rule, §C3 clear-never-re-homes, §C4
      // ICD/Zedi garble aliases, §D1 professional observation rewording
      // (RULE 1b + Examples 12) and §D2 AMBIGUOUS C2/C3 SEVERITY (targeted
      // factual ask + three-way crack outcomes + clear-cut guards + chain-id
      // echo + Example 13, with RULE 1/1a/3, FI and RESTRAINT reconciled).
      // Measured ~19970; cap 20100 leaves ~130-token headroom.
      //
      // 2026-07-15 (D2 mutation-to-chain correlation): bumped to 20200 to
      // absorb the CHAIN ID echo bullet + Example 13 expanded to THREE COMPLETE
      // record_observation outcomes (C1/C2/C3) each echoing clarification_chain_id
      // (Codex diff-review required complete, non-ellipsised worked examples —
      // the wave's core model-facing contract). Legitimate feature growth of the
      // canonical example, not bloat.
      //
      // 2026-07-18 (marker-② Phase-4 steer, numeric-gate-redesign): bumped to
      // 20420 to absorb the calculate_zs intent guard (tool blurb: explicit
      // compute intent only) + Example 8 rewritten as the intent split — bare
      // value-less "Zs for circuit 4." is an incomplete READING → ONE
      // ask_user (missing_value/number) even with inputs present (meter
      // wins); explicit-compute path preserved; rule extended to
      // calculate_r1_plus_r2. Closes the live 8/8 beep-then-silence repro at
      // the model layer (the marker-② net is the deterministic backstop).
      // Measured ~20378; cap 20420 leaves ~42-token headroom.
      //
      // 2026-07-18 (marker-② cycle-2 consistency fix): bumped to 20480 —
      // CORE DIRECTIVE 4 + the EXTRACTION RULES incomplete-reading line were
      // CONTRADICTING the new Example 8 (both said WAIT on a value-less
      // "Zs..."), which would make the steer unreliable; both now carve out
      // the field+circuit-no-value shape as ask-once. Measured ~20445; cap
      // 20480 leaves ~35-token headroom.
      const estimate = Math.ceil(combinedPrompt.length / 4);
      expect(estimate).toBeLessThanOrEqual(20480);
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

    test('#35 (AD0AE9FA): "observation note" lead-in rule + worked example are present (never no-op)', () => {
      // Field session AD0AE9FA #35 — "Observation note RCD protection for
      // circuits 1 and 2." was silently no-op'd (observations:0). RULE 1a +
      // Example 11 instruct the model to ALWAYS record an explicit
      // "observation"/"observation note" lead-in, even when the text references
      // circuits or sounds compliant. Lock the steering wording so it can't be
      // dropped by a future prompt edit without a test failure.
      const lower = prompt.toLowerCase();
      expect(lower).toEqual(expect.stringContaining('observation note'));
      expect(lower).toEqual(expect.stringContaining('never no-op'));
      // The worked example pins the exact recurring session phrasing.
      expect(prompt).toEqual(expect.stringContaining('RCD protection for circuits 1 and 2'));
      // RULE 1a headline + its forbid-record_reading clause must be present.
      expect(lower).toEqual(expect.stringContaining('lead-in is always an observation'));
      expect(lower).toEqual(
        expect.stringContaining('does not turn the utterance into a circuit reading')
      );
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

    test('contains the #3.4.2 NEGATIVE designation-on-create clause (designation-wire-sync)', () => {
      // The prompt already steers designation-on-create POSITIVELY (CIRCUIT
      // NAMING). #3.4.2 adds the EXPLICIT NEGATIVE counter to the schema's
      // "Null if unknown" wording: never emit designation:null for a named
      // circuit. This test must NOT pass on the generic positive guidance —
      // it asserts the negative phrasing specifically.
      const lower = prompt.toLowerCase();
      // Anchor on the negative "designation:null when ... a name" idea.
      const idx = lower.indexOf('designation:null');
      expect(idx).toBeGreaterThanOrEqual(0);
      const windowStart = Math.max(0, idx - 300);
      const windowEnd = Math.min(prompt.length, idx + 300);
      const section = lower.slice(windowStart, windowEnd);
      // NEVER ... designation-less / designation:null, tied to a spoken name.
      expect(section).toEqual(expect.stringContaining('never'));
      expect(section).toEqual(expect.stringContaining('name'));
      const hasNegativeDesignation =
        section.includes('designation-less') || section.includes('designation:null');
      expect(hasNegativeDesignation).toBe(true);
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

    test('prompt does NOT reference `address` as a circuit-scoped `record_reading` field or as an `ask_user` context_field (board-level `record_board_reading` MAY use it for ambiguous site-address writes)', () => {
      // Plan 04-07 decision (still standing for `address`): the legacy
      // single `address` slot is reserved for the SITE address, not
      // freely written by the circuit-scoped record_reading tool —
      // keep that identifier out of record_reading field / ask_user
      // context_field positions.
      //
      // Phase 4.0 / 4.2 (2026-06-04 PLAN-backend-final) added the
      // four `client_*` BILLING address slots and the prompt guidance
      // that explicitly writes `field: "client_address"` (alongside
      // _postcode/_town/_county) when the inspector confirms "use
      // site address for client too". The inverted assertion is the
      // companion test below; this one only locks the legacy `address`
      // identifier.
      //
      // PLAN voice-feedback-2026-06-05 W1.6 / Group H — the rewritten
      // AMBIGUOUS-SLOT DEFAULT rule introduced
      // `record_board_reading({field: "address", ...})` worked
      // examples to teach Sonnet that ambiguous addresses default to
      // the SITE slot family. That tool is BOARD-scoped, distinct from
      // the circuit-scoped `record_reading`; the negative below scopes
      // to `record_reading\(` only. The legacy ask_user negative also
      // tightens to reject `ask_user({context_field: "address"})` while
      // permitting the new `context_field: "address_mirror_ask"` etc.
      expect(prompt).not.toMatch(/record_reading\([^)]*field:\s*"address"/);
      expect(prompt).not.toMatch(/ask_user\([^)]*context_field:\s*"address"\s*[,}]/);
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
      //   - 9100 (PLAN voice-feedback-2026-06-05 W1.7 — combustible
      //     CU → C3 worked example): one new bullet at the end of
      //     OBSERVATION CODES carrying the BS 7671:2018+A2 §421.1.201
      //     cite and the "C3, NOT C2" ruling. ~70 tokens. Closes
      //     voice_feedback marker #9 (session 84CE2125 at 10:43:30
      //     wrote C2 four times for a combustible CU).
      //   - 9900 (PLAN voice-feedback-2026-06-05 W1.6 — address
      //     mirror one-shot ask per job): CLIENT BILLING ADDRESS —
      //     SITE COPY RULE rewrite (replacing the silent mirror with
      //     a one-shot per-job ask + ambiguous-slot default + two
      //     worked examples covering yes/no answers + symmetric
      //     site↔customer copy direction). ~+650 tokens. Measured
      //     9818; cap 9900 leaves ~82-token headroom. Closes voice_
      //     feedback marker #8 (session 84CE2125 at 10:42:09 reported
      //     silent mirror from client to installation address).
      //   - 10193 (2026-06-12 field session 15B88D6B voice-feedback
      //     fixes): MAIN PROTECTIVE BONDING section (check fields take
      //     PASS/FAIL/LIM/N-A, per-service PASS writes, csa routing —
      //     voiceFeedbackId 21) + MERGED / STUTTERED NAMING rule
      //     (voiceFeedbackId 22), on top of the merged 2026-06-05
      //     W1.6/W1.7 additions. Measured 10093; cap 10193 leaves ~100-token headroom.
      //   - 10600 (2026-06-16 field session F1AC26FB): SWAP/REORDER
      //     DESIGNATIONS (#5.1), TAILS→main_switch_conductor_csa (#2.1),
      //     and the earthing head/value garble line (#1.4). Measured
      //     10498; cap 10600 leaves ~100-token headroom.
      //   - 10920 (2026-06-17 surge-protection-box, rebased): SURGE vs
      //     SUPPLY-FUSE DISAMBIGUATION block on top of F1AC26FB. Measured
      //     10822; cap 10920 leaves ~98-token headroom.
      //   - 12050 (2026-06-18 readback-correction-optionb §3.2 + §3.3,
      //     rebased onto the above): CONFIDENCE SCORING rewrite (diagnostic-
      //     only, no silent drop) + Directive-3/RESTRAINT bare-negation
      //     exceptions + RECENT CONTEXT transient-memory sentence + BARE
      //     NEGATION AFTER A READ-BACK behaviour block + Example 10.
      //     Measured 11952 on the MERGED base; cap 12050 leaves ~98-token headroom.
      //   - 12450 (2026-06-19 field session AD0AE9FA #35 — observation not
      //     landing, recurring): OBSERVATIONS RULE 1a ("observation note …"
      //     lead-in is ALWAYS an observation, never no-op, even when the text
      //     references circuits / sounds compliant) + Example 11 (the exact
      //     "Observation note RCD protection for circuits 1 and 2." case).
      //     Measured 12345 on the base; cap 12450 leaves ~105-token headroom.
      //   - 13100 (2026-06-23 field session DFCE2145 obs-#49 + #55 + #53 + #51):
      //     OBSERVATIONS RULE 0 (EIC has no observations → graceful comments
      //     ask) + the #55 no-CPC clarifying-ask steering + #53 bare-observation
      //     deterministic ask + #51 RULE 7 (rationale clause). Measured 12980;
      //     cap 13100 leaves ~120-token headroom.
      //   - 13200 (2026-06-25 field session 6674E8C5 M1): SPARE CIRCUITS bullet
      //     (multiple "Spare" circuits are valid, emit one create_circuit per
      //     ref, never go silent on a spare rejection) — defense-in-depth for
      //     the silent-drop fix. Measured 13138 on the merged base; cap 13200
      //     leaves ~62-token headroom.
      //   - 14850 (2026-07-14 field session 6B6FE011 feedback wave): §C1
      //     designation-outranks-ambient + creation-only-on-explicit-intent +
      //     garbled-ref rule; §C3 clear-never-re-homes; §C4 ICD/Zedi garble
      //     aliases; §D1 RULE 1b professional rewording + Example 12; §D2
      //     AMBIGUOUS C2/C3 SEVERITY block (targeted factual ask, three-way
      //     outcomes, clear-cut guards, chain-id echo) + Example 13, with
      //     RULE 1/1a/3, FI and RESTRAINT reconciled. Measured ~14731;
      //     cap 14850 leaves ~119-token headroom.
      //   - 14950 (2026-07-15 D2 mutation-to-chain correlation): CHAIN ID echo
      //     bullet (echo on the continuation AND the resolving record_observation;
      //     null for direct) + Example 13 expanded from one C1 call + C2/C3
      //     shorthand to THREE COMPLETE record_observation outcomes each echoing
      //     clarification_chain_id, + Examples 11/12 null. Codex diff-review
      //     required complete (non-ellipsised) worked examples for the wave's
      //     core model-facing contract — legitimate example growth, not bloat.
      //     Measured ~14909; cap 14950 leaves ~41-token headroom.
      //   - 15180 (2026-07-18 marker-② Phase-4 steer): calculate_zs intent
      //     guard in the tool blurb + Example 8 intent split (bare value-less
      //     field+circuit → ask_user for the value, even with inputs present;
      //     explicit compute preserved; extended to calculate_r1_plus_r2).
      //     Closes the live "Zs for circuit 4." beep-then-silence repro at the
      //     model layer. Measured ~15141; cap 15180 leaves ~39-token headroom.
      //   - 15240 (2026-07-18 marker-② cycle-2 consistency fix): CORE
      //     DIRECTIVE 4 + the EXTRACTION RULES incomplete-reading line
      //     carved out the field+circuit-no-value shape (ask once, Example
      //     8) — they previously said WAIT, contradicting the steer.
      //     Measured ~15208; cap 15240 leaves ~32-token headroom.
      const estimate = Math.ceil(prompt.length / 4);
      expect(estimate).toBeLessThanOrEqual(15240);
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
      const end = prompt.indexOf('OBSERVATIONS (eight rules)', idx);
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

  describe('Group 15 — 2026-06-05 voice-feedback Group H (address mirror one-shot ask per job)', () => {
    test('CLIENT BILLING ADDRESS — SITE COPY RULE section retains its header and the one-shot ask semantics', () => {
      // Voice_feedback marker #8 (session 84CE2125 at 10:42:09): inspector
      // dictated the client address; the system silently mirrored it onto
      // the site. Derek's locked decision is one-shot ask per job with
      // ambiguous default to SITE and a durable "no" answer.
      const idx = prompt.search(/CLIENT BILLING ADDRESS — SITE COPY RULE/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('OBSERVATIONS (eight rules)', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);

      // Header advertises one-shot semantics so the next contributor knows
      // the file's per-job gating is intentional, not an accident.
      expect(block).toEqual(expect.stringContaining('one-shot ask per job'));

      // AMBIGUOUS-SLOT DEFAULT rule (Derek decision: ambiguous → SITE).
      expect(block).toEqual(expect.stringContaining('AMBIGUOUS-SLOT DEFAULT'));
      expect(block).toMatch(/default the write to the SITE slot family/i);

      // Per-job gating is bound to the jobs.address_mirror_asked column
      // so the iOS reconnect-then-re-fire bug class can't recur.
      expect(block).toEqual(expect.stringContaining('jobs.address_mirror_asked'));

      // Durable "no" — the answer outlives the ask.
      expect(block).toMatch(/DURABLE/);
      expect(block).toMatch(/"no" answer is DURABLE|the ask is NEVER re-fired/i);
    });

    test('CLIENT BILLING ADDRESS block contains both directions (site→customer AND customer→site) of the mirror copy', () => {
      const idx = prompt.search(/CLIENT BILLING ADDRESS — SITE COPY RULE/);
      const end = prompt.indexOf('OBSERVATIONS (eight rules)', idx);
      const block = prompt.slice(idx, end);

      // Two worked examples — yes-answer (site→customer copy) and
      // no-answer (customer first, durable "no"). Without both, Sonnet
      // gets imbalanced training signal and may favour one direction
      // even when the inspector dictated the other slot first.
      expect(block).toMatch(/site address dictated first/i);
      expect(block).toMatch(/customer address dictated first/i);
      // Symmetric copy direction is stated explicitly so the model
      // knows the customer→site copy is the same four-write pattern.
      expect(block).toMatch(/Customer→site direction is symmetric/i);
    });

    test('jobs.address_mirror_asked is named ONLY inside the address rule block (no orphan references elsewhere)', () => {
      // The flag should be a load-bearing concept INSIDE the address
      // rule and nowhere else. An orphan reference elsewhere would
      // indicate a half-applied refactor.
      const matches = prompt.match(/address_mirror_asked/g) ?? [];
      expect(matches.length).toBe(1);
    });
  });

  describe('Group 14 — 2026-06-05 voice-feedback Group I (combustible CU → C3, NOT C2)', () => {
    test('OBSERVATION CODES section contains the combustible-CU worked example with explicit C3 ruling', () => {
      // Field-test session 84CE2125 at 10:43:30 saw Sonnet write
      // record_observation {code: "C2"} for a combustible consumer
      // unit (4 times in 5 seconds). BS 7671:2018+A2 §421.1.201
      // codes a non-fire-rated CU as C3 (improvement recommended)
      // — the historical C2 classification was softened in the 2022
      // amendment. The fix surfaces the boundary as a worked example
      // inside the OBSERVATION CODES block so the model picks C3 even
      // without consulting WRAG.
      const idx = prompt.search(/OBSERVATION CODES \(criteria — apply to ANY defect\)/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // Section ends at the next WORKED EXAMPLES heading (Example 1).
      const end = prompt.indexOf('WORKED EXAMPLES:', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);

      // The example must call out the combustible/non-amendment-3
      // case AND the C3 ruling AND name BS 7671:2018+A2 §421.1.201
      // — without any one of these the model may fall back to the
      // pre-amendment C2 default.
      expect(block).toEqual(expect.stringContaining('combustible'));
      expect(block).toEqual(expect.stringContaining('consumer unit'));
      expect(block).toEqual(expect.stringContaining('§421.1.201'));
      // "C3, NOT C2" is the load-bearing assertion — pin the exact
      // phrasing so a "drop the NOT C2" tidy-up that would let the
      // model wobble back to C2 fails the test loudly.
      expect(block).toMatch(/C3,\s*NOT\s*C2/i);
    });
  });

  describe('Group 16 — 2026-06-17 surge-protection-box (SURGE vs SUPPLY-FUSE)', () => {
    // Field session F1AC26FB: inspector said "the main fuse"; it correctly
    // routed to spd_* (the DNO cutout) but the UI box read "(SPD)" =
    // Surge Protection Device, and there was no box for a real surge device.
    // Option A adds a separate surge_* family. The agentic prompt must teach
    // the model to keep main-fuse/cutout on spd_* AND route genuine surge
    // talk to surge_*, or the two collide again at the model layer.
    test('SURGE vs SUPPLY-FUSE DISAMBIGUATION section exists with the surge_* family', () => {
      const idx = prompt.search(/SURGE vs SUPPLY-FUSE DISAMBIGUATION/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // Section ends at the next sibling block (MAIN PROTECTIVE BONDING).
      const end = prompt.indexOf('MAIN PROTECTIVE BONDING', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);

      // Surge vocabulary + the canonical field family it routes to. Both
      // must co-occur or the routing is incomplete.
      expect(block).toEqual(expect.stringContaining('surge protection'));
      expect(block).toEqual(expect.stringContaining('surge_spd_present'));
      expect(block).toEqual(expect.stringContaining('surge_spd_type'));
      expect(block).toEqual(expect.stringContaining('surge_spd_bs_en'));
      expect(block).toEqual(expect.stringContaining('surge_status_indicator'));

      // Load-bearing: surge talk must NOT collapse into the spd_* cutout
      // family. The block must explicitly keep main fuse/cutout on spd_*.
      expect(block).toMatch(/NEVER route surge.*spd_\*/i);
      expect(block).toEqual(expect.stringContaining('spd_*'));
    });

    test('§4 regression — main-fuse value-kinds stay split (BS→spd_bs_en, amps→spd_rated_current)', () => {
      // Session F1AC26FB turn-13 dumped spd_bs_en="MCB 100" — type/current
      // text leaked into the BS-number slot. The SUPPLY vs MAIN SWITCH block
      // must keep the per-value-kind split so a "main fuse BS 1361, 100 amp"
      // utterance separates the standard from the rating.
      const idx = prompt.search(/SUPPLY vs MAIN SWITCH DISAMBIGUATION/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('SURGE vs SUPPLY-FUSE DISAMBIGUATION', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      // BS/standard number → spd_bs_en; rating/amps → spd_rated_current.
      expect(block).toEqual(expect.stringContaining('spd_bs_en'));
      expect(block).toEqual(expect.stringContaining('spd_rated_current'));
      expect(block).toMatch(/rating.*amps.*spd_rated_current|spd_rated_current/i);
    });
  });

  describe('Group 17 — 2026-06-23 obs-#49 proactive EIC observation-handling (RULE 0)', () => {
    test('RULE 0 carries a PROACTIVE clause keyed off the snapshot CERTIFICATE TYPE: EIC line', () => {
      // Follow-up 1 (#49) — the snapshot now surfaces `CERTIFICATE TYPE: EIC`
      // (eicr-extraction-session.js _computeSnapshotParts). RULE 0 must key off
      // it so the model goes STRAIGHT to the graceful comments ask without first
      // making the rejected `record_observation` round-trip. The snapshot line
      // alone is insufficient — the prompt clause is the behavioural backstop.
      const idx = prompt.search(/RULE 0 — EIC HAS NO OBSERVATIONS/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // Bound the RULE 0 block at the next sibling rule.
      const end = prompt.indexOf('RULE 1 —', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);

      // Proactive trigger: names the snapshot cert-type signal + a PROACTIVE marker.
      expect(block).toEqual(expect.stringContaining('CERTIFICATE TYPE'));
      expect(block).toMatch(/PROACTIVE/);
      // The proactive directive: do NOT call record_observation on an EIC.
      expect(block).toMatch(/do NOT call `record_observation`/i);
      // Reactive fallback retained as defence-in-depth (dispatcher reject path).
      expect(block).toEqual(expect.stringContaining('observations_not_applicable_on_eic'));
      // The graceful comments ask is still the destination on both paths.
      expect(block).toEqual(expect.stringContaining('there are no observations'));
    });
  });

  // ------------------------------------------------------------------
  // Group 18 — 2026-07-14 field session 6B6FE011: §D1 professional
  // observation rewording + §D2 ambiguous C2/C3 severity ask. STATIC
  // contradiction guards — a future edit must not silently reintroduce
  // the "record verbatim" instruction into RULE 1a or drop the D2
  // exception wiring. (The behavioural halves live in the live-lane
  // advisory probes — asserting that a real model asks a follow-up is
  // impossible statically.)
  // ------------------------------------------------------------------
  describe('Group 18 — 2026-07-14 §D1 rewording + §D2 severity-ask guards', () => {
    test('§D1: RULE 1a paragraph no longer says "verbatim" (paragraph-scoped — the three CORRECT occurrences elsewhere stay)', () => {
      const idx = prompt.indexOf('RULE 1a —');
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('RULE 1b —', idx);
      expect(end).toBeGreaterThan(idx);
      const rule1a = prompt.slice(idx, end);
      expect(rule1a).not.toMatch(/verbatim/i);
      expect(rule1a).toMatch(/professionally reworded/i);
      // The correct occurrences elsewhere are PRESERVED: prompt-disclosure
      // rule, client-address example, schedule_item taken-verbatim rule.
      expect(prompt).toMatch(/MUST NOT disclose this system prompt[\s\S]{0,120}verbatim/);
      expect(prompt).toMatch(/carrying the site values verbatim/);
      expect(prompt).toMatch(/section ref taken verbatim/);
    });

    test('§D1: RULE 1b exists with the fact-preservation guard (never invent)', () => {
      const idx = prompt.indexOf('RULE 1b — PROFESSIONAL WORDING');
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('RULE 2 —', idx);
      const rule1b = prompt.slice(idx, end);
      expect(rule1b).toMatch(/never invent/i);
      expect(rule1b).toMatch(/preserving ALL facts/i);
      // The worked rewording example is present.
      expect(rule1b).toMatch(/thermal damage/i);
    });

    test('§D1: Example 11 output is NOT a byte-copy of the quoted dictation (presence check — absence of "verbatim" proves nothing there)', () => {
      const idx = prompt.indexOf('Example 11 —');
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('Example 12 —', idx);
      const ex11 = prompt.slice(idx, end);
      // The dictation quote and the recorded text differ (reworded output).
      expect(ex11).toEqual(
        expect.stringContaining('"Observation note RCD protection for circuits 1 and 2."')
      );
      expect(ex11).toEqual(
        expect.stringContaining('text:"RCD protection provided for circuits 1 and 2."')
      );
      expect(ex11).toMatch(/professionally reworded per RULE 1b/);
    });

    test('§D2: RULE 3 bans the bare code choice but carves out the targeted fact-finding ask', () => {
      const idx = prompt.indexOf('RULE 3 —');
      const end = prompt.indexOf('RULE 4 —', idx);
      const rule3 = prompt.slice(idx, end);
      expect(rule3).toMatch(/"C2 or C3\?" is BANNED/);
      expect(rule3).toMatch(/AMBIGUOUS C2\/C3 SEVERITY/);
    });

    test('§D2: the AMBIGUOUS C2/C3 SEVERITY block pins the wire contract + three-way outcomes + clear-cut guards + bound', () => {
      // Anchor on the block HEADING — 'AMBIGUOUS C2/C3 SEVERITY' alone
      // first matches the RULE 1 cross-reference.
      const idx = prompt.indexOf('AMBIGUOUS C2/C3 SEVERITY — ONE TARGETED FACTUAL ASK');
      expect(idx).toBeGreaterThanOrEqual(0);
      const block = prompt.slice(idx, idx + 3200);
      expect(block).toEqual(expect.stringContaining('`reason: "observation_confirmation"`'));
      expect(block).toEqual(expect.stringContaining('`context_field: "observation_clarify"`'));
      expect(block).toEqual(expect.stringContaining('`expected_answer_shape: "free_text"`'));
      // Three-way crack outcomes.
      expect(block).toMatch(/accessible exposed live parts → \*\*C1\*\*/);
      expect(block).toMatch(/WITHOUT accessible live parts → \*\*C2\*\*/);
      expect(block).toMatch(/superficial\/cosmetic only → \*\*C3\*\*/);
      // Clear-cut guards.
      expect(block).toMatch(/reliable\/effective means of earthing/);
      expect(block).toMatch(/thermal damage/i);
      // Bound + chain id echo.
      expect(block).toMatch(/AT MOST ONE continuation/);
      expect(block).toMatch(/clarification_chain_id/);
    });

    test('§D2: FI criterion routes ordinary C2-vs-C3 fact gaps to the ask, not FI', () => {
      const idx = prompt.indexOf('- FI — FURTHER INVESTIGATION');
      const block = prompt.slice(idx, idx + 700);
      expect(block).toMatch(/NOT the escape hatch/i);
      expect(block).toMatch(/AMBIGUOUS C2\/C3 SEVERITY/);
    });

    test('§D2: RESTRAINT carries the bounded observation_clarify continuation exception', () => {
      const idx = prompt.indexOf('RESTRAINT (DO NOT RE-ASK):');
      const block = prompt.slice(idx, idx + 1600);
      expect(block).toMatch(/EXPLICIT EXCEPTION/);
      expect(block).toMatch(/AMBIGUOUS C2\/C3 SEVERITY/);
      expect(block).toMatch(/third question is still forbidden/);
    });

    test('§D2: the mandatory no-CPC/Class-II question survives as AUTHORITATIVE (not subsumed)', () => {
      const idx = prompt.indexOf('NO-CPC / MISSING-EARTH');
      expect(idx).toBeGreaterThanOrEqual(0);
      const block = prompt.slice(idx, idx + 2000);
      expect(block).toMatch(/AUTHORITATIVE/);
      expect(block).toMatch(/NOT subsumed/);
    });
  });

  describe('Group 19 — 2026-07-15 D2 mutation-to-chain correlation (chain-id echo on record_observation)', () => {
    // Test-matrix item 11: the CHAIN ID bullet now requires the same
    // server-issued clarification_chain_id echoed on BOTH the continuation ask
    // AND the eventual record_observation; direct observations pass null.
    test('CHAIN ID bullet requires the mutation echo AND the continuation echo AND null-for-direct', () => {
      const idx = prompt.indexOf('- CHAIN ID:');
      expect(idx).toBeGreaterThanOrEqual(0);
      const bullet = prompt.slice(idx, prompt.indexOf('\n', idx));
      // continuation echo preserved
      expect(bullet).toMatch(/continuation ask/);
      // mutation echo (the new requirement)
      expect(bullet).toMatch(/record_observation/);
      // direct/unclarified observation → null
      expect(bullet).toMatch(/clarification_chain_id: null/);
    });

    test('Example 13 shows the chain id echoed on EACH post-answer record_observation (C1/C2/C3), each a valid coded write', () => {
      const idx = prompt.indexOf('Example 13 —');
      expect(idx).toBeGreaterThanOrEqual(0);
      const ex13 = prompt.slice(idx, idx + 1600);
      // The ask's tool_result carries the id.
      expect(ex13).toMatch(/tool_result returns `clarification_chain_id:"obsclr-1"`/);
      // ALL THREE severity outcomes are explicit record_observation calls that
      // echo the SAME id (not shorthand) — each of C1/C2/C3.
      const writeIds =
        ex13.match(/record_observation\(\{[^)]*clarification_chain_id:"obsclr-1"/g) || [];
      expect(writeIds.length).toBe(3);
      for (const code of ['C1', 'C2', 'C3']) {
        // Each coded call carries a non-empty suggested_regulation AND the id,
        // so validateRecordObservation would ACCEPT it (a coded observation
        // with null/empty regulation is rejected → the exact fallback this wave
        // prevents). Order-independent on the two fields.
        const call = new RegExp(`record_observation\\(\\{code:"${code}"[^)]*\\)`).exec(ex13);
        expect(call).not.toBeNull();
        expect(call[0]).toMatch(/suggested_regulation:"[^"]+"/);
        expect(call[0]).toMatch(/clarification_chain_id:"obsclr-1"/);
      }
    });

    test('Examples 11 and 12 (direct observations) are valid coded writes with clarification_chain_id:null and no stray source_turn_id', () => {
      const idx11 = prompt.indexOf('Example 11 —');
      const idx12 = prompt.indexOf('Example 12 —');
      const idx13 = prompt.indexOf('Example 13 —');
      const ex11 = prompt.slice(idx11, idx12);
      const ex12 = prompt.slice(idx12, idx13);
      for (const ex of [ex11, ex12]) {
        const call = /record_observation\(\{[^)]*\)/.exec(ex);
        expect(call).not.toBeNull();
        expect(call[0]).toMatch(/clarification_chain_id:null/);
        // Coded (C1/C2/C3/FI) observation → non-empty suggested_regulation so
        // the example would not be rejected at dispatch.
        expect(call[0]).toMatch(/suggested_regulation:"[^"]+"/);
        // source_turn_id is a record_reading field, NOT record_observation —
        // it must not appear on these observation examples.
        expect(call[0]).not.toContain('source_turn_id');
      }
    });
  });
});
