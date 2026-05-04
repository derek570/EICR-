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
  // Bucket keys match the backend wire shape (see src/routes/jobs.js:575-592);
  // pre-Wave-B the PWA read drifted aliases (`installation`, `supply`, `board`)
  // which zod stripped, so these hero boxes were rendering empty.
  const installation = (job.installation_details ?? {}) as Record<string, unknown>;
  const supply = (job.supply_characteristics ?? {}) as Record<string, unknown>;
  const board = (job.board_info ?? {}) as Record<string, unknown>;
  const circuits: CircuitRow[] = job.circuits ?? [];
  const observations: ObservationRow[] = job.observations ?? [];

  const str = (v: unknown): string | null => {
    if (v === null || v === undefined || v === '') return null;
    return String(v);
  };

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-5 landscape:gap-1.5 landscape:px-1.5 landscape:py-1.5 portrait:md:px-8 portrait:md:py-7"
      style={{ maxWidth: '1280px' }}
    >
      {/* ── Hero strip ───────────────────────────────────────────
          Landscape (incl. landscape phone): 5 boxes side-by-side,
          mirroring iOS LiveFillView landscape layout (5x HStack with
          .frame(maxWidth: .infinity)). Portrait phone keeps the
          1-col stack; portrait tablet keeps 2-col; desktop 5-col.

          NOTE: `md:grid-cols-2` is gated on `portrait:` so it does not
          override `landscape:grid-cols-5` on a landscape iPhone (>768px
          viewport). Without the `portrait:` prefix, both modifiers
          match at the same specificity and the later-generated `md:`
          rule wins, collapsing the hero strip back to 2 columns —
          which is what IMG_6311 was showing. */}
      <div className="grid gap-3 landscape:grid-cols-5 landscape:gap-1 portrait:md:grid-cols-2 xl:grid-cols-5">
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
      <div className="grid gap-3 landscape:grid-cols-2 landscape:gap-1 md:grid-cols-2">
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
            body={str((job.extent_and_type ?? ({} as Record<string, unknown>)).extent)}
            empty="No extent recorded yet."
          />
        )}
      </div>

      {/* ── Circuits ───────────────────────────────────────────── */}
      {/* Compact table: portrait phones / narrow tablets.
          Wide landscape-style table: desktop (≥lg) by default, AND phones
          held in landscape orientation. iOS users expect the full 29-
          column schedule at a glance when they rotate the device; the
          `@media (orientation: landscape)` escape hatch re-shows the wide
          panel below 1024px as long as width > height. */}
      <div className="lg:hidden landscape:hidden">
        <CircuitsPanel circuits={circuits} href={`${base}/circuits`} />
      </div>
      <div className="hidden lg:block landscape:block">
        <WideCircuitsPanel circuits={circuits} href={`${base}/circuits`} />
      </div>

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
      className="group flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3 transition landscape:gap-0.5 landscape:rounded-md landscape:px-1.5 landscape:py-1 hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-3)]"
    >
      <div className="flex items-center gap-2 text-[var(--color-brand-blue)] landscape:gap-1">
        <Icon className="h-4 w-4 landscape:h-2.5 landscape:w-2.5" strokeWidth={2.25} aria-hidden />
        <span className="text-[13px] font-semibold uppercase tracking-[0.06em] landscape:text-[8.5px] landscape:tracking-[0.03em]">
          {title}
        </span>
      </div>
      <dl className="flex flex-col gap-0.5 text-[12.5px] leading-snug landscape:gap-0 landscape:text-[9px] landscape:leading-[1.15]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-2 landscape:gap-1">
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
      className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3 transition landscape:gap-0.5 landscape:rounded-md landscape:px-1.5 landscape:py-1 hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-3)]"
    >
      <div className="flex items-center gap-2 text-[var(--color-brand-blue)] landscape:gap-1">
        <Icon className="h-4 w-4 landscape:h-2.5 landscape:w-2.5" strokeWidth={2.25} aria-hidden />
        <span className="text-[13px] font-semibold uppercase tracking-[0.06em] landscape:text-[8.5px] landscape:tracking-[0.03em]">
          {title}
        </span>
      </div>
      <p
        className={
          body
            ? 'text-[13.5px] leading-snug text-[var(--color-text-primary)] landscape:text-[9px] landscape:leading-[1.2]'
            : 'text-[13px] italic leading-snug text-[var(--color-text-tertiary)] landscape:text-[8.5px] landscape:leading-[1.2]'
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
      <header className="flex items-center justify-between landscape:gap-1">
        <div className="flex items-center gap-2 text-[var(--color-brand-blue)] landscape:gap-1">
          <CircuitBoard
            className="h-4 w-4 landscape:h-3 landscape:w-3"
            strokeWidth={2.25}
            aria-hidden
          />
          <span className="text-[13px] font-semibold uppercase tracking-[0.06em] landscape:text-[10px] landscape:tracking-[0.04em]">
            Circuits ({circuits.length})
          </span>
        </div>
        <Link
          href={href}
          className="text-[12px] font-semibold text-[var(--color-brand-blue)] landscape:text-[10px] hover:underline"
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
 * Wide circuits panel — mirrors the iOS landscape Overview schedule.
 *
 * Renders the full 29-column circuit matrix in a two-row header group
 * (Circuit / Cond / Dt / OCPD / RCD / Ring / Cont / IR / Test) with each
 * row a compact read-only cell. Used on desktop (≥lg) by default, and
 * on phones held in landscape orientation — both surfaces have enough
 * horizontal real-estate to show the full schedule without the per-
 * circuit drilldown that the compact panel forces on portrait.
 *
 * Data is sourced from the same `CircuitRow[]` as the compact panel;
 * cells fall back to an em-dash when empty so the grid doesn't reflow
 * as Sonnet/CCU fills values in. Tap anywhere jumps to the Circuits
 * tab for edits — this view is read-only.
 */
function WideCircuitsPanel({ circuits, href }: { circuits: CircuitRow[]; href: string }) {
  return (
    <section className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3 landscape:gap-0.5 landscape:rounded-md landscape:px-1.5 landscape:py-1">
      <header className="flex items-center justify-between landscape:gap-1">
        <div className="flex items-center gap-2 text-[var(--color-brand-blue)] landscape:gap-1">
          <CircuitBoard
            className="h-4 w-4 landscape:h-3 landscape:w-3"
            strokeWidth={2.25}
            aria-hidden
          />
          <span className="text-[13px] font-semibold uppercase tracking-[0.06em] landscape:text-[10px] landscape:tracking-[0.04em]">
            Circuits ({circuits.length})
          </span>
        </div>
        <Link
          href={href}
          className="text-[12px] font-semibold text-[var(--color-brand-blue)] landscape:text-[10px] hover:underline"
        >
          Open tab →
        </Link>
      </header>
      {circuits.length === 0 ? (
        <p className="py-3 text-[13px] italic text-[var(--color-text-tertiary)]">
          No circuits yet — capture a CCU photo or dictate to populate the board.
        </p>
      ) : (
        // Landscape (incl. landscape phone) drops the 1100px floor so the
        // full 29-col schedule shrinks to fit the viewport (iOS parity:
        // LiveCircuitGrid renders without horizontal scroll on phone
        // landscape). Desktop keeps the comfortable 1100px min-width via
        // the lg: breakpoint so wide displays don't scrunch unnecessarily.
        //
        // Font drop: 7px in landscape is the smallest readable size at
        // iPhone Pro Max retina (3x). 29 cols × ~24px each = ~696px which
        // fits inside the ~720px usable width after AppShell px-1.5
        // padding. Cells use `landscape:p-0` to remove all padding so
        // each column is purely content-width.
        <div className="overflow-x-auto landscape:overflow-x-visible">
          <table className="w-full min-w-[1100px] border-collapse text-[11.5px] landscape:min-w-0 landscape:table-auto landscape:text-[7px]">
            <thead>
              {/* Group header — mirrors iOS (Circuit / Cond / Dt / OCPD / RCD / Ring / Cont / IR / Test) */}
              <tr className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-brand-blue)] landscape:text-[6.5px] landscape:tracking-[0.02em]">
                <th
                  colSpan={2}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  Circuit
                </th>
                <th
                  colSpan={3}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  Cond
                </th>
                <th
                  colSpan={2}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  Dt
                </th>
                <th
                  colSpan={5}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  OCPD
                </th>
                <th
                  colSpan={4}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  RCD
                </th>
                <th
                  colSpan={3}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  Ring
                </th>
                <th
                  colSpan={2}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  Cont
                </th>
                <th
                  colSpan={3}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  IR
                </th>
                <th
                  colSpan={4}
                  className="py-1 text-left font-semibold landscape:py-0 landscape:text-center"
                >
                  Test
                </th>
              </tr>
              <tr className="border-b border-[var(--color-border-subtle)] text-left text-[10px] uppercase tracking-[0.05em] text-[var(--color-text-tertiary)] landscape:text-[6.5px] landscape:tracking-[0.01em]">
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  #
                </th>
                <th className="py-1 pr-2 font-semibold landscape:px-0 landscape:py-0 landscape:text-left">
                  Desig
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  WT
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  RM
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  Pts
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  L
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  C
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  BS
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  Ty
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  A
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  kA
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  Zs
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  Ty
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  mA
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  ms
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  ΔT
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  r1
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  rn
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  r2
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  R1+R2
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  R2
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  V
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  L-L
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  L-E
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  P
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  Zs
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  ms
                </th>
                <th className="py-1 pr-1 font-semibold landscape:px-0 landscape:py-0 landscape:text-center">
                  Rc
                </th>
                <th className="py-1 font-semibold">Af</th>
              </tr>
            </thead>
            <tbody>
              {circuits.map((c) => (
                <WideCircuitRow key={c.id} circuit={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WideCircuitRow({ circuit }: { circuit: CircuitRow }) {
  const ref = circuit.circuit_ref ?? circuit.number ?? '?';
  const designation = (circuit.circuit_designation ?? circuit.description) as string | undefined;
  const v = (key: string): string => {
    const x = (circuit as Record<string, unknown>)[key];
    if (x === null || x === undefined || x === '') return '—';
    return String(x);
  };
  const num = (key: string) => (
    <td className="py-1 pr-1 text-right font-mono tabular-nums landscape:overflow-hidden landscape:px-0 landscape:py-0 landscape:text-center">
      {v(key)}
    </td>
  );
  const txt = (key: string) => (
    <td className="py-1 pr-1 landscape:overflow-hidden landscape:px-0 landscape:py-0 landscape:text-center">
      {v(key)}
    </td>
  );
  return (
    <tr className="border-t border-[var(--color-border-subtle)]/60 text-[var(--color-text-primary)]">
      <td className="py-1 pr-1 font-mono text-[var(--color-brand-blue)] landscape:px-0 landscape:py-0 landscape:text-center">
        {String(ref)}
      </td>
      <td
        className="max-w-[160px] truncate py-1 pr-2 landscape:max-w-none landscape:px-0 landscape:py-0"
        title={designation ?? ''}
      >
        {designation ?? <span className="italic text-[var(--color-text-tertiary)]">Unnamed</span>}
      </td>
      {/* Cond */}
      {txt('wiring_type')}
      {txt('ref_method')}
      {num('number_of_points')}
      {/* Dt — cable CSAs */}
      {num('live_csa_mm2')}
      {num('cpc_csa_mm2')}
      {/* OCPD */}
      {txt('ocpd_bs_en')}
      {txt('ocpd_type')}
      {num('ocpd_rating_a')}
      {num('ocpd_short_circuit_ka')}
      {num('ocpd_max_zs_ohm')}
      {/* RCD */}
      {txt('rcd_type')}
      {num('rcd_rating_a')}
      {num('rcd_trip_time_ms')}
      {num('rcd_trip_current_ma')}
      {/* Ring */}
      {num('ring_r1_ohm')}
      {num('ring_rn_ohm')}
      {num('ring_r2_ohm')}
      {/* Cont */}
      {num('r1_r2_ohm')}
      {num('r2_ohm')}
      {/* IR */}
      {num('ir_test_voltage_v')}
      {num('ir_live_live_mohm')}
      {num('ir_live_earth_mohm')}
      {/* Test */}
      {txt('polarity_confirmed')}
      {num('measured_zs_ohm')}
      {num('rcd_measured_trip_time_ms')}
      {txt('rcd_button_confirmed')}
      {txt('afdd_button_confirmed')}
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
