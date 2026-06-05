import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronRight, Cookie, FileText, Handshake, Server, Shield, Volume2 } from 'lucide-react';

/**
 * Public legal documents hub at `/legal`. The home of every customer-,
 * regulator-, and homeowner-facing compliance document. Linked from the
 * site footer; also the URL submitted to App Store Connect as the
 * "Privacy Policy URL" hub.
 *
 * Server component, statically rendered.
 */

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Legal — CertMate',
  description:
    'Privacy policy, cookie policy, sub-processors, acceptable use, beta tester agreement, and the door script CertMate inspectors read to homeowners before recording.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/legal' },
};

const DOCS = [
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    subtitle: 'How CertMate handles personal data under UK GDPR.',
    Icon: Shield,
  },
  {
    slug: 'cookie-policy',
    title: 'Cookie Policy',
    subtitle: 'What CertMate stores in your browser, and why.',
    Icon: Cookie,
  },
  {
    slug: 'sub-processors',
    title: 'Sub-processors',
    subtitle: 'Third parties that process personal data on our behalf.',
    Icon: Server,
  },
  {
    slug: 'acceptable-use-policy',
    title: 'Acceptable Use Policy',
    subtitle: 'How CertMate may and may not be used.',
    Icon: FileText,
  },
  {
    slug: 'beta-tester-agreement',
    title: 'Beta Tester Agreement',
    subtitle: 'The contract that governs participation in the closed beta.',
    Icon: Handshake,
  },
  {
    slug: 'door-script',
    title: 'Door Script — Recording Notice',
    subtitle: 'Notice an inspector reads to a homeowner before recording.',
    Icon: Volume2,
  },
] as const;

export default function LegalHubPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-[28px] font-semibold leading-tight text-[var(--color-text-primary)]">
          Legal documents
        </h1>
        <p className="text-[14px] text-[var(--color-text-secondary)]">
          The customer-, regulator-, and homeowner-facing documents that govern how CertMate is used
          and how personal data is handled.
        </p>
      </header>

      <nav aria-label="Documents" className="flex flex-col gap-2">
        {DOCS.map((doc) => (
          <Link
            key={doc.slug}
            href={`/legal/${doc.slug}`}
            className="group flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4 transition hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            <span className="flex items-start gap-3">
              <doc.Icon
                className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-brand-blue)]"
                strokeWidth={2}
                aria-hidden
              />
              <span className="flex flex-col">
                <span className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                  {doc.title}
                </span>
                <span className="text-[12px] text-[var(--color-text-secondary)]">
                  {doc.subtitle}
                </span>
              </span>
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)] transition group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        ))}
      </nav>
    </div>
  );
}
