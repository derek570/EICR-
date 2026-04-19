'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDownToLine,
  Building2,
  CheckCircle2,
  CircuitBoard,
  ClipboardList,
  FileText,
  Plug,
  ShieldCheck,
  User,
  Zap,
} from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import type { CircuitRow, ObservationRow } from '@/lib/types';

/**
 * Job overview tab — at-a-glance dashboard mirroring the iOS Overview
 * screen the inspector sees while recording. Shows hero boxes for
 * Client / Installation / Supply / Main Fuse / Earthing, then the
 * General Condition + Purpose of Report summary cards, then a compact
 * circuits table and an observations panel.
 *
 * Pre-deploy: this page used to be a tile grid linking to every other
 * tab. The inspector wanted the recording surface (page-stays-visible
 * with a red ring around it) to be useful at a glance — switching to
 * the dashboard layout means they can see hero values populate live as
 * Sonnet extracts them, without having to leave the Overview tab.
 *
 * Every field is read-only here; edits still happen on the dedicated
 * tab pages. Each hero box / section is a link to its tab so the
 * inspector can drill in with a single tap.
 */
export default function JobOverviewPage() {
  const { job, certificateType } = useJobContext();
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const base = `/job/${jobId}`;

  // Cast tab data bags to a permissive record so we can read whichever
  // keys Sonnet has populated without fighting the type system.
  const installation = (job.installation ?? {}) as Record<string, unknown>;
  const supply = (job.supply ?? {}) as Record<string, unknown>;
  const board = (job.board ?? {}) as Record<string, unknown>;
  const circuits: CircuitRow[] = job.circuits ?? [];
  const observations: ObservationRow[] = job.observations ?? [];

  const str = (v: unknown): string | null => {
    if (v === null || v === undefined || v === '') return null;
    return String(v);
  };

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-5 md:px-8 md:py-7"
      style={{ maxWidth: '1280px' }}
    >
      {/* ── Hero strip ─────────────────────────────────────────── */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <HeroBox
          icon={User}
          title="Client"
          href={`${base}/installation`}
          rows={[
            ['Name', str(installation.client_name)],
            ['Address', str(installation.client_address)],
            ['Town', str(installation.client_town)],
            ['Postcode', str(installation.client_postcode)],
          ]}
        />
        <HeroBox
          icon={Building2}
          title="Installation"
          href={`${base}/installation`}
          rows={[
            ['Occupier', str(installation.occupier_name)],
            ['Address', str(installation.address)],
            ['Town', str(installation.town)],
            ['Postcode', str(installation.postcode)],
          ]}
        />
        <HeroBox
          icon={Zap}
          title="Supply"
          href={`${base}/supply`}
          rows={[
            ['Earth', str(supply.earthing_arrangement)],
            ['Ze', str(supply.ze_ohm) ?? str(supply.ze)],
            ['Ze@DB', str(supply.ze_at_db_ohm) ?? str(supply.ze_at_db)],
            ['PFC', str(supply.pfc_ka) ?? str(supply.pfc)],
          ]}
        />
        <HeroBox
          icon={Plug}
          title="Main Fuse"
          href={`${base}/supply`}
          rows={[
            ['BS/EN', str(supply.main_fuse_bs_en) ?? str(board.main_switch_bs_en)],
            ['Current', str(supply.main_fuse_rating_a) ?? str(board.main_switch_rated_current_a)],
            ['CSA', str(supply.tails_csa_mm2) ?? str(supply.tails_csa)],
          ]}
        />
        <HeroBox
          icon={ArrowDownToLine}
          title="Earthing"
          href={`${base}/supply`}
          rows={[
            [
              'Main E',
              str(supply.earthing_conductor_csa_mm2) ?? str(supply.earthing_conductor_csa),
            ],
            ['Bond', str(supply.main_bonding_csa_mm2) ?? str(supply.main_bonding_csa)],
            ['Svcs', summariseBonding(supply)],
          ]}
        />
      </div>

      {/* ── General Condition + Purpose of Report ──────────────── */}
      <div className="grid gap-3 md:grid-cols-2">
        <SummaryCard
          icon={ShieldCheck}
          title="General Condition"
          href={`${base}/installation`}
          body={str(installation.general_condition_of_installation)}
          empty="Not yet recorded — dictate or open the Installation tab."
        />
        {certificateType === 'EICR' ? (
          <SummaryCard
            icon={FileText}
            title="Purpose of Report"
            href={`${base}/installation`}
            body={str(installation.reason_for_report)}
            empty="No purpose recorded yet."
          />
        ) : (
          <SummaryCard
            icon={ClipboardList}
            title="Extent"
            href={`${base}/extent`}
            body={str((job.extent ?? ({} as Record<string, unknown>)).extent)}
            empty="No extent recorded yet."
          />
        )}
      </div>

      {/* ── Circuits ───────────────────────────────────────────── */}
      <CircuitsPanel circuits={circuits} href={`${base}/circuits`} />

      {/* ── Observations (EICR only) ───────────────────────────── */}
      {certificateType === 'EICR' ? (
        <ObservationsPanel observations={observations} href={`${base}/observations`} />
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

type HeroRow = readonly [label: string, value: string | null];

/**
 * Hero box — small key/value list under an icon + title. Renders an
 * em-dash for empty values so the inspector sees the field exists and
 * is just unset, rather than the row collapsing and the hero size
 * jumping as fields populate.
 */
function HeroBox({
  icon: Icon,
  title,
  href,
  rows,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  title: string;
  href: string;
  rows: ReadonlyArray<HeroRow>;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3 transition hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-3)]"
    >
      <div className="flex items-center gap-2 text-[var(--color-brand-blue)]">
        <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
        <span className="text-[13px] font-semibold uppercase tracking-[0.06em]">{title}</span>
      </div>
      <dl className="flex flex-col gap-0.5 text-[12.5px] leading-snug">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-2">
            <dt className="shrink-0 text-[var(--color-text-tertiary)]">{label}:</dt>
            <dd
              className={
                value
                  ? 'min-w-0 flex-1 truncate text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-tertiary)]'
              }
            >
              {value ?? '—'}
            </dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}

/* ----------------------------------------------------------------------- */

function SummaryCard({
  icon: Icon,
  title,
  href,
  body,
  empty,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  title: string;
  href: string;
  body: string | null;
  empty: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3 transition hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-3)]"
    >
      <div className="flex items-center gap-2 text-[var(--color-brand-blue)]">
        <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
        <span className="text-[13px] font-semibold uppercase tracking-[0.06em]">{title}</span>
      </div>
      <p
        className={
          body
            ? 'text-[13.5px] leading-snug text-[var(--color-text-primary)]'
            : 'text-[13px] italic leading-snug text-[var(--color-text-tertiary)]'
        }
      >
        {body ?? empty}
      </p>
    </Link>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Compact circuits table — one row per circuit with the readings the
 * inspector most often glances at while recording (OCPD, RCD, Zs, R1+R2,
 * IR, polarity). On narrow viewports we drop columns from the right
 * rather than horizontally scrolling — Zs / R1+R2 / IR are always
 * available on desktop, and the user can tap into the Circuits tab to
 * see the full 29-column matrix.
 */
function CircuitsPanel({ circuits, href }: { circuits: CircuitRow[]; href: string }) {
  return (
    <section className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[var(--color-brand-blue)]">
          <CircuitBoard className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          <span className="text-[13px] font-semibold uppercase tracking-[0.06em]">
            Circuits ({circuits.length})
          </span>
        </div>
        <Link
          href={href}
          className="text-[12px] font-semibold text-[var(--color-brand-blue)] hover:underline"
        >
          Open tab →
        </Link>
      </header>
      {circuits.length === 0 ? (
        <p className="py-3 text-[13px] italic text-[var(--color-text-tertiary)]">
          No circuits yet — capture a CCU photo or dictate to populate the board.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] table-fixed text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
                <th className="w-10 py-1.5 pr-2 font-semibold">#</th>
                <th className="py-1.5 pr-2 font-semibold">Designation</th>
                <th className="w-16 py-1.5 pr-2 text-right font-semibold">OCPD</th>
                <th className="w-14 py-1.5 pr-2 font-semibold">Type</th>
                <th className="w-16 py-1.5 pr-2 font-semibold">RCD</th>
                <th className="w-16 py-1.5 pr-2 text-right font-semibold">Zs (Ω)</th>
                <th className="w-20 py-1.5 pr-2 text-right font-semibold">R1+R2</th>
                <th className="w-20 py-1.5 text-right font-semibold">IR (MΩ)</th>
              </tr>
            </thead>
            <tbody>
              {circuits.map((c) => (
                <CircuitTableRow key={c.id} circuit={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CircuitTableRow({ circuit }: { circuit: CircuitRow }) {
  const ref = circuit.circuit_ref ?? circuit.number ?? '?';
  const designation = (circuit.circuit_designation ?? circuit.description) as string | undefined;
  const cell = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  };
  return (
    <tr className="border-t border-[var(--color-border-subtle)]/60 text-[var(--color-text-primary)]">
      <td className="py-1.5 pr-2 font-mono text-[var(--color-brand-blue)]">{String(ref)}</td>
      <td className="truncate py-1.5 pr-2">
        {designation ?? <span className="italic text-[var(--color-text-tertiary)]">Unnamed</span>}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
        {cell(circuit.ocpd_rating_a)}
      </td>
      <td className="py-1.5 pr-2">{cell(circuit.ocpd_type)}</td>
      <td className="py-1.5 pr-2">{cell(circuit.rcd_type)}</td>
      <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
        {cell(circuit.measured_zs_ohm)}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{cell(circuit.r1_r2_ohm)}</td>
      <td className="py-1.5 text-right font-mono tabular-nums">
        {cell(circuit.ir_live_earth_mohm)}
      </td>
    </tr>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Observations panel — code chip + description per observation. Empty
 * state shows the green "no observations" tick that mirrors iOS.
 */
function ObservationsPanel({
  observations,
  href,
}: {
  observations: ObservationRow[];
  href: string;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[var(--color-brand-blue)]">
          <AlertTriangle className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          <span className="text-[13px] font-semibold uppercase tracking-[0.06em]">
            Observations ({observations.length})
          </span>
        </div>
        <Link
          href={href}
          className="text-[12px] font-semibold text-[var(--color-brand-blue)] hover:underline"
        >
          Open tab →
        </Link>
      </header>
      {observations.length === 0 ? (
        <p className="flex items-center gap-2 py-2 text-[13px] text-[var(--color-text-secondary)]">
          <CheckCircle2
            className="h-4 w-4 text-[var(--color-status-done)]"
            strokeWidth={2.25}
            aria-hidden
          />
          No observations
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {observations.map((o) => (
            <li
              key={o.id}
              className="flex items-start gap-2 text-[13px] text-[var(--color-text-primary)]"
            >
              <CodeChip code={o.code} />
              <span className="min-w-0 flex-1">
                {o.description?.trim() || (
                  <em className="text-[var(--color-text-tertiary)]">Unfilled observation</em>
                )}
                {o.location ? (
                  <span className="ml-2 text-[12px] text-[var(--color-text-tertiary)]">
                    @ {o.location}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * BS 7671 observation code chip. Colour-codes the four severities so an
 * inspector can scan severity at a glance — C1 (red, dangerous), C2
 * (orange, potentially dangerous), C3 (blue, improvement), FI (purple,
 * further investigation).
 */
function CodeChip({ code }: { code: ObservationRow['code'] }) {
  const colour =
    code === 'C1'
      ? 'var(--color-status-failed)'
      : code === 'C2'
        ? 'var(--color-status-processing)'
        : code === 'C3'
          ? 'var(--color-brand-blue)'
          : code === 'FI'
            ? 'var(--color-status-limitation)'
            : 'var(--color-text-tertiary)';
  return (
    <span
      className="mt-0.5 inline-flex h-5 w-7 shrink-0 items-center justify-center rounded text-[10.5px] font-bold tracking-[0.05em] text-white"
      style={{ background: colour }}
    >
      {code ?? '—'}
    </span>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Compact "Svcs" bonding summary — checks each known extraneous bond
 * type and joins the bonded ones. Falls back to em-dash if none of the
 * keys are populated. Mirrors the iOS hero-box behaviour: water/gas/oil/
 * structural steel/lightning all collapse into a single "Wtr·Gas·LP"-
 * style label.
 */
function summariseBonding(supply: Record<string, unknown>): string | null {
  const codes: Array<{ key: string; label: string }> = [
    { key: 'bonding_water', label: 'Wtr' },
    { key: 'bonding_gas', label: 'Gas' },
    { key: 'bonding_oil', label: 'Oil' },
    { key: 'bonding_structural', label: 'Stl' },
    { key: 'bonding_lightning', label: 'LP' },
  ];
  const bonded = codes.filter((c) => supply[c.key] === true || supply[c.key] === 'Yes');
  if (bonded.length === 0) return null;
  return bonded.map((c) => c.label).join(' · ');
}
