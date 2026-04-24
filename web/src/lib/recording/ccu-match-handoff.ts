/**
 * sessionStorage handoff between the Circuits tab (where the photo is
 * analysed + the matcher runs) and the Match Review page (which reads
 * the match result, lets the inspector reassign, and applies).
 *
 * Why sessionStorage instead of URL params:
 *   - The match payload includes the raw analysis (potentially 50+KB
 *     of board metadata, circuit hardware, confidence scores) plus the
 *     match array itself (one entry per analysed circuit, each with a
 *     snapshot of the existing circuit it was matched to). That's way
 *     beyond the ~2KB URL length limit Safari is comfortable with.
 *   - Using module-level state would break across page reloads (the
 *     inspector might come back to the review tab later). sessionStorage
 *     scopes the handoff to the current tab so it survives a soft reload
 *     but self-cleans when the tab closes.
 *   - Keyed by `jobId + nonce` so multi-tab + concurrent review flows
 *     can't cross-contaminate. A single global key would let the
 *     review page pick up a handoff from a DIFFERENT job tab opened
 *     just before.
 *
 * Shape stored in `cm-ccu-match-handoff:<jobId>:<nonce>`:
 *   {
 *     analysis,              // raw /api/analyze-ccu response
 *     matches,               // CircuitMatch[] from matchCircuits()
 *     boardId,                // target board for the apply step
 *     existingBoardCircuits, // snapshot of the board's circuits at
 *                            // match time (used by Reassign dropdown
 *                            // so the inspector can pick ANY circuit,
 *                            // not just the auto-matched ones).
 *     createdAt,             // ms timestamp — 30min TTL check on read
 *   }
 *
 * On the review page, the URL is
 *   /job/{id}/circuits/match-review?nonce={nonce}
 * so the query string has just a short opaque token; the heavy data
 * sits in sessionStorage where it belongs.
 */

import type { CCUAnalysis, CircuitRow } from '@/lib/types';
import type { CircuitMatch } from '@certmate/shared-utils';

/** 30 minutes — matches the backend analyze-ccu response cache TTL. */
const HANDOFF_TTL_MS = 30 * 60 * 1000;

export interface CcuMatchHandoff {
  analysis: CCUAnalysis;
  matches: CircuitMatch[];
  boardId: string;
  existingBoardCircuits: CircuitRow[];
  createdAt: number;
}

function storageKey(jobId: string, nonce: string): string {
  return `cm-ccu-match-handoff:${jobId}:${nonce}`;
}

/** Write a match result for later retrieval. Returns the nonce the
 *  caller should embed in the review page URL. */
export function writeMatchHandoff(
  jobId: string,
  payload: Omit<CcuMatchHandoff, 'createdAt'>
): string {
  const nonce =
    globalThis.crypto?.randomUUID?.() ?? `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const full: CcuMatchHandoff = { ...payload, createdAt: Date.now() };
  try {
    window.sessionStorage.setItem(storageKey(jobId, nonce), JSON.stringify(full));
  } catch {
    // Quota / private mode — fall through; the review page will see
    // null and bounce the user back to Circuits with a toast. Better
    // than silently failing mid-apply.
  }
  return nonce;
}

/** Read + consume a previously-written match handoff. Returns null if
 *  the nonce is unknown, the entry has expired, or JSON parsing fails.
 *  The caller is expected to clear after a successful apply via
 *  `clearMatchHandoff`; this function does NOT auto-clear on read so
 *  a soft reload of the review page still works. */
export function readMatchHandoff(jobId: string, nonce: string): CcuMatchHandoff | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(jobId, nonce));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CcuMatchHandoff;
    if (!parsed.createdAt || Date.now() - parsed.createdAt > HANDOFF_TTL_MS) {
      window.sessionStorage.removeItem(storageKey(jobId, nonce));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Remove a handoff — called after the inspector applies (or cancels
 *  explicitly) so a tab-reload doesn't resurrect the review screen. */
export function clearMatchHandoff(jobId: string, nonce: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(jobId, nonce));
  } catch {
    /* ignore */
  }
}
