'use client';

import * as React from 'react';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { api } from '@/lib/api-client';
import { getUser } from '@/lib/auth';

/**
 * Header-chrome bell for the /voice-feedback triage list.
 *
 * Mirrors `AlertsBell` (web/src/components/dashboard/alerts-bell.tsx):
 *   - Lives in the AppShell right-cluster, next to AlertsBell.
 *   - Badge count = number of `status='open'` voice-feedback rows
 *     reachable to the signed-in user. Drives off
 *     `api.voiceFeedbackList({status:'open', limit:1})` — we only need
 *     the `total` field from the wire envelope, so a limit-1 fetch is
 *     enough.
 *   - Refetches on `focus` + `visibilitychange` so a status-change
 *     happening on the detail page propagates to the badge when the
 *     user navigates back without a full shell remount.
 *
 * Why MessageSquare (and not Mic / Megaphone): the iOS pattern uses
 * SF Symbol "message" for inspector-feedback channels; MessageSquare
 * is the closest lucide-react primitive and reads as "annotation /
 * communication" without overloading the Bell affordance the
 * AlertsBell already owns.
 *
 * Failure mode: swallow errors. The bell is decorative; the page it
 * links to surfaces the real fetch state. We don't want to red-flash
 * the header chrome for a transient 5xx on an idle browser tab.
 */
export function VoiceFeedbackBell({ dataTour }: { dataTour?: string } = {}) {
  const [count, setCount] = React.useState<number>(0);

  React.useEffect(() => {
    const user = getUser();
    if (!user) return;
    let cancelled = false;

    const fetchCount = () => {
      void api
        .voiceFeedbackList({ status: 'open', limit: 1 })
        .then((res) => {
          if (cancelled) return;
          setCount(res.total);
        })
        .catch(() => {
          // See header doc — decorative bell, silent on errors.
        });
    };

    fetchCount();

    const onFocus = () => fetchCount();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchCount();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <Link
      href="/voice-feedback"
      aria-label={count > 0 ? `Voice feedback — ${count} open` : 'Voice feedback'}
      data-tour={dataTour}
      data-testid="voice-feedback-bell"
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
    >
      <MessageSquare className="h-5 w-5" strokeWidth={2} aria-hidden />
      {count > 0 ? (
        <span
          aria-hidden
          data-testid="voice-feedback-badge"
          className="absolute right-1 top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--color-status-processing)] px-1 text-[10px] font-bold text-black"
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
