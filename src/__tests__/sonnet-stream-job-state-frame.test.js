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
});
