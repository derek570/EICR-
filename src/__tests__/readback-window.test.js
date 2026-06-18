/**
 * readback-window.test.js — rolling conversational window (Design 2).
 *
 * readback-correction-optionb §3.3a/b. Covers: reading-vs-non-reading
 * discrimination, slot-identity de-dupe (mid-stream + final → once), turn-count
 * staleness trimming, chronological user→assistant injection, and the
 * window-has-readback predicate for the tool_choice no-op gate.
 */

import {
  isReadingConfirmation,
  toReadbackEntry,
  dedupeReadbacks,
  readbackKey,
  pushReadbackTurn,
  buildReadbackWindowMessages,
  windowHasReadback,
  NON_READING_CONFIRMATION_FIELDS,
  READBACK_WINDOW_MAX_TURNS,
} from '../extraction/readback-window.js';

describe('isReadingConfirmation', () => {
  test('real circuit/board fields are readings', () => {
    expect(isReadingConfirmation({ field: 'measured_zs_ohm', circuit: 3 })).toBe(true);
    expect(isReadingConfirmation({ field: 'earth_loop_impedance_ze', circuit: null })).toBe(true);
  });

  test('state-change / observation / clear sentinel fields are NOT readings', () => {
    for (const field of NON_READING_CONFIRMATION_FIELDS) {
      expect(isReadingConfirmation({ field })).toBe(false);
    }
  });

  test('missing / empty field is not a reading', () => {
    expect(isReadingConfirmation(null)).toBe(false);
    expect(isReadingConfirmation({})).toBe(false);
    expect(isReadingConfirmation({ field: '' })).toBe(false);
  });
});

describe('dedupeReadbacks — slot identity (mid-stream + final → once)', () => {
  test('same slot read back mid-stream (with value) and finally (text only) collapses to one', () => {
    const mid = toReadbackEntry({
      text: 'Circuit 3, Zs 0.86',
      field: 'measured_zs_ohm',
      circuit: 3,
      value: '0.86',
    });
    // Final line uses a designation, so text DRIFTS — but slot identity matches.
    const fin = toReadbackEntry({ text: 'Cooker, Zs 0.86', field: 'measured_zs_ohm', circuit: 3 });
    const out = dedupeReadbacks([mid, fin]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Circuit 3, Zs 0.86'); // first-seen wins
  });

  test('different circuits are kept', () => {
    const a = toReadbackEntry({ text: 'Circuit 3, Zs 0.86', field: 'measured_zs_ohm', circuit: 3 });
    const b = toReadbackEntry({ text: 'Circuit 4, Zs 0.91', field: 'measured_zs_ohm', circuit: 4 });
    expect(dedupeReadbacks([a, b])).toHaveLength(2);
  });

  test('board scope separates same field+circuit', () => {
    const main = { field: 'measured_zs_ohm', circuit: 3, text: 'a' };
    const sub = { field: 'measured_zs_ohm', circuit: 3, board_id: 'sub-1', text: 'b' };
    expect(readbackKey(main)).not.toBe(readbackKey(sub));
    expect(dedupeReadbacks([main, sub])).toHaveLength(2);
  });

  test('grouped circuits key is order-independent', () => {
    expect(readbackKey({ field: 'ir', circuits: [3, 2] })).toBe(
      readbackKey({ field: 'ir', circuits: [2, 3] })
    );
  });
});

describe('pushReadbackTurn — turn-count staleness trimming', () => {
  test('keeps only the last READBACK_WINDOW_MAX_TURNS turns', () => {
    let w = [];
    for (let i = 0; i < 5; i += 1) {
      w = pushReadbackTurn(w, `utt ${i}`, [{ text: `rb ${i}`, field: 'measured_zs_ohm', circuit: i + 1 }]);
    }
    expect(w).toHaveLength(READBACK_WINDOW_MAX_TURNS);
    expect(w[0].inspector_utterance).toBe('utt 2'); // oldest two dropped
    expect(w[2].inspector_utterance).toBe('utt 4');
  });

  test('empty-readback turns are still stored (age out read-backs by turn count)', () => {
    let w = [];
    w = pushReadbackTurn(w, 'circuit 3 zs 0.86', [
      { text: 'Circuit 3, Zs 0.86', field: 'measured_zs_ohm', circuit: 3 },
    ]);
    w = pushReadbackTurn(w, 'chitchat one', []);
    w = pushReadbackTurn(w, 'chitchat two', []);
    w = pushReadbackTurn(w, 'chitchat three', []); // pushes the readback turn out
    expect(w).toHaveLength(3);
    expect(windowHasReadback(w)).toBe(false); // read-back has aged out
  });
});

describe('buildReadbackWindowMessages — chronological user→assistant pairs', () => {
  test('emits user then assistant per readback turn, current appended by caller', () => {
    const w = [
      {
        inspector_utterance: 'Zs on circuit 3 is 0.86',
        readbacks_spoken: [{ text: 'Circuit 3, Zs 0.86', field: 'measured_zs_ohm', circuit: 3 }],
      },
    ];
    const msgs = buildReadbackWindowMessages(w);
    expect(msgs).toEqual([
      { role: 'user', content: 'Zs on circuit 3 is 0.86' },
      { role: 'assistant', content: 'Read back: Circuit 3, Zs 0.86' },
    ]);
  });

  test('multiple read-backs in a turn join into one assistant line', () => {
    const w = [
      {
        inspector_utterance: 'circuits 2 and 3',
        readbacks_spoken: [
          { text: 'Circuit 2, Zs 0.86', field: 'measured_zs_ohm', circuit: 2 },
          { text: 'Circuit 3, Zs 0.91', field: 'measured_zs_ohm', circuit: 3 },
        ],
      },
    ];
    expect(buildReadbackWindowMessages(w)[1]).toEqual({
      role: 'assistant',
      content: 'Read back: Circuit 2, Zs 0.86; Circuit 3, Zs 0.91',
    });
  });

  test('turns with NO read-backs are skipped (no leading assistant; strict alternation)', () => {
    const w = [
      { inspector_utterance: 'chitchat', readbacks_spoken: [] },
      {
        inspector_utterance: 'Zs on 3 is 0.86',
        readbacks_spoken: [{ text: 'Circuit 3, Zs 0.86', field: 'measured_zs_ohm', circuit: 3 }],
      },
    ];
    const msgs = buildReadbackWindowMessages(w);
    // Only the readback-bearing turn is injected → starts with user.
    expect(msgs[0].role).toBe('user');
    expect(msgs).toHaveLength(2);
    // Appending the current user message keeps strict alternation.
    const full = [...msgs, { role: 'user', content: 'No.' }];
    for (let i = 1; i < full.length; i += 1) {
      if (full[i].role === full[i - 1].role) {
        // allow only the final user-after-assistant boundary; no same-role adjacency
        expect(full[i].role).not.toBe(full[i - 1].role);
      }
    }
  });

  test('empty / absent window → no injected messages (byte-identical to pre-feature)', () => {
    expect(buildReadbackWindowMessages([])).toEqual([]);
    expect(buildReadbackWindowMessages(undefined)).toEqual([]);
  });
});

describe('windowHasReadback', () => {
  test('true when any turn has read-backs, false otherwise', () => {
    expect(windowHasReadback([{ readbacks_spoken: [] }])).toBe(false);
    expect(windowHasReadback([{ readbacks_spoken: [{ text: 'x' }] }])).toBe(true);
    expect(windowHasReadback([])).toBe(false);
    expect(windowHasReadback(null)).toBe(false);
  });
});
