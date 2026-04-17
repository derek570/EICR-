'use client';

import * as React from 'react';
import { Cable, Gauge, Layers, Power, ShieldCheck, Sigma, Wrench, Zap } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
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

export default function SupplyPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const supply = (job.supply ?? {}) as SupplyShape;

  const patch = React.useCallback(
    (next: SupplyShape) => {
      updateJob({ supply: { ...supply, ...next } });
    },
    [supply, updateJob]
  );

  const text = (k: keyof SupplyShape) => (supply[k] as string | undefined) ?? '';
  const bool = (k: keyof SupplyShape) => supply[k] as boolean | undefined;

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroBanner certificateType={certificateType} />

      <SectionCard accent="green" icon={Zap} title="Supply details">
        <SelectChips
          label="Earthing arrangement"
          value={text('earthing_arrangement') || null}
          options={EARTHING_OPTIONS}
          onChange={(v) => patch({ earthing_arrangement: v })}
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
            onChange={(e) => patch({ earth_loop_impedance_ze: e.target.value })}
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
            onChange={(v) => patch({ supply_polarity_confirmed: v === 'yes' })}
            options={[
              { value: 'yes', label: 'Confirmed', variant: 'pass' },
              { value: 'no', label: 'Not confirmed', variant: 'fail' },
            ]}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={Sigma} title="Means of earthing">
        <div className="flex flex-col gap-2">
          <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
            Distributor / electrode
          </label>
          <SegmentedControl
            aria-label="Means of earthing"
            value={
              bool('means_earthing_distributor')
                ? 'distributor'
                : bool('means_earthing_electrode')
                  ? 'electrode'
                  : null
            }
            onChange={(v) =>
              patch({
                means_earthing_distributor: v === 'distributor',
                means_earthing_electrode: v === 'electrode',
              })
            }
            options={[
              { value: 'distributor', label: 'Distributor', variant: 'info' },
              { value: 'electrode', label: 'Electrode', variant: 'info' },
            ]}
          />
        </div>
        {bool('means_earthing_electrode') ? (
          <div className="grid gap-3 md:grid-cols-2">
            <FloatingLabelInput
              label="Electrode type"
              value={text('earth_electrode_type')}
              onChange={(e) => patch({ earth_electrode_type: e.target.value })}
            />
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
        <div className="grid gap-3 md:grid-cols-3">
          <FloatingLabelInput
            label="Material"
            value={text('earthing_conductor_material')}
            onChange={(e) => patch({ earthing_conductor_material: e.target.value })}
          />
          <FloatingLabelInput
            label="CSA (mm²)"
            inputMode="decimal"
            value={text('earthing_conductor_csa')}
            onChange={(e) => patch({ earthing_conductor_csa: e.target.value })}
          />
          <FloatingLabelInput
            label="Continuity (Ω)"
            inputMode="decimal"
            value={text('earthing_conductor_continuity')}
            onChange={(e) => patch({ earthing_conductor_continuity: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={Wrench} title="Main protective bonding">
        <div className="grid gap-3 md:grid-cols-3">
          <FloatingLabelInput
            label="Material"
            value={text('main_bonding_material')}
            onChange={(e) => patch({ main_bonding_material: e.target.value })}
          />
          <FloatingLabelInput
            label="CSA (mm²)"
            inputMode="decimal"
            value={text('main_bonding_csa')}
            onChange={(e) => patch({ main_bonding_csa: e.target.value })}
          />
          <FloatingLabelInput
            label="Continuity (Ω)"
            inputMode="decimal"
            value={text('main_bonding_continuity')}
            onChange={(e) => patch({ main_bonding_continuity: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="green" icon={Layers} title="Bonding of extraneous parts">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Water"
            value={text('bonding_water')}
            onChange={(e) => patch({ bonding_water: e.target.value })}
          />
          <FloatingLabelInput
            label="Gas"
            value={text('bonding_gas')}
            onChange={(e) => patch({ bonding_gas: e.target.value })}
          />
          <FloatingLabelInput
            label="Oil"
            value={text('bonding_oil')}
            onChange={(e) => patch({ bonding_oil: e.target.value })}
          />
          <FloatingLabelInput
            label="Structural steel"
            value={text('bonding_structural_steel')}
            onChange={(e) => patch({ bonding_structural_steel: e.target.value })}
          />
          <FloatingLabelInput
            label="Lightning protection"
            value={text('bonding_lightning')}
            onChange={(e) => patch({ bonding_lightning: e.target.value })}
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
        </div>
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

function HeroBanner({ certificateType }: { certificateType: 'EICR' | 'EIC' }) {
  return (
    <div
      className="relative flex items-center justify-between overflow-hidden rounded-[var(--radius-xl)] px-5 py-5 md:px-6 md:py-6"
      style={{
        background:
          'linear-gradient(135deg, var(--color-brand-green) 0%, var(--color-brand-blue) 100%)',
      }}
    >
      <div className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-white/75">{certificateType}</p>
        <h2 className="text-[22px] font-bold text-white md:text-[26px]">Supply Characteristics</h2>
        <p className="text-[13px] text-white/85">Earthing, fault current &amp; protection</p>
      </div>
      <Zap className="h-10 w-10 text-white/30" strokeWidth={2} aria-hidden />
    </div>
  );
}
