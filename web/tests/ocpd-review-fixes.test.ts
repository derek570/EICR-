/**
 * PLAN-CC — regression cover for the defects the EP diff review found.
 *
 * Each case here failed on the candidate the three Codex lanes read. They are
 * grouped by the lane that found them so a later reader can tell which review
 * bought which guarantee, and every one names the concrete trigger rather than
 * the mechanism, because the mechanism is what changed.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyOcpdAwarePatch,
  canonicaliseOcpdStandard,
  canonicaliseOcpdStandardForImport,
  isValueCheckedCircuitField,
  ocpdRowWarnings,
  ocpdStandardStatus,
  applyVoiceCommand,
  type MaxZsRow,
} from '@certmate/shared-utils';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import { mapServerActionToVoiceCommand } from '@/lib/recording/voice-command-action';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';

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
function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  };
}
const derived = (over: Partial<CircuitRow> = {}): CircuitRow => ({
  id: 'c-1',
  circuit_ref: '1',
  circuit_designation: 'Cooker',
  ocpd_bs_en: 'BS EN 60898',
  ocpd_type: 'B',
  ocpd_rating_a: '32',
  max_disconnect_time_s: '0.4',
  ocpd_max_zs_ohm: '1.44',
  ocpd_max_zs_source: 'auto',
  ...over,
});

describe('server apply canonicalises the standard (comprehensive lane)', () => {
  it('writes BS EN 61009 for a dictated 60909, as iOS already did', () => {
    // Web wrote the raw value, so the same frame produced `60909` on web and
    // `BS EN 61009` on iOS — and `60909` is not a device standard at all.
    const applied = applyExtractionToJob(
      makeJob({ circuits: [{ id: 'c-1', circuit_ref: '1' } as CircuitRow] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_bs_en', value: '60909' }] })
    );
    expect(applied!.patch.circuits![0].ocpd_bs_en).toBe('BS EN 61009');
  });

  // CONTRACT, not a regression: this passed before the fix too, because the
  // pre-fix code wrote the raw value. Kept because the property matters and
  // could regress the other way — but it is not what proves the fix.
  it('preserves an unreadable standard exactly as sent', () => {
    const applied = applyExtractionToJob(
      makeJob({ circuits: [{ id: 'c-1', circuit_ref: '1' } as CircuitRow] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_bs_en', value: 'There is no RCBO' }] })
    );
    expect(applied!.patch.circuits![0].ocpd_bs_en).toBe('There is no RCBO');
  });
});

describe('an explicit max-Zs clear is not undone by the H3 pass (two lanes)', () => {
  it('a field_cleared for ocpd_max_zs_ohm survives a resolvable tuple', () => {
    // `clearMaxZs` removed value and key, and H3 then saw an empty cell with a
    // computable tuple and wrote the same figure straight back, so the clear
    // the inspector asked for never reached the certificate.
    const applied = applyExtractionToJob(
      makeJob({ circuits: [derived()] }),
      makeResult({ field_clears: [{ circuit: 1, field: 'ocpd_max_zs_ohm' }] })
    );
    const row = applied!.patch.circuits![0];
    expect(row.ocpd_max_zs_ohm ?? '').toBe('');
    expect(row.ocpd_max_zs_source ?? '').toBe('');
  });

  it('suppresses the derivation on the CLEARED row only, in a same-ref multi-board job', () => {
    // The suppression set is keyed by row IDENTITY, not by `circuit_ref`.
    // Keying on the ref alone would suppress BOTH boards' circuit 1 — the
    // collision H3's prior map already had to avoid for the same reason.
    const main = derived({ id: 'm-1', board_id: 'main' });
    const sub = derived({
      id: 's-1',
      board_id: 'sub',
      ocpd_rating_a: '16',
      ocpd_max_zs_ohm: '2.87',
    });
    const applied = applyExtractionToJob(
      makeJob({ circuits: [main, sub] }),
      makeResult({ field_clears: [{ circuit: 1, field: 'ocpd_max_zs_ohm' }] })
    );
    const rows = applied!.patch.circuits!;
    // Web's per-circuit clear is ref-only, so it lands on one row; whichever
    // it lands on, the OTHER must keep its derived value rather than being
    // suppressed by a shared key.
    const cleared = rows.filter((r) => (r.ocpd_max_zs_ohm ?? '') === '');
    const kept = rows.filter((r) => (r.ocpd_max_zs_ohm ?? '') !== '');
    expect(cleared).toHaveLength(1);
    expect(kept).toHaveLength(1);
  });

  it('the suppression is scoped to the turn, not to the row forever', () => {
    const cleared = applyExtractionToJob(
      makeJob({ circuits: [derived()] }),
      makeResult({ field_clears: [{ circuit: 1, field: 'ocpd_max_zs_ohm' }] })
    )!.patch.circuits![0];
    // A LATER turn that changes a tuple member derives normally again. Driven
    // as a spoken correction because the 3-tier value guard otherwise refuses
    // to overwrite a populated column — correct, and unrelated to this rule.
    const next = applyExtractionToJob(
      makeJob({ circuits: [cleared as CircuitRow] }),
      makeResult({
        readings: [{ circuit: 1, field: 'ocpd_type', value: 'C', replaces_cleared: true } as never],
      })
    );
    expect(next!.patch.circuits![0].ocpd_max_zs_ohm).toBe('0.72');
    expect(next!.patch.circuits![0].ocpd_max_zs_source).toBe('auto');
  });

  it('a clear on one circuit does not suppress derivation on another', () => {
    const other: CircuitRow = {
      id: 'c-2',
      circuit_ref: '2',
      ocpd_bs_en: 'BS EN 60898',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      max_disconnect_time_s: '0.4',
    };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [derived(), other] }),
      makeResult({ field_clears: [{ circuit: 1, field: 'ocpd_max_zs_ohm' }] })
    );
    const rows = applied!.patch.circuits!;
    expect(rows.find((r) => r.id === 'c-1')!.ocpd_max_zs_ohm ?? '').toBe('');
    expect(rows.find((r) => r.id === 'c-2')!.ocpd_max_zs_ohm).toBe('1.44');
  });
});

describe('local voice commands route through the tuple helper (max-Zs lane)', () => {
  const job = {
    circuits: [derived(), derived({ id: 'c-2', circuit_ref: '2' })],
  } as never;

  it('a dictated standard change invalidates the derived value', () => {
    // The bare `{ ...row, [field]: value }` spread recomputed nothing, so the
    // PREVIOUS device's max Zs stayed on the certificate.
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd_bs_en', value: 'BS 3871', circuit: 1 },
      job
    );
    const rows = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].ocpd_bs_en).toBe('BS 3871');
    expect(rows[0].ocpd_max_zs_ohm ?? '').toBe('');
  });

  it('a dictated max Zs is recorded manual, so a later tuple change cannot eat it', () => {
    const out = applyVoiceCommand(
      { type: 'update_field', field: 'ocpd max zs', value: '0.99', circuit: 1 },
      job
    );
    const rows = out.patch?.circuits as Array<Record<string, unknown>>;
    expect(rows[0].ocpd_max_zs_ohm).toBe('0.99');
    expect(rows[0].ocpd_max_zs_source).toBe('manual');
  });

  it('a BULK standard change recomputes every targeted row', () => {
    const out = applyVoiceCommand(
      {
        type: 'apply_field',
        field: 'ocpd_bs_en',
        value: 'BS 3871',
        scope: { kind: 'all' },
      } as never,
      job
    );
    const rows = out.patch?.circuits as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect(row.ocpd_bs_en).toBe('BS 3871');
      expect(row.ocpd_max_zs_ohm ?? '').toBe('');
    }
  });
});

describe('the wire decoder keeps ocpd_bs_en in the tolerant class (parity lane)', () => {
  it('the predicate covers the guarded five plus ocpd_bs_en', () => {
    expect(isValueCheckedCircuitField('ocpd_bs_en')).toBe(true);
    expect(isValueCheckedCircuitField('wiring_type')).toBe(true);
    expect(isValueCheckedCircuitField('measured_zs_ohm')).toBe(false);
  });

  it('stringifies a NUMERIC server value instead of dropping the action', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'update_field',
      params: { field: 'ocpd_bs_en', value: 60898, circuit: 1 },
    } as never);
    expect(cmd).not.toBeNull();
    expect((cmd as { value: string }).value).toBe('60898');
  });

  it('forwards an EMPTY value rather than dropping it under a spoken success line', () => {
    // Dropping it here is the PLAN-C failure in a new place: the action never
    // applies and the caller still speaks the server's "Set …" confirmation.
    const cmd = mapServerActionToVoiceCommand({
      type: 'update_field',
      params: { field: 'ocpd_bs_en', value: '', circuit: 1 },
    } as never);
    expect(cmd).not.toBeNull();
  });

  it('routes an apply_field with no resolvable scope to the missing-target re-ask', () => {
    const cmd = mapServerActionToVoiceCommand({
      type: 'apply_field',
      params: { field: 'ocpd_bs_en', value: '60898' },
    } as never);
    expect(cmd).not.toBeNull();
    expect((cmd as { type: string }).type).toBe('update_field');
    expect((cmd as { circuit?: number }).circuit).toBeUndefined();
  });
});

describe('an unreadable standard is marked even with no max Zs (comprehensive lane)', () => {
  const imported: MaxZsRow = { circuit_ref: '3', ocpd_bs_en: 'There is no RCBO' };

  it('the standard has its own status, reachable when the max-Zs cell is empty', () => {
    expect(ocpdStandardStatus(imported)).toBe('unreadable');
    expect(ocpdStandardStatus({ circuit_ref: '3', ocpd_bs_en: 'BS 3871' })).toBeNull();
    expect(ocpdStandardStatus({ circuit_ref: '3' })).toBeNull();
  });

  it('produces exactly one preflight line, with the pinned copy', () => {
    expect(ocpdRowWarnings('3', imported)).toEqual([
      'Circuit 3: OCPD standard There is no RCBO was stored as recorded and is not a recognised form — check it before issuing',
    ]);
  });

  it('reports the standard FIRST when both questions fire', () => {
    const both: MaxZsRow = {
      circuit_ref: '4',
      ocpd_bs_en: 'There is no RCBO',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      ocpd_max_zs_ohm: '1.44',
    };
    const lines = ocpdRowWarnings('4', both);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('OCPD standard');
    expect(lines[1]).toContain('no recorded source');
  });
});

// These two are the WEB HALF of a cross-client divergence, and web was already
// correct on both — JavaScript's `\s` trimmed the non-breaking space and its
// `\d` already refused fullwidth digits. The discriminating half is the Swift
// one (`OcpdStandardContractTests`), which failed before the fix. They are kept
// as the other end of the pinned pair: if a future change made web match ICU
// instead, these would catch it.
describe('the twins cannot diverge on whitespace or digits (parity lane)', () => {
  it('a non-breaking space at the edges still resolves N/A', () => {
    expect(canonicaliseOcpdStandard(' N/A ')).toBe('N/A');
    expect(canonicaliseOcpdStandard('BS EN 60898')).toBe('BS EN 60898');
  });

  it('fullwidth digits MISS, because ICU would have accepted them', () => {
    expect(canonicaliseOcpdStandard('６０８９８')).toBeNull();
    expect(canonicaliseOcpdStandard('BS EN ６０８９８')).toBeNull();
  });
});

// CONTRACT tests for a helper these fixes did not change. They document the
// two properties the review asked about — one decision per patch, and a
// same-patch max-Zs edit surviving — rather than proving a fix.
describe('applyOcpdAwarePatch — contract', () => {
  it('a patch touching TWO tuple members produces ONE decision', () => {
    const log = vi.fn();
    const before = derived();
    const after = applyOcpdAwarePatch(
      before as Record<string, unknown>,
      { ocpd_bs_en: 'BS 1361', ocpd_type: '2', ocpd_rating_a: '30' },
      canonicaliseOcpdStandardForImport,
      log
    );
    expect(after.ocpd_max_zs_ohm).toBe('1.09');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a max-Zs edit in the same patch is manual and is not recomputed away', () => {
    const after = applyOcpdAwarePatch(
      derived() as Record<string, unknown>,
      { ocpd_max_zs_ohm: '0.99', ocpd_type: 'C' },
      canonicaliseOcpdStandardForImport
    );
    expect(after.ocpd_max_zs_ohm).toBe('0.99');
    expect(after.ocpd_max_zs_source).toBe('manual');
  });
});

describe('the regex instant fill recomputes the tuple (verification lane gap)', () => {
  it('a regex-admitted STANDARD change invalidates the derived max Zs', async () => {
    // The per-candidate route had no runtime cover: the existing regex tests
    // assert canonicalisation only, so a missing recompute survived them. This
    // fails on the pre-fix spread, which left the previous device's figure.
    const { applyRegexMatchToJob } = await import('@/lib/recording/apply-regex-match');
    const { FieldSourceTracker } = await import('@/lib/recording/field-source-tracker');
    const job = makeJob({ circuits: [derived()] });
    const out = applyRegexMatchToJob(
      job,
      {
        supply_updates: {},
        // `60898` is what the detector can emit; the row already holds
        // BS EN 60898, so use the OCPD TYPE to move the tuple instead — it is
        // the same computed-key write and the same helper.
        circuit_updates: { '1': { ocpd_type: 'D' } },
        board_updates: {},
        installation_updates: {},
        new_circuits: [],
      } as never,
      new FieldSourceTracker()
    );
    const row = out!.patch.circuits![0];
    expect(row.ocpd_type).toBe('D');
    // BS EN 60898 / D / 32 @ 0.4 s = 0.36, not the 1.44 the row carried.
    expect(row.ocpd_max_zs_ohm).toBe('0.36');
    expect(row.ocpd_max_zs_source).toBe('auto');
  });
});
