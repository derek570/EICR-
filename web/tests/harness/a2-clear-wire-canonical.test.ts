/**
 * A2 mock-lane pin (field-feedback-2026-07-14) — canonicalised
 * `field_corrected` clear wire.
 *
 * Backend PR #87 (`dispatchClearReading` → bundler rewrite) now
 * canonicalises the OUTBOUND `field_corrected` wire key through
 * FIELD_CORRECTIONS (`r1_r2_ohm` → `r1_plus_r2`) — EXCEPT the
 * CLEAR_WIRE_EXEMPT set (`r2_ohm` keeps its raw form, because on iOS the
 * corrected `r2` key would land on the R1+R2 cell). This suite pins that
 * web's apply path handles BOTH shapes through the REAL
 * RecordingProvider → onFieldCorrected → field_clears →
 * `translateCircuitField` chain (apply-extraction.ts
 * LEGACY_TO_PWA_CIRCUIT_FIELD maps `r1_plus_r2` → `r1_r2_ohm`; `r2_ohm`
 * passes through raw onto the modern column), so a web regression on
 * `field_corrected` mapping — the F5 "TTS said cleared, cell still
 * populated" class — fails deterministically here. Mock lane: scripted
 * frames, fake timers, zero tokens.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { replayScenario, type ReplayResult } from './runner';
import type { ReplayScenario } from './scenario';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';

const CLEAR_R1R2 = 'Clear the reading on circuit 2.';
const CLEAR_R2 = 'Now clear the second reading on circuit 2.';

const scenario: ReplayScenario = {
  file: '(inline) a2-clear-wire-canonical',
  name: 'a2-clear-wire-canonical',
  description:
    'field_corrected with canonical r1_plus_r2 clears the r1_r2_ohm cell; ' +
    'CLEAR_WIRE_EXEMPT r2_ohm arrives raw and clears the r2_ohm cell.',
  suite: 'pwa-replay-harness',
  job_state: {
    boards: [
      {
        id: 'main',
        designation: 'DB-1',
        circuits: [
          // Sibling circuit — proves the clear is scoped to circuit 2.
          { number: 1, designation: 'Cooker', r1_r2_ohm: '0.41' },
          // Target circuit — both clearable cells populated.
          { number: 2, designation: 'Upstairs lights', r1_r2_ohm: '0.86', r2_ohm: '0.30' },
        ],
      },
    ],
  },
  transcript: [
    { at_ms: 0, text: CLEAR_R1R2, isFinal: true },
    { at_ms: 8000, text: CLEAR_R2, isFinal: true },
  ],
  mock_frames: [
    {
      on_transcript: CLEAR_R1R2,
      // CANONICAL wire key (post-A2 backend): r1_plus_r2, NOT the raw
      // dispatcher key r1_r2_ohm.
      frames: [{ type: 'field_corrected', circuit: 2, field: 'r1_plus_r2' }],
    },
    {
      on_transcript: CLEAR_R2,
      // CLEAR_WIRE_EXEMPT: r2_ohm stays RAW on the wire by design.
      frames: [{ type: 'field_corrected', circuit: 2, field: 'r2_ohm' }],
    },
  ],
};

/** Flattened applied-field keys for the utterance (extraction source). */
function appliedKeys(result: ReplayResult, utteranceText: string): Map<string, unknown> {
  const u = result.trace.utterances.find((x) => x.text === utteranceText.slice(0, 80));
  expect(u, `utterance "${utteranceText}" missing from trace`).toBeTruthy();
  const map = new Map<string, unknown>();
  for (const f of u!.appliedFields) map.set(f.key, f.value);
  return map;
}

describe('A2 pin — canonicalised field_corrected clear wire (mock lane)', () => {
  afterEach(() => {
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
  });

  it('r1_plus_r2 (canonical) clears the r1_r2_ohm cell; r2_ohm (exempt, raw) clears the r2_ohm cell', async () => {
    const result = await replayScenario(scenario, { mode: 'mock' });

    // Both utterances must have reached the send (mock frames key on it).
    for (const text of [CLEAR_R1R2, CLEAR_R2]) {
      const u = result.trace.utterances.find((x) => x.text === text.slice(0, 80));
      expect(u?.sonnetSent, `"${text}" never sent — gate change?`).toBe(true);
    }

    // ── Utterance 1: canonical r1_plus_r2 → r1_r2_ohm cleared ──
    const after1 = appliedKeys(result, CLEAR_R1R2);
    // The apply ran and re-emitted circuit 2's row…
    expect(after1.get('circuits[2].designation')).toBe('Upstairs lights');
    // …WITHOUT the cleared column (F5 class: pre-A2 an unmapped wire key
    // left the cell populated while TTS said "cleared").
    expect(after1.has('circuits[2].r1_r2_ohm')).toBe(false);
    // The r1_plus_r2 clear must NOT touch the separate bare-R2 cell…
    expect(after1.get('circuits[2].r2_ohm')).toBe('0.30');
    // …nor the sibling circuit's R1+R2.
    expect(after1.get('circuits[1].r1_r2_ohm')).toBe('0.41');
    // And the wire key must never leak through as a raw column write.
    expect(after1.has('circuits[2].r1_plus_r2')).toBe(false);

    // ── Utterance 2: CLEAR_WIRE_EXEMPT r2_ohm arrives raw → r2_ohm cleared ──
    const after2 = appliedKeys(result, CLEAR_R2);
    expect(after2.get('circuits[2].designation')).toBe('Upstairs lights');
    expect(after2.has('circuits[2].r2_ohm')).toBe(false);
    // r1_r2_ohm was already cleared by utterance 1 and must not reappear.
    expect(after2.has('circuits[2].r1_r2_ohm')).toBe(false);
    // Sibling circuit untouched throughout.
    expect(after2.get('circuits[1].r1_r2_ohm')).toBe('0.41');
  });
});
