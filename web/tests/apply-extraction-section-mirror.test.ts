/**
 * apply-extraction — board_info → supply_characteristics section
 * mirror tests.
 *
 * The PWA's `CIRCUIT_0_SECTION` map routes `main_switch_*` / `spd_*` /
 * `rcd_operating_*` to `board_info` so `LiveFillView`
 * (`web/src/components/live-fill/live-fill-view.tsx` reads
 * `str(board.main_switch_bs_en)` etc.) shows the live fill during
 * recording. But the Supply tab (`web/src/app/job/[id]/supply/page.tsx`)
 * renders the SAME fields from `supply_characteristics`. Without a
 * mirror, the Supply tab is empty post-recording even though the
 * during-recording overlay flashed the values.
 *
 * `applyCircuit0Readings` now mirrors those 15 fields to both
 * sections. Tests below pin every entry in `MIRROR_BOARD_TO_SUPPLY`
 * and the protect-user-value invariant that must hold across BOTH
 * sections.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
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

/** Every field name whose `CIRCUIT_0_SECTION` primary is `board_info`
 *  AND the Supply tab renders. Must match the
 *  `MIRROR_BOARD_TO_SUPPLY` set in apply-extraction.ts — a future
 *  drift on either side fails this test. */
const MIRRORED_FIELDS: ReadonlyArray<string> = [
  'main_switch_bs_en',
  'main_switch_current',
  'main_switch_fuse_setting',
  'main_switch_poles',
  'main_switch_voltage',
  'main_switch_location',
  'main_switch_conductor_material',
  'main_switch_conductor_csa',
  'rcd_operating_current',
  'rcd_time_delay',
  'rcd_operating_time',
  'spd_bs_en',
  'spd_type_supply',
  'spd_short_circuit',
  'spd_rated_current',
];

describe('apply-extraction board_info → supply_characteristics mirror', () => {
  it.each(MIRRORED_FIELDS)(
    'mirrors "%s" to BOTH board_info AND supply_characteristics',
    (field) => {
      const result = makeResult({
        readings: [{ circuit: 0, field, value: '100' }],
      });
      const applied = applyExtractionToJob(makeJob(), result);

      expect(applied).not.toBeNull();
      const board = applied!.patch.board_info as Record<string, unknown>;
      const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
      expect(board?.[field]).toBe('100');
      expect(supply?.[field]).toBe('100');
    }
  );

  it('does NOT mirror non-listed board_info fields', () => {
    // `manufacturer` is in CIRCUIT_0_SECTION but NOT in
    // MIRROR_BOARD_TO_SUPPLY (Supply tab doesn't render it; the Board
    // tab reads it from `boards[i].manufacturer` — separate structural
    // fix). Must land only in board_info, not double-write to supply.
    const result = makeResult({
      readings: [{ circuit: 0, field: 'manufacturer', value: 'Wylex' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);

    expect(applied).not.toBeNull();
    const board = applied!.patch.board_info as Record<string, unknown>;
    const supply = applied!.patch.supply_characteristics as Record<string, unknown> | undefined;
    expect(board.manufacturer).toBe('Wylex');
    expect(supply?.manufacturer).toBeUndefined();
  });

  it('skips when the user already typed into supply_characteristics', () => {
    // Inspector typed "100" into the Supply tab's Main Switch Current
    // (lands in `supply_characteristics.main_switch_current`). Sonnet
    // then dictates "main switch is 80 amps". The mirror's priority
    // check must see the Supply value and skip the entire write —
    // both sections — so the user's value isn't blown away on the
    // board side either.
    const job = makeJob({
      supply_characteristics: { main_switch_current: '100' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'main_switch_current', value: '80' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).toBeNull();
  });

  it('skips when the user already typed into board_info', () => {
    // Reverse case — LiveFillView writes / legacy import landed under
    // board_info. Same protection applies.
    const job = makeJob({
      board_info: { main_switch_current: '100' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'main_switch_current', value: '80' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).toBeNull();
  });

  it('passes through Supply-native fields untouched (no mirror)', () => {
    // `ze` is routed primarily to `supply_characteristics` already,
    // so the mirror logic must not fire / not pollute board_info.
    const result = makeResult({
      readings: [{ circuit: 0, field: 'ze', value: '0.42' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    const board = applied!.patch.board_info as Record<string, unknown> | undefined;
    expect(supply.ze).toBe('0.42');
    expect(board?.ze).toBeUndefined();
  });
});
