'use client';

import * as React from 'react';
import { CheckCircle2, X, Zap } from 'lucide-react';
import { api } from '@/lib/api-client';
import { ApiError, type LegalTextVersionsBundle } from '@/lib/types';

/**
 * Per-PDF attestation modal — the web counterpart to iOS
 * IssueCertificateSheet.swift.
 *
 * Spec: .planning/compliance/pdf-issuance-attestations.md.
 *
 * Two independent checkboxes (readings, observations). Both must be
 * checked to enable the Issue button. On confirm, posts both
 * attestations atomically to /api/cert-attestations/accept; on success
 * calls `onConfirmed(attestationIds)` so the host can fire the real
 * generate-PDF flow. Default state on every appearance is both
 * unchecked — no `Remember my choice`, no localStorage. Per spec §4.1
 * every PDF that leaves CertMate gets its own fresh attestation pair,
 * including unchanged re-renders.
 */
interface IssueCertificateModalProps {
  open: boolean;
  jobId: string;
  onConfirmed: (attestationIds: number[]) => void;
  onCancelled: () => void;
}

export function IssueCertificateModal({
  open,
  jobId,
  onConfirmed,
  onCancelled,
}: IssueCertificateModalProps) {
  const [bundle, setBundle] = React.useState<LegalTextVersionsBundle | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [readingsAttested, setReadingsAttested] = React.useState(false);
  const [observationsAttested, setObservationsAttested] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Reset every time the modal opens — never carry confirmation state
  // across presentations.
  React.useEffect(() => {
    if (!open) return;
    setReadingsAttested(false);
    setObservationsAttested(false);
    setSubmitError(null);
  }, [open]);

  // Fetch the wording bundle the first time we open. Re-use on
  // subsequent opens — wording only changes via deploy.
  React.useEffect(() => {
    if (!open || bundle) return;
    let cancelled = false;
    api
      .legalTextVersions()
      .then((b) => {
        if (!cancelled) setBundle(b);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load attestation wording');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, bundle]);

  const canIssue = readingsAttested && observationsAttested && !isSubmitting && bundle !== null;

  const submit = async () => {
    if (!canIssue || !bundle) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const now = new Date().toISOString();
      const response = await api.acceptCertAttestations({
        job_id: jobId,
        attestations: [
          {
            kind: 'readings',
            text_version: bundle.cert_attestation_readings.version,
            attested_at: now,
            platform: 'web',
          },
          {
            kind: 'observations',
            text_version: bundle.cert_attestation_observations.version,
            attested_at: now,
            platform: 'web',
          },
        ],
      });
      setIsSubmitting(false);
      onConfirmed(response.attestation_ids);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to record your confirmations';
      setSubmitError(`${message}. Please check your connection and try again.`);
      setIsSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="issue-cert-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={(e) => {
        // Click on backdrop = cancel. The matching iOS behaviour is
        // `interactiveDismissDisabled` (drag-to-dismiss blocked) — on
        // web we allow the close affordance because the explicit
        // Cancel button is the equivalent obvious escape hatch.
        if (e.target === e.currentTarget && !isSubmitting) onCancelled();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-6 py-4">
          <div className="flex flex-col">
            <h2
              id="issue-cert-title"
              className="text-[18px] font-semibold text-[var(--color-text-primary)]"
            >
              Issue certificate
            </h2>
            <p className="text-[12px] text-[var(--color-text-tertiary)]">
              Two checks before this certificate is issued to the customer.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelled}
            disabled={isSubmitting}
            aria-label="Cancel"
            className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)] disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loadError ? (
            <p className="text-[14px] text-[var(--color-status-expired,#ef4444)]" role="alert">
              Couldn’t load the attestation wording: {loadError}
            </p>
          ) : !bundle ? (
            <p className="text-[14px] text-[var(--color-text-tertiary)]">Loading…</p>
          ) : (
            <div className="flex flex-col gap-5">
              <AttestationCard
                isOn={readingsAttested}
                onChange={setReadingsAttested}
                heading={bundle.cert_attestation_readings.copy.heading}
                body={bundle.cert_attestation_readings.copy.body}
                icon={<Zap className="h-6 w-6 text-[var(--color-brand-blue)]" aria-hidden />}
                accentBorder="var(--color-brand-blue)"
                disabled={isSubmitting}
              />
              <AttestationCard
                isOn={observationsAttested}
                onChange={setObservationsAttested}
                heading={bundle.cert_attestation_observations.copy.heading}
                body={bundle.cert_attestation_observations.copy.body}
                icon={
                  <CheckCircle2
                    className="h-6 w-6 text-[var(--color-brand-green,#10b981)]"
                    aria-hidden
                  />
                }
                accentBorder="var(--color-brand-green,#10b981)"
                disabled={isSubmitting}
              />
              <p className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)]">
                A record of your two confirmations will be saved alongside the certificate for audit
                purposes.
              </p>
            </div>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/90 px-6 py-4">
          {submitError ? (
            <p
              className="text-center text-[13px] text-[var(--color-status-expired,#ef4444)]"
              role="alert"
            >
              {submitError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={submit}
            disabled={!canIssue}
            className="inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-[var(--color-brand-blue)] to-[var(--color-brand-green,#10b981)] px-6 py-3 text-[15px] font-semibold text-white shadow-md transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? 'Recording…' : 'Issue certificate'}
          </button>
          <button
            type="button"
            onClick={onCancelled}
            disabled={isSubmitting}
            className="text-center text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

interface AttestationCardProps {
  isOn: boolean;
  onChange: (next: boolean) => void;
  heading: string;
  body: string;
  icon: React.ReactNode;
  accentBorder: string;
  disabled: boolean;
}

function AttestationCard({
  isOn,
  onChange,
  heading,
  body,
  icon,
  accentBorder,
  disabled,
}: AttestationCardProps) {
  return (
    <div
      className="rounded-[var(--radius-md)] border bg-[var(--color-surface-0)] p-4 transition"
      style={{ borderColor: isOn ? accentBorder : 'var(--color-border-subtle)' }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5">{icon}</span>
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-[15px] font-semibold leading-tight text-[var(--color-text-primary)]">
            {heading}
          </p>
          <p className="text-[13px] leading-relaxed text-[var(--color-text-secondary)]">{body}</p>
          <label className="mt-1 flex items-center gap-2 text-[14px] font-medium text-[var(--color-text-primary)]">
            <input
              type="checkbox"
              checked={isOn}
              onChange={(e) => onChange(e.target.checked)}
              disabled={disabled}
              className="h-4 w-4 cursor-pointer rounded border-[var(--color-border-subtle)] text-[var(--color-brand-blue)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
            />
            I confirm the above
          </label>
        </div>
      </div>
    </div>
  );
}
