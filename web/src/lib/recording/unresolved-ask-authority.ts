/**
 * PLAN-CD (feedback-2026-09-17 wave) — CD2's ONE canonical, non-consuming,
 * unresolved-backend-ask authority (Decision 18).
 *
 * WHY THIS EXISTS
 * ---------------
 * A locally parsed `ocpd_bs_en` command whose value the canonicaliser cannot
 * read is handed to the model as an ordinary transcript (Decision 7 handoff,
 * CD1) — but ONLY when no backend ask is live (Decision 15). With an ask live
 * the forwarded utterance can be consumed as the answer to an unrelated
 * question, so the client keeps today's spoken re-ask instead.
 *
 * "Is a backend ask live?" is a question about the BACKEND's registration
 * lifetime. Every existing client structure (the in-flight slot, the pending
 * FIFO, alert cards) is an ATTRIBUTION timer with a shorter expiry, and a
 * union of them is incomplete by construction. So this authority:
 *
 *   - LATCHES on an INTERACTIVE `ask_user_started` (never one whose
 *     `expected_answer_shape` is `'none'` — that frame is speech, not a
 *     question);
 *   - is a SET keyed by `tool_call_id` (a second ask never drops the first);
 *   - CLEARS only on an answer for that ask, its cancellation, a
 *     backend-equivalent timeout for its CLASS, or session reset;
 *   - never consumes, burns or resolves anything when read.
 *
 * The class and its lifetime come from `config/ask-class-lifetimes-v1.json`
 * through the generated module. No prefix and no lifetime literal lives in
 * this file: the fixture's `match` field is the rule, and `classifyAskId`
 * implements it.
 */
import { ASK_CLASS_LIFETIMES } from './ask-class-lifetimes-v1.generated';

export type AskClass = 'dispatcher' | 'dialogue-script' | 'unrecognised';

export interface AskClassification {
  askClass: AskClass;
  lifetimeMs: number;
}

/**
 * Classify a `tool_call_id` exactly as the fixture's `match` field specifies:
 * the input bytes as received (no trimming, no case folding), rows walked in
 * array order, the first row whose `prefix` is a leading case-sensitive
 * byte-prefix wins, and `default` when none matches.
 */
export function classifyAskId(toolCallId: string): AskClassification {
  for (const row of ASK_CLASS_LIFETIMES.rows) {
    if (toolCallId.startsWith(row.prefix)) {
      return { askClass: row.class as AskClass, lifetimeMs: row.lifetime_ms };
    }
  }
  return {
    askClass: ASK_CLASS_LIFETIMES.default.class as AskClass,
    lifetimeMs: ASK_CLASS_LIFETIMES.default.lifetime_ms,
  };
}

export interface UnresolvedAskEntry extends AskClassification {
  toolCallId: string;
  latchedAtMs: number;
}

export class UnresolvedAskAuthority {
  private readonly entries = new Map<string, UnresolvedAskEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Latch an `ask_user_started`. Returns whether the frame entered the
   * authority. Non-interactive frames (`expected_answer_shape: 'none'`) and
   * frames with no `tool_call_id` never do. A re-emitted id keeps its
   * ORIGINAL latch time: the backend registration it mirrors did not restart.
   */
  latch(toolCallId: string | null | undefined, expectedAnswerShape: unknown): boolean {
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) return false;
    if (expectedAnswerShape === 'none') return false;
    if (this.entries.has(toolCallId)) return true;
    this.entries.set(toolCallId, {
      toolCallId,
      latchedAtMs: this.now(),
      ...classifyAskId(toolCallId),
    });
    return true;
  }

  /** Clear condition 1 — an answer for that ask. */
  resolve(toolCallId: string | null | undefined): void {
    if (typeof toolCallId === 'string') this.entries.delete(toolCallId);
  }

  /** Clear condition 2 — cancellation (`cancel_pending_tts` by prefix). */
  cancelByPrefix(prefix: string): void {
    if (!prefix) return;
    for (const id of [...this.entries.keys()]) {
      if (id.startsWith(prefix)) this.entries.delete(id);
    }
  }

  /** Clear condition 4 — session reset. */
  reset(): void {
    this.entries.clear();
  }

  /**
   * The live entries. Clear condition 3 — the backend-equivalent timeout —
   * is applied here: an entry is live while fewer than its class lifetime
   * milliseconds have elapsed since it latched. Expired entries are dropped.
   * `isAnswered` screens ids the client has already answered, so an answer
   * recorded anywhere clears the entry even if no caller resolved it.
   */
  liveEntries(isAnswered?: (toolCallId: string) => boolean): UnresolvedAskEntry[] {
    const t = this.now();
    const live: UnresolvedAskEntry[] = [];
    for (const [id, entry] of [...this.entries]) {
      if (t - entry.latchedAtMs >= entry.lifetimeMs) {
        this.entries.delete(id);
        continue;
      }
      if (isAnswered?.(id)) {
        this.entries.delete(id);
        continue;
      }
      live.push({ ...entry });
    }
    return live;
  }

  /** The non-consuming read CD2's reject branch takes. */
  hasLive(isAnswered?: (toolCallId: string) => boolean): boolean {
    return this.liveEntries(isAnswered).length > 0;
  }
}
