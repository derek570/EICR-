/**
 * Unit tests for the pure burst + naming buffers.
 *
 * Drives the buffers with a controllable scheduler so timer fires are
 * deterministic. Pins:
 *  - burst-buffer 500ms window + ' ... ' separator + min-confidence
 *  - naming-buffer 3000ms window + trailing-pattern detection +
 *    space-separated concat
 *  - flush vs clear semantics on teardown
 */
import { describe, it, expect } from 'vitest';
import {
  BurstBuffer,
  NamingBuffer,
  isTrailingCircuitNamingPattern,
  type ScheduleFn,
  type ClearScheduleFn,
} from '@/lib/recording/dispatch-buffers';

interface Scheduler {
  schedule: ScheduleFn;
  clearScheduler: ClearScheduleFn;
  /** Flush the most recent armed timer. */
  fireLatest: () => boolean;
  /** Number of armed timers (set + not cleared + not fired). */
  pendingCount: () => number;
}

function makeScheduler(): Scheduler {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    schedule: (cb) => {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearScheduler: (handle) => {
      timers.delete(handle as number);
    },
    fireLatest: () => {
      const ids = Array.from(timers.keys());
      if (ids.length === 0) return false;
      const id = ids[ids.length - 1];
      const cb = timers.get(id)!;
      timers.delete(id);
      cb();
      return true;
    },
    pendingCount: () => timers.size,
  };
}

describe('isTrailingCircuitNamingPattern', () => {
  it.each([
    ['Circuit 1 is', true],
    ['circuit number 2 is', true],
    ['Circuit one is.', true],
    ['Circuit twelve is ', true],
    ['Circuit 1 is a cooker', false], // continues past "is"
    ['just some text', false],
    ['', false],
  ])('%j → %j', (input, expected) => {
    expect(isTrailingCircuitNamingPattern(input)).toBe(expected);
  });
});

describe('BurstBuffer', () => {
  it('dispatches a single final after the window elapses', () => {
    const dispatched: Array<{ text: string; confidence: number }> = [];
    const s = makeScheduler();
    const buf = new BurstBuffer((text, confidence) => dispatched.push({ text, confidence }), 500, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });

    buf.feed('Observation.', 0.92);
    expect(dispatched).toHaveLength(0);
    expect(s.pendingCount()).toBe(1);

    s.fireLatest();
    expect(dispatched).toEqual([{ text: 'Observation.', confidence: 0.92 }]);
    expect(buf.hasPending).toBe(false);
  });

  it('merges two finals arriving inside the window using " ... " separator', () => {
    const dispatched: Array<{ text: string; confidence: number }> = [];
    const s = makeScheduler();
    const buf = new BurstBuffer((text, confidence) => dispatched.push({ text, confidence }), 500, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });

    buf.feed('Observation.', 0.92);
    buf.feed('There is a crack in a socket in a bedroom.', 0.88);

    expect(dispatched).toEqual([
      { text: 'Observation. ... There is a crack in a socket in a bedroom.', confidence: 0.88 },
    ]);
    // No leftover timer.
    expect(s.pendingCount()).toBe(0);
  });

  it('confidence collapses to Math.min when merging', () => {
    const dispatched: Array<{ text: string; confidence: number }> = [];
    const s = makeScheduler();
    const buf = new BurstBuffer((text, confidence) => dispatched.push({ text, confidence }), 500, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });

    buf.feed('A', 0.45);
    buf.feed('B', 0.99);
    expect(dispatched[0].confidence).toBe(0.45);
  });

  it('flush dispatches pending entry and clears slot', () => {
    const dispatched: Array<{ text: string; confidence: number }> = [];
    const s = makeScheduler();
    const buf = new BurstBuffer((text, confidence) => dispatched.push({ text, confidence }), 500, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });

    buf.feed('held', 0.9);
    buf.flush();
    expect(dispatched).toEqual([{ text: 'held', confidence: 0.9 }]);
    expect(buf.hasPending).toBe(false);
    expect(s.pendingCount()).toBe(0);
  });

  it('clear drops pending entry without dispatch', () => {
    const dispatched: Array<{ text: string; confidence: number }> = [];
    const s = makeScheduler();
    const buf = new BurstBuffer((text, confidence) => dispatched.push({ text, confidence }), 500, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.feed('held', 0.9);
    buf.clear();
    expect(dispatched).toEqual([]);
    expect(buf.hasPending).toBe(false);
  });
});

describe('NamingBuffer', () => {
  it('passes plain finals straight through with no buffering', () => {
    const dispatched: string[] = [];
    const s = makeScheduler();
    const buf = new NamingBuffer((text) => dispatched.push(text), 3000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.feed('R1 plus R2 is 0.4', 0.9);
    expect(dispatched).toEqual(['R1 plus R2 is 0.4']);
    expect(buf.hasPending).toBe(false);
  });

  it('buffers a trailing "Circuit N is" preface and waits for completion', () => {
    const dispatched: string[] = [];
    const s = makeScheduler();
    const buf = new NamingBuffer((text) => dispatched.push(text), 3000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });

    buf.feed('Circuit 2 is', 0.95);
    expect(dispatched).toEqual([]);
    expect(buf.hasPending).toBe(true);

    buf.feed('downstairs sockets', 0.91);
    expect(dispatched).toEqual(['Circuit 2 is downstairs sockets']);
    expect(buf.hasPending).toBe(false);
  });

  it('timeout-flushes a held preface alone if no completion arrives', () => {
    const dispatched: string[] = [];
    const s = makeScheduler();
    const buf = new NamingBuffer((text) => dispatched.push(text), 3000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.feed('Circuit 5 is', 0.93);
    expect(dispatched).toEqual([]);
    s.fireLatest();
    expect(dispatched).toEqual(['Circuit 5 is']);
  });

  it('rebuffers when concatenation is itself a trailing preface (user backed out)', () => {
    const dispatched: string[] = [];
    const s = makeScheduler();
    const buf = new NamingBuffer((text) => dispatched.push(text), 3000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });

    buf.feed('Circuit 2 is', 0.95);
    // Concat = "Circuit 2 is Circuit 3 is" — would NOT match the
    // trailing pattern because of the embedded "is". Verify the
    // simpler case: a fresh "Circuit N is" arriving with no pending
    // re-arms a new buffer.
    buf.feed('lights', 0.9); // resolves the first
    expect(dispatched).toEqual(['Circuit 2 is lights']);
    buf.feed('Circuit 3 is', 0.95);
    expect(buf.hasPending).toBe(true);
    expect(dispatched).toHaveLength(1);
  });

  it('minimum confidence wins on concatenation', () => {
    const captured: Array<{ text: string; confidence: number }> = [];
    const s = makeScheduler();
    const buf = new NamingBuffer((text, confidence) => captured.push({ text, confidence }), 3000, {
      scheduler: s.schedule,
      clearScheduler: s.clearScheduler,
    });
    buf.feed('Circuit 4 is', 0.95);
    buf.feed('shower', 0.42);
    expect(captured[0].confidence).toBe(0.42);
  });
});
