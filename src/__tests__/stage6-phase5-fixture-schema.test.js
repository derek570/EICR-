/**
 * Stage 6 Phase 5 Plan 05-07 r1-#5 — fixture schema validation gate.
 *
 * WHAT: Asserts every Phase 5 over-ask fixture (and the synthetic-breach
 * fixture) carries an `ask_user_calls[].call.input` shape that passes the
 * production `validateAskUser` validator from
 * `src/extraction/stage6-dispatch-validation.js`.
 *
 * WHY: r1-#5 surfaced multiple fixtures using `expected_answer_shape:"text"`
 * and one using `"yes_no_with_text"` — neither in the
 * `ASK_USER_ANSWER_SHAPES` enum (`yes_no | number | free_text | circuit_ref`).
 * The exit-gate harness used a minimal mock inner dispatcher that bypassed
 * the validator, so invalid payloads replayed unchallenged. Real Plan 03-05
 * dispatch would have rejected every fixture call at the validator gate.
 *
 * WHY a dedicated test (not folded into stage6-over-ask-exit-gate.test.js):
 * the exit-gate test is a child-process spawnSync harness; this test is a
 * fast in-process assertion suite. Splitting them keeps the spawn surface
 * minimal and the schema check cheap. r1-#4 (Plan 05-07 Task 2) wires the
 * validator into the harness itself; this test is the static fixture
 * snapshot covering both the production fixtures and the synthetic-breach
 * fixture used by r1-#4's runtime gate.
 *
 * Requirements: STS-07 (validateAskUser is the canonical ask_user shape gate).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAskUser } from '../extraction/stage6-dispatch-validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PHASE5_FIXTURES_DIR = path.join(
  REPO_ROOT,
  'src',
  '__tests__',
  'fixtures',
  'stage6-phase5-golden-sessions'
);
const SYNTHETIC_BREACH_DIR = path.join(
  REPO_ROOT,
  'src',
  '__tests__',
  'fixtures',
  'stage6-golden-sessions-synthetic-breach'
);

function loadJsonFixtures(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`fixtures dir does not exist: ${dir}`);
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      path: path.join(dir, name),
      data: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')),
    }));
}

describe('Plan 05-07 r1-#5 — Phase 5 fixture schema validation', () => {
  describe('stage6-phase5-golden-sessions/ — every ask_user input passes validateAskUser', () => {
    const fixtures = loadJsonFixtures(PHASE5_FIXTURES_DIR);

    test.each(fixtures)('$name validates clean', ({ data, name }) => {
      // Sanity — every Phase 5 over-ask fixture declares its shape.
      expect(data._fixture_shape).toBe('phase5-over-ask');
      const calls = Array.isArray(data.ask_user_calls) ? data.ask_user_calls : [];
      // The fixture roster guarantees ≥1 ask_user_call per Phase 5 fixture
      // (sample-06 has 0 because it's a turn-rolling regression canary; the
      // expected_ask_user_count for that fixture is 0). Skip the iteration
      // assertion for that case rather than forcing false coverage.
      for (let i = 0; i < calls.length; i += 1) {
        const input = calls[i]?.call?.input;
        const result = validateAskUser(input);
        if (result !== null) {
          throw new Error(
            `${name}: ask_user_calls[${i}].call.input failed validateAskUser → ${result.code}:${result.field ?? '<no field>'}\n` +
              `input=${JSON.stringify(input)}`
          );
        }
        expect(result).toBeNull();
      }
    });
  });

  describe('stage6-golden-sessions-synthetic-breach/ — every ask_user input passes validateAskUser', () => {
    const fixtures = loadJsonFixtures(SYNTHETIC_BREACH_DIR);

    test.each(fixtures)('$name validates clean', ({ data, name }) => {
      const calls = Array.isArray(data.ask_user_calls) ? data.ask_user_calls : [];
      expect(calls.length).toBeGreaterThan(0);
      for (let i = 0; i < calls.length; i += 1) {
        const input = calls[i]?.call?.input;
        const result = validateAskUser(input);
        if (result !== null) {
          throw new Error(
            `${name}: ask_user_calls[${i}].call.input failed validateAskUser → ${result.code}:${result.field ?? '<no field>'}\n` +
              `input=${JSON.stringify(input)}`
          );
        }
        expect(result).toBeNull();
      }
    });
  });
});
