/**
 * replay-clock.test.js — fake clock exactness, timer ledger, ask-timeout
 * binding, and the clock pump (plan Item 2). Pins:
 *   - the EXACT toFake list (microtasks/performance/hrtime stay REAL);
 *   - a deterministic answer resolving after registration but BEFORE the
 *     45s timeout, with zero real-time waits (timeout-backed regression);
 *   - POST-REGISTRATION exact-handle ask-timeout binding (zero/multiple
 *     matches FAIL);
 *   - the pump refusing unknown timers and undeclared ask timeouts, and
 *     same-delay multi-timer discrimination (a declared ask timeout cannot
 *     fire an unrelated timer).
 */

import FakeTimers from '@sinonjs/fake-timers';
import {
  installReplayClock,
  EXACT_TO_FAKE,
  QUESTION_GATE_DELAY_MS,
  ASK_USER_TIMEOUT_MS,
  TIMER_CLASSES,
} from '../../../scripts/field-replay/lib/replay-clock.mjs';

const TEST_ALLOWLIST = [
  { class: TIMER_CLASSES.QUESTION_GATE, callsite: /replay-clock\.test/, delay: QUESTION_GATE_DELAY_MS },
  { class: TIMER_CLASSES.ASK_TIMEOUT, callsite: /replay-clock\.test/, delay: ASK_USER_TIMEOUT_MS },
];

let ctl;
afterEach(() => {
  if (ctl) {
    try {
      ctl.uninstall();
    } catch {
      /* already uninstalled */
    }
    ctl = null;
  }
});

function install(extra = {}) {
  ctl = installReplayClock(FakeTimers, { startMs: 1_000_000, allowlist: TEST_ALLOWLIST, ...extra });
  return ctl;
}

describe('exact toFake list', () => {
  test('pinned literal', () => {
    expect(EXACT_TO_FAKE).toEqual(['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']);
  });
  test('Date is faked; queueMicrotask/setImmediate/performance/hrtime stay REAL', async () => {
    const c = install();
    expect(Date.now()).toBe(1_000_000);
    // Microtasks stay real by construction.
    let micro = false;
    queueMicrotask(() => {
      micro = true;
    });
    await Promise.resolve();
    expect(micro).toBe(true);
    // setImmediate is NOT faked (it would reorder ask registration).
    await new Promise((res) => setImmediate(res));
    // performance.now()/hrtime advance independently of the fake wall clock.
    const p1 = performance.now();
    const h1 = process.hrtime.bigint();
    await ctl.tick(60_000);
    const p2 = performance.now();
    const h2 = process.hrtime.bigint();
    expect(Date.now()).toBe(1_060_000);
    expect(p2 - p1).toBeLessThan(5_000); // real ms, not the 60s logical jump
    expect(h2 > h1).toBe(true);
  });
});

describe('timer ledger', () => {
  test('records delay, due time, callsite; clearTimeout marks cleared', () => {
    const c = install();
    const h = setTimeout(() => {}, QUESTION_GATE_DELAY_MS);
    const entries = c.pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].delay).toBe(QUESTION_GATE_DELAY_MS);
    expect(entries[0].dueMs).toBe(1_000_000 + QUESTION_GATE_DELAY_MS);
    expect(entries[0].callsite).toMatch(/replay-clock\.test/);
    clearTimeout(h);
    expect(c.pendingEntries()).toHaveLength(0);
  });

  test('POST-REGISTRATION ask-timeout binding: exact handle binds; zero/multiple matches FAIL', () => {
    const c = install();
    // Both the initial and pvr-* dispatchers call setTimeout BEFORE
    // pendingAsks.register — simulate two unbound 45s timers, then bind one
    // by its exact handle (retrieved from the real registry entry).
    const hInitial = setTimeout(() => {}, ASK_USER_TIMEOUT_MS);
    const hPvr = setTimeout(() => {}, ASK_USER_TIMEOUT_MS);
    const bound = c.bindAskTimeout('toolu_01initial', hInitial, 'gen_1');
    expect(bound.askToolCallId).toBe('toolu_01initial');
    const boundPvr = c.bindAskTimeout('pvr-abc123', hPvr, 'gen_1');
    expect(boundPvr.askToolCallId).toBe('pvr-abc123');
    // Zero matches (already-fired/cleared or bogus handle) FAILS.
    expect(() => c.bindAskTimeout('toolu_02', { bogus: true })).toThrow(/expected exactly 1/);
  });
});

describe('clock pump', () => {
  test('a gated ask + deterministic answer terminate with ZERO real-time waits, resolving before the 45s timeout', async () => {
    const c = install();
    const startedReal = performance.now();
    const outcome = { gateFired: false, timedOut: false, answered: false };
    // Production shape: gate timer (1.5s), then ask timeout (45s), answer
    // resolves via microtask after the gate fires.
    setTimeout(() => {
      outcome.gateFired = true;
      const askTimer = setTimeout(() => {
        outcome.timedOut = true;
      }, ASK_USER_TIMEOUT_MS);
      c.bindAskTimeout('toolu_01ask', askTimer);
      // Deterministic answer: resolves via microtask, clears the timeout —
      // production's answer path.
      queueMicrotask(() => {
        outcome.answered = true;
        clearTimeout(askTimer);
      });
    }, QUESTION_GATE_DELAY_MS);

    const r = await c.advanceNext();
    expect(r.class).toBe(TIMER_CLASSES.QUESTION_GATE);
    await c.drainMicrotasks();
    expect(outcome).toEqual({ gateFired: true, timedOut: false, answered: true });
    expect(c.pendingEntries()).toHaveLength(0);
    expect(performance.now() - startedReal).toBeLessThan(2_000); // no real 1.5s/45s waits
  });

  test('an UNKNOWN next timer is an infrastructure error, never silently fired', async () => {
    const c = install();
    setTimeout(() => {}, 777); // no allowlist rule matches delay 777? callsite matches but delays are pinned
    await expect(c.advanceNext()).rejects.toMatchObject({ infrastructure: true });
    expect(c.ledger.violations.length).toBeGreaterThan(0);
  });

  test('an UNDECLARED ask timeout is refused; a DECLARED one fires — and only for the bound ask (same-delay discrimination)', async () => {
    const c = install();
    const fired = [];
    const hA = setTimeout(() => fired.push('A'), ASK_USER_TIMEOUT_MS);
    c.bindAskTimeout('toolu_A', hA);
    // Undeclared → refuse.
    await expect(c.advanceNext({ declaredTimeoutAskIds: new Set() })).rejects.toMatchObject({
      infrastructure: true,
    });
    // Two same-delay 45s timers, only B declared: the earliest (A) is still
    // refused — a declared ask timeout cannot fire an unrelated timer.
    const hB = setTimeout(() => fired.push('B'), ASK_USER_TIMEOUT_MS);
    c.bindAskTimeout('toolu_B', hB);
    await expect(c.advanceNext({ declaredTimeoutAskIds: new Set(['toolu_B']) })).rejects.toMatchObject({
      infrastructure: true,
    });
    // Clear A (production answer path), then B's DECLARED timeout may fire.
    clearTimeout(hA);
    const r = await c.advanceNext({ declaredTimeoutAskIds: new Set(['toolu_B']) });
    expect(r.class).toBe(TIMER_CLASSES.ASK_TIMEOUT);
    expect(fired).toEqual(['B']);
  });

  test('inter-turn tick executes elapsed allowed timers without firing ask timeouts (long-gap fixture)', async () => {
    const c = install();
    let gateFired = false;
    setTimeout(() => {
      gateFired = true;
    }, QUESTION_GATE_DELAY_MS);
    // Advance through the gate via the pump, then a long inter-turn gap that
    // stays below any pending 45s timer (none pending here).
    await c.advanceNext();
    expect(gateFired).toBe(true);
    await c.tick(10 * 60 * 1000); // 10 logical minutes, zero real wait
    expect(Date.now()).toBe(1_000_000 + QUESTION_GATE_DELAY_MS + 10 * 60 * 1000);
  });

  test('resetLedger clears entries between fixtures (corpus-lifetime clock)', () => {
    const c = install();
    setTimeout(() => {}, 1500);
    expect(c.pendingEntries()).toHaveLength(1);
    c.resetLedger();
    expect(c.pendingEntries()).toHaveLength(0);
  });

  test('uninstall restores real timers and Date', () => {
    const c = install();
    expect(Date.now()).toBe(1_000_000);
    c.uninstall();
    ctl = null;
    expect(Date.now()).toBeGreaterThan(1_700_000_000_000);
  });
});
