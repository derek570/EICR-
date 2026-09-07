import { afterEach, describe, expect, it, vi } from 'vitest';

import { replayScenario } from './runner';
import type { ReplayScenario } from './scenario';

function scenario(
  name: string,
  transcript: Array<{ at_ms: number; text: string }>,
  regexHints: '0' | '1' = '1'
): ReplayScenario {
  return {
    file: `${name}.yaml`,
    name,
    env: { regex_hints: regexHints },
    job_state: {
      boards: [
        {
          id: 'board-1',
          circuits: [
            { number: 4, designation: 'Lights' },
            { number: 5, designation: 'Sockets' },
          ],
        },
      ],
    },
    transcript,
  };
}

describe('ConversationAdmissionV1 mounted RecordingProvider boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('admits repeat and protects a value-bearing question from every local write', async () => {
    const result = await replayScenario(
      scenario('admission-query-no-write', [
        { at_ms: 0, text: 'Could you repeat that please?' },
        { at_ms: 1_200, text: 'Was circuit four Zs 0.7' },
        { at_ms: 2_400, text: 'Circuit five R1 R2 0.3' },
      ])
    );

    expect(result.sentTranscripts).toEqual([
      'Could you repeat that please?',
      'Was circuit 4 Zs 0.7',
      'Circuit 5 R1 R2 0.3',
    ]);
    expect(result.trace.totals.sonnetSends).toBe(3);
    expect(result.trace.totals.chimes).toBe(3);
    expect(
      result.trace.utterances.slice(0, 2).flatMap((utterance) => utterance.appliedFields)
    ).toEqual([]);
    expect(result.trace.utterances[2].appliedFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: expect.stringContaining('r1'), value: '0.3' })])
    );
  });

  it('clears active matcher context at the query boundary with hints on and off', async () => {
    for (const hints of ['1', '0'] as const) {
      const result = await replayScenario(
        scenario(
          `admission-context-reset-${hints}`,
          [
            { at_ms: 0, text: 'Circuit four' },
            { at_ms: 1_200, text: 'What did you hear?' },
            { at_ms: 2_400, text: 'Zs 0.7' },
          ],
          hints
        )
      );

      expect(result.sentTranscripts).toEqual(['Circuit 4', 'What did you hear?', 'Zs 0.7']);
      expect(
        result.trace.utterances[2].appliedFields.some((field) => field.value === '0.7')
      ).toBe(false);
      expect(
        result.trace.utterances.some(
          (utterance) =>
            utterance.text === 'What did you hear?' && utterance.appliedFields.length > 0
        )
      ).toBe(false);
    }
  });

  it('keeps weak unrelated questions on the existing gate decision', async () => {
    const result = await replayScenario(
      scenario('admission-existing-gate', [
        { at_ms: 0, text: 'Can I use the toilet, please?' },
        { at_ms: 1_200, text: 'Can we move on?' },
      ])
    );
    expect(result.sentTranscripts).toEqual(['Can we move on?']);
    expect(result.trace.totals.chimes).toBe(1);
  });
});
