'use client';

import * as React from 'react';
import { AlertTriangle, Building2, CircuitBoard, ClipboardList, Layers, Zap } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { useIsFieldRecent, useLiveFillStore } from '@/lib/recording/live-fill-state';
import type { CircuitRow, ObservationRow } from '@/lib/types';
import { SectionCard } from '@/components/ui/section-card';
import { LiveField, LiveFieldWide } from './live-field';

/**
 * LiveFillView — the full-form live dashboard shown while a recording
 * session is active. Ports iOS `LiveFillView.swift`.
 *
 * Sections (in scroll order):
 *   1. Installation — client + premises metadata
 *   2. Supply       — earthing, Ze, PFC, voltage, SPD
 *   3. Board        — main switch + board-level SPD
 *   4. Circuits     — one row per circuit, readings inline
 *   5. Observations — EICR only (EIC has no observations)
 *
 * Auto-scroll: a useEffect watches `lastUpdatedSection` from the store.
 * When it changes, the matching section scrolls into view. Skipped
 * under `prefers-reduced-motion`.
 *
 * The whole surface is semantically a `<section role="status"
 * aria-live="polite">` so screen readers announce new content. Each
 * subsection announces its own inserts via the enclosing role.
 */
export function LiveFillView() {
  const { job, certificateType } = useJobContext();
  const { lastUpdatedSection, lastUpdatedAt } = useLiveFillStore();

  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the most-recently-updated section. We scope the
  // scroll to this overlay's scroll container (`rootRef`) so the page
  // body doesn't jerk if the overlay is rendered nested.
  React.useEffect(() => {
    if (!lastUpdatedSection) return;
    if (typeof window === 'undefined') return;
    const root = rootRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-section="${lastUpdatedSection}"]`);
    if (!target) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    // lastUpdatedAt is the trigger — when the same section updates twice
    // in a row we still re-fire the scroll.
  }, [lastUpdatedSection, lastUpdatedAt]);

  const installation = (job.installation ?? {}) as Record<string, unknown>;
  const supply = (job.supply ?? {}) as Record<string, unknown>;
  const board = (job.board ?? {}) as Record<string, unknown>;
  const extent = (job.extent ?? {}) as Record<string, unknown>;
  const circuits = job.circuits ?? [];
  const observations = job.observations ?? [];

  const str = (v: unknown): string | undefined =>
    v === null || v === undefined ? undefined : String(v);

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      aria-label="Live fill — extracted fields update in real time"
      className="flex h-full flex-col gap-4 overflow-y-auto px-4 py-4 md:px-6 md:py-6"
    >
      {/* ── Installation ───────────────────────────────────────────── */}
      <div data-section="installation" className="cm-live-section">
        <SectionCard accent="blue" icon={Building2} title="Installation">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <LiveFieldWide
              fieldKey="installation.client_name"
              label="Client name"
              value={str(installation.client_name)}
            />
            <LiveFieldWide
              fieldKey="installation.address"
              label="Address"
              value={str(installation.address)}
            />
            <LiveField
              fieldKey="installation.postcode"
              label="Postcode"
              value={str(installation.postcode)}
              monospace
            />
            <LiveField
              fieldKey="installation.premises_description"
              label="Premises"
              value={str(installation.premises_description)}
            />
            <LiveField
              fieldKey="installation.occupier_name"
              label="Occupier"
              value={str(installation.occupier_name)}
            />
            <LiveField
              fieldKey="installation.reason_for_report"
              label="Reason for report"
              value={str(installation.reason_for_report)}
            />
            <LiveField
              fieldKey="installation.date_of_inspection"
              label="Inspection date"
              value={str(installation.date_of_inspection)}
            />
            <LiveField
              fieldKey="installation.estimated_age_of_installation"
              label="Estimated age"
              value={str(installation.estimated_age_of_installation)}
            />
          </div>
        </SectionCard>
      </div>

      {/* ── Extent (EIC only) ──────────────────────────────────────── */}
      {certificateType === 'EIC' ? (
        <div data-section="extent" className="cm-live-section">
          <SectionCard accent="magenta" icon={Layers} title="Extent covered">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <LiveFieldWide
                fieldKey="extent.extent_of_installation"
                label="Extent of installation"
                value={str(extent.extent_of_installation)}
              />
              <LiveField
                fieldKey="extent.installation_type"
                label="Installation type"
                value={str(extent.installation_type)}
              />
            </div>
          </SectionCard>
        </div>
      ) : null}

      {/* ── Supply ─────────────────────────────────────────────────── */}
      <div data-section="supply" className="cm-live-section">
        <SectionCard accent="green" icon={Zap} title="Supply characteristics">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <LiveField
              fieldKey="supply.earthing_arrangement"
              label="Earthing"
              value={str(supply.earthing_arrangement)}
            />
            <LiveField fieldKey="supply.ze" label="Ze (Ω)" value={str(supply.ze)} monospace />
            <LiveField fieldKey="supply.pfc" label="PFC (kA)" value={str(supply.pfc)} monospace />
            <LiveField
              fieldKey="supply.nominal_voltage_u"
              label="U (V)"
              value={str(supply.nominal_voltage_u ?? supply.nominal_voltage)}
              monospace
            />
            <LiveField
              fieldKey="supply.nominal_voltage_uo"
              label="Uo (V)"
              value={str(supply.nominal_voltage_uo)}
              monospace
            />
            <LiveField
              fieldKey="supply.nominal_frequency"
              label="Frequency (Hz)"
              value={str(supply.nominal_frequency ?? supply.supply_frequency)}
              monospace
            />
            <LiveField
              fieldKey="supply.live_conductors"
              label="Live conductors"
              value={str(supply.live_conductors)}
            />
            <LiveField
              fieldKey="supply.number_of_supplies"
              label="# Supplies"
              value={str(supply.number_of_supplies)}
            />
            <LiveField
              fieldKey="supply.zs_at_db"
              label="Zs @ DB (Ω)"
              value={str(supply.zs_at_db)}
              monospace
            />
            <LiveField
              fieldKey="supply.main_earth_conductor_csa"
              label="Main earth CSA"
              value={str(supply.main_earth_conductor_csa)}
              monospace
            />
            <LiveField
              fieldKey="supply.main_bonding_conductor_csa"
              label="Bonding CSA"
              value={str(supply.main_bonding_conductor_csa)}
              monospace
            />
            <LiveField
              fieldKey="supply.earth_electrode_resistance"
              label="Electrode (Ω)"
              value={str(supply.earth_electrode_resistance)}
              monospace
            />
          </div>
        </SectionCard>
      </div>

      {/* ── Board ──────────────────────────────────────────────────── */}
      <div data-section="board" className="cm-live-section">
        <SectionCard accent="blue" icon={CircuitBoard} title="Main board">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <LiveField
              fieldKey="board.manufacturer"
              label="Manufacturer"
              value={str(board.manufacturer)}
            />
            <LiveField
              fieldKey="board.main_switch_bs_en"
              label="Main switch BS EN"
              value={str(board.main_switch_bs_en)}
            />
            <LiveField
              fieldKey="board.main_switch_current"
              label="Rating (A)"
              value={str(board.main_switch_current)}
              monospace
            />
            <LiveField
              fieldKey="board.main_switch_poles"
              label="Poles"
              value={str(board.main_switch_poles)}
            />
            <LiveField
              fieldKey="board.main_switch_voltage"
              label="Voltage (V)"
              value={str(board.main_switch_voltage)}
              monospace
            />
            <LiveField
              fieldKey="board.rcd_operating_current"
              label="RCD IΔn (mA)"
              value={str(board.rcd_operating_current)}
              monospace
            />
            <LiveField fieldKey="board.spd_bs_en" label="SPD BS EN" value={str(board.spd_bs_en)} />
            <LiveField
              fieldKey="board.spd_type_supply"
              label="SPD type"
              value={str(board.spd_type_supply)}
            />
            <LiveField
              fieldKey="board.spd_rated_current"
              label="SPD rating (A)"
              value={str(board.spd_rated_current)}
              monospace
            />
          </div>
        </SectionCard>
      </div>

      {/* ── Circuits ───────────────────────────────────────────────── */}
      <div data-section="circuits" className="cm-live-section">
        <SectionCard accent="amber" icon={CircuitBoard} title={`Circuits (${circuits.length})`}>
          {circuits.length === 0 ? (
            <p className="text-[13px] italic text-[var(--color-text-tertiary)]">
              No circuits yet — start describing circuits (e.g. “Circuit 1, lighting, B6”) and
              they’ll populate here as Sonnet extracts them.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {circuits.map((c) => (
                <LiveCircuitRow key={c.id} circuit={c} />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── Observations (EICR only) ───────────────────────────────── */}
      {certificateType !== 'EIC' ? (
        <div data-section="observations" className="cm-live-section">
          <SectionCard
            accent="red"
            icon={AlertTriangle}
            title={`Observations (${observations.length})`}
          >
            {observations.length === 0 ? (
              <p className="text-[13px] italic text-[var(--color-text-tertiary)]">
                No observations yet. Defects you describe land here tagged C1/C2/C3/FI.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {observations.map((o) => (
                  <LiveObservationRow key={o.id} observation={o} />
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}

      {/* Visual tail so the last section can scroll fully into view. */}
      <div className="shrink-0" style={{ height: '40vh' }} aria-hidden />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function LiveCircuitRow({ circuit }: { circuit: CircuitRow }) {
  const id = circuit.id;
  const rowRecent = useIsFieldRecent(`circuit.${id}`);
  const ref = circuit.circuit_ref ?? circuit.number ?? '?';
  const designation = circuit.circuit_designation ?? circuit.description;
  const str = (v: unknown): string | undefined =>
    v === null || v === undefined ? undefined : String(v);

  return (
    <div
      id={`live-circuit-${id}`}
      className="cm-live-field rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2"
      data-recent={rowRecent ? 'true' : 'false'}
    >
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-mono text-[13px] font-bold text-[var(--color-brand-blue)]">
          C{String(ref)}
        </span>
        <span className="flex-1 truncate text-[13.5px] text-[var(--color-text-primary)]">
          {designation ? (
            String(designation)
          ) : (
            <em className="text-[var(--color-text-tertiary)]">Unnamed</em>
          )}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
        <LiveField
          fieldKey={`circuit.${id}.ocpd_rating_a`}
          label="OCPD (A)"
          value={str(circuit.ocpd_rating_a)}
          monospace
        />
        <LiveField
          fieldKey={`circuit.${id}.ocpd_type`}
          label="Type"
          value={str(circuit.ocpd_type)}
        />
        <LiveField fieldKey={`circuit.${id}.rcd_type`} label="RCD" value={str(circuit.rcd_type)} />
        <LiveField
          fieldKey={`circuit.${id}.measured_zs_ohm`}
          label="Zs (Ω)"
          value={str(circuit.measured_zs_ohm)}
          monospace
        />
        <LiveField
          fieldKey={`circuit.${id}.r1_r2_ohm`}
          label="R1+R2 (Ω)"
          value={str(circuit.r1_r2_ohm)}
          monospace
        />
        <LiveField
          fieldKey={`circuit.${id}.ir_live_earth_mohm`}
          label="IR L-E (MΩ)"
          value={str(circuit.ir_live_earth_mohm)}
          monospace
        />
        <LiveField
          fieldKey={`circuit.${id}.ir_live_live_mohm`}
          label="IR L-L (MΩ)"
          value={str(circuit.ir_live_live_mohm)}
          monospace
        />
        <LiveField
          fieldKey={`circuit.${id}.polarity_confirmed`}
          label="Polarity"
          value={str(circuit.polarity_confirmed)}
        />
      </div>
    </div>
  );
}

const CODE_COLOUR: Record<NonNullable<ObservationRow['code']>, string> = {
  C1: 'var(--color-status-failed)',
  C2: 'var(--color-status-processing)',
  C3: 'var(--color-brand-blue)',
  FI: 'var(--color-status-limitation)',
};

function LiveObservationRow({ observation }: { observation: ObservationRow }) {
  const colour = observation.code ? CODE_COLOUR[observation.code] : 'var(--color-text-tertiary)';
  const recent = useIsFieldRecent(`observation.${observation.id}`);
  return (
    <div
      id={`live-observation-${observation.id}`}
      data-recent={recent ? 'true' : 'false'}
      className="cm-live-field flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2"
    >
      <span
        className="mt-0.5 inline-flex h-6 min-w-[32px] shrink-0 items-center justify-center rounded-full px-2 font-mono text-[11px] font-bold uppercase text-white"
        style={{ background: colour }}
      >
        {observation.code ?? '–'}
      </span>
      <div className="flex-1">
        {observation.location ? (
          <p className="mb-0.5 flex items-center gap-1 text-[11px] uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
            <ClipboardList className="h-3 w-3" strokeWidth={2.25} aria-hidden />
            {observation.location}
          </p>
        ) : null}
        <p className="text-[13.5px] leading-snug text-[var(--color-text-primary)]">
          {observation.description ?? <em className="text-[var(--color-text-tertiary)]">…</em>}
        </p>
        {observation.remedial ? (
          <p className="mt-1 text-[12.5px] italic leading-snug text-[var(--color-text-secondary)]">
            Remedial: {observation.remedial}
          </p>
        ) : null}
      </div>
    </div>
  );
}
