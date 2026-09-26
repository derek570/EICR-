/**
 * PLAN-W2 (Decision 7 wrong-value wave, Decision W-5b) — the pre-LLM gate
 * admits a recognised apply-field command for the seven measured-reading and
 * cable-size fields, whatever VOICE_AGENTIC_ANSWERS says.
 *
 * Both clients forward these commands instead of applying them locally (web
 * routing row 6; iOS has no local alias). A digitless value such as
 * "cable n/a for all" carries only the weak trigger `cable` and two content
 * words, so before this rule the backend dropped it as LOW_CONTENT when the
 * flag was off — after the client had chimed. Derek chose to admit these
 * shapes at the backend rather than rest them on the flag (2026-09-26).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORWARDED_APPLY_FIELD_ALIASES,
  GATE_REASONS,
  isForwardedApplyFieldCommand,
  shouldForwardToSonnet,
} from '../extraction/pre-llm-gate.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('PLAN-W2 — recognised forwarded apply-field commands pass the gate with the flag off', () => {
  test.each([
    'cable n/a for all',
    'Cable N/A for all circuits.',
    'set cable n/a for circuits 1 to 4',
    'ir live earth n/a for circuit 3',
    'insulation resistance l l n/a for all',
    'zed s for circuit 2 is n/a',
    'r one plus r two n/a for all',
  ])('%s → HAS_FORWARDED_APPLY_FIELD', (text) => {
    const decision = shouldForwardToSonnet(text, { agenticAnswersEnabled: false });
    expect(decision).toEqual({ forward: true, reason: GATE_REASONS.HAS_FORWARDED_APPLY_FIELD });
  });

  test('the reason does not depend on the flag', () => {
    expect(shouldForwardToSonnet('cable n/a for all', { agenticAnswersEnabled: true })).toEqual({
      forward: true,
      reason: GATE_REASONS.HAS_FORWARDED_APPLY_FIELD,
    });
  });

  test.each([
    ['cable for all', 'no value'],
    [
      'OCPD standard grey square for all',
      'not one of the seven fields (PLAN-CD keeps its flag dependency)',
    ],
    ['the cable is loose', 'no scope clause'],
    ['cable n/a', 'no scope clause'],
    // Review cycle 4 — the scope-first grammar needs " is ", as web's parser
    // does; iOS's recogniser is held to the same boundary.
    ['cable for all n/a', 'scope-first without "is"'],
    ['cable for all = n/a', 'scope-first with "=" instead of "is"'],
    ['cable for all to n/a', 'scope-first with "to" instead of "is"'],
    ['cable for all the circuits is n/a', 'a scope web does not recognise'],
  ])('%s is not admitted by this rule (%s)', (text) => {
    expect(isForwardedApplyFieldCommand(text)).toBe(false);
    const decision = shouldForwardToSonnet(text, { agenticAnswersEnabled: false });
    expect(decision.reason).not.toBe(GATE_REASONS.HAS_FORWARDED_APPLY_FIELD);
  });
});

describe('PLAN-W2 — the alias table is the web parser table for the seven fields', () => {
  test('identical to CIRCUIT_FIELD_ALIASES rows whose value is a LOCAL_APPLY_FORWARDED_FIELDS field', () => {
    const ts = readFileSync(
      resolve(REPO_ROOT, 'packages/shared-utils/src/voice-commands.ts'),
      'utf8'
    );
    const forwardedBlock = /LOCAL_APPLY_FORWARDED_FIELDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(
      ts
    );
    expect(forwardedBlock).not.toBeNull();
    const forwarded = new Set([...forwardedBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
    expect(forwarded.size).toBe(7);

    const aliasBlock = /const CIRCUIT_FIELD_ALIASES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(ts);
    expect(aliasBlock).not.toBeNull();
    const tsAliases = {};
    for (const m of aliasBlock[1].matchAll(
      /^\s*(?:'([^']+)'|([a-z0-9_]+)):\s*'([a-z0-9_]+)',$/gm
    )) {
      const phrase = m[1] ?? m[2];
      if (forwarded.has(m[3])) tsAliases[phrase] = m[3];
    }
    expect(FORWARDED_APPLY_FIELD_ALIASES).toEqual(tsAliases);
  });
});
