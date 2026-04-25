'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ClipboardCopy, Download, Trash2, Wrench } from 'lucide-react';
import { downloadBlob } from '@certmate/shared-utils';
import { collectDiagnostics } from '@/lib/diagnostics';
import { DB_NAME } from '@/lib/pwa/job-cache';
import { clearAuth } from '@/lib/auth';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Diagnostics page — iOS "Export Diagnostics" in
 * `DebugDashboardView.swift` + the Clear-Cache affordance inspectors
 * ask for when a stuck IDB row corrupts the offline queue.
 *
 * Two actions:
 *   1. Export Diagnostics — collects the snapshot from
 *      `lib/diagnostics.ts` and either downloads it as JSON or copies
 *      it to the clipboard. Sensitive keys are redacted by the
 *      collector (see SENSITIVE_PATTERN) so inspectors can paste the
 *      dump into a support ticket without leaking bearer tokens.
 *   2. Clear Cache — destructive. Unregisters every service worker,
 *      deletes the `certmate-cache` IDB, clears localStorage
 *      (including the auth bits — the user lands on /login after the
 *      reload), and force-reloads. Gated behind ConfirmDialog because
 *      it wipes unsaved work in the outbox.
 *
 * Unlike iOS, we do NOT provide a "Reset PWA install" button — users
 * uninstall the PWA via the browser's native UI (Chrome menu · Safari
 * Settings). Inviting that flow here is more confusing than helpful.
 */
export default function DiagnosticsPage() {
  const router = useRouter();
  const [collecting, setCollecting] = React.useState(false);
  const [clearingOpen, setClearingOpen] = React.useState(false);
  const [clearingBusy, setClearingBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [copyBusy, setCopyBusy] = React.useState(false);

  async function buildSnapshot(): Promise<string> {
    const snapshot = await collectDiagnostics();
    return JSON.stringify(snapshot, null, 2);
  }

  async function handleDownload() {
    setCollecting(true);
    setFeedback(null);
    try {
      const json = await buildSnapshot();
      const filename = `eicr-diagnostics-${Date.now()}.json`;
      downloadBlob(new Blob([json], { type: 'application/json' }), filename);
      setFeedback('Diagnostics downloaded.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to collect diagnostics.');
    } finally {
      setCollecting(false);
    }
  }

  async function handleCopy() {
    setCopyBusy(true);
    setFeedback(null);
    try {
      const json = await buildSnapshot();
      await navigator.clipboard.writeText(json);
      setFeedback('Diagnostics copied to clipboard.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to copy diagnostics.');
    } finally {
      setCopyBusy(false);
    }
  }

  async function handleClearCache() {
    setClearingBusy(true);
    try {
      // 1. Unregister every service worker so the next reload bypasses
      //    Serwist caches. Some browsers throw on unregister after
      //    navigation; we swallow the error and press on.
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
        } catch {
          /* ignore */
        }
      }

      // 2. Delete the shared IDB. `deleteDatabase` blocks if any tab
      //    has an open handle — we close our cached handle via
      //    `clearAuth()` below (which also triggers the module-level
      //    dbPromise reset in future), but the best defence is simply
      //    to reload immediately after.
      try {
        indexedDB.deleteDatabase(DB_NAME);
      } catch {
        /* ignore */
      }

      // 3. Clear auth + localStorage. clearAuth() wipes the token;
      //    localStorage.clear() catches any stragglers (tour prefs,
      //    circuits view pref). Session storage follows for
      //    completeness.
      try {
        clearAuth();
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* ignore */
      }

      // 4. Hard reload. Use `location.href` rather than reload() so
      //    the browser rebuilds its HTTP cache state and doesn't
      //    serve the pre-wipe SW shell.
      window.location.href = '/login';
    } finally {
      setClearingBusy(false);
      setClearingOpen(false);
    }
  }

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
        eyebrow="Support"
        title="Diagnostics"
        subtitle="Export a state snapshot or clear the local cache."
        icon={<Wrench className="h-10 w-10" aria-hidden />}
      />

      <SectionCard
        accent="blue"
        title="Export diagnostics"
        subtitle="Includes user info, cached jobs, outbox contents, SW state, and build metadata. Auth tokens are redacted automatically."
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleDownload} disabled={collecting} className="gap-2">
            <Download className="h-4 w-4" aria-hidden />
            {collecting ? 'Collecting…' : 'Download JSON'}
          </Button>
          <Button variant="secondary" onClick={handleCopy} disabled={copyBusy} className="gap-2">
            <ClipboardCopy className="h-4 w-4" aria-hidden />
            {copyBusy ? 'Copying…' : 'Copy to clipboard'}
          </Button>
        </div>
        {feedback ? (
          <p
            className="text-[12px] text-[var(--color-text-secondary)]"
            role="status"
            aria-live="polite"
          >
            {feedback}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        accent="red"
        title="Clear cache"
        subtitle="Unregisters the service worker, wipes local data (IDB + localStorage), and reloads. Any unsaved offline edits in the outbox will be lost."
      >
        <Button variant="destructive" onClick={() => setClearingOpen(true)} className="gap-2">
          <Trash2 className="h-4 w-4" aria-hidden />
          Clear cache
        </Button>
      </SectionCard>

      <ConfirmDialog
        open={clearingOpen}
        onOpenChange={(next) => {
          if (!next && !clearingBusy) setClearingOpen(false);
        }}
        title="Clear cache?"
        description="This unregisters the service worker, wipes IDB, and reloads the app. Any unsaved work in the outbox will be lost."
        confirmLabel="Clear cache"
        confirmLabelBusy="Clearing…"
        destructive
        busy={clearingBusy}
        onConfirm={handleClearCache}
      />
    </main>
  );
}
