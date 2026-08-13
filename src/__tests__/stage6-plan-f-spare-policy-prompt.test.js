/**
 * stage6-plan-f-spare-policy-prompt.test.js
 *
 * PLAN-F item 1 (2026-08-12, feedback id 115) — prompt-suite style content
 * invariant test for `config/prompts/sonnet_agentic_system.md`'s
 * spare_policy guidance. Mirrors stage6-agentic-prompt.test.js's convention
 * (read the file, assert the load-bearing directives survive future edits)
 * rather than a live-LLM call — the schema is the primary contract layer
 * (stage6-tool-schemas.test.js / drift assertions cover that); this locks
 * the SECONDARY prose layer the plan requires: "the prompt teaches the same
 * rule as a SECONDARY layer."
 *
 * Also pins the contradiction-handling guidance: the backend has no way to
 * detect a natural-language contradiction server-side (there is no
 * dispatcher-level validation for "including spares but excluding the spare
 * way" — that is a model-restraint / local-client-parser concern), so the
 * prompt sentence instructing the model NOT to call the tool on
 * contradictory modifiers is the only backend-side artifact for that half
 * of Decision 3's two-sided contradiction handling.
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPT_PATH = path.join(__dirname, '../../config/prompts/sonnet_agentic_system.md');
const promptText = fssync.readFileSync(PROMPT_PATH, 'utf8');

describe('PLAN-F item 1 — spare_policy prompt guidance (secondary layer)', () => {
  test('teaches PREFER OMITTING spare_policy by default', () => {
    expect(promptText).toContain('PREFER OMITTING');
    expect(promptText).toContain('spare_policy`, PLAN-F id 115');
  });

  test('teaches the family-aware automatic default (device-attribute include, reading exclude)', () => {
    expect(promptText).toMatch(/device-attribute fields INCLUDE spares/i);
    expect(promptText).toMatch(/reading fields EXCLUDE spares/i);
  });

  test('teaches emitting spare_policy ONLY on an explicit spoken modifier', () => {
    expect(promptText).toMatch(/spare_policy: "include".*"exclude".*ONLY on explicit/);
  });

  test('teaches rcd_protected_only still composes with spare_policy (not a passthrough)', () => {
    expect(promptText).toContain('scope: "rcd_protected_only"` still composes with `spare_policy`');
  });

  test('discourages the legacy scope:"non_spare" value', () => {
    expect(promptText).toContain('Do NOT emit `scope: "non_spare"`');
  });

  test('teaches the two-sided contradiction rule: do not call the tool, ask_user instead', () => {
    expect(promptText).toMatch(/Contradictory modifiers/);
    expect(promptText).toMatch(/do NOT call the tool — `ask_user` instead/);
  });

  test('the worked example for a reading field omits scope/spare_policy entirely', () => {
    const exampleLine = promptText
      .split('\n')
      .find((l) => l.includes('RCD time is 25 milliseconds for all circuits apart from circuit 1'));
    expect(exampleLine).toBeDefined();
    expect(exampleLine).not.toContain('scope: "non_spare"');
    expect(exampleLine).not.toContain('scope:');
  });
});
