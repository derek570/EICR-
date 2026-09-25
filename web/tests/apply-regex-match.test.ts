/**
 * apply-regex-match unit tests — locks the 3-tier write-priority
 * behaviour the FieldSourceTracker enforces, and the JobDetail patch
 * shape the recording-context.tsx wiring depends on.
 *
 * Critical invariants:
 *   - regex never overwrites Sonnet OR pre-existing
 *   - regex CAN overwrite a previous regex write (last-hit-wins)
 *   - changedKeys list matches FieldSourceTracker keys (so liveFill
 *     and buildRegexSummary see the same keys)
 *   - circuit cells route by row UUID (not circuit_ref)
 *   - empty result returns null (caller can skip updateJob)
 */
import { describe, it, expect } from 'vitest';
import { applyRegexMatchToJob } from '@/lib/recording/apply-regex-match';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
import type { RegexMatchResult } from '@/lib/recording/regex-match-result';
import type { JobDetail } from '@/lib/types';

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    ...over,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<RegexMatchResult> = {}): RegexMatchResult {
  return {
    supply_updates: {},
    circuit_updates: {},
    board_updates: {},
    installation_updates: {},
    new_circuits: [],
    ...over,
  };
}

describe('applyRegexMatchToJob', () => {
  it('returns null when nothing matched', () => {
    const tracker = new FieldSourceTracker();
    const out = applyRegexMatchToJob(makeJob(), makeResult(), tracker);
    expect(out).toBeNull();
  });

  it('writes ze on a fresh job and reports the key', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    const out = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out).not.toBeNull();
    // A02D — the write lands on every stored alias of the destination (the
    // wire key + the Supply page's column), one tracker key.
    expect(out!.patch.supply_characteristics).toEqual({
      ze: '0.34',
      earth_loop_impedance_ze: '0.34',
    });
    expect(out!.changedKeys).toEqual(['supply.ze']);
    expect(tracker.getSource('supply.ze')).toBe('regex');
  });

  it('does not overwrite a pre-existing supply value', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob({ supply_characteristics: { ze: '0.50' } });
    tracker.seedFromJob(job);
    const out = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out).toBeNull();
    expect(tracker.getSource('supply.ze')).toBe('preExisting');
  });

  it('does not overwrite a Sonnet-owned field', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    tracker.recordSonnetWrite('supply.ze');
    const out = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out).toBeNull();
    expect(tracker.getSource('supply.ze')).toBe('sonnet');
  });

  it('overwrites a previous regex write (last-hit-wins)', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    const out1 = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(out1?.patch.supply_characteristics).toEqual({
      ze: '0.34',
      earth_loop_impedance_ze: '0.34',
    });
    const out2 = applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.42' } }), tracker);
    expect(out2?.patch.supply_characteristics).toEqual({
      ze: '0.42',
      earth_loop_impedance_ze: '0.42',
    });
    expect(tracker.getSource('supply.ze')).toBe('regex');
  });

  it('routes main_switch_* to board_info', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    const out = applyRegexMatchToJob(
      job,
      makeResult({
        supply_updates: { main_switch_current: '100', main_switch_bs_en: '60898' },
      }),
      tracker
    );
    expect(out!.patch.board_info).toEqual({
      main_switch_current: '100',
      main_switch_bs_en: '60898',
    });
    expect(out!.patch.supply_characteristics).toBeUndefined();
    expect(out!.changedKeys.sort()).toEqual([
      'board.main_switch_bs_en',
      'board.main_switch_current',
    ]);
  });

  it('routes circuit_updates by row UUID', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob({
      circuits: [
        { id: 'row-uuid-A', circuit_ref: '1', circuit_designation: 'Lights' },
        { id: 'row-uuid-B', circuit_ref: '2', circuit_designation: 'Sockets' },
      ],
    });
    const out = applyRegexMatchToJob(
      job,
      makeResult({
        circuit_updates: { '1': { measured_zs_ohm: '0.72' } },
      }),
      tracker
    );
    expect(out).not.toBeNull();
    expect(out!.changedKeys).toEqual(['circuit.row-uuid-A.measured_zs_ohm']);
    expect(out!.patch.circuits?.[0]).toMatchObject({
      id: 'row-uuid-A',
      circuit_ref: '1',
      measured_zs_ohm: '0.72',
    });
    expect(out!.patch.circuits?.[1]).toMatchObject({ id: 'row-uuid-B', circuit_ref: '2' });
    expect((out!.patch.circuits![1] as Record<string, unknown>).measured_zs_ohm).toBeUndefined();
    expect(tracker.getSource('circuit.row-uuid-A.measured_zs_ohm')).toBe('regex');
  });

  it('drops circuit_updates whose ref is not in the job (out of scope here)', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob({ circuits: [{ id: 'a', circuit_ref: '1', circuit_designation: 'L' }] });
    const out = applyRegexMatchToJob(
      job,
      makeResult({ circuit_updates: { '99': { measured_zs_ohm: '0.5' } } }),
      tracker
    );
    expect(out).toBeNull();
  });

  // PLAN-C (feedback id 129) — the closed-enum guard at the REGEX ingress.
  // The instant fill writes into the same six schema-enumerated columns the
  // voice appliers guard, straight from Flux text, and had no validation of
  // its own. Session 17821FFA is the provenance.
  describe('closed-enum guard', () => {
    const jobWithRow = () =>
      makeJob({ circuits: [{ id: 'row-A', circuit_ref: '1', circuit_designation: 'Cooker' }] });

    it('SUPPRESSES a device class dictated into a closed-enum column', () => {
      const tracker = new FieldSourceTracker();
      const out = applyRegexMatchToJob(
        jobWithRow(),
        makeResult({ circuit_updates: { '1': { rcd_type: 'MCB' } } }),
        tracker
      );
      expect(out).toBeNull();
    });

    it('a suppressed value does NOT mark the field regex-owned (the real value can still land)', () => {
      // Recording a WRITE for a value that never landed would leave the
      // tracker claiming a populated column while the certificate shows
      // blank — and `canRegexWrite` would then reject the correct value
      // arriving moments later. Ownership is never claimed. (The per-turn
      // HINT set is a separate thing and IS populated — see below.)
      const tracker = new FieldSourceTracker();
      const job = jobWithRow();
      applyRegexMatchToJob(
        job,
        makeResult({ circuit_updates: { '1': { rcd_type: 'MCB' } } }),
        tracker
      );
      expect(tracker.getSource('circuit.row-A.rcd_type')).toBeUndefined();
      const out = applyRegexMatchToJob(
        job,
        makeResult({ circuit_updates: { '1': { rcd_type: 'A' } } }),
        tracker
      );
      expect(out!.patch.circuits?.[0]).toMatchObject({ rcd_type: 'A' });
    });

    // Codex cycle 3 — suppression stops at the WRITE.
    //
    // `regexResults` is built from the tracker's per-turn set, and
    // `gateRegexHit` is `regexResults.length > 0`. Dropping the candidate
    // outright therefore silently disarmed the pre-LLM forward gate: a
    // short utterance whose ONLY evidence was the refused match would be
    // gated out, so the server never saw the transcript and the inspector
    // heard nothing at all. (Same mechanism as the 2026-08-11
    // `second`→`circuit` normaliser bug: an upstream repair eating the
    // gate's evidence.) iOS also still sends the hint, so dropping it was
    // a wire divergence on top.
    it('a suppressed value STILL emits its hint, so the forward gate stays open', () => {
      const tracker = new FieldSourceTracker();
      applyRegexMatchToJob(
        jobWithRow(),
        makeResult({ circuit_updates: { '1': { rcd_type: 'MCB' } } }),
        tracker
      );
      expect(tracker.consumeTurnWrites()).toEqual(['circuit.row-A.rcd_type']);
    });

    it('the same suppressed value does not re-emit on the next cumulative pass', () => {
      // The matcher re-scans a cumulative window, so the bad match recurs
      // every turn. A WRITTEN value goes non-fresh because the job holds
      // it; a suppressed one lands nowhere, so without its own shadow it
      // would hold the gate open on every later utterance forever.
      const tracker = new FieldSourceTracker();
      const job = jobWithRow();
      const result = makeResult({ circuit_updates: { '1': { rcd_type: 'MCB' } } });
      applyRegexMatchToJob(job, result, tracker);
      tracker.consumeTurnWrites();
      applyRegexMatchToJob(job, result, tracker);
      expect(tracker.consumeTurnWrites()).toEqual([]);
    });

    it('a DIFFERENT off-list value is fresh evidence again', () => {
      const tracker = new FieldSourceTracker();
      const job = jobWithRow();
      applyRegexMatchToJob(
        job,
        makeResult({ circuit_updates: { '1': { rcd_type: 'MCB' } } }),
        tracker
      );
      tracker.consumeTurnWrites();
      applyRegexMatchToJob(
        job,
        makeResult({ circuit_updates: { '1': { rcd_type: 'RCBO' } } }),
        tracker
      );
      expect(tracker.consumeTurnWrites()).toEqual(['circuit.row-A.rcd_type']);
    });

    // PLAN-C2 (Decision 6) — `ocpd_type` left the guard: an explicitly spoken
    // type lands as said (the server read-back owns the advisory), and the
    // examples above moved to `rcd_type`, which is still guarded.
    it('ocpd_type is free text at the regex applier — a spoken type lands silently', () => {
      const tracker = new FieldSourceTracker();
      const out = applyRegexMatchToJob(
        jobWithRow(),
        makeResult({ circuit_updates: { '1': { ocpd_type: 'B' } } }),
        tracker
      );
      expect(out!.patch.circuits?.[0]).toMatchObject({ ocpd_type: 'B' });
    });

    it('CANONICALISES a valid alias so regex and Sonnet agree on one string', () => {
      const tracker = new FieldSourceTracker();
      const out = applyRegexMatchToJob(
        jobWithRow(),
        makeResult({ circuit_updates: { '1': { ocpd_bs_en: '60898' } } }),
        tracker
      );
      expect(out!.patch.circuits?.[0]).toMatchObject({ ocpd_bs_en: 'BS EN 60898' });
      expect(out!.changedKeys).toEqual(['circuit.row-A.ocpd_bs_en']);
    });

    it('a canonicalised re-hit is NOT fresh against the already-stored canonical value', () => {
      // The matcher re-scans a CUMULATIVE window, so "60898" re-fires on
      // later utterances. Canonicalising BEFORE the A3 freshness compare is
      // what stops each re-hit looking like a new write (a phantom
      // changedKey → chime → chitchat-counter reset).
      const tracker = new FieldSourceTracker();
      const job = makeJob({
        circuits: [
          {
            id: 'row-A',
            circuit_ref: '1',
            circuit_designation: 'Cooker',
            ocpd_bs_en: 'BS EN 60898',
          },
        ],
      });
      const out = applyRegexMatchToJob(
        job,
        makeResult({ circuit_updates: { '1': { ocpd_bs_en: '60898' } } }),
        tracker
      );
      expect(out).toBeNull();
    });

    it('leaves an unguarded column alone', () => {
      const tracker = new FieldSourceTracker();
      const out = applyRegexMatchToJob(
        jobWithRow(),
        makeResult({ circuit_updates: { '1': { measured_zs_ohm: '0.42' } } }),
        tracker
      );
      expect(out!.patch.circuits?.[0]).toMatchObject({ measured_zs_ohm: '0.42' });
    });

    it('a same-shaped SUPPLY field outside the guarded six is untouched', () => {
      // `main_switch_bs_en` / `spd_bs_en` look like the guarded BS-EN
      // columns but are not schema-enumerated; the guard keys on the exact
      // canonical field name, so they pass through raw.
      const tracker = new FieldSourceTracker();
      const out = applyRegexMatchToJob(
        makeJob(),
        makeResult({ supply_updates: { main_switch_bs_en: '60898' } }),
        tracker
      );
      expect(out!.patch.board_info).toEqual({ main_switch_bs_en: '60898' });
    });
  });

  it('consumeTurnWrites returns and clears between calls', () => {
    const tracker = new FieldSourceTracker();
    const job = makeJob();
    applyRegexMatchToJob(job, makeResult({ supply_updates: { ze: '0.34' } }), tracker);
    expect(tracker.consumeTurnWrites()).toEqual(['supply.ze']);
    // Second call against same tracker — no new writes, consumeTurnWrites empty.
    expect(tracker.consumeTurnWrites()).toEqual([]);
  });
});
