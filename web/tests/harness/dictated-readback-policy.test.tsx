import { describe, expect, it } from 'vitest';
import { replayScenario } from './runner';
import type { ReplayScenario } from './scenario';

const scenario = (
  name: string,
  spokenResponse: string,
  action: { type: string; params: Record<string, unknown> },
  circuits: Array<Record<string, unknown>>,
  supply: Record<string, unknown> = {}
): ReplayScenario => ({
  file: `${name}.inline`,
  name,
  confirmation_mode: false,
  job_state: {
    supply,
    boards: [
      {
        id: 'main',
        circuits: circuits.map((row, index) => ({
          number: Number(row.number ?? index + 1),
          designation: String(row.designation ?? 'Circuit'),
          circuit_designation: String(row.designation ?? 'Circuit'),
          ...row,
        })),
      },
    ],
  },
  transcript: [{ at_ms: 0, text: `Please handle command ${name} for circuit 1.` }],
  mock_frames: [
    {
      on_transcript: `Please handle command ${name} for circuit 1.`,
      frames: [
        {
          type: 'voice_command_response',
          understood: true,
          spoken_response: spokenResponse,
          action,
        },
      ],
    },
  ],
});

describe('DictatedReadbackPolicyV1 — mounted RecordingProvider action speech', () => {
  it('replaces blank model narration with the actual applied field and value while extra prompts are off', async () => {
    const result = await replayScenario(
      scenario(
        'update',
        '',
        { type: 'update_field', params: { field: 'zs', value: '0.44', circuit: 1 } },
        [{ number: 1, designation: 'Sockets' }]
      )
    );
    expect(result.trace.totals.confirmationsPlayed).toEqual(['Set Zs to 0.44 on circuit 1.']);
  });

  it('replaces contradictory generic narration with every actual calculated value', async () => {
    const result = await replayScenario(
      scenario(
        'calculate',
        'Done.',
        { type: 'calculate_impedance', params: { calculate: 'zs', circuits: 'all' } },
        [
          { number: 1, designation: 'Sockets', r1_r2_ohm: '0.45' },
          { number: 2, designation: 'Lights', r1_r2_ohm: '0.20' },
        ],
        { ze: '0.35' }
      )
    );
    expect(result.trace.totals.confirmationsPlayed).toEqual([
      'Circuit 1, Zs calculated as 0.80 ohms. Circuit 2, Zs calculated as 0.55 ohms',
    ]);
  });

  it('never speaks the server success line when the local target is missing', async () => {
    const result = await replayScenario(
      scenario(
        'missing',
        'Set Zs to 0.44 on circuit 99.',
        { type: 'update_field', params: { field: 'zs', value: '0.44', circuit: 99 } },
        [{ number: 1, designation: 'Sockets' }]
      )
    );
    expect(result.trace.totals.confirmationsPlayed).toEqual(["Circuit 99 doesn't exist."]);
  });
});
