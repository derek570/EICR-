/**
 * Snapshot-restructure sprint (2026-05-27) — Phase 3 ascending-circuits test suite.
 *
 * Locks the behaviour of:
 *   - _resolveCircuitOrder env/option resolution (recent_3 default, ascending opt-in)
 *   - recent_3 byte-parity with pre-Phase-3 main (regression lock)
 *   - ascending renderer — every board circuit in ascending numeric order,
 *     no "stored server-side" summary line, append-only growth across turns.
 *
 * Plan location:
 *   .planning-stage6-agentic/handoffs/snapshot-restructure-2026-05-27/phase3-sprint-plan.md
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');

function makeSession(opts = {}) {
  return new EICRExtractionSession('test-key', `phase3-${Math.random()}`, 'eicr', opts);
}

// Seeds the rolling state snapshot with N circuits, applied in the given
// recency order (last entry is most-recent). Mirrors what record_reading
// would do at runtime: writes the bucket + bumps recentCircuitOrder.
function seedCircuits(session, recencyOrder, fields = { 22: 0.35 }) {
  for (const num of recencyOrder) {
    session.stateSnapshot.circuits[num] = { ...fields, designation: `Circuit ${num}` };
    const idx = session.recentCircuitOrder.indexOf(num);
    if (idx !== -1) session.recentCircuitOrder.splice(idx, 1);
    session.recentCircuitOrder.push(num);
  }
}

// ---------------------------------------------------------------------------
// _resolveCircuitOrder — flag resolution
// ---------------------------------------------------------------------------
describe('_resolveCircuitOrder — flag resolution', () => {
  const originalEnv = process.env.CIRCUIT_ORDER;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CIRCUIT_ORDER;
    else process.env.CIRCUIT_ORDER = originalEnv;
  });

  test('default (env unset, no option) resolves to recent_3', () => {
    delete process.env.CIRCUIT_ORDER;
    const s = makeSession();
    expect(s.circuitOrder).toBe('recent_3');
  });

  test('env=ascending resolves to ascending', () => {
    process.env.CIRCUIT_ORDER = 'ascending';
    const s = makeSession();
    expect(s.circuitOrder).toBe('ascending');
  });

  test('options.circuitOrder overrides env', () => {
    process.env.CIRCUIT_ORDER = 'recent_3';
    const s = makeSession({ circuitOrder: 'ascending' });
    expect(s.circuitOrder).toBe('ascending');
  });

  test('unknown value falls back to recent_3 (regression lock against typos)', () => {
    const s = makeSession({ circuitOrder: 'asc' });
    expect(s.circuitOrder).toBe('recent_3');
  });

  test('mid-session env mutation does NOT drift the mode (Pitfall 4)', () => {
    delete process.env.CIRCUIT_ORDER;
    const s = makeSession();
    expect(s.circuitOrder).toBe('recent_3');
    process.env.CIRCUIT_ORDER = 'ascending';
    expect(s.circuitOrder).toBe('recent_3');
  });
});

// ---------------------------------------------------------------------------
// recent_3 default — byte-identical to pre-Phase-3 main
// ---------------------------------------------------------------------------
describe('recent_3 (default) — regression lock against pre-Phase-3 main', () => {
  test('snapshot with 5 circuits, recency 5,4,3,2,1 → renders 3,2,1 detailed + "2 earlier circuits (4,5) stored server-side"', () => {
    const s = makeSession(); // default recent_3
    seedCircuits(s, [5, 4, 3, 2, 1]); // recentCircuitOrder ends [5,4,3,2,1]
    const text = s.buildStateSnapshotMessage();
    // Last 3 are 3, 2, 1 (the slice(-3)) — rendered detailed.
    expect(text).toMatch(/^3:\{/m);
    expect(text).toMatch(/^2:\{/m);
    expect(text).toMatch(/^1:\{/m);
    // 4 and 5 are older, summarised.
    expect(text).toMatch(/2 earlier circuits \(4,5\) stored server-side/);
  });

  test('snapshot with 2 circuits → no "stored server-side" summary (fewer than the window)', () => {
    const s = makeSession();
    seedCircuits(s, [1, 2]);
    const text = s.buildStateSnapshotMessage();
    expect(text).not.toMatch(/stored server-side/);
  });
});

// ---------------------------------------------------------------------------
// ascending — new behaviour
// ---------------------------------------------------------------------------
describe('ascending — Phase 3 behaviour', () => {
  test('snapshot with 5 circuits dictated 3,1,5,2,4 → all 5 rendered in 1,2,3,4,5 order', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [3, 1, 5, 2, 4]); // out-of-order recency
    const text = s.buildStateSnapshotMessage();
    const detailLines = text
      .split('\n')
      .filter((l) => /^\d+:\{/.test(l))
      .map((l) => parseInt(l.split(':')[0], 10));
    // Supply (0) may appear first; non-supply must be 1..5 ascending.
    const nonSupply = detailLines.filter((n) => n !== 0);
    expect(nonSupply).toEqual([1, 2, 3, 4, 5]);
  });

  test('snapshot with 5 circuits → NO "stored server-side" summary (nothing is hidden)', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [1, 2, 3, 4, 5]);
    const text = s.buildStateSnapshotMessage();
    expect(text).not.toMatch(/stored server-side/);
  });

  test('append-only cache stability — turn N+1 prefix matches turn N when a new circuit appears', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [1, 2, 3]);
    const turnN = s.buildStateSnapshotMessage();

    seedCircuits(s, [4]); // inspector moves to circuit 4
    const turnNext = s.buildStateSnapshotMessage();

    // Strip leading SUPPLY line (if present, identical across both turns).
    // The detail lines for 1, 2, 3 must appear byte-identically in both snapshots.
    for (const num of [1, 2, 3]) {
      const re = new RegExp(`^${num}:\\{[^\\n]*`, 'm');
      const a = turnN.match(re)[0];
      const b = turnNext.match(re)[0];
      expect(a).toBe(b);
    }
    // Turn N+1 adds 4 at the bottom.
    expect(turnNext).toMatch(/^4:\{/m);
    expect(turnN).not.toMatch(/^4:\{/m);
  });

  test('empty session under ascending → no EXTRACTED CIRCUITS section', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    const text = s.buildStateSnapshotMessage();
    // Empty session collapses the snapshot message to null (no surface
    // populated). Either null OR a string with no circuit lines is the
    // contract — assert by coalescing.
    const safe = text ?? '';
    expect(safe).not.toMatch(/^\d+:\{/m);
    expect(safe).not.toMatch(/stored server-side/);
  });

  test('single non-supply circuit under ascending → one detailed line, no summary', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [7]);
    const text = s.buildStateSnapshotMessage();
    expect(text).toMatch(/^7:\{/m);
    expect(text).not.toMatch(/stored server-side/);
  });
});

// ---------------------------------------------------------------------------
// recentCircuitOrder array — still maintained under ascending
// ---------------------------------------------------------------------------
describe('recentCircuitOrder — array still maintained under ascending', () => {
  test('ascending mode still pushes onto recentCircuitOrder so golden-divergence harness behaviour is unchanged', () => {
    // The renderer ignores the array under ascending, but the array itself
    // is still mutated (seedCircuits mirrors record_reading). Lock that
    // contract so the golden-divergence script's assumptions about the
    // export of SNAPSHOT_RECENT_CIRCUITS + the array's presence stay valid.
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [3, 1, 5]);
    expect(s.recentCircuitOrder).toEqual([3, 1, 5]);
  });
});

// ---------------------------------------------------------------------------
// Plan 08C-A — snapshotRecentCircuits constructor-latched benchmark seam
// ---------------------------------------------------------------------------
//
// Lets a 3-arm latency benchmark (recent_3 / ascending / window_6) drive the
// SAME production renderer with a wider recent-circuit window than the
// frozen SNAPSHOT_RECENT_CIRCUITS default, without restarting the process or
// flipping a module-level constant. Deliberately an OPTION rather than an
// env read (unlike _resolveCircuitOrder above) — this is a benchmark/test
// -only knob and must NOT be settable via a mid-session-mutable env var.
describe('snapshotRecentCircuits — constructor-latched override', () => {
  test('no option → defaults byte-identically to the frozen module constant (3)', () => {
    const s = makeSession();
    expect(s.snapshotRecentCircuits).toBe(3);
  });

  test('options.snapshotRecentCircuits: 6 → session.snapshotRecentCircuits is 6', () => {
    const s = makeSession({ snapshotRecentCircuits: 6 });
    expect(s.snapshotRecentCircuits).toBe(6);
  });

  test('snapshotRecentCircuits only accepts a positive integer — 0/-1/NaN/string/null/undefined all fall back to 3', () => {
    for (const bad of [0, -1, 1.5, 'six', null, undefined, NaN]) {
      const s = makeSession({ snapshotRecentCircuits: bad });
      expect(s.snapshotRecentCircuits).toBe(3);
    }
  });

  test('renderer actually renders up to the overridden window — 6 circuits detailed, only the oldest summarised', () => {
    const s = makeSession({ snapshotRecentCircuits: 6 });
    // 7 circuits, recency order 7..1 (seedCircuits: LAST entry is most
    // recent, so circuit 1 is most-recent and circuit 7 is oldest). Window
    // is 6, so only circuit 7 (the oldest) should be pushed into the
    // "stored server-side" summary line — a byte-identical scenario would
    // summarise 4 circuits (4,5,6,7) under the production default of 3.
    seedCircuits(s, [7, 6, 5, 4, 3, 2, 1]);
    const text = s.buildStateSnapshotMessage();
    for (const num of [1, 2, 3, 4, 5, 6]) {
      expect(text).toMatch(new RegExp(`^${num}:\\{`, 'm'));
    }
    expect(text).not.toMatch(/^7:\{/m);
    expect(text).toMatch(/1 earlier circuits? \(7\) stored server-side/);
  });
});

// ---------------------------------------------------------------------------
// Plan 08C-A benchmark hardening (2026-08-16) — providerMaxRetries
// constructor-latched SDK-retry pin
// ---------------------------------------------------------------------------
//
// Companion to _maxProviderAttempts: that clamps callWithRetry's own loop,
// but the SDK client retries 429/5xx internally (default 2) inside every
// attempt — silent backoff that lands inside a benchmark's measured stream
// window. The latency bench pins this to 0 so retries at every layer
// surface as errors instead of contaminating stream_ms.
describe('providerMaxRetries — constructor-latched SDK retry pin', () => {
  test('no option → null (SDK keeps its own default; production unchanged)', () => {
    const s = makeSession();
    expect(s._providerMaxRetries).toBeNull();
  });

  test('options.providerMaxRetries: 0 → latched as 0 (0 is a VALID pin, not falsy-rejected)', () => {
    const s = makeSession({ providerMaxRetries: 0 });
    expect(s._providerMaxRetries).toBe(0);
  });

  test('positive integers latch; non-integers/negatives/strings/null fall back to null', () => {
    expect(makeSession({ providerMaxRetries: 2 })._providerMaxRetries).toBe(2);
    for (const bad of [-1, 1.5, 'zero', null, undefined, NaN]) {
      expect(makeSession({ providerMaxRetries: bad })._providerMaxRetries).toBeNull();
    }
  });

  // ORDERING REGRESSION (Codex cycle-2 BLOCKER): the DEFAULT provider's
  // client is built inside the constructor itself, so the pin must be
  // latched BEFORE that construction — the first version latched it after,
  // and the one client every ordinary round uses silently kept the SDK
  // retry default while _providerMaxRetries reported the pin. Assert on
  // what the constructor ACTUALLY passed to the SDK, not the stored option.
  test('the pin reaches the DEFAULT in-constructor client (Anthropic branch): SDK constructor receives maxRetries', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    Anthropic.mockClear();
    makeSession({ providerMaxRetries: 0 });
    expect(Anthropic).toHaveBeenCalledTimes(1);
    expect(Anthropic.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
  });

  test('no option → the SDK constructor receives NO maxRetries key (its own default stands)', async () => {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    Anthropic.mockClear();
    makeSession();
    expect(Anthropic).toHaveBeenCalledTimes(1);
    expect(Object.keys(Anthropic.mock.calls[0][0])).not.toContain('maxRetries');
  });

  test('the pin reaches the DEFAULT in-constructor client (OpenAI responses branch, the bench path): providerConfig echoes it', () => {
    const savedModel = process.env.SONNET_EXTRACT_MODEL;
    const savedKey = process.env.OPENAI_API_KEY;
    try {
      process.env.SONNET_EXTRACT_MODEL = 'gpt-5.6-luna';
      process.env.OPENAI_API_KEY = 'sk-test-not-dispatched';
      const s = makeSession({ providerMaxRetries: 0 });
      expect(s.client.providerConfig).toEqual({ maxRetries: 0 });
      const dflt = makeSession();
      expect(dflt.client.providerConfig).toEqual({ maxRetries: null });
    } finally {
      if (savedModel === undefined) delete process.env.SONNET_EXTRACT_MODEL;
      else process.env.SONNET_EXTRACT_MODEL = savedModel;
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});
