'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, FileText, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { clearAuth } from '@/lib/auth';
import { ApiError, type LegalTextVersionsBundle } from '@/lib/types';
import { Logo } from '@/components/brand/logo';

/**
 * First-login Beta Tester Agreement consent screen.
 *
 * Spec: .planning/compliance/in-app-consent-screen.md.
 *
 * Mirrors the iOS ConsentScreen.swift behaviour: renders verbatim
 * server-supplied copy, requires scroll-to-bottom before "I agree"
 * enables, posts the acceptance to /api/account/consent/accept on
 * confirm, and routes back to the dashboard on success. Cancel logs
 * the user out and bounces to /login.
 *
 * Gated by the layout's redirect on `consent_pending=true` from
 * /api/auth/me (see onboarding/consent/layout.tsx).
 */

const PLATFORM = 'web';

export default function ConsentPage() {
  const router = useRouter();
  const [bundle, setBundle] = React.useState<LegalTextVersionsBundle | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api
      .legalTextVersions()
      .then((b) => {
        if (!cancelled) setBundle(b);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load agreement');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // IntersectionObserver to flip the scroll-to-bottom sentinel when
  // the inspector has read through to the end of the bullets. Same
  // belt-and-braces gate as the iOS ScrollView .onAppear.
  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setHasScrolledToBottom(true);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.1 }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [bundle]);

  const handleAgree = async () => {
    if (!bundle || !hasScrolledToBottom || isSubmitting) return;
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await api.acceptConsent({
        agreement_kind: 'beta_tester_agreement',
        agreement_version: bundle.beta_tester_agreement.version,
        accepted_at: new Date().toISOString(),
        platform: PLATFORM,
      });
      // Server has recorded the acceptance. Route back to the dashboard;
      // the layout-level guard now reads consent_pending=false and lets
      // the dashboard render.
      router.push('/dashboard');
      // Force a full reload so the AppShell re-fetches /me with fresh
      // consent state — avoids a flash of "still pending" while the
      // SWR cache lingers.
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to record your acceptance';
      setSubmitError(`${message}. Please check your connection and try again.`);
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    try {
      await api.logout();
    } catch {
      // Ignore — we're tearing down auth anyway.
    }
    clearAuth();
    router.replace('/login');
  };

  if (loadError) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-[14px] text-[var(--color-text-secondary)]">
          Couldn’t load the agreement: {loadError}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-[var(--radius-md)] bg-[var(--color-brand-blue)] px-4 py-2 text-[14px] font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!bundle) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-3xl items-center justify-center p-6">
        <p className="text-[14px] text-[var(--color-text-tertiary)]">Loading…</p>
      </div>
    );
  }

  const copy = bundle.beta_tester_agreement.copy;

  return (
    <div className="flex min-h-dvh flex-col bg-[var(--color-surface-0)]">
      <header className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <Logo size="sm" />
          <span className="text-[12px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Before you start
          </span>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-brand-blue)] to-[var(--color-brand-green,#10b981)]">
              <ShieldCheck className="h-6 w-6 text-white" aria-hidden />
            </span>
            <h1 className="text-[28px] font-semibold leading-tight text-[var(--color-text-primary)]">
              {copy.heading}
            </h1>
          </div>

          <p
            className="text-[15px] leading-relaxed text-[var(--color-text-primary)]"
            // Server-supplied copy contains markdown bold + links.
            // dangerouslySetInnerHTML is safe here because the source
            // is our own backend constants file, not user-supplied.
            dangerouslySetInnerHTML={{ __html: renderMarkdownInline(copy.summary) }}
          />

          <section className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-5 md:p-7">
            <h2 className="mb-4 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
              {copy.bulletsHeading}
            </h2>
            <ul className="flex flex-col gap-4">
              {copy.bullets.map((bullet, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-3 text-[14px] leading-relaxed text-[var(--color-text-primary)]"
                >
                  <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-brand-green,#10b981)]" />
                  <span dangerouslySetInnerHTML={{ __html: renderMarkdownInline(bullet) }} />
                </li>
              ))}
            </ul>
          </section>

          <a
            href={copy.links.betaTesterAgreement}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-2 text-[14px] font-semibold text-[var(--color-brand-blue)] hover:underline"
          >
            <FileText className="h-4 w-4" aria-hidden />
            {copy.buttons.readFull}
          </a>

          <p
            className="text-[12px] leading-relaxed text-[var(--color-text-tertiary)]"
            dangerouslySetInnerHTML={{ __html: renderMarkdownInline(copy.footer) }}
          />

          <div ref={sentinelRef} className="h-px" aria-hidden />
        </article>
      </main>

      <footer className="sticky bottom-0 z-10 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
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
            onClick={handleAgree}
            disabled={!hasScrolledToBottom || isSubmitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[var(--color-brand-blue)] to-[var(--color-brand-green,#10b981)] px-6 py-3 text-[15px] font-semibold text-white shadow-md transition disabled:cursor-not-allowed disabled:opacity-50"
            aria-describedby="consent-cta-hint"
          >
            {isSubmitting ? 'Recording…' : copy.buttons.primary}
            {!isSubmitting && <ArrowRight className="h-4 w-4" aria-hidden />}
          </button>
          <p
            id="consent-cta-hint"
            className="text-center text-[11px] text-[var(--color-text-tertiary)]"
          >
            {hasScrolledToBottom
              ? 'A record of your acceptance is kept for audit purposes.'
              : 'Scroll to the bottom of the agreement to enable.'}
          </p>
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSubmitting}
            className="text-center text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            {copy.buttons.cancel}
          </button>
        </div>
      </footer>
    </div>
  );
}

/**
 * Minimal inline-markdown renderer for the **bold** + raw URL patterns
 * the server-supplied copy uses. Deliberately limited surface — only
 * the two patterns we actually use — so the input doesn't introduce
 * an XSS sink. The source is our own backend constants module, but
 * keeping the renderer narrow is belt-and-braces.
 */
function renderMarkdownInline(source: string): string {
  // Escape HTML special chars first.
  let html = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // **bold**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return html;
}
