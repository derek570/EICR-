/**
 * Cluster A1 — observation prompt edits (voice-feedback-cleanup-2026-06-09).
 *
 * Markers 12, 13, 15, 16, 17, 18 — six markers cluster around the
 * `record_observation` fan-out / no-body / orphan-schedule pattern.
 * The fix has three prompt-layer pieces:
 *   - RULE 1 TRIGGER-WITHOUT-BODY clause: bare triggers go to ask_user
 *     instead of recording an empty-text observation.
 *   - RULE 7 PER-TURN DEDUP: at most one record_observation per trigger,
 *     with the RULE 6 (delete+record code-change pair) exception named.
 *   - OBSERVATIONS TOOL ERROR HANDLING block: recovery contracts for
 *     prompt_leak_in_observation AND schedule_item_required_for_coded_observation.
 *
 * This file is a prompt-content lock — it asserts the new prose survives
 * future edits. Behavioural verification (Sonnet actually obeys the
 * rules under real input) lives with the live-Sonnet bench suite, not
 * here.
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('Cluster A1 — observation prompt edits (sonnet_agentic_system.md)', () => {
  let prompt;

  beforeAll(() => {
    prompt = fssync.readFileSync(PROMPT_PATH, 'utf8');
  });

  describe('A1.1 — RULE 1 TRIGGER-WITHOUT-BODY clause', () => {
    test('RULE 1 names the TRIGGER-WITHOUT-BODY phrase + the ask_user envelope', () => {
      const idx = prompt.search(/RULE 1 — EXPLICIT/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('RULE 2 — NO INFERRED OBSERVATIONS', idx);
      const block = prompt.slice(idx, end);
      expect(block).toEqual(expect.stringContaining('TRIGGER-WITHOUT-BODY'));
      // The ask_user envelope is named verbatim so the dispatcher accepts
      // the model's emitted ask without rejection. Lock the four fields
      // the validator checks.
      expect(block).toEqual(expect.stringContaining("reason: \"observation_confirmation\""));
      expect(block).toEqual(expect.stringContaining("context_field: \"observation_clarify\""));
      expect(block).toEqual(expect.stringContaining("context_circuit: null"));
      expect(block).toEqual(expect.stringContaining("expected_answer_shape: \"free_text\""));
      // The prohibition on empty/placeholder text — without this, the
      // model could route around the rule by recording with text="".
      expect(block.toLowerCase()).toMatch(/empty\/placeholder.*text.*forbidden|forbidden.*empty/);
    });
  });

  describe('A1.2 — RULE 7 PER-TURN DEDUP', () => {
    test('RULE 7 exists, OBSERVATIONS section header advertises seven rules', () => {
      // Header count must match — if a future edit adds a rule without
      // bumping the header, the discrepancy is silent. Lock the header.
      expect(prompt).toEqual(expect.stringContaining('OBSERVATIONS (seven rules)'));
      expect(prompt).toEqual(expect.stringContaining('RULE 7 — PER-TURN DEDUP'));
    });

    test('RULE 7 caps record_observation per trigger AND names the RULE 6 exception', () => {
      const idx = prompt.search(/RULE 7 — PER-TURN DEDUP/);
      expect(idx).toBeGreaterThanOrEqual(0);
      // The block ends at the next sibling block (SCHEDULE OF INSPECTION).
      const end = prompt.indexOf('SCHEDULE OF INSPECTION', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      // Core invariants:
      expect(block.toLowerCase()).toMatch(/at most one new.*record_observation/i);
      expect(block).toEqual(expect.stringContaining('per inspector trigger utterance'));
      // Enumeration escape phrases — these make the rule survive the
      // legitimate "do A, and another B" pattern without re-asking.
      expect(block).toEqual(expect.stringContaining('"and another"'));
      expect(block).toEqual(expect.stringContaining('"also"'));
      // RULE 6 exception named (otherwise the rule swallows the legit
      // delete_observation + record_observation code-change pair).
      expect(block).toEqual(expect.stringContaining('EXCEPTION'));
      expect(block).toEqual(expect.stringContaining('delete_observation'));
      expect(block).toEqual(expect.stringContaining('RULE 6'));
    });
  });

  describe('A1.3 / A2b — SCHEDULE OF INSPECTION block now requires schedule_item for coded obs', () => {
    test('SCHEDULE OF INSPECTION block names the REQUIRED-for-coded contract + ask_user escape', () => {
      const idx = prompt.search(/SCHEDULE OF INSPECTION \(`schedule_item`\):/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('OBSERVATIONS TOOL ERROR HANDLING', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      // The contract: REQUIRED for C1/C2/C3/FI, null only for NC.
      expect(block.toLowerCase()).toMatch(/coded observations.*c1\/c2\/c3\/fi.*required|required.*c1\/c2\/c3\/fi/);
      // Error code named verbatim so the model recognises the rejection.
      expect(block).toEqual(expect.stringContaining('schedule_item_required_for_coded_observation'));
      // Ask-user escape — same envelope shape Sonnet emits when it
      // genuinely cannot pick. Recovery contract relies on this matching.
      expect(block).toEqual(expect.stringContaining("reason: \"missing_context\""));
      expect(block).toEqual(expect.stringContaining("context_field: \"observation_clarify\""));
      expect(block.toLowerCase()).toMatch(/end the turn without recording/);
    });
  });

  describe('A1.4 / A2b — OBSERVATIONS TOOL ERROR HANDLING block (recovery contracts)', () => {
    test('block exists between SCHEDULE OF INSPECTION and OBSERVATION CODES', () => {
      const idx = prompt.search(/OBSERVATIONS TOOL ERROR HANDLING/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const codesIdx = prompt.indexOf('OBSERVATION CODES (criteria', idx);
      expect(codesIdx).toBeGreaterThan(idx);
    });

    test('prompt_leak_in_observation recovery contract: ONE retry, <60-char ref, then ask_user', () => {
      const idx = prompt.search(/OBSERVATIONS TOOL ERROR HANDLING/);
      const end = prompt.indexOf('OBSERVATION CODES (criteria', idx);
      const block = prompt.slice(idx, end);
      expect(block).toEqual(expect.stringContaining('prompt_leak_in_observation'));
      expect(block.toLowerCase()).toMatch(/under 60 chars/);
      expect(block.toLowerCase()).toMatch(/one retry only|one retry/);
      expect(block.toLowerCase()).toMatch(/do not split/);
      expect(block.toLowerCase()).toMatch(/do not change `code` or `text`/);
      // Worked retry shape — "522.6.201" or "Reg 543.1.1".
      expect(block).toEqual(expect.stringContaining('"522.6.201"'));
      // Fallback ask_user envelope:
      expect(block).toEqual(expect.stringContaining("reason: \"missing_value\""));
    });

    test('schedule_item recovery contract names the error code AND the ask_user escape', () => {
      const idx = prompt.search(/OBSERVATIONS TOOL ERROR HANDLING/);
      const end = prompt.indexOf('OBSERVATION CODES (criteria', idx);
      const block = prompt.slice(idx, end);
      expect(block).toEqual(expect.stringContaining('schedule_item_required_for_coded_observation'));
      expect(block.toLowerCase()).toMatch(/retry the same observation with `schedule_item` filled/);
      expect(block.toLowerCase()).toMatch(/do not retry-loop indefinitely/);
    });

    test('regulation_required_for_coded_observation is named in the prompt_leak retry contract', () => {
      // The prompt instructs the model NOT to pass suggested_regulation:null
      // on coded observations, and names the matching error code so the
      // model recognises it as a separate gate (NOT the leak filter).
      const idx = prompt.search(/OBSERVATIONS TOOL ERROR HANDLING/);
      const end = prompt.indexOf('OBSERVATION CODES (criteria', idx);
      const block = prompt.slice(idx, end);
      expect(block).toEqual(expect.stringContaining('regulation_required_for_coded_observation'));
    });
  });

  describe('A1.5 — Worked example for bare-trigger ASK then record', () => {
    test('Example 10 demonstrates the TRIGGER-WITHOUT-BODY → ask_user → record_observation flow', () => {
      const idx = prompt.search(/Example 10 — Bare-trigger observation/);
      expect(idx).toBeGreaterThanOrEqual(0);
      const end = prompt.indexOf('RESTRAINT (DO NOT RE-ASK)', idx);
      expect(end).toBeGreaterThan(idx);
      const block = prompt.slice(idx, end);
      // Two-turn anchor: trigger alone in turn A, defect content in turn B.
      expect(block.toLowerCase()).toMatch(/turn a.*observation/);
      expect(block.toLowerCase()).toMatch(/turn b/);
      // Worked record_observation must include schedule_item (the new
      // requirement) so the model sees the expected shape.
      expect(block).toEqual(expect.stringContaining('schedule_item'));
      // Worked ask_user envelope mirrors the rule-1 verbatim envelope.
      expect(block).toEqual(expect.stringContaining("reason:\"observation_confirmation\""));
      expect(block).toEqual(expect.stringContaining("context_field:\"observation_clarify\""));
    });
  });
});
