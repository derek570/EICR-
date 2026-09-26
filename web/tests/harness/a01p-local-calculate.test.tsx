/**
 * A01P (2026-09-08) — mounted RecordingProvider proof for the web Calculate
 * companion. Every scenario starts at ACTUAL final transcripts with
 * production regex hints ON (plus OFF controls) and drives the REAL parser,
 * the REAL admission classifier, the REAL gate, the REAL send path and the
 * REAL confirmation FIFO (playback starts counted at the harness player's
 * `controls.onStart` — DictatedReadbackPolicyV1's measured point).
 *
 * Contract under test:
 *   - single-board job (boards absent / null / [] / one entry): a recognised
 *     Calculate executes LOCALLY through the typed calculator, zero server
 *     calls, ONE read-back per accepted operation, Ze resolved once for the
 *     job (board override → at-DB → supply long → short);
 *   - two-board job: the parse is DISCARDED, the final is sent as an ordinary
 *     transcript carrying the additive `client_command` marker — even the
 *     trigger-less "calculate impedance for all" / "calculate z s for all" —
 *     with zero local mutation and zero local read-back;
 *   - board-qualified trailing text forwards on ANY job;
 *   - terminal punctuation and the ConversationAdmissionV1 carve-out rescue
 *     `?`-terminated commands; mixed queries and protected ordinals do not;
 *   - the regex 0.35 → accepted → server 0.50 correction → Calculate → 0.70
 *     sequence with both supply aliases persisted and NO implicit 0.55.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replayScenario, type ReplayResult } from './runner';
import type { ReplayScenario } from './scenario';
import { invariant1_everyConfirmationPlaysExactlyOnce } from './invariants';

const FIXTURE_DIR = resolve(process.cwd(), '../src/__tests__/fixtures/job-state');
const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;

type Board = { id: string; designation?: string } & Record<string, unknown>;

function scenario(
  name: string,
  transcript: Array<{ at_ms: number; text: string }>,
  jobState: {
    supply?: Record<string, unknown>;
    board_info?: Record<string, unknown>;
    boards?: Board[];
    circuits?: Array<Record<string, unknown>>;
    job_detail?: Record<string, unknown>;
  },
  extra: Partial<ReplayScenario> = {}
): ReplayScenario {
  const boards: Board[] = jobState.boards ?? [{ id: 'main' }];
  // `circuit_designation` is the spare-classification signal (blank = spare,
  // excluded from `all`), so every row carries it beside `designation`.
  const circuits = (
    jobState.circuits ?? [
      { number: 1, designation: 'Kitchen Ring', r1_r2_ohm: '0.20' },
      { number: 2, designation: 'Lights', r1_r2_ohm: '0.30' },
    ]
  ).map((row) => ({ circuit_designation: row.designation, ...row }));
  return {
    file: `${name}.inline`,
    name,
    confirmation_mode: false,
    job_state: {
      supply: jobState.supply ?? {},
      board_info: jobState.board_info,
      boards: boards.map((b, i) => (i === 0 ? { ...b, circuits } : b)),
      job_detail: jobState.job_detail,
    },
    transcript,
    ...extra,
  };
}

const sends = (r: ReplayResult) =>
  r.trace.utterances.filter((u) => u.sonnetSent).map((u) => u.dispatchedText);
const applied = (r: ReplayResult) => r.trace.utterances.flatMap((u) => u.appliedFields);
const localCalcOutcomes = (r: ReplayResult) =>
  r.trace.utterances.flatMap((u) => u.events.filter((e) => e.kind === 'local_calculate_outcome'));
const forwarded = (r: ReplayResult) =>
  r.trace.utterances.flatMap((u) => u.events.filter((e) => e.kind === 'local_calculate_forwarded'));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('[invariant] single-board local Calculate (hints ON and OFF)', () => {
  for (const hints of ['1', '0'] as const) {
    it(`"calculate Zs for circuit 1" computes locally through the typed calculator, one read-back, no server send (hints=${hints})`, async () => {
      const r = await replayScenario(
        scenario(
          `local-calc-single-${hints}`,
          [{ at_ms: 0, text: 'calculate Zs for circuit 1' }],
          { supply: { ze: '0.35' } },
          { env: { regex_hints: hints } }
        )
      );
      expect(r.trace.totals.confirmationsPlayed).toEqual(['Circuit 1, Zs calculated as 0.55 ohms']);
      expect(r.trace.totals.sonnetSends).toBe(0);
      expect(applied(r)).toEqual(
        expect.arrayContaining([
          { key: 'circuits[1].measured_zs_ohm', value: '0.55', source: 'local_command' },
        ])
      );
      expect(localCalcOutcomes(r)).toHaveLength(1);
      expect(localCalcOutcomes(r)[0].payload.outcome).toBe('applied');
      expect(invariant1_everyConfirmationPlaysExactlyOnce(r.trace)).toEqual([]);
      // Playback-start latency is recorded at the FIFO seam.
      const latency = r.trace.utterances[0].events.find(
        (e) => e.kind === 'local_calculate_playback_started'
      );
      expect(latency).toBeDefined();
      expect(typeof latency!.payload.latencyMs).toBe('number');
    });
  }

  it('the trigger-less grammars ("calculate impedance for all", "calculate z s for all") compute locally too', async () => {
    for (const text of ['calculate impedance for all', 'calculate z s for all']) {
      const r = await replayScenario(
        scenario(`local-calc-${text.replace(/\s+/g, '-')}`, [{ at_ms: 0, text }], {
          supply: { ze: '0.35' },
        })
      );
      expect(r.trace.totals.confirmationsPlayed).toEqual([
        'Circuit 1, Zs calculated as 0.55 ohms. Circuit 2, Zs calculated as 0.65 ohms',
      ]);
      expect(r.trace.totals.sonnetSends).toBe(0);
    }
  });

  it('punctuation controls execute locally, classified ORDINARY at the raw-final classifier, exactly one read-back', async () => {
    for (const text of [
      'calculate Zs for circuit 1.',
      'Calculate Zs for circuit one?',
      'Calculate Zs for circuits one to two?',
    ]) {
      const r = await replayScenario(
        scenario(`local-calc-punct-${text.length}`, [{ at_ms: 0, text }], {
          supply: { ze: '0.35' },
        })
      );
      expect(r.trace.totals.confirmationsPlayed.length, text).toBe(1);
      expect(r.trace.totals.sonnetSends, text).toBe(0);
      const finalEv = r.trace.utterances[0].events.find(
        (e) => e.kind === 'pipeline_final_transcript'
      );
      expect(finalEv, text).toBeDefined();
    }
  });

  it('a mixed-query control and the protected-ordinal negative execute nothing locally', async () => {
    for (const text of [
      'calculate Zs for circuit one, what did I say?',
      'Calculate Zs for second one?',
    ]) {
      const r = await replayScenario(
        scenario(`local-calc-neg-${text.length}`, [{ at_ms: 0, text }], { supply: { ze: '0.35' } })
      );
      expect(r.trace.totals.confirmationsPlayed, text).toEqual([]);
      expect(
        applied(r).some((f) => f.key.includes('measured_zs_ohm')),
        text
      ).toBe(false);
      expect(localCalcOutcomes(r), text).toHaveLength(0);
    }
  });
});

describe('[invariant] single-board Ze ladder through the real job keys', () => {
  it('a one-board job whose circuits carry absent and empty board_id uses the board Ze override, not supply, and touches the addressed row', async () => {
    const r = await replayScenario(
      scenario('local-calc-board-override', [{ at_ms: 0, text: 'calculate Zs for circuit 2' }], {
        supply: { ze: '0.50', earth_loop_impedance_ze: '0.50' },
        boards: [{ id: 'main', board_type: 'main', ze: '0.30' }],
        circuits: [
          { number: 1, designation: 'Kitchen Ring', r1_r2_ohm: '0.20' },
          { number: 2, designation: 'Lights', r1_r2_ohm: '0.30', board_id: '' },
        ],
      })
    );
    expect(r.trace.totals.confirmationsPlayed).toEqual(['Circuit 2, Zs calculated as 0.60 ohms']);
    expect(applied(r)).toEqual(
      expect.arrayContaining([
        { key: 'circuits[2].measured_zs_ohm', value: '0.60', source: 'local_command' },
      ])
    );
    expect(
      applied(r).some((f) => f.key === 'circuits[1].measured_zs_ohm' && f.value !== undefined)
    ).toBe(false);
  });

  it('separately, the at-DB value (zs_at_db) beats supply when the override is blank', async () => {
    const r = await replayScenario(
      scenario('local-calc-at-db', [{ at_ms: 0, text: 'calculate Zs for circuit 1' }], {
        supply: { ze: '0.50' },
        boards: [{ id: 'main', board_type: 'main', zs_at_db: '0.40' }],
      })
    );
    expect(r.trace.totals.confirmationsPlayed).toEqual(['Circuit 1, Zs calculated as 0.60 ohms']);
  });

  it('a boards-less job (boards null, empty board_info) uses the supply ladder', async () => {
    const r = await replayScenario(
      scenario('local-calc-boardless', [{ at_ms: 0, text: 'calculate Zs for circuit 1' }], {
        supply: { earth_loop_impedance_ze: '0.35' },
        job_detail: { boards: null, board_info: {} },
      })
    );
    expect(r.trace.totals.confirmationsPlayed).toEqual(['Circuit 1, Zs calculated as 0.55 ohms']);
  });

  it.each(['single-board-boards-null.json', 'single-board-boards-empty.json'])(
    'fixture %s (board_info.ze 0.35, supply 0.50, R1+R2 0.20) through the real adapter selects board_info and writes 0.55',
    async (file) => {
      const fixture = readFixture(file);
      const r = await replayScenario(
        scenario(`local-calc-fixture-${file}`, [{ at_ms: 0, text: 'calculate Zs for circuit 1' }], {
          supply: fixture.supply_characteristics as Record<string, unknown>,
          circuits: [{ number: 1, designation: 'Kitchen Ring', r1_r2_ohm: '0.20' }],
          job_detail: { boards: fixture.boards, board_info: fixture.board_info },
        })
      );
      expect(r.trace.totals.confirmationsPlayed).toEqual(['Circuit 1, Zs calculated as 0.55 ohms']);
      expect(applied(r)).toEqual(
        expect.arrayContaining([
          { key: 'circuits[1].measured_zs_ohm', value: '0.55', source: 'local_command' },
        ])
      );
    }
  );

  it('a recorded LIM Ze speaks the policy line exactly once and mutates nothing; an absent Ze keeps the no-Ze wording', async () => {
    const lim = await replayScenario(
      scenario('local-calc-lim', [{ at_ms: 0, text: 'calculate Zs for circuit 1' }], {
        supply: { earth_loop_impedance_ze: '0.50' },
        boards: [{ id: 'main', board_type: 'main', ze: 'LIM' }],
      })
    );
    expect(lim.trace.totals.confirmationsPlayed).toEqual(['I couldn’t apply that calculation.']);
    expect(applied(lim).some((f) => f.key.includes('measured_zs_ohm'))).toBe(false);
    expect(localCalcOutcomes(lim)[0].payload).toMatchObject({
      outcome: 'unsupported',
      reason: 'ze_unreadable',
    });

    const absent = await replayScenario(
      scenario('local-calc-absent', [{ at_ms: 0, text: 'calculate Zs for circuit 1' }], {
        supply: {},
        boards: [{ id: 'main', board_type: 'main' }],
      })
    );
    expect(absent.trace.totals.confirmationsPlayed).toEqual([
      "I can't calculate that — no zed E value has been set yet.",
    ]);
  });
});

describe('[invariant] the accepted-Ze sequence: regex 0.35 → echo → server 0.50 (no fresh regex) → echo → Calculate → 0.70', () => {
  it('both supply aliases persist 0.50, no implicit 0.55, requested Zs 0.70, one read-back per accepted operation', async () => {
    const r = await replayScenario(
      scenario(
        'accepted-ze-sequence',
        [
          { at_ms: 0, text: 'Ze is 0.35' },
          { at_ms: 3_000, text: 'Actually make that nought point five' },
          { at_ms: 6_000, text: 'calculate Zs for circuit 1' },
        ],
        { supply: {}, boards: [{ id: 'main', board_type: 'main' }] },
        {
          mock_frames: [
            {
              on_transcript: 'Ze is 0.35',
              frames: [
                {
                  type: 'extraction',
                  readings: [{ field: 'ze', value: '0.35', circuit: 0 }],
                  confirmations: [{ field: 'ze', circuit: 0, text: 'Ze 0.35' }],
                },
              ],
            },
            {
              on_transcript: 'Actually make that nought point five',
              frames: [
                {
                  type: 'extraction',
                  readings: [{ field: 'ze', value: '0.50', circuit: 0 }],
                  confirmations: [{ field: 'ze', circuit: 0, text: 'Ze 0.50' }],
                },
              ],
            },
          ],
        }
      )
    );
    const all = applied(r);
    // No implicit derivation anywhere before the explicit Calculate.
    expect(all.some((f) => f.key.includes('measured_zs_ohm') && f.value === '0.55')).toBe(false);
    expect(all).toEqual(
      expect.arrayContaining([
        { key: 'supply_characteristics.ze', value: '0.50', source: 'extraction' },
        {
          key: 'supply_characteristics.earth_loop_impedance_ze',
          value: '0.50',
          source: 'extraction',
        },
        { key: 'circuits[1].measured_zs_ohm', value: '0.70', source: 'local_command' },
      ])
    );
    expect(r.trace.totals.confirmationsPlayed).toEqual([
      'Ze 0.35',
      'Ze 0.50',
      'Circuit 1, Zs calculated as 0.70 ohms',
    ]);
    expect(invariant1_everyConfirmationPlaysExactlyOnce(r.trace)).toEqual([]);
    expect(r.trace.totals.sonnetSends).toBe(2);
  });

  it('R1+R2 dictated between the Ze steps and both alias orders still yield the requested Zs from the LATEST Ze', async () => {
    const r = await replayScenario(
      scenario(
        'accepted-ze-order',
        [
          { at_ms: 0, text: 'Ze is 0.35' },
          { at_ms: 3_000, text: 'Circuit 1 R1 plus R2 0.20' },
          { at_ms: 6_000, text: 'Make the earth loop impedance nought point five' },
          { at_ms: 9_000, text: 'calculate Zs for circuit 1' },
        ],
        {
          supply: {},
          boards: [{ id: 'main', board_type: 'main' }],
          circuits: [{ number: 1, designation: 'Kitchen Ring' }],
        },
        {
          mock_frames: [
            {
              on_transcript: 'Ze is 0.35',
              frames: [
                {
                  type: 'extraction',
                  readings: [{ field: 'earth_loop_impedance_ze', value: '0.35', circuit: 0 }],
                  confirmations: [
                    { field: 'earth_loop_impedance_ze', circuit: 0, text: 'Ze 0.35' },
                  ],
                },
              ],
            },
            {
              on_transcript: 'Circuit 1 R1 plus R2 0.20',
              frames: [
                {
                  type: 'extraction',
                  readings: [{ field: 'r1_r2_ohm', value: '0.20', circuit: 1 }],
                  confirmations: [
                    { field: 'r1_r2_ohm', circuit: 1, text: 'Circuit 1, R1 plus R2 0.20' },
                  ],
                },
              ],
            },
            {
              on_transcript: 'Make the earth loop impedance nought point five',
              frames: [
                {
                  type: 'extraction',
                  readings: [{ field: 'ze', value: '0.50', circuit: 0 }],
                  confirmations: [{ field: 'ze', circuit: 0, text: 'Ze 0.50' }],
                },
              ],
            },
          ],
        }
      )
    );
    expect(r.trace.totals.confirmationsPlayed.at(-1)).toBe('Circuit 1, Zs calculated as 0.70 ohms');
    expect(applied(r).some((f) => f.key.includes('measured_zs_ohm') && f.value === '0.55')).toBe(
      false
    );
  });

  it('an earlier queued accepted-reading confirmation followed by a local Calculate: both play exactly once, in order', async () => {
    for (const hints of ['1', '0'] as const) {
      const r = await replayScenario(
        scenario(
          `fifo-order-${hints}`,
          [
            { at_ms: 0, text: 'Circuit 2 Zs 0.44' },
            { at_ms: 1_500, text: 'calculate Zs for circuit 1' },
          ],
          { supply: { ze: '0.35' } },
          {
            env: { regex_hints: hints },
            mock_frames: [
              {
                on_transcript: 'Circuit 2 Zs 0.44',
                frames: [
                  {
                    type: 'extraction',
                    readings: [{ field: 'measured_zs_ohm', value: '0.44', circuit: 2 }],
                    confirmations: [
                      { field: 'measured_zs_ohm', circuit: 2, text: 'Circuit 2, Zs 0.44' },
                    ],
                  },
                ],
              },
            ],
          }
        )
      );
      expect(r.trace.totals.confirmationsPlayed).toEqual([
        'Circuit 2, Zs 0.44',
        'Circuit 1, Zs calculated as 0.55 ohms',
      ]);
      expect(invariant1_everyConfirmationPlaysExactlyOnce(r.trace)).toEqual([]);
    }
  });
});

describe('[invariant] multi-board forwarding — the parse is discarded, the final is an ordinary transcript with client_command', () => {
  const twoBoards: Board[] = [
    { id: 'main', designation: 'Main DB', board_type: 'main', ze: '0.35' },
    { id: 'garage', designation: 'Garage CU', board_type: 'sub_distribution', ze: '0.38' },
  ];

  it.each([
    ['calculate Zs for circuit 1', 'calculate_zs'],
    ['calculate Zs for circuits 1 to 2', 'calculate_zs'],
    ['calculate Zs for all', 'calculate_zs'],
    ['calculate impedance for all', 'calculate_zs'],
    ['calculate z s for all', 'calculate_zs'],
    ['calculate impedance for all.', 'calculate_zs'],
    ['calculate z s for all?', 'calculate_zs'],
    ['calculate R1 plus R2 for all', 'calculate_r1_plus_r2'],
    ['calculate Zs for circuit 1 on the garage board', 'calculate_zs'],
  ])('"%s" → zero local mutation, zero local read-back, sent with %s', async (text, marker) => {
    const r = await replayScenario(
      scenario(`multi-fwd-${text.length}-${marker}`, [{ at_ms: 0, text }], {
        supply: { ze: '0.50' },
        boards: twoBoards,
      })
    );
    expect(r.trace.totals.confirmationsPlayed).toEqual([]);
    expect(applied(r).filter((f) => f.source === 'local_command')).toEqual([]);
    expect(
      applied(r).some(
        (f) =>
          (f.key.includes('measured_zs_ohm') || f.key.endsWith('.r1_r2_ohm')) && f.value === '0.85'
      )
    ).toBe(false);
    expect(localCalcOutcomes(r)).toHaveLength(0);
    expect(r.trace.totals.sonnetSends).toBe(1);
    expect(r.trace.utterances[0].gate).toBe('passed');
    const send = r.trace.utterances[0].events.find((e) => e.kind === 'pipeline_sonnet_send');
    expect(send?.payload.clientCommand).toBe(marker);
    expect(send?.payload.admission).toBe('ORDINARY');
    expect(forwarded(r)[0]?.payload.reason).toBe(
      text.includes('on the garage board') ? 'trailing_text' : 'multi_board'
    );
  });

  it('control: an UNPARSED trigger-less utterance on the same job is still gate-blocked client-side', async () => {
    const r = await replayScenario(
      scenario('multi-control-blocked', [{ at_ms: 0, text: 'impedance for everything please' }], {
        supply: { ze: '0.50' },
        boards: twoBoards,
      })
    );
    expect(r.trace.totals.sonnetSends).toBe(0);
    expect(r.trace.utterances[0].gate).toBe('blocked');
  });

  // PLAN-W2 (I-24, Decision W-1.4) — this case used to pin the defect: a
  // two-board apply-field wrote every board's circuits locally. It now copies
  // Calculate: nothing is written, and the utterance forwards as an ordinary
  // transcript. Unlike Calculate it carries no `client_command` marker
  // (Decision 13 forbids widening that union).
  it('apply_field on the same two-board job forwards like Calculate, with no marker and no local write', async () => {
    const r = await replayScenario(
      scenario('multi-apply-field', [{ at_ms: 0, text: 'wiring type A for all circuits' }], {
        supply: { ze: '0.50' },
        boards: twoBoards,
      })
    );
    expect(r.trace.totals.sonnetSends).toBe(1);
    expect(applied(r).some((f) => f.key.includes('wiring_type'))).toBe(false);
    expect(
      r.trace.utterances[0].events.find((e) => e.kind === 'pipeline_sonnet_send')?.payload
        .clientCommand
    ).toBeNull();
  });
});

describe('[invariant] board-qualified trailing text forwards on ANY job; a bare scope stays local', () => {
  for (const sole of ['main', 'garage']) {
    it(`sole-${sole} job: "… on the garage board" and its range form forward; "calculate Zs for circuit 1." stays local`, async () => {
      for (const text of [
        'calculate Zs for circuit 1 on the garage board',
        'calculate Zs for circuits 1 to 2 on the garage board',
      ]) {
        const r = await replayScenario(
          scenario(`sole-${sole}-fwd-${text.length}`, [{ at_ms: 0, text }], {
            supply: { ze: '0.35' },
            boards: [
              {
                id: sole,
                designation: sole,
                board_type: sole === 'main' ? 'main' : 'sub_distribution',
              },
            ],
          })
        );
        expect(r.trace.totals.confirmationsPlayed, text).toEqual([]);
        expect(
          applied(r).some((f) => f.key.includes('measured_zs_ohm')),
          text
        ).toBe(false);
        expect(r.trace.totals.sonnetSends, text).toBe(1);
        expect(
          r.trace.utterances[0].events.find((e) => e.kind === 'pipeline_sonnet_send')?.payload
            .clientCommand
        ).toBe('calculate_zs');
      }
      const local = await replayScenario(
        scenario(`sole-${sole}-local`, [{ at_ms: 0, text: 'calculate Zs for circuit 1.' }], {
          supply: { ze: '0.35' },
          boards: [
            {
              id: sole,
              designation: sole,
              board_type: sole === 'main' ? 'main' : 'sub_distribution',
            },
          ],
        })
      );
      expect(local.trace.totals.confirmationsPlayed).toEqual([
        'Circuit 1, Zs calculated as 0.55 ohms',
      ]);
      expect(local.trace.totals.sonnetSends).toBe(0);
    });
  }
});

describe('[current_behaviour] legacy server action path uses the same three-state calculator', () => {
  it('a server `calculate_impedance` action over a recorded LIM speaks only the policy line, never the model success', async () => {
    const r = await replayScenario({
      file: 'legacy-lim.inline',
      name: 'legacy-lim',
      confirmation_mode: false,
      job_state: {
        supply: { earth_loop_impedance_ze: '0.50' },
        boards: [
          {
            id: 'main',
            board_type: 'main',
            ze: 'LIM',
            circuits: [
              {
                number: 1,
                designation: 'Sockets',
                circuit_designation: 'Sockets',
                r1_r2_ohm: '0.45',
              },
            ],
          },
        ],
      },
      transcript: [{ at_ms: 0, text: 'Please handle command legacy for circuit 1.' }],
      mock_frames: [
        {
          on_transcript: 'Please handle command legacy for circuit 1.',
          frames: [
            {
              type: 'voice_command_response',
              understood: true,
              spoken_response: 'Done, Zs calculated.',
              action: { type: 'calculate_impedance', params: { calculate: 'zs', circuits: 'all' } },
            },
          ],
        },
      ],
    });
    expect(r.trace.totals.confirmationsPlayed).toEqual(['I couldn’t apply that calculation.']);
    expect(applied(r).some((f) => f.key.includes('measured_zs_ohm'))).toBe(false);
  });
});

describe('[invariant] client_name — the web half of the global identity route', () => {
  it('a board-scope clear frame for client_name from a garage-selected job clears installation_details.client_name only', async () => {
    const r = await replayScenario({
      file: 'client-name-clear.inline',
      name: 'client-name-clear',
      confirmation_mode: false,
      job_state: {
        supply: { ze: '0.35' },
        boards: [
          {
            id: 'main',
            board_type: 'main',
            circuits: [{ number: 1, designation: 'Sockets', circuit_designation: 'Sockets' }],
          },
          { id: 'garage', board_type: 'sub_distribution' },
        ],
        job_detail: { installation_details: { client_name: 'Mrs Smith', address: '1 A St' } },
      },
      transcript: [{ at_ms: 0, text: 'Clear the client name' }],
      mock_frames: [
        {
          on_transcript: 'Clear the client name',
          frames: [
            { type: 'field_corrected', circuit: null, field: 'client_name', board_id: 'garage' },
          ],
        },
      ],
    });
    const fields = applied(r);
    expect(
      fields.some((f) => f.key === 'installation_details.address' && f.value === '1 A St')
    ).toBe(true);
    expect(fields.some((f) => f.key === 'installation_details.client_name')).toBe(false);
    expect(fields.some((f) => f.key.startsWith('supply_characteristics.ze'))).toBe(false);
    expect(fields.some((f) => f.key.startsWith('boards'))).toBe(false);
  });
});
