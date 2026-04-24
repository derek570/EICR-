'use client';

import * as React from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, CircleCheck, CirclePlus, Loader2 } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { applyCcuAnalysisToJob } from '@/lib/recording/apply-ccu-analysis';
import {
  clearMatchHandoff,
  readMatchHandoff,
  type CcuMatchHandoff,
} from '@/lib/recording/ccu-match-handoff';
import type { CCUAnalysisCircuit, CircuitRow } from '@/lib/types';
import type { CircuitMatch } from '@certmate/shared-utils';

/**
 * Hardware Update — Match Review screen.
 *
 * Mirrors iOS `Views/CCUExtraction/CircuitMatchReviewView.swift`. When
 * the inspector chose `Update Hardware (Keep Readings)` on the CCU mode
 * sheet, we:
 *   1. Run `/api/analyze-ccu` against their photo.
 *   2. Feed the resulting circuits into `matchCircuits()` to pair new
 *      circuits with existing ones by fuzzy label.
 *   3. Stash the match result in sessionStorage and navigate here.
 *
 * This page renders each proposed match as a card with:
 *   - the new circuit's label + OCPD summary on the left,
 *   - the paired existing circuit (if any) on the right,
 *   - a confidence badge + match reason,
 *   - a "Reassign" dropdown so the inspector can override the match
 *     (or flag it as a brand-new circuit).
 *
 * "Apply" feeds the user-approved matches into
 * `applyCcuAnalysisToJob(job, analysis, { mode: 'hardware_update', ... })`
 * and navigates back to the Circuits tab. "Cancel" discards the
 * handoff without mutating the job.
 *
 * iOS UX simplifications taken deliberately:
 *   - One persistent Reassign control per row (combobox) rather than
 *     iOS's sheet-per-row reassignment — web has room, a modal-per-
 *     row feels heavy.
 *   - "Accept All High-Confidence" button kept (iOS doesn't have
 *     this, but web inspectors often review many circuits at once,
 *     and a one-tap "I trust the auto-matches above 0.8" shortcut
 *     saves clicks).
 */

type MatchState = CircuitMatch<CCUAnalysisCircuit, CircuitRow>[];

export default function MatchReviewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const searchParams = useSearchParams();
  const nonce = searchParams?.get('nonce') ?? '';

  const { job, updateJob } = useJobContext();

  const [handoff, setHandoff] = React.useState<CcuMatchHandoff | null>(null);
  const [matches, setMatches] = React.useState<MatchState>([]);
  const [applying, setApplying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Resolve the handoff on mount — read sessionStorage, or bounce back
  // to Circuits if the nonce is stale / missing.
  React.useEffect(() => {
    if (!nonce) {
      router.replace(`/job/${jobId}/circuits`);
      return;
    }
    const loaded = readMatchHandoff(jobId, nonce);
    if (!loaded) {
      router.replace(`/job/${jobId}/circuits`);
      return;
    }
    setHandoff(loaded);
    setMatches(loaded.matches);
  }, [jobId, nonce, router]);

  const reassign = React.useCallback(
    (index: number, oldCircuitId: string | null) => {
      if (!handoff) return;
      const nextMatches = [...matches];
      const match = nextMatches[index];
      if (!match) return;

      const newCircuit = match.newCircuit;

      if (oldCircuitId === null) {
        nextMatches[index] = {
          newCircuit,
          matchedOldCircuit: null,
          confidence: 0,
          matchReason: 'manually unassigned',
        };
      } else {
        const target = handoff.existingBoardCircuits.find((c) => c.id === oldCircuitId);
        if (!target) return;
        // If another match was holding this existing circuit, release
        // it so each existing row can only be claimed once — same
        // one-to-one invariant iOS `reassignMatch` enforces.
        for (let i = 0; i < nextMatches.length; i++) {
          if (i !== index && nextMatches[i].matchedOldCircuit?.id === oldCircuitId) {
            nextMatches[i] = {
              newCircuit: nextMatches[i].newCircuit,
              matchedOldCircuit: null,
              confidence: 0,
              matchReason: 'manually unassigned',
            };
          }
        }
        nextMatches[index] = {
          newCircuit,
          matchedOldCircuit: target,
          confidence: 1,
          matchReason: 'manual assignment',
        };
      }

      setMatches(nextMatches);
    },
    [handoff, matches]
  );

  const acceptHighConfidence = () => {
    // No-op for matches already accepted — this button exists to
    // short-circuit the user's need to inspect every row. We treat
    // any confidence >= 0.8 as "leave as-is" (already accepted) and
    // clear any below-0.8 match the inspector hasn't touched. iOS
    // review screen doesn't have this shortcut; it's a web-only
    // convenience confirmed in the scope brief.
    setMatches((prev) =>
      prev.map((m) => {
        if (m.confidence >= 0.8) return m;
        if (m.matchedOldCircuit === null) return m; // already "new" — leave alone
        return {
          newCircuit: m.newCircuit,
          matchedOldCircuit: null,
          confidence: 0,
          matchReason: 'auto-cleared (below 80%)',
        };
      })
    );
  };

  const apply = async () => {
    if (!handoff) return;
    setApplying(true);
    setError(null);
    try {
      const { patch } = applyCcuAnalysisToJob(job, handoff.analysis, {
        mode: 'hardware_update',
        targetBoardId: handoff.boardId,
        userApprovedMatches: matches,
      });
      updateJob(patch);
      clearMatchHandoff(jobId, nonce);
      router.replace(`/job/${jobId}/circuits`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed.');
      setApplying(false);
    }
  };

  const cancel = () => {
    clearMatchHandoff(jobId, nonce);
    router.replace(`/job/${jobId}/circuits`);
  };

  if (!handoff) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-4 py-10">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--color-text-tertiary)]" aria-hidden />
        <p className="text-[13px] text-[var(--color-text-secondary)]">Loading review…</p>
      </div>
    );
  }

  const matchedCount = matches.filter((m) => m.matchedOldCircuit !== null).length;
  const newCount = matches.length - matchedCount;

  return (
    <div
      className="mx-auto flex w-full flex-col gap-4 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={cancel}
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Back to Circuits
          </button>
          <h1 className="text-[22px] font-bold text-[var(--color-text-primary)]">Review Matches</h1>
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            Hardware from the new board photo will be applied to matched circuits. Existing test
            readings on matched circuits are preserved.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[12px]">
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-brand-green)]/15 px-2 py-0.5 font-semibold text-[var(--color-brand-green)]">
            <CircleCheck className="h-3 w-3" aria-hidden />
            {matchedCount} matched
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-brand-blue)]/15 px-2 py-0.5 font-semibold text-[var(--color-brand-blue)]">
            <CirclePlus className="h-3 w-3" aria-hidden />
            {newCount} new
          </span>
        </div>
      </header>

      {error ? (
        <p
          className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-[12px] text-[var(--color-status-failed)]"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={acceptHighConfidence}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-brand-blue)] hover:underline"
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          Accept matches above 80% only
        </button>
        <span className="text-[11px] text-[var(--color-text-tertiary)]">
          {matches.length} proposed match{matches.length === 1 ? '' : 'es'}
        </span>
      </div>

      <ol className="flex flex-col gap-3" aria-label="Proposed circuit matches">
        {matches.map((m, idx) => (
          <MatchRow
            key={`${m.newCircuit.circuit_number}-${idx}`}
            index={idx}
            match={m}
            allExisting={handoff.existingBoardCircuits}
            onReassign={reassign}
          />
        ))}
      </ol>

      <footer className="sticky bottom-0 -mx-4 mt-4 flex items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)] px-4 py-3 md:-mx-8 md:px-8">
        <Button variant="ghost" onClick={cancel} disabled={applying}>
          Cancel
        </Button>
        <Button onClick={apply} disabled={applying}>
          {applying ? (
            <>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              Applying…
            </>
          ) : (
            <>
              Apply
              <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
            </>
          )}
        </Button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Match row — two-column card with reassign dropdown
// ---------------------------------------------------------------------------

function MatchRow({
  index,
  match,
  allExisting,
  onReassign,
}: {
  index: number;
  match: CircuitMatch<CCUAnalysisCircuit, CircuitRow>;
  allExisting: CircuitRow[];
  onReassign: (index: number, oldCircuitId: string | null) => void;
}) {
  const newCircuit = match.newCircuit;
  const old = match.matchedOldCircuit;
  const isNew = !old;
  const confidencePct = Math.round(match.confidence * 100);
  const badgeTone =
    match.confidence >= 0.8 ? 'good' : match.confidence >= 0.5 ? 'warn' : isNew ? 'info' : 'danger';

  return (
    <li>
      <SectionCard
        accent={isNew ? 'blue' : match.confidence >= 0.8 ? 'green' : 'amber'}
        title={`Circuit #${newCircuit.circuit_number}`}
      >
        <div className="mb-2 flex items-center">
          <ConfidenceBadge tone={badgeTone} pct={confidencePct} isNew={isNew} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              From photo
            </span>
            <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              {newCircuit.label?.trim() || 'Unnamed'}
            </span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {newCircuit.ocpd_type && newCircuit.ocpd_rating_a
                ? `${newCircuit.ocpd_type} · ${newCircuit.ocpd_rating_a}A`
                : 'No OCPD data'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              {isNew ? 'No existing match' : 'Paired with existing'}
            </span>
            <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
              {old
                ? (old.circuit_designation as string | undefined)?.trim() || 'Untitled'
                : 'Will be added as new'}
            </span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {old
                ? `Ref ${(old.circuit_ref as string | undefined) ?? ''}`
                : 'No readings to preserve'}
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--color-text-tertiary)]">{match.matchReason}</span>
          <ReassignMenu
            index={index}
            currentId={old?.id ?? null}
            allExisting={allExisting}
            onReassign={onReassign}
          />
        </div>
      </SectionCard>
    </li>
  );
}

function ConfidenceBadge({
  tone,
  pct,
  isNew,
}: {
  tone: 'good' | 'warn' | 'danger' | 'info';
  pct: number;
  isNew: boolean;
}) {
  if (isNew) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-brand-blue)]/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--color-brand-blue)]">
        New
      </span>
    );
  }
  const bg =
    tone === 'good'
      ? 'var(--color-brand-green)'
      : tone === 'warn'
        ? 'var(--color-status-processing, #ff9f0a)'
        : 'var(--color-status-failed)';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
      style={{ background: `${bg}26`, color: bg }}
    >
      {pct}%
    </span>
  );
}

function ReassignMenu({
  index,
  currentId,
  allExisting,
  onReassign,
}: {
  index: number;
  currentId: string | null;
  allExisting: CircuitRow[];
  onReassign: (index: number, oldCircuitId: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
      Reassign
      <select
        value={currentId ?? ''}
        onChange={(e) => onReassign(index, e.target.value === '' ? null : e.target.value)}
        className="min-h-[36px] rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-2 py-1 text-[12px] text-[var(--color-text-primary)]"
      >
        <option value="">— New circuit (no match) —</option>
        {allExisting.map((c) => {
          const ref = (c.circuit_ref as string | undefined) ?? '';
          const designation =
            ((c.circuit_designation as string | undefined) ?? '').trim() || 'Untitled';
          return (
            <option key={c.id} value={c.id}>
              {ref ? `${ref}.` : ''} {designation}
            </option>
          );
        })}
      </select>
    </label>
  );
}
