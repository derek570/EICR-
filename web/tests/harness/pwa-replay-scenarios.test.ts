/**
 * PWA replay scenario suite (pwa-replay-harness Wave 3, B4) — the
 * mock-mode lane. Globs every scenario YAML under
 * `tests/fixtures/pwa-replay-sessions/` (+ the generated sweep dirs once
 * Wave 5 lands), replays each through the REAL RecordingProvider, and
 * evaluates its `expect.web` block + the seeded D1 invariants.
 *
 * Filter locally: `PWA_REPLAY_SCENARIO=<name> npm run pwa-replay`.
 * A4 xfail (Wave 3 → Wave 6): scenarios with `expect.web.xfail_until_wave6`
 * get an extra `it.fails` case for that block — it flips to a plain `it`
 * when Wave 6 ships the feedback port.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenario, type ReplayScenario } from './scenario';
import { replayScenario } from './runner';
import { evaluateWebExpectations, evaluateA4Expectations } from './expectations';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIRS = [
  path.resolve(here, '../../../tests/fixtures/pwa-replay-sessions'),
  // Wave 5 adds: tests/fixtures/pwa-replay/generated-sweep
];

function collectScenarios(): ReplayScenario[] {
  const scenarios: ReplayScenario[] = [];
  for (const dir of FIXTURE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      scenarios.push(loadScenario(path.join(dir, file)));
    }
  }
  const filter = process.env.PWA_REPLAY_SCENARIO;
  return filter ? scenarios.filter((s) => s.name.includes(filter)) : scenarios;
}

const scenarios = collectScenarios();
const MODE = (process.env.PWA_REPLAY_MODE === 'live' ? 'live' : 'mock') as 'live' | 'mock';
const TRACE_OUT = process.env.PWA_REPLAY_TRACE_OUT;

function maybeWriteTrace(name: string, trace: unknown): void {
  if (!TRACE_OUT) return;
  fs.mkdirSync(TRACE_OUT, { recursive: true });
  fs.writeFileSync(path.join(TRACE_OUT, `${name}.trace.json`), JSON.stringify(trace, null, 2));
}

describe(`pwa-replay — recorded/authored session scenarios (${MODE} mode)`, () => {
  it('found at least the two Wave-1 fixtures', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(2);
  });

  for (const scenario of scenarios) {
    const webExpect = scenario.expect?.web;
    if (!webExpect) continue;

    it(`${scenario.name} — expect.web + seed invariants hold`, async () => {
      const result = await replayScenario(scenario, { mode: MODE });
      maybeWriteTrace(scenario.name, result.trace);
      const failures = evaluateWebExpectations(result, webExpect);
      expect(failures).toEqual([]);
    });

    if (webExpect.xfail_until_wave6) {
      // xfail: A4 ships in Wave 6, which flips `it.fails` → `it` and
      // re-runs this GREEN (plan §6 — the four-bug proof completes there).
      it.fails(`${scenario.name} — A4 feedback capture [xfail until Wave 6]`, async () => {
        const result = await replayScenario(scenario);
        const failures = evaluateA4Expectations(result, webExpect.xfail_until_wave6!);
        expect(failures).toEqual([]);
      });
    }
  }
});
