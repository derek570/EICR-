/**
 * f7-adapter-parity.test.js — proves the jest adapters
 * (f7-audibility-matrix.js) and the env-neutral core
 * (f7-audibility-core.js) return IDENTICAL verdicts over the same captures
 * (plan Item 2 "Jest-independent invariant module"), including the
 * regression where the ONLY `__` sentinel is in an emitted ask question.
 * Also pins the core's import-graph rule: zero src/extraction imports.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as core from '../helpers/f7-audibility-core.js';
import {
  turnIsAudible as jestTurnIsAudible,
  iosSendAttempts as jestIosSendAttempts,
  spokenTexts as jestSpokenTexts,
  anySentinelInSpokenText as jestAnySentinel,
  makeLogger,
  makeOpenWs,
} from '../helpers/f7-audibility-matrix.js';

function scenario({ confirmationText = 'Zs zero point three five, circuit two.', askQuestion = null } = {}) {
  const result = {
    confirmations: confirmationText != null ? [{ field: 'measured_zs_ohm', circuit: 2, text: confirmationText }] : [],
    extracted_readings: [{ field: 'measured_zs_ohm', circuit: 2, value: '0.35' }],
  };
  const ws = makeOpenWs();
  if (askQuestion != null) {
    ws.send(JSON.stringify({ type: 'ask_user_started', tool_call_id: 'sym_tc_ask', question: askQuestion }));
  }
  const logger = makeLogger();
  logger.info('ios_send_attempt', { field: 'measured_zs_ohm', circuit: 2 });
  logger.info('stage6_tool_call', { tool: 'record_reading' });
  const standaloneLogRows = logger.info.mock.calls.map(([name, meta]) => ({ name, meta }));
  return { result, ws, logger, standaloneLogRows };
}

describe('jest adapter ↔ standalone core parity', () => {
  test('turnIsAudible agrees for spoken, emitted-ask-only, and silent turns', () => {
    const spoken = scenario();
    expect(jestTurnIsAudible(spoken.result, spoken.ws)).toBe(core.turnIsAudible(spoken.result, spoken.ws.sent));

    const askOnly = scenario({ confirmationText: null, askQuestion: 'Which circuit was that?' });
    expect(jestTurnIsAudible(askOnly.result, askOnly.ws)).toBe(true);
    expect(core.turnIsAudible(askOnly.result, askOnly.ws.sent)).toBe(true);

    const silent = scenario({ confirmationText: '   ' });
    expect(jestTurnIsAudible(silent.result, silent.ws)).toBe(false);
    expect(core.turnIsAudible(silent.result, silent.ws.sent)).toBe(false);
  });

  test('iosSendAttempts agrees between jest-mock calls and plain rows', () => {
    const s = scenario();
    expect(jestIosSendAttempts(s.logger)).toEqual(core.iosSendAttempts(s.standaloneLogRows));
    expect(jestIosSendAttempts(s.logger)).toHaveLength(1);
  });

  test('spokenTexts agrees and includes emitted ask question text', () => {
    const s = scenario({ askQuestion: '  Which circuit was that reading for?  ' });
    const jestTexts = jestSpokenTexts(s.result, s.ws);
    const coreTexts = core.spokenTexts(s.result, s.ws.sent);
    expect(jestTexts).toEqual(coreTexts);
    expect(jestTexts).toContain('Which circuit was that reading for?');
  });

  test('REGRESSION: the ONLY __ sentinel is in an emitted ask question — both adapters catch it', () => {
    const s = scenario({ askQuestion: 'Which circuit is __circuit_ref__ on?' });
    expect(jestAnySentinel(s.result, s.ws)).toBe(true);
    expect(core.anySentinelInSpokenText(s.result, s.ws.sent)).toBe(true);
    // Without the frames both are blind — the exact pre-refactor gap.
    expect(jestAnySentinel(s.result)).toBe(false);
    expect(core.anySentinelInSpokenText(s.result, [])).toBe(false);
  });
});

describe('core import-graph rule', () => {
  test('f7-audibility-core.js imports nothing from src/extraction and no jest', () => {
    const src = fs.readFileSync(
      path.resolve('src/__tests__/helpers/f7-audibility-core.js'),
      'utf8',
    );
    // Check import SPECIFIERS only (the header comment legitimately names
    // the rule it enforces).
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers).toEqual([]);
    const dynamicImports = [...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(dynamicImports).toEqual([]);
  });
});
