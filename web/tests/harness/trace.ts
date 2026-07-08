/**
 * B2 — behavioural trace capture (pwa-replay-harness Wave 3).
 *
 * Assembles the normalised per-utterance trace from THREE seams —
 * `clientDiagnostic` is one input, NOT the sole source (the apply-pipeline
 * diagnostics mostly omit written values, and the chime emits no
 * diagnostic at all):
 *   1. the diagnosticTap (gate decisions, regex changedKeys, sonnet send,
 *      ask/queue events);
 *   2. the jobStateObserver (applied {key, value, source} — what proves
 *      "the field landed with the spoken value");
 *   3. traceable injected effects (chime hook, TTS players).
 *
 * The trace JSON here is the common currency for WS-C's differ and WS-D's
 * invariants: per-utterance records of gate decision, regex changedKeys,
 * sonnet send y/n, applied fields, confirmations
 * enqueued/played/deferred/discarded, questions, chimes, feedback events.
 */

import type { JobStateChange } from '@/lib/recording/test-services';

export interface AppliedField {
  key: string;
  value: unknown;
  /** Write tier: regex | extraction | board_ops. */
  source: string;
}

export interface TraceEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface UtteranceTrace {
  /** Final transcript text as dispatched (post-normalisation preview). */
  text: string;
  gate: 'passed' | 'blocked' | 'none';
  regexChangedKeys: string[];
  sonnetSent: boolean;
  chimes: number;
  appliedFields: AppliedField[];
  confirmationsEnqueued: number;
  confirmationsPlayed: string[];
  confirmationsDeferred: number;
  confirmationsDiscarded: number;
  questionsAsked: string[];
  pendingReadingsAsks: number;
  rescuedFromBuffer: string[];
  feedbackEvents: string[];
  events: TraceEvent[];
}

export interface BehaviouralTrace {
  utterances: UtteranceTrace[];
  /** Events before the first final (session start etc.). */
  preamble: TraceEvent[];
  /** Whole-run rollups. */
  totals: {
    chimes: number;
    sonnetSends: number;
    pendingReadingsAsks: number;
    confirmationsPlayed: string[];
    confirmationsDiscarded: number;
    deferredNeverResumed: number;
  };
}

function emptyUtterance(text: string): UtteranceTrace {
  return {
    text,
    gate: 'none',
    regexChangedKeys: [],
    sonnetSent: false,
    chimes: 0,
    appliedFields: [],
    confirmationsEnqueued: 0,
    confirmationsPlayed: [],
    confirmationsDeferred: 0,
    confirmationsDiscarded: 0,
    questionsAsked: [],
    pendingReadingsAsks: 0,
    rescuedFromBuffer: [],
    feedbackEvents: [],
    events: [],
  };
}

/** Flatten a job-state patch into leaf {key, value} pairs (section.key or
 *  circuits[ref].key) so applied fields are diffable. */
export function flattenPatch(
  patch: Record<string, unknown>
): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = [];
  for (const [section, val] of Object.entries(patch)) {
    if (section === 'circuits' && Array.isArray(val)) {
      for (const row of val as Array<Record<string, unknown>>) {
        const ref = (row?.circuit_ref as string) ?? (row?.id as string) ?? '?';
        for (const [k, v] of Object.entries(row ?? {})) {
          if (k === 'id' || k === 'circuit_ref') continue;
          out.push({ key: `circuits[${ref}].${k}`, value: v });
        }
      }
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out.push({ key: `${section}.${k}`, value: v });
      }
    } else {
      out.push({ key: section, value: val });
    }
  }
  return out;
}

/**
 * Live collector. Wire its methods into the B1 seams (buildHarnessServices
 * does this in `withTrace` mode), then call `finalize()` after the replay.
 *
 * Attribution model: events belong to the most recent utterance (a new
 * `pipeline_final_transcript` starts a new record). In mock mode backend
 * frames are emitted synchronously per send, so attribution is exact; in
 * live mode late frames may attribute to the following utterance — the
 * WS-C differ compares per-utterance with order-tolerant loose lanes for
 * exactly this reason.
 */
export class TraceCollector {
  private seq = 0;
  private preamble: TraceEvent[] = [];
  private utterances: UtteranceTrace[] = [];
  /** dedupe-key → played count, for the deferred/discard bookkeeping. */
  private deferredOpen = 0;
  private discardedTexts: string[] = [];

  private current(): UtteranceTrace | null {
    return this.utterances.length > 0 ? this.utterances[this.utterances.length - 1] : null;
  }

  private push(kind: string, payload: Record<string, unknown>): TraceEvent {
    const ev = { seq: this.seq++, kind, payload };
    const cur = this.current();
    if (cur) cur.events.push(ev);
    else this.preamble.push(ev);
    return ev;
  }

  onDiagnostic = (category: string, payload: Record<string, unknown>): void => {
    if (category === 'pipeline_final_transcript') {
      this.utterances.push(emptyUtterance(String(payload.textPreview ?? '')));
    }
    this.push(category, payload);
    const cur = this.current();
    if (!cur) return;
    switch (category) {
      case 'transcript_gate_blocked':
        cur.gate = 'blocked';
        break;
      case 'pipeline_sonnet_send':
        cur.gate = 'passed';
        cur.sonnetSent = true;
        break;
      case 'pipeline_regex_applied':
        cur.regexChangedKeys = Array.isArray(payload.changedKeysPreview)
          ? (payload.changedKeysPreview as string[])
          : [];
        break;
      case 'pending_readings_ask':
        cur.pendingReadingsAsks += 1;
        break;
      case 'non_circuit_field_rescued_from_buffer':
        cur.rescuedFromBuffer.push(String(payload.field ?? ''));
        break;
      case 'tts_queue_enqueue':
        cur.confirmationsEnqueued += 1;
        break;
      case 'tts_queue_deferred':
        cur.confirmationsDeferred += 1;
        this.deferredOpen += 1;
        break;
      case 'tts_queue_resume':
        this.deferredOpen = Math.max(0, this.deferredOpen - 1);
        break;
      case 'onQuestion_entered':
        cur.questionsAsked.push(String(payload.questionPreview ?? ''));
        break;
      default:
        if (category.startsWith('feedback_')) cur.feedbackEvents.push(category);
    }
    // A discarded-prefetch / preempt-flush / overflow means a confirmation
    // died before playing.
    if (
      category === 'tts_queue_discarded_prefetch' ||
      category === 'tts_queue_overflow' ||
      category === 'tts_queue_preempt_flush'
    ) {
      const n =
        category === 'tts_queue_preempt_flush' ? Number(payload.discardedCount ?? 0) || 0 : 1;
      cur.confirmationsDiscarded += n;
      for (let i = 0; i < n; i++) this.discardedTexts.push('(unknown)');
    }
  };

  onJobChange = (change: JobStateChange): void => {
    const cur = this.current();
    const fields = flattenPatch(change.patch as Record<string, unknown>).map((f) => ({
      ...f,
      source: change.source,
    }));
    this.push('job_state_change', {
      source: change.source,
      changedKeys: change.changedKeys ?? [],
      fieldCount: fields.length,
    });
    if (cur) cur.appliedFields.push(...fields);
  };

  onChime = (): void => {
    this.push('chime', {});
    const cur = this.current();
    if (cur) cur.chimes += 1;
  };

  onTtsPlayed = (kind: 'confirmation' | 'direct', text: string): void => {
    this.push('tts_played', { kind, text });
    const cur = this.current();
    if (kind === 'confirmation' && cur) {
      cur.confirmationsPlayed.push(text);
      // A deferred head that finally played closes its deferral.
    }
  };

  finalize(finalJob?: Record<string, unknown>): BehaviouralTrace & {
    finalJob?: Record<string, unknown>;
  } {
    const totals = {
      chimes: this.utterances.reduce((n, u) => n + u.chimes, 0),
      sonnetSends: this.utterances.filter((u) => u.sonnetSent).length,
      pendingReadingsAsks: this.utterances.reduce((n, u) => n + u.pendingReadingsAsks, 0),
      confirmationsPlayed: this.utterances.flatMap((u) => u.confirmationsPlayed),
      confirmationsDiscarded: this.utterances.reduce((n, u) => n + u.confirmationsDiscarded, 0),
      deferredNeverResumed: this.deferredOpen,
    };
    return { utterances: this.utterances, preamble: this.preamble, totals, finalJob };
  }
}
