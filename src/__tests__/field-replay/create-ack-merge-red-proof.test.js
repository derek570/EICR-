/**
 * create-ack-merge-red-proof.test.js — PLAN-D 2026-08-23 (feedback id 130):
 * the PRE-FIX RED proof for the committed corpus fixture frc_1e2f5aab…,
 * executed against the fixture's OWN declared oracle.
 *
 * The fixture is registered `required_green` (fix-lands-first contingency:
 * PLAN-D's D3 merge ships in the SAME branch, so an on-disk expected_red
 * would fail the merge-blocking gate — the corpus state machine's dual-proof
 * required_green admission). Its `red_proof_failure_id` documents what fails
 * on pre-fix code; this suite EXECUTES that claim by running the committed
 * fixture's declared `expected_audible_outputs` through the REAL
 * matchAudibleOutputs oracle against the PRE-FIX output set — the exact two
 * clips the CloudWatch `ios_send_attempt` rows recorded for the field turn
 * ("Downstairs light, circuit 3, wiring type A" + "Circuit 3 is now the
 * Downstairs light"). Assertions: the documented id
 * `audibility.output.out_created_merge` FAILS (0 matches — the merged text
 * does not exist pre-fix), and both legacy clips additionally fail
 * `audibility.unclaimed` (the bipartite matcher's absence guarantee — the
 * same mechanism that post-fix forbids the standalone ack from returning).
 *
 * The GREEN half of the dual proof is the corpus run itself: the same
 * fixture replays through the REAL harness (frozen model rounds → real
 * dispatchers → real bundler) and passes — see `npm run replay:field-corpus`.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { matchAudibleOutputs } from '../../../scripts/field-replay/lib/replay-assertions.mjs';

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/fixtures/field-replay-corpus/frc_1e2f5aabe7e7a73f522d98582f6ab734/fixture.yaml'
);

/** The pre-fix output set, byte-faithful to the field evidence rows. */
const PRE_FIX_RESULT = {
  confirmations: [
    {
      text: 'Downstairs light, circuit 3, wiring type A',
      expanded_text: 'Downstairs light, circuit 3, wiring type A',
      field: 'wiring_type',
      circuit: 3,
    },
    {
      text: 'Circuit 3 is now the Downstairs light',
      expanded_text: 'Circuit 3 is now the Downstairs light',
      field: 'circuit_op',
      circuit: 3,
      dedupe_token: 'circop_turn-1_0_create_3',
      expects_ios_ack: false,
    },
  ],
};

/** The ask frame the fixture declares (identical pre/post fix). */
const ASK_FRAMES = [
  {
    type: 'ask_user_started',
    tool_call_id: 'toolu_d130ask',
    question: "Which circuit is the wiring type for? I don't see circuit 3 on the schedule.",
  },
];

describe('id-130 red proof — the committed fixture oracle REDs on the pre-fix output set', () => {
  const fixture = yaml.load(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const expectedOutputs = fixture.turns[0].expected_audible_outputs;

  test('fixture declares the documented red_proof_failure_id', () => {
    expect(fixture.gate_state).toBe('required_green');
    expect(fixture.red_proof_failure_id).toBe('audibility.output.out_created_merge');
    expect(expectedOutputs.map((o) => o.output_id)).toEqual(['out_ask', 'out_created_merge']);
  });

  test('pre-fix output set fails EXACTLY the documented id (+ unclaimed rows for both legacy clips)', () => {
    const { failures } = matchAudibleOutputs(expectedOutputs, {
      result: PRE_FIX_RESULT,
      wsFrames: ASK_FRAMES,
    });
    const ids = failures.map((f) => f.id);
    expect(ids).toContain('audibility.output.out_created_merge');
    // Both pre-fix clips are unclaimed — the same absence mechanism that
    // post-fix forbids the standalone ack from coming back.
    const unclaimed = failures.filter((f) => f.id === 'audibility.unclaimed');
    expect(unclaimed).toHaveLength(2);
    // No OTHER declared output fails: the ask matches pre- and post-fix.
    expect(ids).not.toContain('audibility.output.out_ask');
    // Every failure is a clean FAIL, never infrastructure.
    for (const f of failures) expect(f.outcome).toBe('fail');
  });

  test('post-fix output set (the merged clip) satisfies the oracle with zero failures', () => {
    const { failures } = matchAudibleOutputs(expectedOutputs, {
      result: {
        confirmations: [
          {
            text: 'Created circuit 3, Downstairs light — wiring type A',
            field: 'wiring_type',
            circuit: 3,
          },
        ],
      },
      wsFrames: ASK_FRAMES,
    });
    expect(failures).toEqual([]);
  });
});
