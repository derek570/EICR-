'use client';

import * as React from 'react';
import { notFound } from 'next/navigation';
import { Building2, AlertTriangle, Zap } from 'lucide-react';

import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { SkeletonRow } from '@/components/ui/skeleton-row';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TallyBadge } from '@/components/ui/tally-badge';
import { Button } from '@/components/ui/button';
import { SECTION_ACCENTS, type SectionAccent } from '@/lib/constants/section-accents';

const CATEGORY_ACCENTS: SectionAccent[] = [
  'client',
  'electrical',
  'board',
  'test-results',
  'schedule',
  'notes',
  'protection',
];

function Snippet({ code }: { code: string }) {
  return (
    <pre className="mt-3 max-h-64 overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3 font-mono text-[12px] leading-[1.45] text-[var(--color-text-secondary)]">
      <code>{code}</code>
    </pre>
  );
}

function ExampleBlock({
  title,
  description,
  children,
  code,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  code: string;
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-5">
      <header className="mb-3">
        <h3 className="text-[16px] font-bold text-[var(--color-text-primary)]">{title}</h3>
        <p className="mt-1 text-[13px] text-[var(--color-text-secondary)]">{description}</p>
      </header>
      <div className="flex flex-col gap-4">{children}</div>
      <Snippet code={code} />
    </section>
  );
}

export default function PrimitivesReferencePage() {
  if (process.env.NODE_ENV === 'production') notFound();

  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [destructiveOpen, setDestructiveOpen] = React.useState(false);

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-4 py-8 md:px-8">
      <header>
        <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
          Dev-only — _reference
        </p>
        <h1 className="mt-1 text-[28px] font-bold text-[var(--color-text-primary)]">
          Design primitives
        </h1>
        <p className="mt-1 text-[14px] text-[var(--color-text-secondary)]">
          Phase 1 shared components consumed by parity phases 2-9. This page renders every primitive
          with copy-pasteable invocations.
        </p>
      </header>

      <ExampleBlock
        title="HeroHeader"
        description="Gradient + breathing glow banner. Port of iOS heroHeader pattern."
        code={`<HeroHeader
  eyebrow="EICR"
  title="Installation Details"
  subtitle="Client, premises & dates"
  icon={<Building2 className="h-10 w-10" strokeWidth={2} aria-hidden />}
  accent="client"
/>`}
      >
        <HeroHeader
          eyebrow="EICR"
          title="Installation Details"
          subtitle="Client, premises & dates"
          icon={<Building2 className="h-10 w-10" strokeWidth={2} aria-hidden />}
          accent="client"
        />
        <HeroHeader
          eyebrow="EICR"
          title="Test Results"
          subtitle="Zs, R1+R2, insulation resistance"
          icon={<Zap className="h-10 w-10" strokeWidth={2} aria-hidden />}
          accent="test-results"
          action={
            <Button variant="secondary" size="sm">
              Export
            </Button>
          }
        />
      </ExampleBlock>

      <ExampleBlock
        title="SECTION_ACCENTS"
        description="iOS-parity category token map. Used by SectionCard, HeroHeader, and any status-conduit surface."
        code={`import { SECTION_ACCENTS } from '@/lib/constants/section-accents';

SECTION_ACCENTS['client'];
// { text: '#2979FF', bg: 'color-mix(…)', border: 'color-mix(…)', stripe: '#2979FF' }`}
      >
        <div className="grid gap-2 md:grid-cols-2">
          {CATEGORY_ACCENTS.map((key) => {
            const tokens = SECTION_ACCENTS[key];
            return (
              <div
                key={key}
                className="flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2"
                style={{ borderColor: tokens.border, background: tokens.bg }}
              >
                <span
                  aria-hidden
                  className="h-6 w-1.5 rounded-full"
                  style={{ background: tokens.stripe }}
                />
                <span className="flex-1 text-[13px] font-semibold" style={{ color: tokens.text }}>
                  {key}
                </span>
                <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">
                  {tokens.stripe}
                </span>
              </div>
            );
          })}
        </div>
      </ExampleBlock>

      <ExampleBlock
        title="SectionCard (existing + category accents)"
        description="Existing 5 colour accents render byte-identical; the new iOS category accents add a subtle tinted background + border."
        code={`<SectionCard accent="blue" icon={Building2} title="Client details">…</SectionCard>
<SectionCard accent="client" icon={Building2} title="Client details">…</SectionCard>
<SectionCard accent="test-results" icon={AlertTriangle} title="Test Results">…</SectionCard>`}
      >
        <SectionCard accent="blue" icon={Building2} title="Legacy colour accent — blue">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            Default — unchanged by Phase 1. Matches the surface + border every existing callsite has
            been using.
          </p>
        </SectionCard>
        <SectionCard accent="client" icon={Building2} title="Category accent — client">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            Phase 1 — adds a 6% tint + accent-tinted border. Matches `CMSectionCard(category:
            .client)` on iOS.
          </p>
        </SectionCard>
        <SectionCard
          accent="test-results"
          icon={AlertTriangle}
          title="Category accent — test-results"
          subtitle="For result sections"
        >
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            Red stripe + rose background + rose-tinted border.
          </p>
        </SectionCard>
      </ExampleBlock>

      <ExampleBlock
        title="SkeletonRow"
        description="Shimmer placeholder for loading rows. Respects prefers-reduced-motion via the global guard."
        code={`<SkeletonRow lines={3} />`}
      >
        <SkeletonRow />
        <SkeletonRow lines={3} />
        <SkeletonRow lines={5} className="max-w-md" />
      </ExampleBlock>

      <ExampleBlock
        title="ConfirmDialog"
        description="Radix Dialog wrapper for binary confirmations. Built-in busy state prevents double-fire on async confirms."
        code={`<ConfirmDialog
  open={open}
  onOpenChange={setOpen}
  title="Delete job?"
  description="This will remove all linked circuits and observations."
  destructive
  confirmLabel="Delete"
  onConfirm={async () => { await api.deleteJob(id); }}
/>`}
      >
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setConfirmOpen(true)}>Open confirm</Button>
          <Button variant="destructive" onClick={() => setDestructiveOpen(true)}>
            Open destructive confirm
          </Button>
        </div>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Save changes?"
          description="The inspector profile will be updated."
          confirmLabel="Save"
          onConfirm={async () => {
            await new Promise((r) => setTimeout(r, 600));
            setConfirmOpen(false);
          }}
        />
        <ConfirmDialog
          open={destructiveOpen}
          onOpenChange={setDestructiveOpen}
          title="Delete job?"
          description="This will remove all linked circuits and observations. This cannot be undone."
          destructive
          confirmLabel="Delete"
          confirmLabelBusy="Deleting…"
          onConfirm={async () => {
            await new Promise((r) => setTimeout(r, 600));
            setDestructiveOpen(false);
          }}
        />
      </ExampleBlock>

      <ExampleBlock
        title="TallyBadge"
        description="Count-plus-label pill. Consumed by Observations C1/C2/C3/FI totals and the Phase 3 Alerts bell."
        code={`<TallyBadge count={2} label="C1" variant="destructive" />
<TallyBadge count={5} label="C2" variant="warn" />
<TallyBadge count={12} variant="info" />`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <TallyBadge count={2} label="C1" variant="destructive" />
          <TallyBadge count={5} label="C2" variant="warn" />
          <TallyBadge count={8} label="C3" variant="info" />
          <TallyBadge count={1} label="FI" variant="muted" />
          <TallyBadge count={42} label="Pass" variant="success" />
          <TallyBadge count={12} variant="info" />
        </div>
      </ExampleBlock>
    </div>
  );
}
