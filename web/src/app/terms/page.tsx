'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AppWindow,
  CheckCircle2,
  ChevronRight,
  FileText,
  Lock,
  ShieldCheck,
  Square,
  CheckSquare,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { sanitiseRedirect } from '@/lib/auth-redirect';
import { cn } from '@/lib/utils';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from './legal-texts';
import { recordTermsAcceptance } from './legal-texts-gate';

/**
 * Terms & Conditions acceptance gate — port of iOS
 * `TermsAcceptanceView.swift`.
 *
 * Inspectors must accept three legal documents (T&Cs, Privacy Policy,
 * EULA) and confirm three professional declarations (qualified, insured,
 * AI-disclaimer aware) before the rest of the app is unlocked.
 *
 * Storage parity: the same three localStorage keys iOS writes to
 * `UserDefaults` so an inspector who already accepted on iPhone is not
 * re-prompted on web (and vice versa, once a future sync moves these to
 * the server). Keys: `termsAccepted=true`, `termsAcceptedVersion="1.0"`,
 * `termsAcceptedDate=<ISO8601>`.
 *
 * Deliberate divergence from iOS:
 *   - **No signature capture** in v1. iOS captures a finger-drawn
 *     signature into `UserDefaults["termsAcceptanceSignature"]` for an
 *     audit trail. On web, the inspector's signature already lives on
 *     their `InspectorProfile` (signed once during staff setup), and a
 *     dedicated signature pad is its own dependency choice. Tracked in
 *     `web/audit/INDEX.md` as a known-divergence item; if legal review
 *     requires the audit trail, port `SignatureCaptureView` and add it
 *     here under a fourth confirmation step.
 *   - **Read-detection via modal-open** rather than iOS's scroll-to-80%
 *     heuristic. The modal opens once per doc and the row marks itself
 *     read when closed. Stricter scroll detection adds little legal
 *     value on web (a user can right-click → open in tab and scroll
 *     anywhere) and is brittle in jsdom for tests.
 *
 * `TERMS_VERSION` and the localStorage keys live in
 * `legal-texts-gate.ts` (kept dependency-free so the AppShell gate can
 * import them without pulling in the page UI's lucide / radix deps).
 * Bump `TERMS_VERSION` there whenever `legal-texts.ts` is materially
 * updated to force re-acceptance.
 */

const CONFIRMATION_TEXTS = [
  {
    id: 'qualified' as const,
    icon: UserCheck,
    text: 'I am a qualified and competent person within the meaning of the Electricity at Work Regulations 1989 and hold the appropriate professional qualifications for electrical inspection, testing, and certification.',
  },
  {
    id: 'insured' as const,
    icon: ShieldCheck,
    text: 'I hold valid and adequate professional liability insurance (professional indemnity insurance) that covers my electrical certification activities.',
  },
  {
    id: 'aiDisclaimer' as const,
    icon: Sparkles,
    text: 'I understand that CertMate uses AI to assist with data capture and extraction, and that all AI-generated content must be thoroughly verified by me before inclusion in any certificate. I accept full and sole responsibility for the accuracy of all certificates I issue.',
  },
] as const;

const DOCUMENT_ICONS: Record<LegalDocumentId, React.ComponentType<{ className?: string }>> = {
  termsAndConditions: FileText,
  privacyPolicy: Lock,
  eula: AppWindow,
};

export default function TermsPage() {
  const router = useRouter();
  const search = useSearchParams();
  // Sanitise the `next` query param — without this, a crafted
  // `/terms?next=https://evil.example` or `/terms?next=//evil.example`
  // would bounce an authenticated user off-site the moment they
  // accept. Same class of open-redirect we already fixed on /login;
  // reuse the shared sanitiser so both gates have one source of truth.
  // (Codex review finding on `06caaf9`.)
  const next = sanitiseRedirect(search.get('next'));

  const [readDocs, setReadDocs] = React.useState<Record<LegalDocumentId, boolean>>({
    termsAndConditions: false,
    privacyPolicy: false,
    eula: false,
  });
  const [confirmations, setConfirmations] = React.useState({
    qualified: false,
    insured: false,
    aiDisclaimer: false,
  });
  const [openDoc, setOpenDoc] = React.useState<LegalDocumentId | null>(null);
  const [isAccepting, setIsAccepting] = React.useState(false);

  const allRead = readDocs.termsAndConditions && readDocs.privacyPolicy && readDocs.eula;
  const allConfirmed =
    confirmations.qualified && confirmations.insured && confirmations.aiDisclaimer;
  const canAccept = allRead && allConfirmed && !isAccepting;

  const completion =
    [
      readDocs.termsAndConditions,
      readDocs.privacyPolicy,
      readDocs.eula,
      confirmations.qualified,
      confirmations.insured,
      confirmations.aiDisclaimer,
    ].filter(Boolean).length / 6;

  function markRead(id: LegalDocumentId) {
    setReadDocs((prev) => ({ ...prev, [id]: true }));
  }

  function toggle(key: keyof typeof confirmations) {
    setConfirmations((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function accept() {
    if (!canAccept) return;
    setIsAccepting(true);
    recordTermsAcceptance();
    router.replace(next);
  }

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '768px' }}
    >
      <HeroHeader
        eyebrow="Before you begin"
        title="Review & Accept Our Terms"
        subtitle="Please review and accept our Terms & Conditions, Privacy Policy, and End User Licence Agreement to continue."
        accent="client"
        icon={<FileText className="h-10 w-10" aria-hidden />}
      />

      <ProgressBar value={completion} />

      <SectionCard accent="blue" icon={FileText} title="Legal Documents">
        {LEGAL_DOCUMENTS.map((doc) => {
          const isRead = readDocs[doc.id];
          const Icon = DOCUMENT_ICONS[doc.id];
          return (
            <button
              key={doc.id}
              type="button"
              onClick={() => setOpenDoc(doc.id)}
              aria-label={`Read ${doc.title}`}
              data-doc-id={doc.id}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition',
                isRead
                  ? 'border-[var(--color-brand-green)]/40 bg-[var(--color-brand-green)]/[0.06]'
                  : 'border-transparent bg-[var(--color-surface-2)] hover:border-[var(--color-border-default)]'
              )}
            >
              <span
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)]',
                  isRead
                    ? 'bg-[var(--color-brand-green)]/15 text-[var(--color-brand-green)]'
                    : 'bg-[var(--color-brand-blue)]/15 text-[var(--color-brand-blue)]'
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-medium text-[var(--color-text-primary)]">
                  {doc.title}
                </span>
              </span>
              {isRead ? (
                <CheckCircle2
                  className="h-5 w-5 shrink-0"
                  style={{ color: 'var(--color-brand-green)' }}
                  aria-hidden
                />
              ) : (
                <span className="rounded-full bg-[var(--color-brand-blue)]/15 px-3 py-1 text-[11.5px] font-semibold text-[var(--color-brand-blue)]">
                  Read
                </span>
              )}
              <ChevronRight
                className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]"
                aria-hidden
              />
            </button>
          );
        })}
      </SectionCard>

      <SectionCard accent="green" icon={UserCheck} title="Professional Confirmations">
        {CONFIRMATION_TEXTS.map((conf) => {
          const Icon = conf.icon;
          const checked = confirmations[conf.id];
          return (
            <button
              key={conf.id}
              type="button"
              onClick={() => toggle(conf.id)}
              aria-pressed={checked}
              className={cn(
                'flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition',
                checked
                  ? 'border-[var(--color-brand-green)]/40 bg-[var(--color-brand-green)]/[0.06]'
                  : 'border-transparent bg-[var(--color-surface-2)] hover:border-[var(--color-border-default)]'
              )}
            >
              <span className="mt-0.5 shrink-0">
                {checked ? (
                  <CheckSquare
                    className="h-5 w-5"
                    style={{ color: 'var(--color-brand-green)' }}
                    aria-hidden
                  />
                ) : (
                  <Square
                    className="h-5 w-5"
                    style={{ color: 'var(--color-text-secondary)' }}
                    aria-hidden
                  />
                )}
              </span>
              <Icon
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-secondary)]"
                aria-hidden
              />
              <p className="text-[12.5px] leading-snug text-[var(--color-text-primary)]">
                {conf.text}
              </p>
            </button>
          );
        })}
      </SectionCard>

      <Button
        type="button"
        variant="primary"
        size="lg"
        disabled={!canAccept}
        onClick={accept}
        aria-label="Accept terms and conditions"
        className="w-full"
      >
        {isAccepting ? 'Accepting…' : 'I Accept'}
      </Button>

      <Dialog
        open={openDoc !== null}
        onOpenChange={(open) => {
          if (!open && openDoc) {
            // Close → mark the doc as read. Mirrors iOS's
            // "scroll-to-bottom triggers read" but is web-idiomatic:
            // viewing the modal at all counts as reading it. The
            // confirmation toggles below carry the substantive
            // attestation.
            markRead(openDoc);
          }
          setOpenDoc(null);
        }}
      >
        <DialogContent
          className="fixed left-1/2 top-1/2 z-50 mx-4 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-0 shadow-lg"
          showCloseButton={false}
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-4">
            <DialogTitle>
              {openDoc ? LEGAL_DOCUMENTS.find((d) => d.id === openDoc)?.title : ''}
            </DialogTitle>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" aria-label="Close legal document">
                Done
              </Button>
            </DialogClose>
          </div>
          <div className="flex-1 overflow-y-auto whitespace-pre-wrap px-5 py-4 text-[13px] leading-relaxed text-[var(--color-text-primary)]">
            {openDoc ? LEGAL_DOCUMENTS.find((d) => d.id === openDoc)?.content : ''}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const isDone = value >= 1;
  return (
    <div className="flex flex-col gap-2 px-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
          Completion
        </span>
        <span
          className={cn(
            'text-[12.5px] font-semibold',
            isDone ? 'text-[var(--color-brand-green)]' : 'text-[var(--color-brand-blue)]'
          )}
        >
          {pct}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            isDone ? 'bg-[var(--color-brand-green)]' : 'bg-[var(--color-brand-blue)]'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
