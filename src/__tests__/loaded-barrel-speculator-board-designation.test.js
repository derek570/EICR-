/**
 * A2-multiboard item 3, sub-part (H) — the loaded-barrel speculator resolves
 * circuit designations on the EFFECTIVE board.
 *
 * Three defects this pins, all of them "the speculator speaks a different
 * circuit's name than the bundler is about to":
 *
 *   1. The per-turn designation map was seeded through a `Number(k)` filter, so
 *      every pair-identity key the harness seeds for a SUB-board circuit was
 *      silently dropped. A named sub-board circuit spoke as "Circuit 3".
 *   2. Both the observe and the lookup were board-BLIND (bare ref only), so
 *      main's "Cooker" and sub-b's "Shed sockets" — both circuit 3 — fought
 *      over one entry and the last writer's name was spoken for BOTH boards.
 *   3. `input.board_id` alone could not have fixed it: the model omits board_id
 *      in the common case and scope comes from select_board state, which is why
 *      the resolver is a live closure rather than a wire field.
 *
 * The designation is the ONLY thing resolved on the effective board — the raw
 * board id stays the identity for the fan-out bucket and the cache key.
 */

import { jest } from '@jest/globals';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import { _resetForTests as resetCache } from '../extraction/loaded-barrel-cache.js';
import {
  encodeReadingKey,
  circuitDesignationKey,
} from '../extraction/stage6-per-turn-writes.js';

const MAIN = 'main';
const SUB = 'sub-b';

// The per-turn speculation cap defaults to 2; the cross-board cases below need
// three speculations in one turn to show BOTH boards' names at once, and a
// cap-skipped third would look exactly like the leak these tests exist to catch.
const CAP_ENV = 'VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN';

beforeEach(() => {
  resetCache();
  process.env[CAP_ENV] = '8';
});
afterEach(() => {
  resetCache();
  delete process.env[CAP_ENV];
});

async function flush() {
  await new Promise((r) => setImmediate(r));
}

function makeMockClientFactory() {
  const synths = [];
  const factory = jest.fn(() => ({
    synth: jest.fn((text, opts) => {
      synths.push({ text, opts });
      return new Promise(() => {}); // never settles — we only assert the TEXT
    }),
    close: jest.fn(),
  }));
  return { factory, synths };
}

/**
 * @param currentBoardId  what select_board state says the working board is;
 *                        `undefined` means NO resolver is wired at all (the
 *                        legacy/single-board callers, which must stay
 *                        byte-identical to pre-item-3 behaviour).
 */
function makeSpeculator({ factory, initialDesignations, currentBoardId, resolverThrows = false }) {
  return createSpeculator({
    sessionId: 'S',
    apiKey: 'test-key',
    costTracker: new CostTracker(),
    clientFactory: factory,
    initialDesignations,
    ...(currentBoardId === undefined && !resolverThrows
      ? {}
      : {
          resolveEffectiveBoard: (boardId) => {
            if (resolverThrows) throw new Error('snapshot exploded');
            if (typeof boardId === 'string' && boardId !== '') return boardId;
            return currentBoardId ?? MAIN;
          },
        }),
  });
}

/** onSnapshotPatch event for one or more record_reading adds. */
function patchAdding(entries, turnId = 'T1') {
  return {
    patch: {
      readings: {
        added: entries.map(({ field, circuit, boardId, value }) => ({
          key: encodeReadingKey(field, circuit, boardId),
          value: { value, confidence: 1.0, source_turn_id: turnId },
        })),
        overwritten: [],
        removed: [],
      },
      boardReadings: { added: [], overwritten: [], removed: [] },
      cleared: [],
      observations: [],
      deletedObservations: [],
      circuitOps: [],
      boardOps: [],
      fieldCorrections: [],
    },
    raw: { perTurnWrites: null },
    ctx: { sessionId: 'S', turnId, toolName: 'record_reading', toolCallId: 'tc1', roundIdx: 1 },
  };
}

describe('A2-multiboard item 3(H) — seeded designations survive for SUB-boards', () => {
  test('a pair-keyed sub-board seed is spoken (pre-fix it was dropped by Number(k))', async () => {
    const { factory, synths } = makeMockClientFactory();
    const seeds = new Map([[circuitDesignationKey(SUB, 3), 'Shed sockets']]);
    const spec = makeSpeculator({ factory, initialDesignations: seeds, currentBoardId: MAIN });

    spec.onSnapshotPatch(
      patchAdding([{ field: 'measured_zs_ohm', circuit: 3, boardId: SUB, value: '0.42' }])
    );
    await flush();

    expect(synths).toHaveLength(1);
    expect(synths[0].text.startsWith('Shed sockets,')).toBe(true);
  });

  test("a sub-board reading never speaks MAIN's name for the same ref", async () => {
    const { factory, synths } = makeMockClientFactory();
    // Exactly what the harness seeds for a named MAIN circuit: bare ref AND the
    // main pair. Neither may reach a sub-board reading.
    const seeds = new Map([
      [3, 'Cooker'],
      [circuitDesignationKey(MAIN, 3), 'Cooker'],
    ]);
    const spec = makeSpeculator({ factory, initialDesignations: seeds, currentBoardId: MAIN });

    spec.onSnapshotPatch(
      patchAdding([{ field: 'measured_zs_ohm', circuit: 3, boardId: SUB, value: '0.42' }])
    );
    await flush();

    expect(synths).toHaveLength(1);
    expect(synths[0].text.startsWith('Circuit 3,')).toBe(true);
    expect(synths[0].text).not.toContain('Cooker');
  });

  test('the main board still resolves its own seeded name', async () => {
    const { factory, synths } = makeMockClientFactory();
    const seeds = new Map([
      [3, 'Cooker'],
      [circuitDesignationKey(MAIN, 3), 'Cooker'],
    ]);
    const spec = makeSpeculator({ factory, initialDesignations: seeds, currentBoardId: MAIN });

    spec.onSnapshotPatch(
      patchAdding([{ field: 'measured_zs_ohm', circuit: 3, boardId: MAIN, value: '0.42' }])
    );
    await flush();

    expect(synths[0].text.startsWith('Cooker,')).toBe(true);
  });
});

describe('A2-multiboard item 3(H) — same-turn designation writes are board-scoped', () => {
  test('a sub-board rename this turn names the sub-board reading, not main', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({
      factory,
      initialDesignations: new Map([
        [3, 'Cooker'],
        [circuitDesignationKey(MAIN, 3), 'Cooker'],
      ]),
      currentBoardId: MAIN,
    });

    // One patch carrying BOTH the sub-board rename and two readings — the
    // designation is observed before any speculation, exactly as the hook does.
    spec.onSnapshotPatch(
      patchAdding([
        { field: 'circuit_designation', circuit: 3, boardId: SUB, value: 'Shed sockets' },
        { field: 'measured_zs_ohm', circuit: 3, boardId: SUB, value: '0.42' },
        { field: 'r1_r2_ohm', circuit: 3, boardId: MAIN, value: '0.31' },
      ])
    );
    await flush();

    // The rename has its own read-back ("Circuit 3 is now the Shed sockets");
    // drop it and assert on the two READINGS, which is where the leak shows.
    const texts = synths.map((s) => s.text).filter((t) => !t.startsWith('Circuit 3 is now'));
    expect(texts).toHaveLength(2);
    // Pre-fix BOTH lines carried the same name (one board-blind bare-ref entry,
    // last writer wins), so the discriminating assertion is one of each.
    expect(texts.filter((t) => t.startsWith('Shed sockets,'))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith('Cooker,'))).toHaveLength(1);
  });

  test('a streamed rename with NO board_id is filed against the select_board board', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({ factory, initialDesignations: new Map(), currentBoardId: SUB });

    // The common wire shape: the model omits board_id entirely and scope comes
    // from the session's currentBoardId.
    spec.onToolUseStreamed({
      record: {
        name: 'record_reading',
        input: { field: 'circuit_designation', circuit: 3, value: 'Shed sockets' },
      },
      ctx: { sessionId: 'S', turnId: 'T1', toolCallId: 'tc1', roundIdx: 1 },
    });
    await flush();

    // A later reading on the SAME (unscoped ⇒ sub-b) scope picks the name up…
    spec.onSnapshotPatch(
      patchAdding([{ field: 'measured_zs_ohm', circuit: 3, boardId: SUB, value: '0.42' }])
    );
    await flush();
    expect(synths.some((s) => s.text.startsWith('Shed sockets,'))).toBe(true);

    // …while an explicitly main-scoped reading does not.
    spec.onSnapshotPatch(
      patchAdding([{ field: 'r1_r2_ohm', circuit: 3, boardId: MAIN, value: '0.31' }])
    );
    await flush();
    const mainText = synths[synths.length - 1].text;
    expect(mainText.startsWith('Circuit 3,')).toBe(true);
    expect(mainText).not.toContain('Shed sockets');
  });
});

describe('A2-multiboard item 3(H) — the resolver is optional and untrusted', () => {
  test('NO resolver wired ⇒ bare-ref behaviour, byte-identical to pre-item-3', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({
      factory,
      initialDesignations: new Map([[3, 'Cooker']]),
      currentBoardId: undefined, // no resolveEffectiveBoard passed at all
    });

    spec.onSnapshotPatch(
      patchAdding([{ field: 'measured_zs_ohm', circuit: 3, boardId: null, value: '0.42' }])
    );
    await flush();

    expect(synths[0].text.startsWith('Cooker,')).toBe(true);
  });

  test('a THROWING resolver degrades to the raw board id instead of escaping the hook', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpeculator({
      factory,
      initialDesignations: new Map([[circuitDesignationKey(SUB, 3), 'Shed sockets']]),
      currentBoardId: MAIN,
      resolverThrows: true,
    });

    // Must not throw out of onSnapshotPatch — the module's contract.
    expect(() =>
      spec.onSnapshotPatch(
        patchAdding([{ field: 'measured_zs_ohm', circuit: 3, boardId: SUB, value: '0.42' }])
      )
    ).not.toThrow();
    await flush();

    // Raw board id still resolves the pair, so this particular case even keeps
    // the right name — the point is that a broken resolver costs cache hits,
    // never correctness.
    expect(synths[0].text.startsWith('Shed sockets,')).toBe(true);
  });
});
