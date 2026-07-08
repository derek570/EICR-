/**
 * B3 mock-frame PROVENANCE regression (pwa-replay-harness Wave 3/4).
 *
 * Rule: mock backend frames may be reconstructed from SERVER-ORIGIN iOS
 * log events ONLY (`sonnet/` category: field_set, field_update,
 * confirmation_received, question_asked). Regex-category client events
 * (`regex/field_matched`, a hypothetical regex-tier field_set) must NEVER
 * become mock frames — feeding a client regex write back as fake backend
 * output would mask exactly the A3 bug class the harness exists to catch
 * (and contradict D1 invariant 1's regex-tier exemption).
 *
 * This drives the real convert-session.mjs over a synthetic debug log
 * containing a regex-category field_set + field_matched and asserts no
 * extraction frame is produced from them.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const converter = path.join(repoRoot, 'scripts/pwa-replay/convert-session.mjs');

function writeSyntheticSession(dir: string): void {
  const t0 = '2026-07-08T10:00:00.000Z';
  const t = (s: number) => new Date(Date.parse(t0) + s * 1000).toISOString();
  const lines = [
    {
      category: 'session',
      event: 'session_start',
      data: { sessionId: 'SYNTH-PROVENANCE' },
      timestamp: t0,
    },
    // Utterance 1 — a REGEX-category field_set + field_matched (client
    // trace) AND a server-origin sonnet field_set. Only the sonnet one may
    // become a frame.
    {
      category: 'deepgram',
      event: 'final_transcript',
      data: { raw: 'Ze is naught point four two.', normalised: 'Ze is 0.42.' },
      timestamp: t(2),
    },
    {
      category: 'regex',
      event: 'field_matched',
      data: { field: 'ze', value: '0.42' },
      timestamp: t(2.1),
    },
    {
      category: 'regex',
      event: 'field_set',
      data: { key: 'supply.ze', value: '0.42' },
      timestamp: t(2.2),
    },
    {
      category: 'sonnet',
      event: 'server_extraction_received',
      data: { readings: 1 },
      timestamp: t(4),
    },
    {
      category: 'sonnet',
      event: 'field_set',
      data: { key: 'supply.ze', value: '0.42' },
      timestamp: t(4.1),
    },
    {
      category: 'sonnet',
      event: 'confirmation_received',
      data: { field: 'earth_loop_impedance_ze', circuit: 'nil', text: 'Ze 0.42', deferred: false },
      timestamp: t(4.2),
    },
    // Utterance 2 — ONLY regex-category events. Must produce NO frames.
    {
      category: 'deepgram',
      event: 'final_transcript',
      data: { raw: 'What do you mean?', normalised: 'What do you mean?' },
      timestamp: t(10),
    },
    {
      category: 'regex',
      event: 'field_matched',
      data: { field: 'ze', value: '0.42' },
      timestamp: t(10.1),
    },
    {
      category: 'regex',
      event: 'field_set',
      data: { key: 'supply.ze', value: '0.42' },
      timestamp: t(10.2),
    },
  ];
  fs.writeFileSync(
    path.join(dir, 'debug_log.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ sessionId: 'SYNTH-PROVENANCE', timestamp: t0 })
  );
}

describe('B3 provenance — regex-category events never become mock frames', () => {
  it('converter emits frames from sonnet-category events only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-out-'));
    writeSyntheticSession(dir);
    execFileSync('node', [converter, `--dir=${dir}`, '--name=synth', `--out-dir=${out}`]);
    const fixture = yaml.load(fs.readFileSync(path.join(out, 'synth.yaml'), 'utf8')) as {
      mock_frames?: Array<{ on_transcript: string; frames: Array<Record<string, unknown>> }>;
    };
    const frames = fixture.mock_frames ?? [];
    // Utterance 1: exactly ONE extraction frame, from the sonnet events.
    const u1 = frames.find((f) => f.on_transcript.includes('naught point four two'));
    expect(u1).toBeTruthy();
    expect(u1!.frames).toHaveLength(1);
    // Utterance 2 (regex-only): NO frames at all.
    const u2 = frames.find((f) => f.on_transcript === 'What do you mean?');
    expect(u2).toBeUndefined();
  });
});
