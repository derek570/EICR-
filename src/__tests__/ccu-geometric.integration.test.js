/**
 * Integration tests for ccu-geometric.js — runs against real Anthropic API.
 *
 * SKIPPED unless BOTH:
 *   - ANTHROPIC_API_KEY is set
 *   - Fixture photos exist at /tmp/ccu-ab-test/photo-{1,2,3}.jpg
 *
 * No hard assertions on exact module counts — this is a smoke/observability run.
 * Logs actual vs expected so Phase B can be eyeballed before Phase D rollout.
 */

import { jest } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';

const FIXTURE_DIR = '/tmp/ccu-ab-test';
const FIXTURES = [
  { name: 'photo-1', path: `${FIXTURE_DIR}/photo-1.jpg`, expectedModules: null },
  { name: 'photo-2', path: `${FIXTURE_DIR}/photo-2.jpg`, expectedModules: null },
  { name: 'photo-3', path: `${FIXTURE_DIR}/photo-3.jpg`, expectedModules: null },
];

const hasKey = !!process.env.ANTHROPIC_API_KEY;
const fixturesExist = FIXTURES.every((f) => existsSync(f.path));
const shouldRun = hasKey && fixturesExist;

const describeIf = shouldRun ? describe : describe.skip;

describeIf('extractCcuGeometric — integration (live VLM)', () => {
  let extractCcuGeometric;

  beforeAll(async () => {
    const mod = await import('../extraction/ccu-geometric.js');
    extractCcuGeometric = mod.extractCcuGeometric;
  });

  // Live API calls can take 20-40s each × 4 calls × 3 fixtures → long-running.
  jest.setTimeout(5 * 60_000);

  test.each(FIXTURES)('processes $name', async (fixture) => {
    const buf = readFileSync(fixture.path);
    const result = await extractCcuGeometric(buf);

    console.log(
      `[ccu-geometric:${fixture.name}]`,
      JSON.stringify(
        {
          moduleCount: result.moduleCount,
          vlmCount: result.vlmCount,
          disagreement: result.disagreement,
          lowConfidence: result.lowConfidence,
          medianRails: result.medianRails,
          mainSwitchWidth: result.mainSwitchWidth,
          moduleWidth: result.moduleWidth,
          timings: result.timings,
          usage: result.usage,
          expected: fixture.expectedModules,
        },
        null,
        2
      )
    );

    // Basic sanity — ensure the schema returned is well-formed.
    expect(result.schemaVersion).toBe('ccu-geometric-v1');
    expect(Number.isFinite(result.moduleCount)).toBe(true);
    expect(result.moduleCount).toBeGreaterThan(0);
    expect(result.slotCentersX).toHaveLength(result.moduleCount);
    expect(result.stageOutputs.stage1.rails).toHaveLength(3);
  });
});

if (!shouldRun) {
  console.log(
    `[ccu-geometric.integration] SKIPPED — hasKey=${hasKey}, fixturesExist=${fixturesExist}`
  );
}
