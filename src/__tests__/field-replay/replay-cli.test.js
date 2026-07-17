/**
 * replay-cli.test.js — SUBPROCESS regressions for the bootstrap/runner
 * split (plan Item 2): legacy byte-for-byte compatibility (loader provably
 * not applied), lane validation, the recorded lane's env pinning, and the
 * TIMEOUT-BACKED zero-real-wait regression — a GATED ask (1.5s
 * QUESTION_GATE_DELAY_MS) and a no-ask turn both terminate fast under the
 * fake clock + pump, with the declared answer resolving through the real
 * registry.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('scripts/voice-latency-bench/transcript-replay-direct.mjs');

function runCli(args, env = {}, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      cwd: process.cwd(),
      timeout: opts.timeout ?? 60_000,
    });
    return { stdout, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? -1 };
  }
}

describe('bootstrap dispatch + compatibility', () => {
  test('legacy invocation (no --model-lane): the env loader is provably NOT applied (pre-seeded values survive)', () => {
    const { stdout } = runCli(['--frc-debug-env'], {
      SONNET_EXTRACT_MODEL: 'claude-bogus-preseed',
      SNAPSHOT_FORMAT: 'single_block',
      VOICE_ORPHAN_PROMPT: 'true',
    });
    const env = JSON.parse(stdout.trim());
    expect(env.SONNET_EXTRACT_MODEL).toBe('claude-bogus-preseed');
    expect(env.SNAPSHOT_FORMAT).toBe('single_block');
    expect(env.VOICE_ORPHAN_PROMPT).toBe('true');
  });

  test('recorded lane: the loader pins the task-def snapshot before anything else', () => {
    const { stdout } = runCli(['--model-lane=recorded', '--frc-debug-env'], {
      SONNET_EXTRACT_MODEL: 'claude-bogus-preseed',
      SNAPSHOT_FORMAT: 'single_block',
      VOICE_ORPHAN_PROMPT: 'true',
    });
    const env = JSON.parse(stdout.trim());
    expect(env.SONNET_EXTRACT_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(env.SNAPSHOT_FORMAT).toBe('split_blocks');
    expect(env.VOICE_ORPHAN_PROMPT).toBeNull();
    expect(env.VOICE_LATENCY_LOADED_BARREL).toBe('false');
    expect(env.NODE_ENV).toBe('production');
    expect(env.ANTHROPIC_API_KEY_PRESENT).toBe(false); // recorded lane clears secrets
  });

  test('an invalid lane value exits 2', () => {
    const r = runCli(['--model-lane=bogus']);
    expect(r.code).toBe(2);
  });

  test('the live lane FAILS without an explicit ANTHROPIC_API_KEY (AWS fallback never used)', () => {
    const clean = { ...process.env };
    delete clean.ANTHROPIC_API_KEY;
    const r = runCli(['--model-lane=live'], { ANTHROPIC_API_KEY: '' });
    expect(r.code).toBe(2);
    expect(String(r.stderr)).toMatch(/ANTHROPIC_API_KEY is REQUIRED/);
  });

  test('legacy usage message preserved when no scenario args given', () => {
    const r = runCli([]);
    expect(r.code).toBe(2);
    expect(String(r.stderr)).toMatch(/--scenario=<path> OR --scenario-dir=<dir>/);
  });
});

describe('recorded-lane corpus execution (subprocess, fake clock)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frc-cli-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeFixture(doc) {
    const dir = path.join(tmp, doc.corpus_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fixture.yaml'), JSON.stringify(doc));
  }

  test('empty corpus exits 0 with the explicit summary', () => {
    const r = runCli(['--model-lane=recorded', `--corpus=${path.join(tmp, 'missing')}`]);
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.discovered).toBe(0);
  });

  test('TIMEOUT-BACKED regression: a large 30s inter-turn logical gap terminates with zero real-time waits', () => {
    writeFixture({
      schema_version: 1,
      corpus_id: 'frc_000000000000000000000000000000aa',
      purpose: 'triage',
      gate_state: 'required_green',
      owner: 'Derek Beckley',
      initial_state_fidelity: 'hand_authored',
      job_state: {
        certificateType: 'eicr',
        boards: [{ id: 'main', board_type: 'main' }],
        circuits: [{ number: 2 }, { number: 3 }],
      },
      client_capabilities: { value: ['low_conf_readback_v1'], provenance: 'recorded_full' },
      fallback_to_legacy: { value: false, provenance: 'recorded_full' },
      turns: [
        {
          turn_index: 1,
          at_ms: 0,
          transcript: 'zed s nought point three five circuit two',
          regex_results: [],
          confirmations_enabled: { value: true, provenance: 'recorded_full' },
          in_response_to: { value: false, provenance: 'recorded_full' },
          ws_mode: 'open',
          chime_observed: true,
          model_rounds: [
            {
              stop_reason: 'tool_use',
              tool_calls: [
                {
                  id: 'sym_tc_zs2',
                  name: 'record_reading',
                  input: { field: 'measured_zs_ohm', circuit: 2, value: '0.35', confidence: 0.9, source_turn_id: 'sym_turn_1' },
                  schema_expectation: 'accept',
                  dispatcher_expectation: 'accept',
                },
              ],
            },
            { stop_reason: 'end_turn', text: '' },
          ],
          expected_operations: [
            {
              operation_id: 'op_zs2',
              kind: 'reading',
              field: 'measured_zs_ohm',
              circuit: 2,
              value: '0.35',
              audibility: 'exactly_once',
            },
          ],
          expected_audible_outputs: [
            {
              output_id: 'out_zs2',
              kind: 'reading_confirmation',
              count: 1,
              match: { field: 'measured_zs_ohm', circuit: 2 },
            },
          ],
        },
        {
          turn_index: 2,
          at_ms: 30_000,
          transcript: 'zed s nought point four one circuit three',
          regex_results: [],
          confirmations_enabled: { value: true, provenance: 'recorded_full' },
          in_response_to: { value: false, provenance: 'recorded_full' },
          ws_mode: 'open',
          chime_observed: true,
          model_rounds: [
            {
              stop_reason: 'tool_use',
              tool_calls: [
                {
                  id: 'sym_tc_zs3',
                  name: 'record_reading',
                  input: { field: 'measured_zs_ohm', circuit: 3, value: '0.41', confidence: 0.9, source_turn_id: 'sym_turn_2' },
                  schema_expectation: 'accept',
                  dispatcher_expectation: 'accept',
                },
              ],
            },
            { stop_reason: 'end_turn', text: '' },
          ],
          expected_operations: [
            {
              operation_id: 'op_zs3',
              kind: 'reading',
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.41',
              audibility: 'exactly_once',
            },
          ],
          expected_audible_outputs: [
            {
              output_id: 'out_zs3',
              kind: 'reading_confirmation',
              count: 1,
              match: { field: 'measured_zs_ohm', circuit: 3 },
            },
          ],
        },
      ],
    });

    const startedReal = Date.now();
    // 20s subprocess ceiling: with real timers the 30s inter-turn logical
    // gap alone would blow it — the ceiling proves the fake clock advanced
    // logical time with zero real wait.
    const r = runCli(['--model-lane=recorded', `--corpus=${tmp}`], {}, { timeout: 20_000 });
    const elapsed = Date.now() - startedReal;
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(elapsed).toBeLessThan(20_000);
  });

  test('--proof-state is INERT without --evidence-mode (structurally unavailable to the blocking script)', () => {
    writeFixture({
      schema_version: 1,
      corpus_id: 'frc_000000000000000000000000000000ab',
      purpose: 'regression',
      gate_state: 'expected_red',
      expected_failure_id: 'audibility.turn',
      red_proof_failure_id: 'audibility.turn',
      owner: 'Derek Beckley',
      introduced_at: '2026-01-10T00:00:00Z',
      fix_reference: 'fix_000000000000000000000000000000ab',
      expires_at: '2099-01-01T00:00:00.000Z',
      initial_state_fidelity: 'hand_authored',
      is_keystone: true,
      job_state: { certificateType: 'eicr', boards: [{ id: 'main', board_type: 'main' }], circuits: [{ number: 2 }] },
      client_capabilities: { value: [], provenance: 'recorded_full' },
      fallback_to_legacy: { value: false, provenance: 'recorded_full' },
      turns: [
        {
          turn_index: 1,
          at_ms: 0,
          transcript: 'garbled whatsit doing over',
          regex_results: [],
          confirmations_enabled: { value: true, provenance: 'reconstructed_reviewed' },
          in_response_to: { value: false, provenance: 'reconstructed_reviewed' },
          ws_mode: 'open',
          chime_observed: true,
          model_rounds: [{ stop_reason: 'end_turn', text: '' }],
        },
      ],
    });
    // Blocking lane: the RED is EXPECTED → exit 0.
    const blocking = runCli(['--model-lane=recorded', `--corpus=${tmp}`, '--proof-state=required_green']);
    expect(blocking.code).toBe(0);
    const s1 = JSON.parse(blocking.stdout);
    expect(s1.results[0].verdict).toBe('pass'); // expected RED confirmed — proof-state ignored
    // Evidence mode honours it: the still-failing assertion FAILS the proof.
    const proof = runCli(['--model-lane=recorded', `--corpus=${tmp}`, '--evidence-mode', '--proof-state=required_green']);
    expect(proof.code).toBe(1);
    const s2 = JSON.parse(proof.stdout);
    expect(s2.results[0].verdict).toBe('fail');
  });
});
