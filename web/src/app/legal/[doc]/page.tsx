import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { MarkdownRender } from '@/components/legal/markdown-render';

/**
 * Public legal document viewer. Server component, build-time render via
 * `force-static` + `generateStaticParams` — every doc is pre-rendered into
 * an HTML file so unauthenticated visitors (Apple App Store reviewers, ICO
 * staff, homeowners following a door-script QR code) hit a static asset
 * with no Node round-trip.
 *
 * Source markdown lives in `src/content/legal/public/` (copies of
 * `.planning/compliance/*.md`). See that directory's README.md for the
 * sync rule.
 *
 * Adding a doc: drop the .md file into `src/content/legal/public/`, then
 * add an entry to `DOCS` below. The slug becomes the URL.
 */

const DOCS = {
  'privacy-policy': {
    title: 'Privacy Policy',
    description:
      'How CertMate collects, uses, and protects personal data when inspectors generate EICR / EIC certificates.',
    file: 'privacy-policy.md',
  },
  'cookie-policy': {
    title: 'Cookie Policy',
    description:
      'The cookies and browser storage CertMate uses on the certmate.uk website and web app.',
    file: 'cookie-policy.md',
  },
  'sub-processors': {
    title: 'Sub-processors',
    description:
      'Third parties that process personal data on CertMate’s behalf, under UK GDPR Article 28.',
    file: 'sub-processors.md',
  },
  'acceptable-use-policy': {
    title: 'Acceptable Use Policy',
    description: 'How CertMate may and may not be used.',
    file: 'acceptable-use-policy.md',
  },
  'beta-tester-agreement': {
    title: 'Beta Tester Agreement',
    description:
      'The contract that governs participation in the CertMate closed beta, including the embedded Data Processing Agreement.',
    file: 'beta-tester-agreement.md',
  },
  'door-script': {
    title: 'Door Script — Recording Notice',
    description:
      'The short notice an inspector reads to a homeowner before recording an electrical inspection.',
    file: 'door-script.md',
  },
} as const;

type DocSlug = keyof typeof DOCS;

export const dynamic = 'force-static';

export function generateStaticParams() {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ doc: string }>;
}): Promise<Metadata> {
  const { doc } = await params;
  if (!(doc in DOCS)) return { title: 'Not found' };
  const meta = DOCS[doc as DocSlug];
  return {
    title: `${meta.title} — CertMate`,
    description: meta.description,
    robots: { index: true, follow: true },
    alternates: { canonical: `/legal/${doc}` },
  };
}

export default async function LegalDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  if (!(doc in DOCS)) notFound();
  const meta = DOCS[doc as DocSlug];
  const filePath = path.join(process.cwd(), 'src/content/legal/public', meta.file);
  const source = await fs.readFile(filePath, 'utf8');

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <Link
        href="/legal"
        className="inline-flex w-fit items-center gap-1 text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All legal documents
      </Link>

      <header className="flex flex-col gap-1">
        <h1 className="text-[28px] font-semibold leading-tight text-[var(--color-text-primary)]">
          {meta.title}
        </h1>
        <p className="text-[13px] text-[var(--color-text-tertiary)]">{meta.description}</p>
      </header>

      <section className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-5 md:p-7">
        <MarkdownRender source={source} />
      </section>
    </article>
  );
}
