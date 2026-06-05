/**
 * Unit tests for the pending-readings buffer + the question-text helper.
 *
 * The buffer is pure (scheduler injectable). These tests pin the
 * iOS-canon semantics:
 *  - 2s timer (re-)starts on every add
 *  - removeResolved + clearResolved drop matching entries and cancel
 *    the timer when the buffer empties
 *  - suppressSelfRetry only fires when a pending entry of that field
 *    exists; cancels timer but keeps the buffer
 *  - reset drops everything
 *  - friendlyFieldName covers the iOS-canon mapping
 *  - buildPendingReadingsQuestion mirrors iOS plural/singular phrasing
 */
import { describe, it, expect } from 'vitest';
import {
  PendingReadingsBuffer,
  buildPendingReadingsQuestion,
  friendlyFieldName,
  DEFAULT_PENDING_READINGS_TIMEOUT_MS,
  type PendingReading,
} from '@/lib/recording/pending-readings-buffer';

type Scheduler = {
  schedule: (cb: () => void, ms: number) => unknown;
  clearScheduler: (h: unknown) => void;
  fire: () => boolean;
  count: () => number;
};

function makeScheduler(): Scheduler {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    schedule: (cb) => {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearScheduler: (h) => {
      timers.delete(h as number);
    },
    fire: () => {
      const ids = Array.from(timers.keys());
      if (ids.length === 0) return false;
      const id = ids[ids.length - 1];
      const cb = timers.get(id)!;
      timers.delete(id);
      cb();
      return true;
    },
    count: () => timers.size,
  };
}

describe('friendlyFieldName', () => {
  it.each([
    ['measured_zs_ohm', 'Zs'],
    ['zs', 'Zs'],
    ['r1_r2_ohm', 'R1 plus R2'],
    ['ring_r1_ohm', 'ring R1'],
    ['ir_live_earth_mohm', 'insulation resistance live to earth'],
    ['rcd_time_ms', 'RCD trip time'],
    ['polarity_confirmed', 'polarity'],
    ['some_new_field', 'some_new_field'], // pass-through fallback
  ])('%j → %j', (input, expected) => {
    expect(friendlyFieldName(input)).toBe(expected);
  });
});

describe('buildPendingReadingsQuestion', () => {
  it('singular form when one reading', () => {
    expect(buildPendingReadingsQuestion([{ field: 'measured_zs_ohm', value: '0.3' }])).toBe(
      'Which circuit was that Zs 0.3 reading for?'
    );
  });

  it('plural form when multiple readings', () => {
    expect(
      buildPendingReadingsQuestion([
        { field: 'measured_zs_ohm', value: '0.3' },
        { field: 'r1_r2_ohm', value: '0.42' },
      ])
    ).toBe('Which circuit were those readings for? Zs 0.3, R1 plus R2 0.42');
  });

  it('empty array returns empty string', () => {
    expect(buildPendingReadingsQuestion([])).toBe('');
  });
});

describe('PendingReadingsBuffer', () => {
  const reading = (field: string, value: string): PendingReading => ({ field, value });

  it('add starts the timer and fires onTimeout with the buffered readings', () => {
    const s = makeScheduler();
    let captured: PendingReading[] | null = null;
    const buf = new PendingReadingsBuffer(
      (r) => {
        captured = [...r];
      },
      2000,
      { scheduler: s.schedule, clearScheduler: s.clearScheduler }
    );

    buf.add(reading('measured_zs_ohm', '0.3'));
    expect(buf.size).toBe(1);
    expect(buf.hasTimer).toBe(true);

    s.fire();
    expect(captured).toEqual([reading('measured_zs_ohm', '0.3')]);
    // Buffer remains populated — caller decides when to clear.
    expect(buf.size).toBe(1);
    expect(buf.hasTimer).toBe(false);
  });

  it('successive adds restart the timer (the second add resets the window)', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.add(reading('measured_zs_ohm', '0.3'));
    const firstCount = s.count();
    buf.add(reading('r1_r2_ohm', '0.42'));
    // One armed timer, not two — the first was cancelled.
    expect(s.count()).toBe(firstCount);
    expect(buf.size).toBe(2);
  });

  it('addAll buffers all readings under a single timer', () => {
    const s = makeScheduler();
    let captured: PendingReading[] = [];
    const buf = new PendingReadingsBuffer(
      (r) => {
        captured = [...r];
      },
      2000,
      { scheduler: s.schedule, clearScheduler: s.clearScheduler }
    );

    buf.addAll([reading('measured_zs_ohm', '0.3'), reading('r1_r2_ohm', '0.42')]);
    expect(s.count()).toBe(1);
    s.fire();
    expect(captured).toHaveLength(2);
  });

  it('addAll([]) is a no-op', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.addAll([]);
    expect(buf.size).toBe(0);
    expect(buf.hasTimer).toBe(false);
  });

  it('snapshotForQuestion captures current buffer into lastSnapshot', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.add(reading('measured_zs_ohm', '0.3'));
    buf.add(reading('r1_r2_ohm', '0.42'));
    const snap = buf.snapshotForQuestion();
    expect(snap).toHaveLength(2);
    expect(buf.lastSnapshot()).toHaveLength(2);
  });

  it('removeResolved drops matching entries by {field, value} and cancels timer when empty', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.add(reading('measured_zs_ohm', '0.3'));
    buf.add(reading('r1_r2_ohm', '0.42'));
    buf.removeResolved([reading('measured_zs_ohm', '0.3')]);
    expect(buf.size).toBe(1);
    expect(buf.hasTimer).toBe(true);
    buf.removeResolved([reading('r1_r2_ohm', '0.42')]);
    expect(buf.size).toBe(0);
    expect(buf.hasTimer).toBe(false);
  });

  it('clearResolved behaves the same as removeResolved + drops snapshot', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.add(reading('measured_zs_ohm', '0.3'));
    buf.snapshotForQuestion();
    expect(buf.lastSnapshot()).toHaveLength(1);
    buf.clearResolved([reading('measured_zs_ohm', '0.3')]);
    expect(buf.size).toBe(0);
    expect(buf.lastSnapshot()).toHaveLength(0);
  });

  it('suppressSelfRetry cancels timer but keeps buffer when a pending entry of that field exists', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.add(reading('measured_zs_ohm', '0.3'));
    expect(buf.hasTimer).toBe(true);
    buf.suppressSelfRetry('measured_zs_ohm');
    expect(buf.hasTimer).toBe(false);
    expect(buf.size).toBe(1);
  });

  it('suppressSelfRetry is a no-op when field not in buffer', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.add(reading('measured_zs_ohm', '0.3'));
    buf.suppressSelfRetry('r1_r2_ohm');
    expect(buf.hasTimer).toBe(true);
  });

  it('reset drops buffer + snapshot + timer', () => {
    const s = makeScheduler();
    const buf = new PendingReadingsBuffer(() => {}, 2000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.add(reading('measured_zs_ohm', '0.3'));
    buf.snapshotForQuestion();
    buf.reset();
    expect(buf.size).toBe(0);
    expect(buf.hasTimer).toBe(false);
    expect(buf.lastSnapshot()).toHaveLength(0);
  });

  it('timer callback receiving an empty buffer (drained during wait) does not invoke onTimeout', () => {
    const s = makeScheduler();
    let called = false;
    const buf = new PendingReadingsBuffer(
      () => {
        called = true;
      },
      2000,
      { scheduler: s.schedule, clearScheduler: s.clearScheduler }
    );
    buf.add(reading('measured_zs_ohm', '0.3'));
    // Cancel timer via removeResolved
    buf.removeResolved([reading('measured_zs_ohm', '0.3')]);
    // Even if a stale timer somehow fired (it shouldn't — clearScheduler
    // removes it), the defensive guard inside the callback would also
    // catch the empty buffer. Verify nothing got called.
    expect(s.count()).toBe(0);
    expect(called).toBe(false);
  });

  it('uses DEFAULT_PENDING_READINGS_TIMEOUT_MS when not overridden', () => {
    expect(DEFAULT_PENDING_READINGS_TIMEOUT_MS).toBe(2_000);
  });
});
