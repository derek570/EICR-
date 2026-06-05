'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronRight, FileText, ScrollText, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';

/**
 * Legal documents hub — mirrors iOS `TermsAcceptanceView.swift` document list.
 * Three docs: Terms & Conditions, Privacy Policy, EULA. Each renders the
 * same source markdown the iOS app embeds in `LegalTexts.swift` (kept in
 * sync manually — see CLAUDE.md docs sync rules).
 */

const DOCS = [
  {
    slug: 'terms',
    title: 'Terms & Conditions',
    subtitle: 'Your agreement with CertMate.',
    Icon: ScrollText,
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    subtitle: 'What we collect and how it is processed.',
    Icon: Shield,
  },
  {
    slug: 'eula',
    title: 'End User Licence Agreement',
    subtitle: 'Software licensing terms for the app.',
    Icon: FileText,
  },
] as const;

export default function LegalHubPage() {
  const router = useRouter();
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="gap-1 text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Settings
        </Button>
      </div>

      <HeroHeader
        eyebrow="Legal"
        title="Terms & Legal"
        subtitle="Read the documents that govern your use of CertMate."
        icon={<ScrollText className="h-10 w-10" aria-hidden />}
      />

      <SectionCard accent="blue" title="Documents">
        <nav className="flex flex-col gap-2">
          {DOCS.map((doc) => (
            <Link
              key={doc.slug}
              href={`/settings/legal/${doc.slug}`}
              className="group flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3 transition hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <span className="flex items-center gap-3">
                <doc.Icon
                  className="h-5 w-5 text-[var(--color-brand-blue)]"
                  strokeWidth={2}
                  aria-hidden
                />
                <span className="flex flex-col">
                  <span className="text-[14px] font-medium text-[var(--color-text-primary)]">
                    {doc.title}
                  </span>
                  <span className="text-[12px] text-[var(--color-text-secondary)]">
                    {doc.subtitle}
                  </span>
                </span>
              </span>
              <ChevronRight
                className="h-4 w-4 text-[var(--color-text-tertiary)] transition group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          ))}
        </nav>
      </SectionCard>
    </main>
  );
}
