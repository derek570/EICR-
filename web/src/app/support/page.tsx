import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { PublicFooter } from '@/components/public-footer';
import { Mail, MessageCircle, ShieldCheck, FileText } from 'lucide-react';

/**
 * Public Support page — the URL submitted to App Store Connect as the
 * "Support URL". Apple requires one separately from the Privacy URL, and
 * rejects listings where the support route 404s or hides behind a login.
 *
 * Deliberately minimal: a single inbox + a short FAQ. The phone-style
 * contact-form pattern is deferred until volume justifies it; a working
 * email is the App Store reviewer's only hard requirement.
 *
 * Statically rendered. Middleware allow-lists /support (alongside /legal,
 * /login, /offline) so visitors hit it without an auth cookie.
 */

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Support — CertMate',
  description:
    'Get help with CertMate. Contact, response times, FAQ, and pointers to the privacy and beta-tester documents.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/support' },
};

const SUPPORT_EMAIL = 'support@beckleyelectrical.co.uk';
const PRIVACY_EMAIL = 'privacy@certmate.uk';

const FAQ = [
  {
    q: 'I need to delete my CertMate account.',
    a: 'Open the iOS app, tap Settings, scroll to the bottom, and tap "Delete Account". You will be asked to confirm. Your account and all linked personal data are erased immediately; issued certificate PDFs are retained for 6 years under NICEIC scheme rules and dissociated from your active account.',
  },
  {
    q: 'How do I get a copy of my data?',
    a: `Email ${PRIVACY_EMAIL} and ask for a Subject Access Request. We respond within one calendar month per UK GDPR Article 12, usually faster.`,
  },
  {
    q: 'A certificate I issued has the wrong information on it. Can you change it?',
    a: "Certificates are signed off by you, the named inspector. You're welcome to re-issue with corrected data; CertMate keeps the original alongside the new one. We don't edit issued certificates retrospectively on a customer's behalf — that would compromise the audit trail every scheme relies on.",
  },
  {
    q: 'A homeowner has asked me about their data.',
    a: `As the inspector you are the data controller for the homeowner's records. Forward the request to ${PRIVACY_EMAIL} and we\'ll assist you in fulfilling it within the GDPR timeframe.`,
  },
  {
    q: 'I think a value was extracted incorrectly during dictation.',
    a: 'You can edit any field on the certificate before issuing it — CertMate is a dictation aid, not the final authority on the data. If a particular phrase consistently mis-extracts, please email a description (no audio attachments, please) so we can tune the language model.',
  },
  {
    q: 'I want to discuss commercial terms / volume pricing.',
    a: `Email ${SUPPORT_EMAIL} with a short description of your team size and typical certificate volume.`,
  },
];

export default function SupportPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--color-surface-0)]">
      <header className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <Link
            href="/support"
            className="flex items-baseline gap-2 focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            <Logo size="sm" />
            <span className="text-[12px] text-[var(--color-text-tertiary)]">— Support</span>
          </Link>
          <Link
            href="/login"
            className="text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
          <header className="flex flex-col gap-2">
            <h1 className="text-[28px] font-semibold leading-tight text-[var(--color-text-primary)]">
              Support
            </h1>
            <p className="text-[14px] text-[var(--color-text-secondary)]">
              Help with CertMate — the iOS app and the certmate.uk web app. Email is the fastest way
              to reach us; please include your account email so we can find your records.
            </p>
          </header>

          <section className="grid gap-3 md:grid-cols-2">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="group flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4 transition hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <Mail
                className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-brand-blue)]"
                aria-hidden
              />
              <span className="flex flex-col">
                <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                  General support
                </span>
                <span className="text-[12px] text-[var(--color-text-secondary)]">
                  {SUPPORT_EMAIL}
                </span>
                <span className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
                  Typically replies within one working day.
                </span>
              </span>
            </a>

            <a
              href={`mailto:${PRIVACY_EMAIL}`}
              className="group flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4 transition hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-brand-blue)]"
                aria-hidden
              />
              <span className="flex flex-col">
                <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                  Privacy &amp; data requests
                </span>
                <span className="text-[12px] text-[var(--color-text-secondary)]">
                  {PRIVACY_EMAIL}
                </span>
                <span className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">
                  Subject Access Requests, erasure, complaints. One-month statutory window.
                </span>
              </span>
            </a>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-[var(--color-brand-blue)]" aria-hidden />
              <h2 className="text-[18px] font-semibold text-[var(--color-text-primary)]">
                Frequently asked
              </h2>
            </div>
            <div className="flex flex-col gap-3">
              {FAQ.map((item, i) => (
                <details
                  key={i}
                  className="group rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4 open:bg-[var(--color-surface-2)]"
                >
                  <summary className="cursor-pointer list-none text-[14px] font-medium text-[var(--color-text-primary)]">
                    <span className="select-none text-[var(--color-text-tertiary)] mr-2 group-open:rotate-90 inline-block transition-transform">
                      ›
                    </span>
                    {item.q}
                  </summary>
                  <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
                    {item.a}
                  </p>
                </details>
              ))}
            </div>
          </section>

          <section className="rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-[var(--color-brand-blue)]" aria-hidden />
              <h2 className="text-[16px] font-semibold text-[var(--color-text-primary)]">
                Related documents
              </h2>
            </div>
            <nav className="mt-3 flex flex-col gap-2 text-[13px]">
              <Link
                href="/legal/privacy-policy"
                className="text-[var(--color-brand-blue)] underline underline-offset-2 hover:text-[var(--color-brand-blue-soft)]"
              >
                Privacy Policy
              </Link>
              <Link
                href="/legal/cookie-policy"
                className="text-[var(--color-brand-blue)] underline underline-offset-2 hover:text-[var(--color-brand-blue-soft)]"
              >
                Cookie Policy
              </Link>
              <Link
                href="/legal/sub-processors"
                className="text-[var(--color-brand-blue)] underline underline-offset-2 hover:text-[var(--color-brand-blue-soft)]"
              >
                Sub-processors
              </Link>
              <Link
                href="/legal/acceptable-use-policy"
                className="text-[var(--color-brand-blue)] underline underline-offset-2 hover:text-[var(--color-brand-blue-soft)]"
              >
                Acceptable Use Policy
              </Link>
              <Link
                href="/legal"
                className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
              >
                All legal documents →
              </Link>
            </nav>
          </section>
        </article>
      </main>

      <PublicFooter />
    </div>
  );
}
