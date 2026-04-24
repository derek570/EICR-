'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Info } from 'lucide-react';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';

/**
 * About page — iOS `SettingsHubView.swift` Version row + the
 * Acknowledgments surface (which is scattered across a few iOS
 * sheets). Version is pulled from `NEXT_PUBLIC_APP_VERSION` when set,
 * with a static fallback so it still renders in dev.
 *
 * Includes the debug-mode toggle required by the Debug Dashboard
 * gate. Flipping the switch writes `cm-debug` = '1' / '0' to
 * localStorage; the debug page reads that value at mount time (plus
 * the NODE_ENV check) to decide whether to render or `notFound()`.
 * We do NOT expose the debug route at all when the flag is off — the
 * link in the hub only shows up once the flag is set.
 */

const DEBUG_KEY = 'cm-debug';

function readDebugFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

export default function AboutPage() {
  const router = useRouter();
  const [debugEnabled, setDebugEnabled] = React.useState(false);
  // Read the flag once on mount so SSR + first client render don't
  // disagree on the checkbox state.
  React.useEffect(() => {
    setDebugEnabled(readDebugFlag());
  }, []);

  function toggleDebug(next: boolean) {
    setDebugEnabled(next);
    try {
      if (next) {
        window.localStorage.setItem(DEBUG_KEY, '1');
      } else {
        window.localStorage.removeItem(DEBUG_KEY);
      }
    } catch {
      /* ignore */
    }
  }

  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0';

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
        eyebrow="App"
        title="About CertMate"
        subtitle="Version and acknowledgments."
        icon={<Info className="h-10 w-10" aria-hidden />}
      />

      <SectionCard accent="blue" title="Version">
        <dl className="grid grid-cols-2 gap-2 text-[14px]">
          <dt className="text-[var(--color-text-secondary)]">Build</dt>
          <dd className="text-right font-medium text-[var(--color-text-primary)]">{version}</dd>
          <dt className="text-[var(--color-text-secondary)]">Environment</dt>
          <dd className="text-right font-medium text-[var(--color-text-primary)]">
            {process.env.NODE_ENV ?? 'unknown'}
          </dd>
        </dl>
      </SectionCard>

      <SectionCard accent="blue" title="Acknowledgments">
        <ul className="flex flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">
          <li>
            <span className="text-[var(--color-text-primary)]">Next.js</span> — App-router frontend
            (Vercel).
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">React</span> — UI runtime.
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">Serwist</span> — PWA service worker
            toolkit.
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">Deepgram</span> — Nova-3 streaming
            transcription.
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">Anthropic</span> — Claude Sonnet 4.5
            live extraction.
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">OpenAI</span> — GPT Vision CCU &amp;
            document analysis.
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">Radix UI</span> — accessible
            dialog/menu primitives.
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">Lucide</span> — icon set.
          </li>
          <li>
            <span className="text-[var(--color-text-primary)]">Zod</span> — runtime schema
            validation.
          </li>
        </ul>
      </SectionCard>

      <SectionCard
        accent="amber"
        title="Developer tools"
        subtitle="Unlock the hidden debug dashboard. Useful for support triage, not for day-to-day inspectors."
      >
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={debugEnabled}
            onChange={(e) => toggleDebug(e.target.checked)}
            className="h-5 w-5 rounded border-[var(--color-border-default)] text-[var(--color-brand-blue)] focus:ring-[var(--color-brand-blue)]"
          />
          <span className="text-[14px] text-[var(--color-text-primary)]">Enable debug mode</span>
        </label>
        {debugEnabled ? (
          <p className="text-[12px] text-[var(--color-text-secondary)]">
            Debug dashboard is now available under Settings → Debug.
          </p>
        ) : null}
      </SectionCard>
    </main>
  );
}
