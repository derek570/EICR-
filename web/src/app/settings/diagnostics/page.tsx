'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ClipboardCopy, Download, Trash2, Wrench } from 'lucide-react';
import { downloadBlob } from '@certmate/shared-utils';
import { collectDiagnostics } from '@/lib/diagnostics';
import {
  clearLog as clearLifecycleLog,
  getLog as getLifecycleLog,
  type LifecycleEvent,
} from '@/lib/diagnostics/lifecycle-log';
import {
  clearPipelineLog,
  getPipelineLog,
  subscribePipelineLog,
  type PipelineEvent,
} from '@/lib/diagnostics/pipeline-log';
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

      <RecentActivityCard />

      <PipelineLogCard />

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

/**
 * Recent activity timeline — surfaces the lifecycle log
 * (`@/lib/diagnostics/lifecycle-log`) inline so an inspector seeing a
 * "the page kept refreshing" symptom can confirm what fired (error
 * boundary, SW upgrade, page-suspend BFCache restore, etc.) without
 * having to download and parse the full diagnostics JSON. The log is
 * also included verbatim in the JSON export via the existing
 * localStorage dump in `lib/diagnostics.ts`, so support gets the same
 * data either way.
 */
function RecentActivityCard() {
  const [events, setEvents] = React.useState<LifecycleEvent[]>([]);
  const [confirmClearOpen, setConfirmClearOpen] = React.useState(false);

  const refresh = React.useCallback(() => {
    setEvents(getLifecycleLog().slice().reverse());
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <SectionCard
      accent="magenta"
      title="Recent activity"
      subtitle="App lifecycle events captured locally. Useful for diagnosing unexpected reloads. Auto-cleared after 100 entries."
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={refresh}>
          Refresh
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmClearOpen(true)}
          disabled={events.length === 0}
          className="gap-1 text-[var(--color-text-secondary)]"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Clear log
        </Button>
      </div>
      {events.length === 0 ? (
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          No events recorded yet. Lifecycle events appear here as you use the app.
        </p>
      ) : (
        <ul className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] text-[12px]">
          {events.map((entry, i) => (
            <li
              key={`${entry.ts}-${i}`}
              className="flex items-start gap-3 border-b border-[var(--color-border-subtle)] px-3 py-2 last:border-b-0"
            >
              <span className="font-mono tabular-nums text-[var(--color-text-tertiary)]">
                {new Date(entry.ts).toLocaleTimeString()}
              </span>
              <span className="font-mono font-semibold text-[var(--color-text-primary)]">
                {entry.event}
              </span>
              <span className="ml-auto truncate font-mono text-[var(--color-text-secondary)]">
                {summarisePayload(entry)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="Clear activity log?"
        description="This removes the local lifecycle event history. The diagnostics JSON export will no longer include past events until new ones accumulate."
        confirmLabel="Clear log"
        cancelLabel="Keep"
        destructive
        onConfirm={() => {
          clearLifecycleLog();
          setConfirmClearOpen(false);
          refresh();
        }}
      />
    </SectionCard>
  );
}

/** Format a lifecycle entry's payload as a single short line for the
 *  list — the full payload is in the export, this is just for at-a-
 *  glance reading. */
function summarisePayload(entry: LifecycleEvent): string {
  const { ts: _ts, event: _event, ...rest } = entry;
  void _ts;
  void _event;
  const keys = Object.keys(rest);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = rest[k];
    if (v == null) continue;
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${str.length > 32 ? str.slice(0, 32) + '…' : str}`);
  }
  return parts.join(' ');
}

/**
 * Recording-pipeline log panel.
 *
 * Renders the in-memory ring populated by `pipelineLog()` calls
 * scattered across the recording-related modules. Lets the user
 * filter by stage substring, auto-refresh as new events arrive,
 * copy the visible slice to the clipboard, and clear the ring.
 *
 * The same events are mirrored to CloudWatch (via
 * `clientDiagnostic` → `Client diagnostic` log rows with the
 * `pipeline.*` category prefix), so this panel is the local-first
 * view of what's also visible server-side.
 */
function PipelineLogCard() {
  const [events, setEvents] = React.useState<PipelineEvent[]>([]);
  const [filter, setFilter] = React.useState('');
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [confirmClearOpen, setConfirmClearOpen] = React.useState(false);
  const [copyFeedback, setCopyFeedback] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    setEvents(getPipelineLog().slice().reverse());
  }, []);

  React.useEffect(() => {
    refresh();
    if (!autoRefresh) return;
    const unsubscribe = subscribePipelineLog(refresh);
    return () => unsubscribe();
  }, [refresh, autoRefresh]);

  const filtered = React.useMemo(() => {
    if (!filter.trim()) return events;
    const needle = filter.trim().toLowerCase();
    return events.filter((e) => {
      if (e.stage.toLowerCase().includes(needle)) return true;
      if (!e.payload) return false;
      try {
        return JSON.stringify(e.payload).toLowerCase().includes(needle);
      } catch {
        return false;
      }
    });
  }, [events, filter]);

  async function handleCopy() {
    try {
      const text = filtered
        .slice()
        .reverse() // chronological for paste-into-ticket
        .map((e) => {
          const ts = new Date(e.ts).toISOString();
          const payload = e.payload ? ` ${JSON.stringify(e.payload)}` : '';
          return `[${ts}] #${e.seq} ${e.stage}${payload}`;
        })
        .join('\n');
      await navigator.clipboard.writeText(text);
      setCopyFeedback(`Copied ${filtered.length} event${filtered.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setCopyFeedback(err instanceof Error ? err.message : 'Copy failed.');
    }
  }

  return (
    <SectionCard
      accent="blue"
      title="Recording pipeline log"
      subtitle="Live trace of the voice → transcript → Sonnet → apply-extraction pipeline. Each event also lands in CloudWatch as a 'Client diagnostic' row with category pipeline.*. Ring holds last 500."
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter (e.g. ws, extraction, circuit)"
          className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-2 py-1 text-[12px] font-mono"
          aria-label="Filter pipeline log"
        />
        <label className="flex items-center gap-1 text-[12px] text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto
        </label>
        <Button variant="secondary" size="sm" onClick={refresh}>
          Refresh
        </Button>
        <Button variant="secondary" size="sm" onClick={handleCopy} disabled={filtered.length === 0}>
          Copy
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmClearOpen(true)}
          disabled={events.length === 0}
          className="gap-1 text-[var(--color-text-secondary)]"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Clear
        </Button>
      </div>
      {copyFeedback ? (
        <p
          className="text-[12px] text-[var(--color-text-secondary)]"
          role="status"
          aria-live="polite"
        >
          {copyFeedback}
        </p>
      ) : null}
      {filtered.length === 0 ? (
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          {events.length === 0
            ? 'No pipeline events recorded yet. Start a recording to populate.'
            : 'No events match the filter.'}
        </p>
      ) : (
        <ul className="max-h-96 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] text-[11px]">
          {filtered.map((entry) => (
            <li
              key={entry.seq}
              className="flex items-start gap-2 border-b border-[var(--color-border-subtle)] px-2 py-1 last:border-b-0 font-mono"
            >
              <span className="shrink-0 tabular-nums text-[var(--color-text-tertiary)]">
                {new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false })}.
                {String(entry.ts % 1000).padStart(3, '0')}
              </span>
              <span className="shrink-0 font-semibold text-[var(--color-text-primary)]">
                {entry.stage}
              </span>
              <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
                {summarisePipelinePayload(entry.payload)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="Clear pipeline log?"
        description="Wipes the in-memory ring and the localStorage tail. Server-side CloudWatch entries are unaffected."
        confirmLabel="Clear log"
        cancelLabel="Keep"
        destructive
        onConfirm={() => {
          clearPipelineLog();
          setConfirmClearOpen(false);
          refresh();
        }}
      />
    </SectionCard>
  );
}

function summarisePipelinePayload(payload: PipelineEvent['payload']): string {
  if (!payload) return '';
  const keys = Object.keys(payload);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = payload[k];
    if (v == null) continue;
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${str.length > 40 ? str.slice(0, 40) + '…' : str}`);
  }
  return parts.join(' ');
}
