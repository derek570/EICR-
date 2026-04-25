'use client';

import * as React from 'react';
import { Cable, Gauge, Layers, Power, ShieldCheck, Sigma, Wrench, Zap } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectChips } from '@/components/ui/select-chips';

/**
 * Supply tab — mirrors iOS `SupplyTab.swift` + `SupplyCharacteristics.swift`.
 *
 * Eight section cards in the same order iOS uses so users who switch
 * platforms mid-job land in the same mental model:
 *   1. Supply details        (earthing, live conductors, voltages, freq, PFC, Ze)
 *   2. Means of earthing     (distributor / electrode choice + electrode detail)
 *   3. Main switch           (BS EN, poles, voltage, current, fuse, location)
 *   4. RCD                   (In, time delay, operating time — design + tested)
 *   5. Earthing conductor    (material, CSA, continuity)
 *   6. Main protective bonding (material, CSA, continuity)
 *   7. Bonding of extraneous parts (water/gas/oil/steel/lightning/other)
 *   8. SPD                   (BS EN, type, Isc, rated current)
 *
 * Phase 4 additions (iOS parity):
 *   - Earthing-arrangement side-effect: picking TT auto-sets electrode=true
 *     and flips `inspection.isTTEarthing` (mirrors `SupplyTab.swift:L28-L48`).
 *   - Distributor + Electrode are independent toggles — real installations
 *     can have both (iOS pattern at L88-L91).
 *   - Earth electrode type select (rod/plate/tape/mat/other) + rod/EE/P alias.
 *   - Main-switch conductor material (with Copper quick-set) + CSA.
 *   - 3-state Bonding pickers (PASS / FAIL / LIM) for Water/Gas/Oil/Steel/Lightning.
 *   - `autoContinuityIfBonded` — any PASS on the 5 bonds auto-ticks main bonding
 *     continuity PASS; never clears.
 *   - Ze → auto-tick polarity + earthing continuity, one-shot per field so
 *     manual "no / fail" overrides are respected.
 *   - First-appearance defaults — SPD / RCD / Main bonding seed to "N/A".
 */

type SupplyShape = Record<string, string | boolean | undefined>;

const EARTHING_OPTIONS = [
  { value: 'TN-S', label: 'TN-S' },
  { value: 'TN-C-S', label: 'TN-C-S' },
  { value: 'TT', label: 'TT' },
  { value: 'IT', label: 'IT' },
];

const LIVE_CONDUCTOR_OPTIONS = [
  { value: 'Single-phase 2-wire', label: 'Single-phase 2-wire' },
  { value: 'Single-phase 3-wire', label: 'Single-phase 3-wire' },
  { value: 'Three-phase 3-wire', label: 'Three-phase 3-wire' },
  { value: 'Three-phase 4-wire', label: 'Three-phase 4-wire' },
];

// Mirrors iOS `Constants.earthElectrodeTypes`. The short aliases
// (E / EE / P / T / M / O) are what the PDF schedule renders; the
// long labels are there for the inspector to read. Keep the value
// identical to the iOS raw string so a round-trip via the backend
// is lossless.
const ELECTRODE_TYPE_OPTIONS = [
  { value: 'rod', label: 'Earth Rod (E)' },
  { value: 'electrode', label: 'Earth Electrode (EE)' },
  { value: 'plate', label: 'Plate (P)' },
  { value: 'tape', label: 'Tape (T)' },
  { value: 'mat', label: 'Mat (M)' },
  { value: 'other', label: 'Other (O)' },
];

/**
 * 3-state result options — iOS `Constants.bondingResults` and
 * `continuityResults` are identical here (PASS / FAIL / LIM), so
 * we share one option set. `SegmentedControl.value` of `null` means
 * "not yet answered".
 */
const RESULT_OPTIONS = [
  { value: 'PASS', label: 'PASS', variant: 'pass' as const },
  { value: 'FAIL', label: 'FAIL', variant: 'fail' as const },
  { value: 'LIM', label: 'LIM', variant: 'lim' as const },
];

export default function SupplyPage() {
  const { job, certificateType, updateJob } = useJobContext();
  // See DesignPage for the rationale — memo-wrap keeps identity stable
  // so `patch` isn't rebuilt every render.
  const supply = React.useMemo<SupplyShape>(
    () => (job.supply_characteristics ?? {}) as SupplyShape,
    [job.supply_characteristics]
  );
  const inspection = React.useMemo<Record<string, unknown>>(
    () => (job.inspection_schedule ?? {}) as Record<string, unknown>,
    [job.inspection_schedule]
  );

  const patch = React.useCallback(
    (next: SupplyShape) => {
      updateJob({ supply_characteristics: { ...supply, ...next } });
    },
    [supply, updateJob]
  );

  const text = (k: keyof SupplyShape) => (supply[k] as string | undefined) ?? '';
  const bool = (k: keyof SupplyShape) => supply[k] as boolean | undefined;

  /**
   * Earthing-arrangement side effects — iOS `SupplyTab.swift:L28-L48`.
   * Picking TT implies an earth electrode on the installation side
   * AND switches the inspection schedule into "TT mode" (item 3.2
   * ticked, 3.1 N/A, the same contract the Inspection tab's
   * `setTTEarthing` honours).
   *
   * We deliberately do NOT clear `means_earthing_electrode` when the
   * user picks a non-TT arrangement — the inspector may have
   * explicitly set electrode=true on a TN system (backup electrode,
   * PME supplement, etc). Only the TT→true edge is auto.
   *
   * Mirror to `inspection.isTTEarthing` also routes through the
   * job context so the Inspection tab sees it via the same debounced
   * save — no bespoke cross-tab wiring needed.
   */
  const setEarthingArrangement = (value: string | null) => {
    const nextSupply: SupplyShape = { earthing_arrangement: value ?? undefined };
    if (value === 'TT') {
      nextSupply.means_earthing_electrode = true;
      nextSupply.means_earthing_distributor = false;
    }
    // Rebuild inspection + supply together so a single outbox write
    // captures both sides of the coupling.
    updateJob({
      supply_characteristics: { ...supply, ...nextSupply },
      inspection_schedule: { ...inspection, isTTEarthing: value === 'TT' },
    });
  };

  /**
   * Bonding rows trip auto-continuity. iOS `autoContinuityIfBonded`
   * (SupplyTab.swift:L343-L351): a PASS on any of the 5 extraneous
   * bonds is enough evidence that the main bonding conductor is
   * continuous — auto-tick PASS so the inspector doesn't have to
   * flip it manually. Never clears (FAIL → PASS would be a noisy
   * autocomplete; the manual value wins).
   */
  const setBonding = (key: keyof SupplyShape, value: string | null) => {
    const next: SupplyShape = { [key]: value ?? undefined };
    if (value === 'PASS') {
      const current = (supply.main_bonding_continuity as string | undefined) ?? '';
      if (!current || current === 'N/A') {
        next.main_bonding_continuity = 'PASS';
      }
    }
    patch(next);
  };

  /**
   * Ze → polarity + earthing continuity side effect.
   * iOS `SupplyTab.swift:L377-L395`: once a valid Ze reading is
   * entered, the supply polarity is by definition confirmed and the
   * earthing conductor's continuity is vouched for. Tick both
   * automatically — but only the first time (tracked via a
   * manual-override Set) so if the inspector deliberately flips
   * polarity=NO or continuity=FAIL, re-editing Ze doesn't stomp
   * their answer.
   */
  const manualOverridesRef = React.useRef<Set<string>>(new Set());
  const handleZeChange = (raw: string) => {
    const next: SupplyShape = { earth_loop_impedance_ze: raw };
    // Only fire the autocomplete when the new value is a plausible
    // numeric reading. Empty string = "I wiped it" → do nothing.
    if (raw.trim().length > 0 && !isNaN(parseFloat(raw))) {
      if (
        !manualOverridesRef.current.has('supply_polarity_confirmed') &&
        supply.supply_polarity_confirmed !== true
      ) {
        next.supply_polarity_confirmed = true;
      }
      const existingContinuity = (supply.earthing_conductor_continuity as string | undefined) ?? '';
      if (
        !manualOverridesRef.current.has('earthing_conductor_continuity') &&
        (!existingContinuity || existingContinuity === 'N/A')
      ) {
        next.earthing_conductor_continuity = 'PASS';
      }
    }
    patch(next);
  };

  /**
   * First-appearance defaults — seed SPD / RCD / Main bonding to
   * "N/A" when the job has no values for them yet. Matches iOS
   * `applyDefaultsIfNeeded` at SupplyTab.swift:L488-L512.
   *
   * Why N/A as the default rather than empty? Most domestic
   * installations have no RCD on the main switch and no SPD —
   * leaving the PDF with blank rows reads as "forgotten", whereas
   * N/A reads as "confirmed absent". The inspector can still
   * overwrite any of them.
   */
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const seed: SupplyShape = {};
    const defaults: Array<keyof SupplyShape> = [
      'spd_bs_en',
      'spd_type_supply',
      'spd_short_circuit',
      'spd_rated_current',
      'rcd_operating_current',
      'rcd_time_delay',
      'rcd_operating_time',
      'rcd_operating_current_test',
      'rcd_time_delay_test',
      'rcd_operating_time_test',
      'main_bonding_material',
      'main_bonding_csa',
      'main_bonding_continuity',
    ];
    for (const key of defaults) {
      if (supply[key] === undefined || supply[key] === null || supply[key] === '') {
        seed[key] = 'N/A';
      }
    }
    if (Object.keys(seed).length > 0) patch(seed);
    // One-shot — guarded by seededRef. Intentionally empty deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markManualOverride = (field: string) => {
    manualOverridesRef.current.add(field);
  };

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroBanner certificateType={certificateType} />

      <SectionCard accent="green" icon={Zap} title="Supply details">
        <SelectChips
          label="Earthing arrangement"
          value={text('earthing_arrangement') || null}
          options={EARTHING_OPTIONS}
          onChange={setEarthingArrangement}
        />
        <SelectChips
          label="Live conductors"
          value={text('live_conductors') || null}
          options={LIVE_CONDUCTOR_OPTIONS}
          onChange={(v) => patch({ live_conductors: v })}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Number of supplies"
            inputMode="numeric"
            value={text('number_of_supplies')}
            onChange={(e) => patch({ number_of_supplies: e.target.value })}
          />
          <FloatingLabelInput
            label="Nominal frequency (Hz)"
            inputMode="decimal"
            value={text('nominal_frequency')}
            onChange={(e) => patch({ nominal_frequency: e.target.value })}
          />
          <FloatingLabelInput
            label="U — line voltage (V)"
            inputMode="decimal"
            value={text('nominal_voltage_u')}
            onChange={(e) => patch({ nominal_voltage_u: e.target.value })}
          />
          <FloatingLabelInput
            label="Uo — phase voltage (V)"
            inputMode="decimal"
            value={text('nominal_voltage_uo')}
            onChange={(e) => patch({ nominal_voltage_uo: e.target.value })}
          />
          <FloatingLabelInput
            label="Prospective fault current (kA)"
            inputMode="decimal"
            value={text('prospective_fault_current')}
            onChange={(e) => patch({ prospective_fault_current: e.target.value })}
          />
          <FloatingLabelInput
            label="Earth loop impedance Ze (Ω)"
            inputMode="decimal"
            value={text('earth_loop_impedance_ze')}
            onChange={(e) => handleZeChange(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            Supply polarity confirmed?
          </label>
          <SegmentedControl
            aria-label="Supply polarity confirmed"
            value={
              bool('supply_polarity_confirmed') === true
                ? 'yes'
                : bool('supply_polarity_confirmed') === false
                  ? 'no'
                  : null
            }
            onChange={(v) => {
              markManualOverride('supply_polarity_confirmed');
              patch({ supply_polarity_confirmed: v === 'yes' });
            }}
            options={[
              { value: 'yes', label: 'Confirmed', variant: 'pass' },
              { value: 'no', label: 'Not confirmed', variant: 'fail' },
            ]}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={Sigma} title="Means of earthing">
        {/*
          iOS presents distributor + electrode as two independent
          toggles (SupplyTab.swift:L88-L91). The old web mutex
          version forced an either/or which doesn't match real
          installations — PME supply WITH a supplementary earth
          electrode is a legitimate combination.
        */}
        <div className="flex flex-col gap-3 md:grid md:grid-cols-2 md:gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              Distributor&rsquo;s facility
            </label>
            <SegmentedControl
              aria-label="Distributor's facility"
              value={
                bool('means_earthing_distributor') === true
                  ? 'yes'
                  : bool('means_earthing_distributor') === false
                    ? 'no'
                    : null
              }
              onChange={(v) => patch({ means_earthing_distributor: v === 'yes' })}
              options={[
                { value: 'yes', label: 'Yes', variant: 'pass' },
                { value: 'no', label: 'No', variant: 'fail' },
              ]}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              Installation earth electrode
            </label>
            <SegmentedControl
              aria-label="Installation earth electrode"
              value={
                bool('means_earthing_electrode') === true
                  ? 'yes'
                  : bool('means_earthing_electrode') === false
                    ? 'no'
                    : null
              }
              onChange={(v) => patch({ means_earthing_electrode: v === 'yes' })}
              options={[
                { value: 'yes', label: 'Yes', variant: 'pass' },
                { value: 'no', label: 'No', variant: 'fail' },
              ]}
            />
          </div>
        </div>
        {bool('means_earthing_electrode') ? (
          <>
            <SelectChips
              label="Electrode type"
              value={text('earth_electrode_type') || null}
              options={ELECTRODE_TYPE_OPTIONS}
              onChange={(v) => patch({ earth_electrode_type: v })}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <FloatingLabelInput
                label="Electrode resistance (Ω)"
                inputMode="decimal"
                value={text('earth_electrode_resistance')}
                onChange={(e) => patch({ earth_electrode_resistance: e.target.value })}
              />
              <FloatingLabelInput
                label="Electrode location"
                value={text('earth_electrode_location')}
                onChange={(e) => patch({ earth_electrode_location: e.target.value })}
              />
            </div>
          </>
        ) : null}
      </SectionCard>

      <SectionCard accent="blue" icon={Power} title="Main switch / fuse">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="BS EN"
            value={text('main_switch_bs_en')}
            onChange={(e) => patch({ main_switch_bs_en: e.target.value })}
          />
          <FloatingLabelInput
            label="Poles"
            value={text('main_switch_poles')}
            onChange={(e) => patch({ main_switch_poles: e.target.value })}
          />
          <FloatingLabelInput
            label="Voltage rating (V)"
            inputMode="decimal"
            value={text('main_switch_voltage')}
            onChange={(e) => patch({ main_switch_voltage: e.target.value })}
          />
          <FloatingLabelInput
            label="Current rating (A)"
            inputMode="decimal"
            value={text('main_switch_current')}
            onChange={(e) => patch({ main_switch_current: e.target.value })}
          />
          <FloatingLabelInput
            label="Fuse setting (A)"
            inputMode="decimal"
            value={text('main_switch_fuse_setting')}
            onChange={(e) => patch({ main_switch_fuse_setting: e.target.value })}
          />
          <FloatingLabelInput
            label="Location"
            value={text('main_switch_location')}
            onChange={(e) => patch({ main_switch_location: e.target.value })}
          />
          {/*
            iOS exposes conductor material + CSA for the main switch
            at SupplyTab.swift:L193-L203 — the PDF renders them as
            their own row in the supply section. Previously missing
            on web; adding now with a Copper quick-set to match the
            iOS QuickSetButton.
          */}
          <FloatingLabelInput
            label="Conductor material"
            value={text('main_switch_conductor_material')}
            onChange={(e) => patch({ main_switch_conductor_material: e.target.value })}
            trailing={
              <button
                type="button"
                onClick={() => patch({ main_switch_conductor_material: 'Copper' })}
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                  text('main_switch_conductor_material') === 'Copper'
                    ? 'bg-[var(--color-brand-blue)] text-white'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
                }`}
              >
                Copper
              </button>
            }
          />
          <FloatingLabelInput
            label="Conductor CSA (mm²)"
            inputMode="decimal"
            value={text('main_switch_conductor_csa')}
            onChange={(e) => patch({ main_switch_conductor_csa: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="amber" icon={Gauge} title="RCD">
        <div className="grid gap-3 md:grid-cols-3">
          <FloatingLabelInput
            label="Operating current (mA)"
            inputMode="decimal"
            value={text('rcd_operating_current')}
            onChange={(e) => patch({ rcd_operating_current: e.target.value })}
          />
          <FloatingLabelInput
            label="Time delay (ms)"
            inputMode="decimal"
            value={text('rcd_time_delay')}
            onChange={(e) => patch({ rcd_time_delay: e.target.value })}
          />
          <FloatingLabelInput
            label="Operating time (ms)"
            inputMode="decimal"
            value={text('rcd_operating_time')}
            onChange={(e) => patch({ rcd_operating_time: e.target.value })}
          />
          <FloatingLabelInput
            label="Tested In (mA)"
            inputMode="decimal"
            value={text('rcd_operating_current_test')}
            onChange={(e) => patch({ rcd_operating_current_test: e.target.value })}
          />
          <FloatingLabelInput
            label="Tested time delay (ms)"
            inputMode="decimal"
            value={text('rcd_time_delay_test')}
            onChange={(e) => patch({ rcd_time_delay_test: e.target.value })}
          />
          <FloatingLabelInput
            label="Tested operating time (ms)"
            inputMode="decimal"
            value={text('rcd_operating_time_test')}
            onChange={(e) => patch({ rcd_operating_time_test: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={Cable} title="Earthing conductor">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Material"
            value={text('earthing_conductor_material')}
            onChange={(e) => patch({ earthing_conductor_material: e.target.value })}
            trailing={
              <button
                type="button"
                onClick={() => patch({ earthing_conductor_material: 'Copper' })}
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                  text('earthing_conductor_material') === 'Copper'
                    ? 'bg-[var(--color-brand-blue)] text-white'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
                }`}
              >
                Copper
              </button>
            }
          />
          <FloatingLabelInput
            label="CSA (mm²)"
            inputMode="decimal"
            value={text('earthing_conductor_csa')}
            onChange={(e) => patch({ earthing_conductor_csa: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            Continuity check
          </label>
          <SegmentedControl
            aria-label="Earthing conductor continuity"
            value={
              (text('earthing_conductor_continuity') || null) as 'PASS' | 'FAIL' | 'LIM' | null
            }
            onChange={(v) => {
              markManualOverride('earthing_conductor_continuity');
              patch({ earthing_conductor_continuity: v });
            }}
            options={RESULT_OPTIONS}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={Wrench} title="Main protective bonding">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Material"
            value={text('main_bonding_material')}
            onChange={(e) => patch({ main_bonding_material: e.target.value })}
            trailing={
              <button
                type="button"
                onClick={() => patch({ main_bonding_material: 'Copper' })}
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                  text('main_bonding_material') === 'Copper'
                    ? 'bg-[var(--color-brand-blue)] text-white'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
                }`}
              >
                Copper
              </button>
            }
          />
          <FloatingLabelInput
            label="CSA (mm²)"
            inputMode="decimal"
            value={text('main_bonding_csa')}
            onChange={(e) => patch({ main_bonding_csa: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            Continuity check
          </label>
          <SegmentedControl
            aria-label="Main bonding continuity"
            value={(text('main_bonding_continuity') || null) as 'PASS' | 'FAIL' | 'LIM' | null}
            onChange={(v) => patch({ main_bonding_continuity: v })}
            options={RESULT_OPTIONS}
          />
        </div>
      </SectionCard>

      <SectionCard accent="green" icon={Layers} title="Bonding of extraneous parts">
        <BondingRow
          label="Water"
          value={text('bonding_water')}
          onChange={(v) => setBonding('bonding_water', v)}
        />
        <BondingRow
          label="Gas"
          value={text('bonding_gas')}
          onChange={(v) => setBonding('bonding_gas', v)}
        />
        <BondingRow
          label="Oil"
          value={text('bonding_oil')}
          onChange={(v) => setBonding('bonding_oil', v)}
        />
        <BondingRow
          label="Structural steel"
          value={text('bonding_structural_steel')}
          onChange={(v) => setBonding('bonding_structural_steel', v)}
        />
        <BondingRow
          label="Lightning protection"
          value={text('bonding_lightning')}
          onChange={(v) => setBonding('bonding_lightning', v)}
        />
        <FloatingLabelInput
          label="Other"
          value={text('bonding_other')}
          onChange={(e) => patch({ bonding_other: e.target.value })}
          trailing={
            <button
              type="button"
              onClick={() => patch({ bonding_other_na: !bool('bonding_other_na') })}
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                bool('bonding_other_na')
                  ? 'bg-[var(--color-brand-blue)] text-white'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
              }`}
            >
              N/A
            </button>
          }
        />
      </SectionCard>

      <SectionCard accent="magenta" icon={ShieldCheck} title="SPD (surge protection)" showCodeChip>
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="BS EN"
            value={text('spd_bs_en')}
            onChange={(e) => patch({ spd_bs_en: e.target.value })}
          />
          <FloatingLabelInput
            label="Type (I / II / III)"
            value={text('spd_type_supply')}
            onChange={(e) => patch({ spd_type_supply: e.target.value })}
          />
          <FloatingLabelInput
            label="Short-circuit rating (kA)"
            inputMode="decimal"
            value={text('spd_short_circuit')}
            onChange={(e) => patch({ spd_short_circuit: e.target.value })}
          />
          <FloatingLabelInput
            label="Rated current (A)"
            inputMode="decimal"
            value={text('spd_rated_current')}
            onChange={(e) => patch({ spd_rated_current: e.target.value })}
          />
        </div>
      </SectionCard>
    </div>
  );
}

/**
 * Single row of the 5 extraneous bonds — 3-state PASS / FAIL / LIM
 * picker matching iOS `BondingResultPicker` (SupplyTab.swift:L610-L640).
 */
function BondingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: 'PASS' | 'FAIL' | 'LIM' | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-[var(--color-text-primary)]">{label}</label>
      <SegmentedControl
        aria-label={label}
        value={(value || null) as 'PASS' | 'FAIL' | 'LIM' | null}
        onChange={onChange}
        options={[
          { value: 'PASS', label: 'PASS', variant: 'pass' },
          { value: 'FAIL', label: 'FAIL', variant: 'fail' },
          { value: 'LIM', label: 'LIM', variant: 'lim' },
        ]}
      />
    </div>
  );
}

function HeroBanner({ certificateType }: { certificateType: 'EICR' | 'EIC' }) {
  return (
    <HeroHeader
      eyebrow={certificateType}
      title="Supply Characteristics"
      subtitle="Earthing, fault current & protection"
      accent="electrical"
      icon={<Zap className="h-10 w-10" strokeWidth={2} aria-hidden />}
    />
  );
}
