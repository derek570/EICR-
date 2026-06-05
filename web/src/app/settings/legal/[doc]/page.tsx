import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { MarkdownRender } from '@/components/legal/markdown-render';

/**
 * Static legal document viewer — server component, build-time render.
 *
 * iOS shows these in `LegalDocumentView` as a scrollable sheet with a
 * "scroll to bottom to mark as read" affordance. The web port keeps it
 * simple — just a page with a Back link. Acceptance tracking on web is
 * a follow-up; the current need is just discoverability of the docs.
 *
 * Source markdown is duplicated from `CertMateUnified/legal/*.md` into
 * `src/content/legal/`. iOS embeds the same texts as Swift constants
 * (LegalTexts.swift). All three locations must be updated together when
 * legal changes — see CLAUDE.md docs sync rules.
 */

const DOCS = {
  terms: {
    title: 'Terms & Conditions',
    file: 'terms.md',
  },
  privacy: {
    title: 'Privacy Policy',
    file: 'privacy.md',
  },
  eula: {
    title: 'End User Licence Agreement',
    file: 'eula.md',
  },
} as const;

type DocSlug = keyof typeof DOCS;

export const dynamic = 'force-static';

export function generateStaticParams() {
  return Object.keys(DOCS).map((doc) => ({ doc }));
}

export default async function LegalDocPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  if (!(doc in DOCS)) notFound();
  const meta = DOCS[doc as DocSlug];
  const filePath = path.join(process.cwd(), 'src/content/legal', meta.file);
  const source = await fs.readFile(filePath, 'utf8');

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <div>
        <Link
          href="/settings/legal"
          className="inline-flex items-center gap-1 text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Legal
        </Link>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-[24px] font-semibold text-[var(--color-text-primary)]">{meta.title}</h1>
      </header>

      <article className="rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-5">
        <MarkdownRender source={source} />
      </article>
    </main>
  );
}
