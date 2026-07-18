/**
 * F/U-4 (Codex review) — job_state_update frame-shape normalisation. The PWA
 * nests the job under `jobState`; iOS sends it flat. Pre-fix, updateJobState
 * received the raw PWA frame and found no top-level circuits/supply/boards —
 * every web mid-session job-state update was a silent no-op.
 */
import { unwrapJobStateFrame } from '../extraction/job-state-frame.js';

describe('unwrapJobStateFrame', () => {
  test('PWA shape: {type, jobState:{…}} unwraps to the nested job', () => {
    const job = { circuits: [{ ref: 1 }], supply: { ze: '0.35' } };
    expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: job })).toBe(job);
  });

  test('iOS flat shape passes through untouched', () => {
    const msg = { type: 'job_state_update', circuits: [{ ref: 1 }], supply: { ze: '0.35' } };
    expect(unwrapJobStateFrame(msg)).toBe(msg);
  });

  test('a PRESENT-but-malformed jobState returns the null sentinel (handler skips — never the envelope)', () => {
    // Falling back to the envelope would hand updateJobState a job-field-less
    // object whose schedule rebuild CLEARS the existing circuit schedule.
    for (const bad of ['oops', null, 42, [], [{ circuits: [] }]]) {
      expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: bad, circuits: [] })).toBe(
        null
      );
    }
  });

  test('a non-object frame returns the null sentinel', () => {
    expect(unwrapJobStateFrame(null)).toBe(null);
    expect(unwrapJobStateFrame('x')).toBe(null);
  });

  test('an EMPTY or envelope-only payload returns the null sentinel (never the schedule-clearing passthrough)', () => {
    // {jobState:{}} — no recognized job-state field → skip.
    expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: {} })).toBe(null);
    // Envelope-only flat frame (e.g. just type/reason) → skip.
    expect(unwrapJobStateFrame({ type: 'job_state_update', reason: 'x' })).toBe(null);
    // An explicit own circuits:[] REMAINS the valid way to clear.
    const clear = { circuits: [] };
    expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: clear })).toBe(clear);
  });

  test('a non-plain-record OUTER frame returns the null sentinel too', () => {
    expect(unwrapJobStateFrame([])).toBe(null);
    expect(unwrapJobStateFrame(new Date())).toBe(null);
    expect(unwrapJobStateFrame(Object.create({ circuits: [] }))).toBe(null);
  });
});

describe('element-level validation (Codex r6)', () => {
  test('non-record elements reject the whole frame atomically', () => {
    for (const bad of [
      { circuits: [null] },
      { circuits: [[]] },
      { circuits: [{ ref: 1 }, 42] },
      { boards: [null] },
      { boards: [{ id: 'main' }, 'x'] },
    ]) {
      expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: bad })).toBe(null);
    }
    const ok = { circuits: [{ ref: 1 }], boards: [{ id: 'main' }] };
    expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: ok })).toBe(ok);
  });
});

describe('structural field validation (Codex r5)', () => {
  test('malformed recognized fields return the null sentinel', () => {
    for (const bad of [
      { circuits: null },
      { circuits: {} },
      { circuits: 42 },
      { boards: 'x' },
      { supply: [] },
    ]) {
      expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: bad })).toBe(null);
    }
    // Production null boards sentinel + explicit clear stay valid.
    const ok = { circuits: [], boards: null };
    expect(unwrapJobStateFrame({ type: 'job_state_update', jobState: ok })).toBe(ok);
  });
});
