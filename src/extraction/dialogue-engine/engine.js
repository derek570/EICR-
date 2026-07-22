/**
 * Dialogue script engine — slot-filling state machine that powers
 * ring-continuity, insulation-resistance, and (in PR2) OCPD / RCD /
 * RCBO walk-throughs.
 *
 * Replaces the per-domain `*-script.js` pattern. Each domain declares a
 * schema (slots, triggers, prompts) and the engine runs them
 * uniformly.
 *
 * Wire contract identical to the per-domain scripts: returns one of
 *   - { handled: false }
 *   - { handled: true, fallthrough: false }
 *   - { handled: true, fallthrough: true, transcriptText }
 * matching what `processRingContinuityTurn` and
 * `processInsulationResistanceTurn` returned. iOS sees no protocol
 * change.
 *
 * Single state object on the session: `session.dialogueScriptState`.
 * Replaces `session.ringContinuityScript` and
 * `session.insulationResistanceScript`. Only one script can be active
 * per session at a time — same constraint the previous design
 * enforced via mutually-exclusive triggers.
 */

import {
  parseCircuitDigit,
  findCircuitByDesignation,
  findCircuitsByDesignation,
  readExistingValues,
  stripDesignationFiller,
} from './helpers/circuit-resolution.js';
import {
  extractNamedFieldValues,
  nextMissingSlot,
  countFilledForCancel,
} from './helpers/extraction.js';
import { applyWrite } from './helpers/snapshot-write.js';
import {
  buildScriptAsk,
  buildScriptInfo,
  buildScriptConfirm,
  buildExtractionPayload,
  buildDisambiguationQuestion,
  safeSend,
  RESPONSE_EPOCH_REQUIRED,
} from './helpers/wire-emit.js';
import { applyDerivations } from './helpers/derivations.js';
import { circuitExistsInSnapshot } from '../stage6-multi-board-shape.js';
import { applyReadingToSnapshot, applyReadingFlagAware } from '../stage6-snapshot-mutators.js';
import {
  parseCircuitRange,
  formatBulkApplyConfirm,
  detectBroadcastIntent,
} from './parsers/circuit-range.js';
import { OBSERVATION_PATTERN } from '../pre-llm-gate.js';
import { coerceRecordReadingValue } from '../record-reading-coercion.js';
// P1 ring-script-hardening — "reading-like" classification for the
// confirmation branch's 5h idle rule (never consume a dictated reading into
// the miss counter). Leaf module (imports only node:module), no cycle.
import { detectStructuredReading } from '../stage6-pending-value.js';

/**
 * Process one transcript turn against all registered schemas. Walks the
 * schema list once. If a schema is currently active, only that schema's
 * active-path runs. Otherwise each schema's entry detector runs in
 * registry order until one matches.
 *
 * @param {object} ctx
 * @param {object} ctx.ws         iOS WebSocket — outgoing wire emit only
 * @param {object} ctx.session    EICRExtractionSession instance
 * @param {string} ctx.sessionId
 * @param {string} ctx.transcriptText
 * @param {Array}  ctx.schemas    Ordered list of dialogue schemas
 * @param {object} [ctx.logger]   Optional pino-style logger
 * @param {number} [ctx.now]      Override for test determinism
 */
export function processDialogueTurn(ctx) {
  const {
    ws,
    session,
    sessionId,
    transcriptText,
    schemas,
    logger,
    now = Date.now(),
    // M4: when set, runEntry applies explicitly-volunteered writes with
    // OVERWRITE semantics (bypasses the skip-already-seeded guard). Used only
    // by the IR voltage-phase escape hatch's reprocess, so a same-circuit
    // correction overwrites the stale seeded value instead of being dropped.
    overwriteVolunteered = false,
    // PLAN-C P4d (row 1) — the creation-time response epoch for every
    // ask_user_started this turn emits. Snapshotted by the caller from the
    // arming utterance's id (sonnet-stream passes msg.utterance_id; the
    // start-of-turn shadow-harness hooks pass responseEpochRef.current) and
    // threaded UNCHANGED through every nested engine fn to the builders. null
    // when there is no live arming utterance (test paths / legacy callers).
    responseEpoch = null,
    // P1 ring-script-hardening (Fix 4) — the RAW client reply, un-annotated.
    // sonnet-stream prepends the `[In response to TTS question…]` bracket to
    // transcriptText BEFORE invoking the engine; parsing that annotated
    // string in the confirmation branch lets extractNamedFieldValues read
    // R1/Rn/R2 out of the QUOTED question and lets detectPositive match
    // "correct" inside "All correct?" even when the reply is "No.". Every
    // confirmation-branch decision parses `replyText` (raw with annotated
    // fallback for direct callers); transcriptText stays the model-bound
    // fallthrough text.
    rawReplyText = null,
  } = ctx;
  if (!session) return { handled: false };
  if (!Array.isArray(schemas) || schemas.length === 0) return { handled: false };
  const text = typeof transcriptText === 'string' ? transcriptText : '';
  const replyText = typeof rawReplyText === 'string' ? rawReplyText : text;

  const state = session.dialogueScriptState;

  // Broadcast-intent pre-filter — when the inspector says "for all
  // circuits" / "every circuit" / "circuits 1 to 6" / "circuits 1, 3, 5",
  // bow out of script entry so Sonnet's set_field_for_all_circuits tool
  // (stage6-tool-schemas.js / stage6-dispatchers-circuit.js) handles the
  // broadcast. See session 27366AC6 (2026-05-25): the OCPD script
  // trigger-matched "breaker", asked "Which circuit?", and the
  // inspector's "all circuits" answer was quoted back as "What's the
  // circuit number for the all circuit?" because no parser at the
  // circuit-resolution step recognised broadcast scope.
  //
  // Critical guard: when the RCD post-completion bulk-apply prompt is
  // pending (state.bulkApplyPending), DO NOT intercept. That reply path
  // owns "yes all" / "all of them" via parseCircuitRange at line ~470
  // and the engine emits the bulk-apply confirm TTS itself.
  if (detectBroadcastIntent(text)) {
    if (!state?.active) {
      logger?.info?.('dialogue_broadcast_bypassed_entry', {
        sessionId,
        textPreview: text.slice(0, 80),
      });
      return { handled: false };
    }
    if (state.active && !state.bulkApplyPending) {
      // P1 ring-script-hardening — canonical position 0: NARROW
      // destructive-broadcast exemption during awaiting_confirmation.
      // "Clear the ring readings for ALL circuits" is a delete intent that
      // must reach the position-1 clearIntent preflight (server-note delete
      // exit), not be consumed here. The exemption is ONLY for replies that
      // ALSO match the schema's confirmationClearIntentPattern — a blanket
      // exemption would let "earths are 1.19 for all circuits" hit the 5b
      // named-amend, write ONLY the current circuit, and silently drop the
      // all-circuits scope. Non-matching broadcast replies keep today's
      // pre-filter behaviour (clear + fall through to Sonnet's
      // set_field_for_all_circuits).
      const preFilterSchema = schemas.find((s) => s.name === state.schemaName);
      const destructiveBroadcastBypass =
        state.awaiting_confirmation === true &&
        preFilterSchema?.confirmationClearIntentPattern &&
        preFilterSchema.confirmationClearIntentPattern.test(replyText);
      // Codex diff-review r1 — false comma-LIST exemption during
      // confirmation: the broadcast list regex misreads a single
      // circuit-scoped decimal reading ("Zs on circuit 17, 0.62" →
      // "circuit 17, 0") as a two-circuit list. Such a reply is a READING,
      // owned by the confirmation branch's 5h reading-like rule (the plan's
      // pinned exemplar). Bypass the pre-filter ONLY when neutralising the
      // false `circuit N, <decimal>` pair kills the broadcast signal
      // entirely — a reply with a genuine all/range/multi-circuit scope
      // keeps today's pre-filter behaviour. Confirmation-only: mid-collection
      // pre-filter behaviour is unchanged.
      const falseListDecimalBypass =
        state.awaiting_confirmation === true &&
        !destructiveBroadcastBypass &&
        /\bcircuits?\s+\d{1,3}\s*(?:,|and)\s*\d{1,3}\.\d/i.test(text) &&
        !detectBroadcastIntent(
          text.replace(/(\bcircuits?\s+\d{1,3}\s*)(?:,|and)(\s*\d{1,3}\.\d)/gi, '$1;$2')
        );
      if (!destructiveBroadcastBypass && !falseListDecimalBypass) {
        // Abort the active script: the inspector's broadcast intent
        // supersedes the partial single-circuit walk-through. Already-
        // committed snapshot writes (applyWrite calls earlier in this
        // session) are NOT rolled back — they're the inspector's confirmed
        // single-circuit readings. We only discard the in-memory working
        // copy and any pending_writes that hadn't been drained yet.
        //
        // Audio-First purge contract: when this clear abandons an
        // in-flight CONFIRMATION, the queued "All correct?" prompt is now
        // stale — purge it before the silent fallthrough (a state-clearing
        // silent fallthrough is a covered confirmation-abandonment exit).
        if (state.awaiting_confirmation === true && preFilterSchema) {
          sendScriptPurge(ws, preFilterSchema, sessionId);
        }
        logger?.info?.('dialogue_broadcast_aborted_mid_script', {
          sessionId,
          schemaName: state.schemaName,
          circuit_ref: state.circuit_ref,
          filled_keys: Object.keys(state.values ?? {}),
          pending_writes_count: Array.isArray(state.pending_writes)
            ? state.pending_writes.length
            : 0,
          textPreview: text.slice(0, 80),
        });
        clearScriptState(session);
        return { handled: false };
      }
      // Destructive broadcast during confirmation → fall through to the
      // active path; position 1 owns the turn.
    }
    // bulkApplyPending === true → fall through to the active-path
    // handler below; handleBulkApplyReply takes the turn via the
    // existing intercept.
  }

  // Paused-state hard-timeout sweep — paused scripts (active=false)
  // sit waiting for the resume hook to wake them after Sonnet creates
  // a matching circuit. If too much time has passed, the inspector
  // has clearly moved on and any later matching create_circuit (e.g.
  // an unrelated kitchen circuit) shouldn't accidentally resume the
  // stale IR session. Reuse the schema's hardTimeoutMs so the
  // tolerance matches the active-path sweep.
  if (state && state.paused && !state.active) {
    const schema = schemas.find((s) => s.name === state.schemaName);
    if (schema && now - (state.paused_at ?? 0) > schema.hardTimeoutMs) {
      logger?.info?.(`${schema.logEventPrefix}_paused_hard_timeout`, {
        sessionId,
        ms_since_paused: now - (state.paused_at ?? 0),
        ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
      });
      clearScriptState(session);
    }
  }

  // Active path: one script is in progress; only its handlers run.
  if (state?.active) {
    const schema = schemas.find((s) => s.name === state.schemaName);
    if (!schema) {
      // The active script belongs to a schema this caller didn't pass
      // in. Don't touch its state — return handled:false so the caller
      // proceeds with its normal flow (e.g. invoking the IR wrapper
      // while ring is the active script means ring stays untouched
      // and IR returns handled:false). The legacy two-wrapper call
      // pattern in sonnet-stream.js depends on this isolation.
      return { handled: false };
    } else {
      // Hard timeout sweep — if the script has been idle too long,
      // clear and fall through to entry detection. The user might be
      // starting a fresh script after stepping away.
      if (now - state.last_turn_at > schema.hardTimeoutMs) {
        logger?.info?.(`${schema.logEventPrefix}_hard_timeout`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          filled: Object.keys(state.values).length,
          ms_since_last_turn: now - state.last_turn_at,
        });
        // Audio-First purge contract (P1): a hard timeout by definition
        // means script prompts may be dangling unanswered — purge the
        // schema's queued TTS namespace before the silent clear. SCOPED to
        // schemas with a confirmation block (ring only today): the P1 purge
        // contract covers the ring confirmation machinery; IR/OCPD/RCBO/RCD
        // timeout wire behaviour stays unchanged (Codex diff-review r1).
        if (schema.confirmation?.buildMessage) {
          sendScriptPurge(ws, schema, sessionId);
        }
        clearScriptState(session);
        // Fall through to entry detection below.
      } else {
        return runActivePath({
          ws,
          session,
          sessionId,
          text,
          transcriptText,
          replyText,
          schema,
          schemas,
          logger,
          now,
          responseEpoch,
        });
      }
    }
  }

  // Post-completion reading correction (#1 belt-and-braces, field report
  // 2026-06-24). Within a short window after a schema with `correctionBreadcrumb`
  // finished, a NEGATION + value-only remainder ("No, 0.47") re-writes the last
  // reading leg. Runs BEFORE entry detection (a correction is not an entry) and
  // only when the breadcrumb's schema is in THIS call's schema list — so the
  // two-wrapper ring/IR dispatch (each invoked with a single-schema list) can't
  // consume the other's crumb. Writes directly to the snapshot (flag-aware, no
  // timeout re-arm) since the script has already cleared. Lifted from the
  // legacy script's item #2b.
  {
    const crumb = session.dialogueCorrectionBreadcrumb;
    const crumbSchema = crumb ? schemas.find((s) => s.name === crumb.schemaName) : null;
    const cbCfg = crumbSchema?.correctionBreadcrumb ?? null;
    if (crumb && cbCfg) {
      const currentBoardId = session.stateSnapshot?.currentBoardId ?? null;
      if (now - crumb.at <= cbCfg.windowMs && (crumb.boardId ?? null) === currentBoardId) {
        const m = text.match(cbCfg.correctionRe);
        if (m && cbCfg.valueOnlyRe.test(m[1])) {
          const corrected = cbCfg.valueParser(m[1]);
          if (corrected !== null && corrected !== undefined) {
            session.dialogueCorrectionBreadcrumb = null; // one-shot
            applyReadingFlagAware(session.stateSnapshot, {
              circuit: crumb.circuit_ref,
              field: crumb.field,
              value: corrected,
            });
            safeSend(
              ws,
              buildExtractionPayload(
                crumb.circuit_ref,
                [{ field: crumb.field, value: corrected }],
                crumbSchema.extractionSource
              )
            );
            const label = cbCfg.fieldLabels?.[crumb.field] ?? crumb.field;
            safeSend(
              ws,
              buildScriptInfo({
                toolCallIdPrefix: crumbSchema.toolCallIdPrefix,
                sessionId,
                kind: 'correction',
                text: `Got it, ${label} ${corrected}.`,
                now,
                responseEpoch,
              })
            );
            logger?.info?.(`${crumbSchema.logEventPrefix}_post_completion_correction`, {
              sessionId,
              circuit_ref: crumb.circuit_ref,
              field: crumb.field,
              value: corrected,
            });
            return { handled: true, fallthrough: false };
          }
        }
      }
    }
  }

  // 2026-05-31 — observation-prefixed utterances skip entry detection.
  // Field repro: inspector says "Observation: the RCD cover is cracked."
  // intending to log a defect. RCD schema's trigger regex (rcd.js:107
  // `\bRCD\b...`) matches the bare RCD mention and runEntry below
  // captures the turn — emitting "What's the BS number?" and clearing
  // any chance for Sonnet to call `record_observation`. The OBSERVATION_
  // PATTERN (pre-llm-gate.js:147) is the canonical signal that the
  // utterance is in observation-flow; honour it here by bailing to
  // Sonnet so the observation tool runs. Reached only when no script
  // is active — the active-path block above already returned for any
  // in-flight script (and an active script's own active-path handles
  // observation utterances via its existing topicSwitchTriggers list,
  // left untouched in this change).
  if (OBSERVATION_PATTERN.test(text)) {
    logger?.info?.('dialogue_entry_bypassed_observation', {
      sessionId,
      textPreview: text.slice(0, 80),
    });
    return { handled: false };
  }

  // [DEVIATION — Codex diff-review r1, WITHIN_INTENT] Cross-wrapper
  // terminal entry-guard veto. sonnet-stream invokes the ring, IR, and
  // protective-device wrappers SEQUENTIALLY on the same transcript; a
  // multi-scope destructive request ("delete the ring continuity and
  // insulation resistance readings for circuit 13") would be correctly
  // guard-skipped by the ring wrapper only to be hijacked by the IR
  // wrapper's unguarded trigger — the delete request still never reaches
  // the model. When ANY schema's entryExclusionPattern fires, the engine
  // records a short-lived per-session veto keyed on the EXACT transcript;
  // subsequent processDialogueTurn calls for the same text within the
  // window skip entry detection entirely (fall through to Sonnet). Checked
  // at CALL start only, so the within-call `continue` semantics of the
  // guard (a different schema in the SAME call may still enter) are
  // unchanged. Engine-only; no wire change.
  {
    // Keyed on the RAW reply (mini-review r1): the confirmation delete exit
    // REPLACES transcriptText with the server note before later wrappers
    // run, so the annotated text is not stable across wrappers — the raw
    // reply is (sonnet-stream passes the same msg.text to all three).
    const veto = session.dialogueEntryGuardVeto;
    if (veto && veto.text === replyText && Math.abs(now - veto.at) < ENTRY_GUARD_VETO_WINDOW_MS) {
      logger?.info?.('dialogue_entry_guard_veto_honoured', {
        sessionId,
        textPreview: text.slice(0, 80),
      });
      return { handled: false };
    }
  }

  // Entry detection — first matching schema wins.
  for (const schema of schemas) {
    const entry = detectEntry(text, schema);
    if (!entry.matched) continue;

    // Entry-exclusion guard — OPT-IN per schema (P1 ring-script-hardening,
    // 2026-07-22, generalising the Phase 6.1 RCD-only guard). Field repro for
    // the original RCD guard: session 60754E4D ("please delete RCD" ×6
    // re-entered the script). Field repro for ring: session B4C45F25 —
    // "Can you delete the readings for the ring continuity on circuit 13"
    // trigger-matched the ring schema, jumped straight to the all-filled
    // confirmation, and the delete intent never reached the model.
    //
    // A schema that supplies `entryExclusionPattern` (an object with a
    // `test(text)` method — RegExp or composite) opts in: when the pattern
    // matches, the engine falls through to Sonnet instead of entering.
    // Schemas WITHOUT the property keep today's behaviour unchanged
    // (IR/OCPD/RCBO). RCD's pattern preserves its combined
    // imperative+denial behaviour verbatim (moved to schemas/rcd.js); ring
    // supplies destructive/corrective verbs ONLY — question-form entries
    // ("Why haven't you added the ring continuity to circuit 17?") must
    // keep entering, because field evidence shows they usefully recover
    // the user. Sonnet has the right tools (`clear_reading` /
    // `delete_circuit` / `record_reading`) for the excluded utterances.
    if (schema.entryExclusionPattern && schema.entryExclusionPattern.test(text)) {
      logger?.info?.(`${schema.name}_entry_guard_skipped`, {
        sessionId,
        textPreview: text.slice(0, 80),
      });
      // Arm the cross-wrapper veto (see the check above the loop) so a
      // LATER wrapper's unguarded schema cannot capture this guarded
      // destructive utterance in the same turn. Keyed on the raw reply.
      session.dialogueEntryGuardVeto = { text: replyText, at: now };
      // Continue the loop in case a DIFFERENT schema also matched —
      // unlikely in practice (only RCD triggers on \bRCD\b alone) but
      // the structural guarantee is "fall through to Sonnet", not
      // "fall through to the next schema's trigger". Returning here
      // would block a hypothetical future cross-schema match, so
      // `continue` is the correct verb.
      continue;
    }

    return runEntry({
      ws,
      session,
      sessionId,
      text,
      schema,
      schemas,
      entry,
      logger,
      now,
      overwriteVolunteered,
      responseEpoch,
    });
  }

  return { handled: false };
}

// Bare yes/no replies to a slot confirm gate (#1 IR voltage). Kept deliberately
// tight — a value-bearing reply ("no, 250") is handled by re-parsing the slot,
// not by these, so a stray "no" never strands the value.
const AFFIRMATIVE_RE = /^\s*(?:yes|yeah|yep|yup|correct|that'?s right|aye)\b/i;
const NEGATIVE_RE = /^\s*(?:no|nope|nah|negative)\b/i;

// Cross-wrapper entry-guard veto window (see the veto block in
// processDialogueTurn). Generous enough to cover the ms-apart sequential
// wrapper calls within one transcript turn; short enough that a genuine
// later re-dictation of the same words re-evaluates from scratch.
const ENTRY_GUARD_VETO_WINDOW_MS = 5000;

// ── P1 ring-script-hardening (2026-07-22) — confirmation-branch helpers. ──

// Negated-positive guard: ring's detectPositive matches `correct`/`ok(ay)`
// ANYWHERE while NEGATIVE_RE only matches reply-INITIAL no/nope/nah — so
// "That's not correct" / "Not okay" would bypass the negation branch and
// false-finish the script. A negation token preceding the positive token
// within the clause ⇒ treat as a negation, never a confirm. Clause-bounded
// (`[^.?!]*?`), NOT a fixed character window, and `n't` may sit words away
// from the positive token — "It isn't actually correct" must never finish
// (Codex diff-review r1).
// Apostrophe variants (per-fix mini-review r1): ASCII n't, smart-quote
// n't, AND the ASR apostrophe-stripped auxiliary forms (isnt/wasnt/…,
// enumerated — a bare `nt\b` would false-match "current is correct").
const NEGATED_POSITIVE_RE =
  /(?:\b(?:not|never|no)\b|n['\u2019]t\b|\b(?:is|was|are|were|does|do|did|has|have|had|would|should|could|ca|ai|wo)nt\b)[^.?!]*?\b(?:correct|ok(?:ay)?|right|good|yes|confirm(?:ed)?)\b/i;

// Correction-cue veto for the 5f positive finish (Codex diff-review r2 +
// per-fix mini-review): detectPositive matches positive vocabulary
// ANYWHERE, so a reply pairing a positive token with an explicit
// correction cue ("Okay, R1 is wrong", "All good except R2", "All correct
// apart from R2", "That cannot be correct", "Yes, there is a mistake in
// R1" — the negation may sit in a LATER clause than the positive) would
// false-finish. A cue routes to the 5e negation flow instead — an
// unnecessary re-ask is always safer than accepting rejected readings.
// `cannot` is predicate-bound (cannot be correct / cannot confirm), never
// a bare token — "I cannot see anything wrong, so yes" must finish.
const CONFIRMATION_CORRECTION_CUE_RE =
  /(?:\b(?:wrong|incorrect|except|mistakes?)\b|\bapart\s+from\b|\bneeds?\s+(?:changing|correcting|redoing)\b|\b(?:cannot|can['\u2019]?t)\s+be\s+(?:correct|right)\b|\bcannot\s+confirm\b)/i;

// Polarity exemption for the cue veto: a cue governed by an emptiness
// quantifier is a CONFIRMATION, not a correction — "Yes, nothing is
// wrong" / "none of those are incorrect" / "cannot see anything wrong, so
// yes" must finish. Bare "no" is deliberately NOT in the quantifier set:
// "Actually no, R1 is wrong" is a genuine correction.
const CONFIRMATION_CUE_EXEMPT_RE =
  /\b(?:nothing|none|anything)\b[^.?!]{0,20}?\b(?:wrong|incorrect)\b/i;

// Composite 5f veto (shared with the legacy twin's mirror).
function isVetoedPositive(reply) {
  if (NEGATED_POSITIVE_RE.test(reply)) return true;
  if (CONFIRMATION_CORRECTION_CUE_RE.test(reply) && !CONFIRMATION_CUE_EXEMPT_RE.test(reply)) {
    return true;
  }
  return false;
}

// Non-ring contexts that must REJECT the ring named-extractors during a
// confirmation (extraction-safety qualification). The ring extractors
// capture the first digit within ~30 chars after CPC/earth/R1/R2, so
// "CPC size for circuit 17 is 2.5" would extract ring_r2_ohm=17 and
// "earth fault loop impedance is 0.62" would write ring_r2_ohm=0.62.
// Bare "earth(s) <value>" ring amendments stay valid — only the compounds
// below reject.
const RING_ANCHOR_SRC = '(?:cpc|c\\s*p\\s*c|earths?|lives?|neutrals?|r\\s*(?:1|2|n))';
const NON_RING_ADJ_SRC = '(?:sizes?|csa|mm2?|millimetre?s?|conductors?|cables?)';
const NON_RING_ADJACENT_RE = new RegExp(
  `\\b${RING_ANCHOR_SRC}\\b[^.?!]{0,30}?\\b${NON_RING_ADJ_SRC}\\b|\\b${NON_RING_ADJ_SRC}\\b[^.?!]{0,30}?\\b${RING_ANCHOR_SRC}\\b`,
  'i'
);
const R1_PLUS_R2_COMPOUND_RE = /\bR\s*1\s*(?:\+|\s+plus\s+)\s*R\s*2\b/i;
const NON_RING_EARTH_COMPOUND_RE =
  /\b(?:earth\s+fault\s+loop|loop\s+impedance|earth\s+electrode|electrode\s+resistance|earth\s+leakage)\b/i;

/**
 * Mask `circuit N` spans out of a reply so a circuit ref can never be
 * captured as a reading value by the named extractors (or by runEntry's own
 * internal extraction when the 5a preflight seeds a different circuit —
 * "ring continuity earths for circuit 17 are 1.19" must never write 17).
 * Length-preserving so proximity windows in the extractors stay honest.
 */
function maskCircuitSpans(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\bcircuit\s*\d{1,3}\b/gi, (m) => ' '.repeat(m.length));
}

/**
 * Masked-and-qualified named extraction for confirmation-mode replies
 * (canonical positions 5a evidence + 5b named-amend). Returns
 * `{rejected, values}` — `rejected: true` means the reply carries an
 * explicit NON-ring context and must fall through to the model untouched
 * (reading-like at 5h), never amend either circuit.
 */
function extractRingSafeNamedValues(replyText, schema) {
  if (
    NON_RING_ADJACENT_RE.test(replyText) ||
    R1_PLUS_R2_COMPOUND_RE.test(replyText) ||
    NON_RING_EARTH_COMPOUND_RE.test(replyText)
  ) {
    return { rejected: true, values: [] };
  }
  return {
    rejected: false,
    values: extractNamedFieldValues(maskCircuitSpans(replyText), schema.slots),
  };
}

/**
 * Collect every `circuit N` ref in a reply with NEGATION POLARITY: a ref is
 * negated when immediately preceded (whitespace only — a comma breaks the
 * clause, so a leading "No, circuit 17 …" does NOT negate 17) by
 * not/no/never. "No, not circuit 17 — circuit 13 …" → [{17, negated},
 * {13, unnegated}]. The `circuit N` form ONLY — never the bare
 * whole-utterance digit (`parseCircuitDigit` also matches a lone "1",
 * which is a legitimate ohms value when answering a pending-slot ask).
 */
function collectCircuitRefsWithPolarity(replyText) {
  const out = [];
  if (typeof replyText !== 'string' || !replyText) return out;
  for (const m of replyText.matchAll(/\bcircuit\s*(\d{1,3})\b/gi)) {
    const ref = Number(m[1]);
    if (!Number.isInteger(ref) || ref <= 0) continue;
    const before = replyText.slice(0, m.index);
    const negated = /\b(?:not|no|never)\s*$/i.test(before);
    out.push({ ref, negated });
  }
  return out;
}

// Enumerated non-ring field anchors for the reading-like classifier — a
// unit-less circuit-less anchored reading ("Zs was 0.62") must classify
// reading-like, never junk (a junk classification would consume a dictated
// reading into the miss counter — write-complete-readings invariant).
const READING_FIELD_ANCHOR_RE =
  /\b(?:zs|ze|pfc|pscc|efli|insulation|polarity|rcd|trip\s*time|r\s*1\s*(?:\+|plus)\s*r\s*2)\b/i;

/**
 * "Reading-like" classification for confirmation-position 5h (transition
 * table). PINNED mechanism: detectStructuredReading(...)?.complete === true
 * (covers NON-numeric complete readings like "earthing arrangement is
 * TN-C-S") OR hasNumericValueWithUnit OR a `circuit N` mention OR an
 * enumerated non-ring field anchor co-occurring with a number.
 */
function isReadingLikeReply(replyText) {
  if (typeof replyText !== 'string' || !replyText.trim()) return false;
  try {
    if (detectStructuredReading(replyText)?.complete === true) return true;
  } catch {
    // classifier must never take down the confirmation branch
  }
  if (hasNumericValueWithUnit(replyText)) return true;
  if (/\bcircuit\s*\d{1,3}\b/i.test(replyText)) return true;
  if (READING_FIELD_ANCHOR_RE.test(replyText) && /\d/.test(replyText)) return true;
  return false;
}

/**
 * Emit the schema-namespace TTS purge frame (`cancel_pending_tts`) — the
 * Audio-First purge contract for confirmation-abandonment exits. Always
 * purge BEFORE any replacement speech: the replacement shares the same
 * `srv-…` prefix and must not be swallowed by its own purge frame.
 */
function sendScriptPurge(ws, schema, sessionId) {
  safeSend(ws, {
    type: 'cancel_pending_tts',
    prefix: `${schema.toolCallIdPrefix}-`,
    sessionId,
  });
}

/**
 * Test if a transcript matches a schema's entry triggers. Returns
 * { matched, circuit_ref } — circuit_ref is the digit captured by the
 * trigger regex, or null if the regex matched but didn't bind a digit.
 *
 * Each trigger regex is expected to have an optional capture group at
 * position 1 for the circuit number.
 */
function detectEntry(text, schema) {
  if (typeof text !== 'string' || !text) return { matched: false, circuit_ref: null };
  for (const pattern of schema.triggers) {
    const m = text.match(pattern);
    if (m) {
      const ref = m[1] ? Number(m[1]) : null;
      const validRef = Number.isInteger(ref) && ref > 0 ? ref : null;
      return { matched: true, circuit_ref: validRef };
    }
  }
  return { matched: false, circuit_ref: null };
}

/**
 * Detect a different entry on a NEW circuit while one is already
 * active. Used so an inspector mid-script can seamlessly switch to a
 * different circuit by re-stating the entry phrase with a new ref.
 */
function detectDifferentEntry(text, schema, currentCircuitRef) {
  for (const pattern of schema.triggers) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const newRef = Number(m[1]);
      if (Number.isInteger(newRef) && newRef > 0 && newRef !== currentCircuitRef) {
        return newRef;
      }
    }
  }
  return null;
}

function clearScriptState(session) {
  if (session) session.dialogueScriptState = null;
}

// PLAN-backend-final.md Phase 6.2 — per-session deferred-slot memory.
// session.dialogueScriptState is cleared on defer / cancel / finish, so
// any deferred-slot tracking attached to it does NOT survive re-entry —
// exactly the failure mode session 60754E4D demonstrated where the RCD
// walk-through re-asked `rcd_bs_en` on every re-entry. The Map below
// lives OUTSIDE the transient script state on the session itself, so
// the deferral persists across the full session lifetime.
//
// Key shape: `${schemaName}:${circuit_ref ?? 'none'}`. Using a string
// key (not the schema object) means concurrent active sessions never
// alias each other's per-circuit deferred sets, and a single
// inspector deferring `rcd_bs_en` on circuit 1 does NOT silently
// suppress the slot on circuit 2.
function deferredSlotKey(schemaName, circuit_ref) {
  return `${schemaName}:${circuit_ref ?? 'none'}`;
}

function getDeferredSlots(session, schemaName, circuit_ref) {
  if (!session?.dialogueScriptDeferredSlots) return null;
  return session.dialogueScriptDeferredSlots.get(deferredSlotKey(schemaName, circuit_ref));
}

function ensureDeferredSlotsMap(session) {
  if (!session) return null;
  if (!(session.dialogueScriptDeferredSlots instanceof Map)) {
    session.dialogueScriptDeferredSlots = new Map();
  }
  return session.dialogueScriptDeferredSlots;
}

function addDeferredSlot(session, schemaName, circuit_ref, field) {
  if (!field) return;
  const map = ensureDeferredSlotsMap(session);
  if (!map) return;
  const key = deferredSlotKey(schemaName, circuit_ref);
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(field);
}

function clearDeferredSlot(session, schemaName, circuit_ref, field) {
  if (!field) return;
  const map = session?.dialogueScriptDeferredSlots;
  if (!(map instanceof Map)) return;
  const key = deferredSlotKey(schemaName, circuit_ref);
  const set = map.get(key);
  if (!set) return;
  set.delete(field);
  if (set.size === 0) map.delete(key);
}

/**
 * Detect whether the utterance carries a number+unit pattern that's
 * worth handing to Sonnet when the entry parsers missed everything.
 * Covers the EICR test-reading vocabulary: ms, ohms / mΩ / MΩ, mA,
 * volts, amps, kA. A bare digit ("RCD on circuit 2") deliberately
 * does NOT match — without a unit, "2" is a circuit number, not a
 * value, and the engine should still enter the walk-through.
 *
 * Repro: session 87856B72 (2026-05-26). Deepgram garbled "trip
 * time" → "triptan", so the RCD trigger /\bRCD\b/ matched but the
 * `\btrip\s*time\b` named-extractor missed. With this helper
 * returning true on "25 ms", runEntry bails to Sonnet, which
 * extracts the value via record_reading; tryEnterScriptFromWrites
 * then re-enters the script with the value pre-seeded.
 */
function hasNumericValueWithUnit(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /\d+(?:\.\d+)?\s*(?:m\s*s\b|millisecond|milliseconds|ohm|ohms|m\s*Ω|kΩ|MΩ|mega\s*ohms?|kilo\s*ohms?|mA\b|milli\s*amps?|amps?\b|kA\b|kilo\s*amps?|volts?\b|kV\b|kilo\s*volts?)/i.test(
    text
  );
}

/**
 * Build the re-ask question for the "couldn't resolve circuit" recovery
 * path. Quotes the user's failed answer back so the second attempt is
 * unambiguous: "What's the circuit number for the upstairs sockets?"
 *
 * Schemas may override via `schema.retryCircuitQuestion(text)`. Default
 * works for every walk-through because the load reference (the user's
 * text) is the schema-agnostic part of the question.
 *
 * Empty / whitespace-only text falls back to the schema's regular
 * `whichCircuitQuestion` — there's nothing useful to quote back.
 */
function buildCircuitRetryQuestion(schema, designationAttempt) {
  // F1AC26FB #3.2 — strip leading filler/articles + trailing punctuation
  // before quoting the user's failed answer back, so the re-ask reads
  // "…circuit number for the sockets?" not "…for the For the sockets.?".
  // If nothing useful survives the strip, fall back to the schema's bare
  // whichCircuitQuestion rather than echoing raw text.
  const trimmed = stripDesignationFiller(designationAttempt);
  if (typeof schema.retryCircuitQuestion === 'function') {
    const out = schema.retryCircuitQuestion(trimmed);
    if (typeof out === 'string' && out.length > 0) return out;
  }
  if (trimmed.length === 0) return schema.whichCircuitQuestion;
  return `What's the circuit number for the ${trimmed}?`;
}

/**
 * Initialise the dialogue state for a freshly-entered script.
 *
 * `circuit_retry_attempted` and `last_designation_attempt` (added 2026-04-30
 * after the 14 Silvertown Road repro — session 842A3289) drive the
 * "re-ask once before discarding pending_writes" recovery path in the
 * active-path handler below. See the comment on the unresolvable-circuit
 * branch for the failure mode they fix.
 */
function initScriptState(session, schema, circuit_ref, now) {
  // A new script invalidates any pending post-completion correction crumb —
  // closes the stale-fire window where a started-then-aborted script would
  // otherwise leave an OLD breadcrumb pointing at the wrong leg (#1).
  session.dialogueCorrectionBreadcrumb = null;
  session.dialogueScriptState = {
    active: true,
    schemaName: schema.name,
    circuit_ref,
    values: {},
    // One-shot pending value awaiting a standard-set confirm (#1 IR voltage).
    // Holds the non-standard Number the engine asked the inspector to repeat;
    // null when no confirm is in flight. Lives on state so it clears with the
    // script and never leaks across circuits.
    slotPendingConfirm: null,
    pending_writes: [],
    skipped_slots: new Set(),
    entered_at: now,
    last_turn_at: now,
    circuit_retry_attempted: false,
    last_designation_attempt: null,
    // Per-slot no-progress tracking (F1AC26FB #4.3). `{ field, misses }` —
    // counts CONSECUTIVE unparseable answers to the same expected slot so a
    // garble (Deepgram noise, off-enum reply) can't loop the same slot ask
    // forever. 2nd miss → format hint; 3rd miss → skip the slot + fall
    // through to Sonnet. Reset on any successful write / slot change.
    slot_no_progress: null,
    // entered_via_pivot is set true only by runPivot; default false on
    // every direct entry path (regex / runEntry / enterScriptByName).
    entered_via_pivot: false,
    pivoted_from: null,
    // Composite-figure capture: a bare value the named-extractors couldn't
    // tag to a slot ("the IR for the cooker is 299"). The schema's
    // bareEntryParser populates this in runEntry; the resume path asks a
    // disambiguation question before draining it into the right slot.
    ambiguous_bare_value: null,
    // Pause/resume markers — set by the second-miss fallthrough when
    // there's preserved context worth waking up later (ambiguous bare
    // value or queued pending_writes). `paused: true` + `active: false`
    // means the engine's entry-detection treats this as no-script-active
    // (so a fresh utterance can start a new script) but the resume hook
    // (post-Sonnet-turn, on create_circuit) can find this state and
    // re-enter the script with the new circuit_ref bound.
    paused: false,
    paused_designation_hint: null,
    paused_at: null,
    // Disambiguation phase: set by tryResumePausedScript when an
    // ambiguous bare value needs L-L vs L-E routing. The active-path
    // pre-slot check intercepts the next user reply, runs
    // schema.disambiguateBareValue(text), assigns the value to the
    // chosen slot, then continues to askNextOrFinish.
    awaiting_disambiguation: null,
    // Designation disambiguation — set when the entry or
    // circuit-resolution path matched ≥2 circuits with the same
    // designation (CCU often stamps three "Sockets" or two "Lighting"
    // rows from a single sticker). The engine asks "Which 'sockets' —
    // circuit 2, 4 or 7?"; the next active-turn validates the user's
    // digit answer is in this list, or runs a designation match
    // restricted to these refs ("the kitchen one" → unique). One retry
    // before falling through to Sonnet, mirroring circuit_retry.
    pending_designation_candidates: null,
    designation_disambiguation_retry_attempted: false,
    // 2026-05-26: end-of-loop confirmation. Set true by the engine
    // when all slots fill and the schema declares a `confirmation`
    // block. The next active turn runs through the confirmation
    // branch: named-field replies overwrite + re-emit confirmation,
    // positive replies call finishScript, anything else falls
    // through to Sonnet without clearing state.
    awaiting_confirmation: false,
    // ── P1 ring-script-hardening (2026-07-22) confirmation-correction
    // episode state. `confirmation_no_progress` counts CONSECUTIVE
    // confirmation-directed misses (negations, same-slot repeats, junk
    // while a pending slot is set — NEVER unrelated readings); the second
    // consecutive miss takes the audible cap exit. `confirmation_pending_slot`
    // remembers which slot a slot-name-only reply ("R1.") selected so the
    // next bare value writes it. `confirmation_negation_reask_emitted` is
    // the per-EPISODE at-most-once latch for the negation re-ask — a
    // counter-based rule would re-emit the byte-identical re-ask after a
    // slot-selection reset (No. → R1. → No.) straight into the client's
    // 30s text-keyed dedupe window (the feedback-91 silence class).
    confirmation_no_progress: 0,
    confirmation_pending_slot: null,
    confirmation_negation_reask_emitted: false,
    // M4 (2026-06-25, field session 6674E8C5): IR voltage-phase tracking.
    // `voltage_phase_entered_at` is stamped (once) by askNextOrFinish the
    // first time it emits the exclusive voltage ask; the step-6 voltage block
    // uses it for a one-shot 30s in-script re-ask on genuine silence. Do NOT
    // reuse last_turn_at for this — it resets to `now` at the top of every
    // active turn, so `now - last_turn_at ≈ 0` and the check would never fire.
    // `voltage_reask_done` makes that re-ask one-shot.
    voltage_phase_entered_at: null,
    voltage_reask_done: false,
  };
}

/**
 * 2026-05-26: transition the active script to end-of-loop confirmation.
 * Sets the flag and emits the schema's confirmation ask. Called from
 * `askNextOrFinish` when all slots are filled and the schema declares
 * a `confirmation` block. Mirrors the legacy
 * `ring-continuity-script.js#transitionToConfirmation` shape exactly so
 * the byte-identical replay tests stay green.
 */
function transitionToConfirmation({
  ws,
  session,
  sessionId,
  schema,
  logger,
  now,
  responseEpoch = RESPONSE_EPOCH_REQUIRED, // sentinel default — see askNextOrFinish
}) {
  const state = session.dialogueScriptState;
  if (!state || !schema?.confirmation?.buildMessage) return;
  state.awaiting_confirmation = true;
  safeSend(
    ws,
    buildScriptConfirm({
      toolCallIdPrefix: schema.toolCallIdPrefix,
      sessionId,
      circuit_ref: state.circuit_ref,
      question: schema.confirmation.buildMessage({ values: state.values }),
      reason: schema.confirmation.reason,
      now,
      responseEpoch,
    })
  );
  logger?.info?.(`${schema.logEventPrefix}_awaiting_confirmation`, {
    sessionId,
    circuit_ref: state.circuit_ref,
    values: { ...state.values },
  });
}

/**
 * Handle the entry turn for a schema (no prior state, trigger
 * matched). Resolves the circuit (regex or designation), seeds the
 * values map with any pre-existing snapshot values, applies any
 * volunteered values from the entry utterance, then asks for the next
 * missing slot.
 */
function runEntry({
  ws,
  session,
  sessionId,
  text,
  schema,
  schemas,
  entry,
  logger,
  now,
  overwriteVolunteered = false,
  responseEpoch = RESPONSE_EPOCH_REQUIRED, // sentinel default — see askNextOrFinish
}) {
  let circuitRef = entry.circuit_ref;
  let entryDesignationMatched = false;
  // Designation lookup at entry time. Three outcomes:
  //   - 1 candidate → resolve circuit immediately (existing behaviour).
  //   - 2+ candidates with a shared designation → CCU stamped multiple
  //     circuits with the same label ("Sockets" × 3). Circuit stays
  //     unresolved; the disambiguation ask below quotes the shared
  //     label and lists the candidate refs.
  //   - 0 candidates → existing fallthrough (engine asks "Which
  //     circuit?" generically; ANY digit/designation can resolve).
  // Only attempted when the entry regex didn't capture a digit, so a
  // "ring continuity for circuit 4" still wins via the digit path.
  let designationCandidates = [];
  let designationSharedLabel = null;
  if (circuitRef === null) {
    const lookup = findCircuitsByDesignation(session, text);
    if (lookup.candidates.length === 1) {
      circuitRef = lookup.matched;
      entryDesignationMatched = true;
    } else if (lookup.candidates.length >= 2) {
      designationCandidates = lookup.candidates;
      designationSharedLabel = lookup.sharedDesignation;
    }
  }

  const slotFields = schema.slots.map((s) => s.field);
  const existing = circuitRef ? readExistingValues(session, circuitRef, slotFields) : {};
  const volunteered = extractNamedFieldValues(text, schema.slots);

  // Handover-to-Sonnet bail. See session 87856B72 (2026-05-26): the
  // RCD trigger /\bRCD\b/ matched on "RCD triptan for upstairs
  // lighting is 25 ms" (Deepgram garbled "trip time" → "triptan"),
  // but the named-extractor missed the bare value. Old behaviour:
  // enter the script, immediately ask "What's the BS number?", and
  // the 25 ms is lost. New behaviour: when every entry-time signal
  // is empty (no named harvest, no snapshot context, no designation
  // ambiguity, AND the schema's bareEntryParser — if any — would
  // also miss) AND the utterance plainly carries a measurement
  // (hasNumericValueWithUnit), bail to Sonnet. The post-dispatch
  // tryEnterScriptFromWrites hook re-enters the script once Sonnet
  // writes a slot-owned value via record_reading.
  //
  // Skip reasons:
  //   - bare entry phrase ("RCD on circuit 2") — no number+unit, so
  //     the script enters as before to walk BS/type/mA.
  //   - designation ambiguity — engine owes a "Which 'sockets' — 2,
  //     4 or 7?" question that Sonnet can't replicate.
  //   - circuitRef===null + schema has bareEntryParser — the IR
  //     "299 megaohms before the cooker exists" path captures the
  //     bare value into the paused state for the resume hook. Bail
  //     here would drop that pause anchor.
  const bareParserWouldCapture =
    circuitRef === null &&
    volunteered.length === 0 &&
    typeof schema.bareEntryParser === 'function' &&
    schema.bareEntryParser(text) != null;
  if (
    volunteered.length === 0 &&
    Object.keys(existing).length === 0 &&
    designationCandidates.length === 0 &&
    !bareParserWouldCapture &&
    hasNumericValueWithUnit(text)
  ) {
    logger?.info?.(`${schema.logEventPrefix}_entry_handover_to_sonnet`, {
      sessionId,
      circuit_ref: circuitRef,
      textPreview: text.slice(0, 80),
    });
    return { handled: false };
  }

  initScriptState(session, schema, circuitRef, now);
  const state = session.dialogueScriptState;
  if (designationCandidates.length >= 2) {
    state.pending_designation_candidates = designationCandidates;
  }

  // Seed values from existing snapshot — skip-already-filled relies on this.
  for (const [f, v] of Object.entries(existing)) {
    if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
      state.values[f] = v;
    }
  }

  // Apply or queue volunteered values from the entry utterance.
  // Track any pivot request from a derivation (e.g., "OCPD on circuit
  // 5 BS EN 61009" enters OCPD with circuit and bs_en, derivation
  // pivots to RCBO mid-entry).
  const writes = [];
  let pivotTo = null;
  for (const w of volunteered) {
    // M4: normally skip a field already seeded from the snapshot (don't
    // re-write a value the inspector didn't restate). When overwriteVolunteered
    // is set (the voltage-phase escape-hatch reprocess), an explicitly-spoken
    // fresh value MUST overwrite the seeded value — otherwise a same-circuit IR
    // correction is silently dropped (the stale value persists). applyWrite
    // updates state.values too, so subsequent slot logic stays consistent.
    if (!overwriteVolunteered && state.values[w.field] !== undefined) continue;
    if (circuitRef !== null) {
      const slot = schema.slots.find((s) => s.field === w.field);
      const r = applyWriteWithDerivations(session, schema, slot, circuitRef, w.value, now);
      writes.push(w);
      // Audit-2026-06-02 Phase 2 — surface derivation mirrors/sets to
      // the same extraction envelope so iOS sees both columns update
      // on one audible confirmation. auto_resolved flags the derived
      // writes so the optimiser comparator can distinguish them from
      // direct inspector dictation.
      for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
      for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
      if (r.pivotTo) pivotTo = r.pivotTo;
    } else {
      // Circuit not yet known → queue. The active path drains
      // pending_writes once a digit or designation answer lands.
      state.pending_writes.push(w);
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(circuitRef, writes, schema.extractionSource));
  }

  // Composite-figure capture: when circuit_ref couldn't be resolved at
  // entry AND the named extractors didn't find a tagged value, try the
  // schema's bareEntryParser. For IR this catches "the IR for the
  // cooker is 299 milligrams" — a single value the inspector tossed out
  // before naming the circuit. Stashed in state for the resume path to
  // disambiguate (L-L vs L-E) once the circuit lands.
  //
  // Limited to the unresolved-circuit path because that's the failure
  // mode field-tested in session C3963EA1 (2026-05-02). Resolved-circuit
  // entries with bare values flow through the existing slot-by-slot
  // walk-through unchanged.
  //
  // Gating note: `writes` only ever populates when circuitRef !== null
  // (resolved-circuit path applies named values immediately). On the
  // unresolved path, named values land in `state.pending_writes` —
  // both must be empty for the bare parser to fire, otherwise an
  // utterance like "live to live 200 megaohms" (L-L tagged) would
  // also stash 200 as ambiguous.
  if (
    circuitRef === null &&
    writes.length === 0 &&
    state.pending_writes.length === 0 &&
    typeof schema.bareEntryParser === 'function'
  ) {
    const bare = schema.bareEntryParser(text);
    if (bare !== null && bare !== undefined) {
      state.ambiguous_bare_value = {
        value: bare,
        source: schema.bareEntrySource ?? 'bare',
      };
      logger?.info?.(`${schema.logEventPrefix}_bare_value_captured`, {
        sessionId,
        source: schema.bareEntrySource ?? 'bare',
        textPreview: text.slice(0, 80),
      });
    }
  }

  logger?.info?.(`${schema.logEventPrefix}_entered`, {
    sessionId,
    circuit_ref: circuitRef,
    entry_designation_matched: entryDesignationMatched,
    designation_candidates: designationCandidates.length >= 2 ? designationCandidates : [],
    pre_existing_filled: Object.keys(existing).filter((f) => slotFields.includes(f)),
    volunteered_writes: writes.map((w) => w.field),
    pending_writes: state.pending_writes.map((w) => w.field),
    ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
    textPreview: text.slice(0, 80),
  });

  // What do we ask next?
  if (circuitRef === null) {
    // 2+ candidates with the same designation → quote the shared label
    // back. Sole-match would have set circuitRef above; zero matches
    // falls through to the schema's generic question.
    const whichQuestion =
      designationCandidates.length >= 2
        ? buildDisambiguationQuestion(designationSharedLabel, designationCandidates)
        : schema.whichCircuitQuestion;
    safeSend(
      ws,
      buildScriptAsk({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        circuit_ref: null,
        missing_field: null,
        whichCircuitQuestion: whichQuestion,
        slotQuestion: null,
        now,
        kind: 'which_circuit',
        responseEpoch,
      })
    );
    return { handled: true, fallthrough: false };
  }

  // Pivot — entry-time derivation requested a schema transition.
  if (pivotTo) {
    return runPivot({
      ws,
      session,
      sessionId,
      schemas,
      fromSchema: schema,
      toSchemaName: pivotTo,
      logger,
      now,
      responseEpoch,
    });
  }

  return askNextOrFinish({ ws, session, sessionId, schema, logger, now, responseEpoch });
}

/**
 * Apply a write to the snapshot AND run any slot derivations. Returns
 * { pivotTo } so the caller can defer pivot handling to a clean point
 * in the active-path flow (after all in-utterance writes have landed).
 */
function applyWriteWithDerivations(session, schema, slot, circuit_ref, value, now) {
  applyWrite(session, schema, circuit_ref, slot.field, value, now);
  return applyDerivations({ session, schema, slot, value });
}

/**
 * Active path: a script is already in progress on this session. Walks
 * cancel → different-entry → topic-switch → per-slot-skip →
 * circuit-resolution → value-extraction → ask-next-or-finish, in that
 * order.
 */
function runActivePath({
  ws,
  session,
  sessionId,
  text,
  transcriptText,
  // P1 Fix 4 — the raw un-annotated reply (fallback: the annotated text).
  // EVERY confirmation-branch decision parses this; positions 2 and 4
  // (cancel + topic-switch) deliberately continue to parse the annotated
  // `text` unchanged — benign, the ring confirm question text contains no
  // cancel or topic-switch trigger; do NOT "fix" them to replyText.
  replyText = undefined,
  schema,
  schemas,
  logger,
  now,
  responseEpoch = RESPONSE_EPOCH_REQUIRED, // sentinel default — see askNextOrFinish
}) {
  const state = session.dialogueScriptState;
  state.last_turn_at = now;
  const reply = typeof replyText === 'string' ? replyText : text;

  // 0a. Bulk-apply reply (RCD, 2026-05-21 fix B slice 3). When the
  //     schema declared a `postCompletionAsk` and the engine emitted
  //     the follow-up prompt last turn, intercept the inspector's
  //     reply BEFORE any other active-path handler. The reply parses
  //     via the schema-bound `parseCircuitRange`; we apply the
  //     specified fields to the resolved circuit set, confirm out
  //     loud, then finish the script. Mutually exclusive with the
  //     disambiguation reply below — both gate on a single boolean
  //     flag so they can't coincide.
  if (state.bulkApplyPending && schema.postCompletionAsk) {
    return handleBulkApplyReply({
      ws,
      session,
      sessionId,
      text,
      schema,
      logger,
      now,
      responseEpoch,
    });
  }

  // 0. Disambiguation reply — when the resume hook asked "Was 299
  //    L-L or L-E?", intercept the answer here BEFORE cancel /
  //    different-entry / topic-switch detection. The user's reply is
  //    a routing answer ("live to live"), not a cancel verb or topic
  //    pivot, so the normal active-path checks would mis-classify
  //    them. Schema's disambiguateBareValue returns either
  //    { field } (assign + continue), { discard: true } (drop the
  //    bare value + continue), or null (unparseable — re-ask once,
  //    then discard on second miss).
  if (state.awaiting_disambiguation && typeof schema.disambiguateBareValue === 'function') {
    const bare = state.awaiting_disambiguation;
    const verdict = schema.disambiguateBareValue(text);
    if (verdict && verdict.field) {
      // Belt-and-braces: don't overwrite if the inspector somehow
      // filled the chosen slot in the meantime (rare but possible if
      // a parallel write landed).
      if (state.values[verdict.field] == null) {
        applyWrite(session, schema, state.circuit_ref, verdict.field, bare.value, now);
        state.values[verdict.field] = bare.value;
        safeSend(
          ws,
          buildExtractionPayload(
            state.circuit_ref,
            [{ field: verdict.field, value: bare.value }],
            schema.extractionSource
          )
        );
      }
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_resolved`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        bare_value: bare.value,
        target_field: verdict.field,
        textPreview: text.slice(0, 80),
      });
      state.awaiting_disambiguation = null;
      state.disambiguation_retry_attempted = false;
      return askNextOrFinish({ ws, session, sessionId, schema, logger, now, responseEpoch });
    }
    if (verdict && verdict.discard) {
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_discarded_by_user`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        bare_value: bare.value,
        textPreview: text.slice(0, 80),
      });
      state.awaiting_disambiguation = null;
      state.disambiguation_retry_attempted = false;
      return askNextOrFinish({ ws, session, sessionId, schema, logger, now, responseEpoch });
    }
    // Unparseable. Re-ask once, then drop the bare value on a second
    // miss so the script doesn't loop forever.
    if (!state.disambiguation_retry_attempted) {
      state.disambiguation_retry_attempted = true;
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_retry`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        textPreview: text.slice(0, 80),
      });
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          circuit_ref: state.circuit_ref,
          missing_field: '_ir_disambiguate_bare',
          whichCircuitQuestion: null,
          slotQuestion:
            typeof schema.bareDisambiguationQuestion === 'function'
              ? schema.bareDisambiguationQuestion(bare.value)
              : `Live-to-live or live-to-earth?`,
          now,
          kind: 'value',
          responseEpoch,
        })
      );
      return { handled: true, fallthrough: false };
    }
    logger?.info?.(`${schema.logEventPrefix}_disambiguation_dropped`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      bare_value: bare.value,
      reason: 'second_unparseable',
      textPreview: text.slice(0, 80),
    });
    state.awaiting_disambiguation = null;
    state.disambiguation_retry_attempted = false;
    return askNextOrFinish({ ws, session, sessionId, schema, logger, now, responseEpoch });
  }

  // P1 canonical position 1 — delete/clear-intent PREFLIGHT. Evaluated ONLY
  // when awaiting_confirmation===true (mid-collection destructive phrases
  // keep today's behaviour — the composed server note asserts a read-back +
  // "All correct?" that has not happened, a false antecedent; delete-at-entry
  // is owned by the Fix-1 entry guard). Runs BEFORE the generic cancel
  // branch so "clear/cancel the readings" takes the delete exit while bare
  // "cancel that" (no object noun) still falls to the preserve-and-exit
  // cancel path (ring's bare /\bcancel\b/ trigger would otherwise consume
  // it first). Position 1 also guarantees delete runs before bare-negation:
  // "No. Please delete them all." matches BOTH and MUST take the delete
  // exit (field session B4C45F25 feedback 90/91).
  //
  // The engine exits the script and falls through to the model with a
  // FIXED, server-controlled antecedent — no reading values interpolated
  // (stored values can be client-seeded text; interpolating them into the
  // trusted bracket is an injection risk). The model keeps clear_reading
  // ownership; the note supplies the read-back antecedent its bare-negation
  // rule needs. The delete exit deliberately REPLACES the client's
  // in_response_to annotation (the server-controlled antecedent supersedes
  // the client's quoted "All correct?" — two bracketed contexts would
  // confuse the model).
  if (
    state.awaiting_confirmation === true &&
    schema.confirmationClearIntentPattern &&
    schema.confirmationClearIntentPattern.test(reply)
  ) {
    // Purge the stale confirm prompt BEFORE the silent exit (the model's
    // reply owns this turn's audibility).
    sendScriptPurge(ws, schema, sessionId);
    const circuitN =
      Number.isInteger(state.circuit_ref) && state.circuit_ref > 0
        ? String(state.circuit_ref)
        : 'the current circuit';
    const serverNote =
      `[Server note: The assistant just read back the complete ring-continuity set ` +
      `(R1, Rn and R2) for circuit ${circuitN} and asked "All correct?". ` +
      `The user's reply follows.] `;
    logger?.info?.(`${schema.logEventPrefix}_confirmation_delete_exit`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      textPreview: reply.slice(0, 80),
    });
    // Arm the cross-wrapper veto (mini-review r1): a multi-scope destructive
    // reply ("delete the ring continuity and insulation resistance
    // readings") would otherwise be captured by a LATER wrapper's unguarded
    // trigger — the note-prefixed fallthrough transcript still contains the
    // sibling scope's trigger words. Keyed on the raw reply.
    session.dialogueEntryGuardVeto = { text: reply, at: now };
    clearScriptState(session);
    return { handled: true, fallthrough: true, transcriptText: `${serverNote}${reply}` };
  }

  // 1. Cancel — preserve writes, clear state, announce.
  if (matchesAny(text, schema.cancelTriggers)) {
    const { filled, total } = countFilledForCancel(state.values, schema.slots);
    logger?.info?.(`${schema.logEventPrefix}_cancelled`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled,
      textPreview: text.slice(0, 80),
    });
    // PLAN-backend-final.md Phase 6.3 — generalised cancel-drain: on any
    // *_script_cancelled, tell iOS to purge queued TTS in the script's
    // `srv-{script}-` namespace (AlertManager.purge(prefix:)). Repro:
    // session 60754E4D 14:17:58 — a stale "BS number?" surfaced with
    // queueDelayMs=18078 ms because the queued TTS outlived the cancel.
    //
    // ORDER (P1 Audio-First purge contract): in CONFIRMATION mode the purge
    // goes FIRST so the cancel acknowledgement (same `srv-…` prefix) cannot
    // be swallowed by its own purge frame. The generic non-confirmation
    // cancel keeps today's speak-then-purge order unchanged.
    const purgeFirst = state.awaiting_confirmation === true;
    if (purgeFirst) sendScriptPurge(ws, schema, sessionId);
    safeSend(
      ws,
      buildScriptInfo({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        kind: 'cancel',
        text: filled > 0 ? schema.cancelMessage({ filled, total }) : schema.cancelMessageEmpty,
        now,
        responseEpoch,
      })
    );
    if (!purgeFirst) sendScriptPurge(ws, schema, sessionId);
    clearScriptState(session);
    return { handled: true, fallthrough: false };
  }

  // 2. Different entry on a NEW circuit — seamlessly switch.
  // P1 canonical position 3 GATE: generic detectDifferentEntry must NOT
  // consume confirmation-mode replies — the confirmation branch's 5a
  // preflight owns different-circuit routing there (with masking, negation
  // polarity and overwriteVolunteered semantics the generic recursion
  // lacks).
  const newRef = state.awaiting_confirmation
    ? null
    : detectDifferentEntry(text, schema, state.circuit_ref);
  if (newRef !== null) {
    const { filled } = countFilledForCancel(state.values, schema.slots);
    logger?.info?.(`${schema.logEventPrefix}_switched_circuit`, {
      sessionId,
      from_ref: state.circuit_ref,
      to_ref: newRef,
      partial_filled_on_old: filled,
      textPreview: text.slice(0, 80),
    });
    clearScriptState(session);
    // Recurse so the fresh entry runs on the same transcript.
    return processDialogueTurn({
      ws,
      session,
      sessionId,
      transcriptText,
      schemas: [schema],
      logger,
      now,
      responseEpoch,
    });
  }

  // 3. Topic switch — clear state, fallthrough to Sonnet.
  if (matchesAny(text, schema.topicSwitchTriggers)) {
    const { filled } = countFilledForCancel(state.values, schema.slots);
    // M4(1b) (2026-06-25, field session 6674E8C5): a topic switch DURING the
    // exclusive (IR voltage) phase, with the two readings already captured,
    // must still READ THEM BACK (finishScript) and register a post-script
    // voltage re-ask — otherwise the captured LL/LE vanish silently. The
    // step-6 null-parse escape hatch can't cover this: a true topic-switch
    // trigger is caught HERE, before step 6. (Fresh IR readings are NOT
    // topic-switch triggers for the IR schema, so they route to step-6's 1a.)
    const exclusiveSlot = schema.slots.find((s) => s.exclusiveWhenExpected);
    const voltageVal = exclusiveSlot ? state.values[exclusiveSlot.field] : undefined;
    const inVoltagePhase =
      state.voltage_phase_entered_at != null &&
      exclusiveSlot &&
      (voltageVal === undefined || voltageVal === null || voltageVal === '');
    if (inVoltagePhase) {
      const readingSlots = schema.slots.filter((s) => !s.exclusiveWhenExpected);
      const readingsCaptured =
        readingSlots.length > 0 &&
        readingSlots.every((s) => {
          const v = state.values[s.field];
          return v !== undefined && v !== null && v !== '';
        });
      logger?.info?.(`${schema.logEventPrefix}_topic_switch_voltage_phase`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        filled,
        readings_captured: readingsCaptured,
        textPreview: text.slice(0, 80),
      });
      if (readingsCaptured && typeof schema.onExclusiveSlotAbandoned === 'function') {
        schema.onExclusiveSlotAbandoned(session, state.circuit_ref, now);
      }
      // finishScript reads back the captured readings AND clears state.
      finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
      return { handled: true, fallthrough: true, transcriptText };
    }
    logger?.info?.(`${schema.logEventPrefix}_topic_switch`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled,
      textPreview: text.slice(0, 80),
    });
    // P1 Audio-First purge contract: a topic switch OUT OF a confirmation
    // is a state-clearing silent fallthrough — the queued "All correct?"
    // prompt is stale; purge before the clear. Non-confirmation topic
    // switches keep today's behaviour (no purge).
    if (state.awaiting_confirmation === true) {
      sendScriptPurge(ws, schema, sessionId);
      // Mini-review r1: a DESTRUCTIVE multi-scope reply ("delete the ring
      // continuity and insulation resistance readings…") exits here via the
      // sibling scope's topic-switch trigger (the clearIntent proximity
      // bound cannot span two scope names) — arm the cross-wrapper veto so
      // the LATER wrapper's unguarded trigger cannot hijack the delete
      // request the model now owns. Keyed on the raw reply.
      if (schema.entryExclusionPattern && schema.entryExclusionPattern.test(reply)) {
        session.dialogueEntryGuardVeto = { text: reply, at: now };
      }
    }
    clearScriptState(session);
    return { handled: true, fallthrough: true, transcriptText };
  }

  // 3.5. Confirmation reply (2026-05-26). When the engine emitted the
  //      schema's `confirmation` ask last turn, route this turn's text
  //      through the four-way confirmation branch:
  //        a) Named-field overwrite → replace the slot value, re-emit
  //           confirmation with the updated readings. This is the
  //           explicit "say a new reading to amend an existing one"
  //           semantics — bypasses the normal skip-if-set guard.
  //        b) Schema-supplied positive confirmation → run finishScript
  //           (the canonical "Got it. R1 X, Rn Y, R2 Z." path) and
  //           clear state.
  //        c) Re-entry trigger ("ring continuity for circuit N" or
  //           equivalent for other schemas) → re-emit the confirmation
  //           ask. Handles inspectors re-stating the entry to revisit
  //           the readback.
  //        d) Anything else → fall through to Sonnet without clearing.
  //           State survives so the inspector can still amend or
  //           confirm on a later turn. Hard timeout eventually clears
  //           stale awaiting_confirmation state.
  if (state.awaiting_confirmation && schema.confirmation?.buildMessage) {
    const confirmCfg = schema.confirmation;

    // P1 ring-script-hardening — canonical confirmation order 5a–5h. Every
    // decision parses `reply` (the Fix-4 raw text with annotated fallback);
    // `transcriptText` (annotated) is reserved for model fallthroughs. The
    // normative counter/speech/state semantics live in the plan's
    // transition table and are pinned by dialogue-engine-ring-confirmation
    // tests.

    // Masked-and-qualified named extraction, shared by 5a evidence + 5b.
    const ringSafe = extractRingSafeNamedValues(reply, schema);

    // Clear + purge + fall through with the UNTOUCHED annotated transcript.
    // Used by the 5a guarded rejections, the 5b non-ring-context rejection,
    // and the 5h reading-like / plain-idle clears. NEVER counts toward the
    // cap — the cap must never consume an unrelated reading (the turn's
    // audibility is owned by the model's handling of the fallthrough; the
    // values the confirm was guarding are already written, so silently
    // closing the formality loses nothing audible).
    const clearAndFallThrough = (logEvent, extra = {}, { armVeto = false } = {}) => {
      logger?.info?.(`${schema.logEventPrefix}_${logEvent}`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        textPreview: reply.slice(0, 80),
        ...extra,
      });
      // Destructive-intent fallthroughs arm the cross-wrapper veto so a
      // later wrapper's unguarded trigger cannot capture the same guarded
      // utterance (mini-review r1). Keyed on the raw reply.
      if (armVeto) session.dialogueEntryGuardVeto = { text: reply, at: now };
      sendScriptPurge(ws, schema, sessionId);
      clearScriptState(session);
      return { handled: true, fallthrough: true, transcriptText };
    };

    // Audible cap exit — purge FIRST (the replacement line shares the
    // `srv-…` prefix and must not be swallowed by its own purge), then the
    // schema's cap-exit wording, then full clear. The cap turn speaks ONLY
    // this line.
    const takeNegationCapExit = () => {
      sendScriptPurge(ws, schema, sessionId);
      safeSend(
        ws,
        buildScriptInfo({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          kind: 'confirmation_cap_exit',
          text: confirmCfg.negationCapExit({ circuit_ref: state.circuit_ref }),
          now,
          responseEpoch,
        })
      );
      logger?.info?.(`${schema.logEventPrefix}_confirmation_cap_exit`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        textPreview: reply.slice(0, 80),
      });
      clearScriptState(session);
      return { handled: true, fallthrough: false };
    };

    const slotLabel = (field) =>
      confirmCfg.slotSelectors?.find((s) => s.field === field)?.label ?? field;

    const emitValueAsk = (field, questionText) => {
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          circuit_ref: state.circuit_ref,
          missing_field: field,
          whichCircuitQuestion: null,
          slotQuestion: questionText,
          now,
          kind: 'value',
          responseEpoch,
        })
      );
    };

    // The full-string-distinct alternate value request (same-slot repeats,
    // junk-while-pending, and the pending-slot post-reset negation all
    // speak this instead of a byte-identical repeat the client 30s
    // text-keyed dedupe would swallow).
    const emitPendingSlotAlternate = () => {
      const field = state.confirmation_pending_slot;
      emitValueAsk(field, `I still need a number for ${slotLabel(field)} — what should it be?`);
    };

    // Shared negation transitions (position 5e; also reached from 5f via
    // the negated-positive guard). Table rows: counter 0 + flag unset →
    // counter→1 + negationReask + set flag; counter 0 + flag SET
    // (post-reset re-negation) → counter→1 + a full-string-distinct
    // alternate; counter ≥1 → cap exit.
    const handleNegation = () => {
      if (state.confirmation_no_progress >= 1) {
        state.confirmation_no_progress = 2;
        return takeNegationCapExit();
      }
      state.confirmation_no_progress = 1;
      if (!state.confirmation_negation_reask_emitted) {
        state.confirmation_negation_reask_emitted = true;
        safeSend(
          ws,
          buildScriptConfirm({
            toolCallIdPrefix: schema.toolCallIdPrefix,
            sessionId,
            circuit_ref: state.circuit_ref,
            question: confirmCfg.negationReask,
            reason: confirmCfg.negationReason,
            now,
            responseEpoch,
          })
        );
        logger?.info?.(`${schema.logEventPrefix}_confirmation_negation_reask`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          textPreview: reply.slice(0, 80),
        });
        return { handled: true, fallthrough: false };
      }
      if (state.confirmation_pending_slot) {
        emitPendingSlotAlternate();
      } else {
        safeSend(
          ws,
          buildScriptConfirm({
            toolCallIdPrefix: schema.toolCallIdPrefix,
            sessionId,
            circuit_ref: state.circuit_ref,
            question: confirmCfg.negationReaskAlternate,
            reason: confirmCfg.negationReason,
            now,
            responseEpoch,
          })
        );
      }
      logger?.info?.(`${schema.logEventPrefix}_confirmation_negation_reask_alternate`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        pending_slot: state.confirmation_pending_slot,
        textPreview: reply.slice(0, 80),
      });
      return { handled: true, fallthrough: false };
    };

    // Non-ring-context rejection runs BEFORE the 5a preflight (Codex
    // diff-review r1): a reply carrying BOTH a ring trigger and an excluded
    // context ("ring continuity CPC size for circuit 17 is 2.5") must never
    // seed — the trigger would satisfy ringEvidence and runEntry's internal
    // extraction would re-capture the non-ring number as a ring value,
    // reopening the exact corruption class the qualification closes.
    // Rejected replies fall through to the model (reading-like handling).
    if (ringSafe.rejected) {
      return clearAndFallThrough('confirmation_non_ring_context_fallthrough');
    }

    // ── 5a. Different-circuit preflight (Fix 3). Runs AFTER the position-4
    // topic-switch check (which keeps FIRST claim on "circuit N is …"), so
    // only replies that dodge every topic-switch trigger reach here.
    const polarityRefs = collectCircuitRefsWithPolarity(reply);
    if (polarityRefs.length > 0) {
      const unnegated = [...new Set(polarityRefs.filter((r) => !r.negated).map((r) => r.ref))];
      const targets = unnegated.filter((ref) => ref !== state.circuit_ref);
      const allNegated = polarityRefs.every((r) => r.negated);
      if (targets.length >= 2 || allNegated) {
        // Multiple distinct unnegated targets, or every ref explicitly
        // negated — never guess a destination circuit (without polarity,
        // "No, not circuit 17 — circuit 13 …" would seed the explicitly
        // REJECTED circuit 17 with overwrite semantics).
        return clearAndFallThrough('confirmation_multi_ref_fallthrough', {
          unnegated_targets: targets,
          all_negated: allNegated,
        });
      }
      if (targets.length === 1) {
        const targetRef = targets[0];
        // ringSafe.rejected already exited above, so both evidence signals
        // here are extraction-safe.
        const ringEvidence = detectEntry(reply, schema).matched || ringSafe.values.length > 0;
        if (ringEvidence) {
          // Defence-in-depth: position 1 already intercepts any clearIntent
          // match before the confirmation branch — keep a cheap invariant
          // guard here.
          if (
            schema.confirmationClearIntentPattern &&
            schema.confirmationClearIntentPattern.test(reply)
          ) {
            return clearAndFallThrough(
              'confirmation_clear_intent_guarded',
              { target_ref: targetRef },
              { armVeto: true }
            );
          }
          // Object-less destructive forms ("fix/delete/clear ring
          // continuity for circuit 17") carry a trigger + a different ref
          // but not the object-qualified clearIntent shape — reject the
          // seed (5g-style guarded fallthrough) so they can never seed or
          // overwrite the named circuit.
          if (schema.entryExclusionPattern && schema.entryExclusionPattern.test(reply)) {
            return clearAndFallThrough(
              'confirmation_destructive_seed_rejected',
              { target_ref: targetRef },
              { armVeto: true }
            );
          }
          // Seed the NEW circuit: purge the stale confirm prompt, clear the
          // old episode, and run a synthetic entry. The extraction text is
          // the circuit-span-MASKED reply — passing the RAW reply would let
          // runEntry's own internal extractNamedFieldValues re-run unmasked
          // ("ring continuity earths for circuit 17 are 1.19" would capture
          // 17 as the earth value). `entry` carries the parsed ref (the
          // trigger patterns cannot bind a LEADING "Circuit 17 …" ref);
          // overwriteVolunteered so the dictated triple OVERWRITES a
          // pre-filled destination instead of being seed-skipped.
          logger?.info?.(`${schema.logEventPrefix}_confirmation_circuit_switch`, {
            sessionId,
            from_ref: state.circuit_ref,
            to_ref: targetRef,
            textPreview: reply.slice(0, 80),
          });
          sendScriptPurge(ws, schema, sessionId);
          clearScriptState(session);
          return runEntry({
            ws,
            session,
            sessionId,
            text: maskCircuitSpans(reply),
            schema,
            schemas,
            entry: { matched: true, circuit_ref: targetRef },
            logger,
            now,
            overwriteVolunteered: true,
            responseEpoch,
          });
        }
        // A bare different-circuit mention with NO ring content ("Zs on
        // circuit 17, 0.62") is NOT a ring circuit switch — it classifies
        // reading-like at 5h below and falls through to the model.
      }
      // targets.length === 0 → the only unnegated ref IS the current
      // circuit → stay (amend the current circuit at 5b).
    }

    // ── 5b. Named amend (masked + qualified extraction; the rejected case
    // exited before 5a).
    if (ringSafe.values.length > 0) {
      const overwrites = [];
      for (const w of ringSafe.values) {
        const slot = schema.slots.find((s) => s.field === w.field);
        const r = applyWriteWithDerivations(session, schema, slot, state.circuit_ref, w.value, now);
        state.values[w.field] = w.value;
        overwrites.push(w);
        // Audit-2026-06-02 Phase 2 — propagate derivation mirrors on
        // confirmation-time amends so a corrected ocpd_bs_en still
        // updates the rcd_bs_en column on the wire (same UX guarantee
        // as entry-time writes).
        for (const mw of r.mirrorWrites) overwrites.push({ ...mw, auto_resolved: true });
        for (const sw of r.setWrites) overwrites.push({ ...sw, auto_resolved: true });
      }
      if (overwrites.length > 0) {
        safeSend(
          ws,
          buildExtractionPayload(state.circuit_ref, overwrites, schema.extractionSource)
        );
      }
      // Genuine progress — reset the miss machinery; an explicit named
      // amend also satisfies any pending slot.
      state.confirmation_no_progress = 0;
      state.confirmation_pending_slot = null;
      transitionToConfirmation({ ws, session, sessionId, schema, logger, now, responseEpoch });
      logger?.info?.(`${schema.logEventPrefix}_confirmation_amended`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        overwritten: overwrites.map((w) => w.field),
      });
      return { handled: true, fallthrough: false };
    }

    // ── 5c. Pending-slot anchored value. ONLY the schema's whole-reply
    // anchored matcher may trigger a write — never the unrestricted slot
    // parser (parseOhms returns the first numeric token ANYWHERE:
    // "R1." → 1, "circuit 13" → 13 — silent corruption).
    if (state.confirmation_pending_slot && confirmCfg.pendingValuePattern) {
      const pv = reply.match(confirmCfg.pendingValuePattern);
      if (pv) {
        const slot = schema.slots.find((s) => s.field === state.confirmation_pending_slot);
        const parsed = slot && typeof slot.parser === 'function' ? slot.parser(pv[1]) : null;
        if (parsed !== null && parsed !== undefined) {
          const r = applyWriteWithDerivations(
            session,
            schema,
            slot,
            state.circuit_ref,
            parsed,
            now
          );
          state.values[slot.field] = parsed;
          const writes = [{ field: slot.field, value: parsed }];
          for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
          for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
          safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
          logger?.info?.(`${schema.logEventPrefix}_confirmation_pending_slot_amended`, {
            sessionId,
            circuit_ref: state.circuit_ref,
            field: slot.field,
            value: parsed,
          });
          state.confirmation_no_progress = 0;
          state.confirmation_pending_slot = null;
          transitionToConfirmation({ ws, session, sessionId, schema, logger, now, responseEpoch });
          return { handled: true, fallthrough: false };
        }
      }
    }

    // ── 5d. Slot-name-only selector — UNCONDITIONAL within the branch (a
    // slot name without a value is correction intent whether or not the
    // negation re-ask was emitted).
    const selected = Array.isArray(confirmCfg.slotSelectors)
      ? confirmCfg.slotSelectors.find((s) => s.selector.test(reply))
      : null;
    if (selected) {
      if (state.confirmation_pending_slot === selected.field) {
        // Repeated selection of the ALREADY-pending slot: a counted miss.
        // Re-emitting the byte-identical "What should R1 be?" would be
        // client-deduped (30s text-keyed window) — speak the alternate.
        state.confirmation_no_progress += 1;
        if (state.confirmation_no_progress >= 2) return takeNegationCapExit();
        emitPendingSlotAlternate();
        logger?.info?.(`${schema.logEventPrefix}_confirmation_same_slot_repeat`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          field: selected.field,
        });
        return { handled: true, fallthrough: false };
      }
      // First-time (or different-slot) selection — genuine progress.
      state.confirmation_pending_slot = selected.field;
      state.confirmation_no_progress = 0;
      emitValueAsk(selected.field, `What should ${selected.label} be?`);
      logger?.info?.(`${schema.logEventPrefix}_confirmation_slot_selected`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: selected.field,
      });
      return { handled: true, fallthrough: false };
    }

    // ── 5e. Bare negation (reply-initial NEGATIVE_RE).
    if (NEGATIVE_RE.test(reply)) {
      return handleNegation();
    }

    // ── 5f. Positive finish — guarded against negated positives: ring's
    // detectPositive matches `correct`/`ok(ay)` ANYWHERE, so "That's not
    // correct" / "Not okay" would false-finish without the guard (they are
    // negations that dodge the reply-initial NEGATIVE_RE).
    if (typeof confirmCfg.detectPositive === 'function' && confirmCfg.detectPositive(reply)) {
      if (isVetoedPositive(reply)) {
        return handleNegation();
      }
      // Deliberately NO purge on the positive finish (Audio-First purge
      // contract exemption): the only queued `srv-…` prompt here is the
      // just-ANSWERED confirm ask, already played — purging would risk
      // cancelling the "Got it." acknowledgement path. Today's finishScript
      // behaviour is preserved unchanged.
      finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
      return { handled: true, fallthrough: false };
    }

    // ── 5g. Guarded re-entry. An object-qualified delete already exited at
    // position 1; an object-less destructive trigger-bearing phrase for the
    // SAME circuit is rejected here (a different circuit was rejected at
    // the 5a exclusion check) and takes the guarded fallthrough — no
    // confirmation re-emit, stale state cleared, untouched transcript to
    // the model.
    if (detectEntry(reply, schema).matched) {
      if (schema.entryExclusionPattern && schema.entryExclusionPattern.test(reply)) {
        return clearAndFallThrough('confirmation_reentry_guarded', {}, { armVeto: true });
      }
      state.confirmation_pending_slot = null;
      state.confirmation_negation_reask_emitted = false;
      state.confirmation_no_progress = 0;
      transitionToConfirmation({ ws, session, sessionId, schema, logger, now, responseEpoch });
      return { handled: true, fallthrough: false };
    }

    // ── 5h. Idle — two sub-cases (the cap must never consume a reading).
    if (isReadingLikeReply(reply)) {
      // A reading-like reply that survived 5a–5g (e.g. "Zs on circuit 17,
      // 0.62", "PFC is 1.2 kA", "earthing arrangement is TN-C-S" — incl.
      // while a pending slot is set): the MODEL's handling of the reading
      // owns the turn's audibility. Not counted.
      return clearAndFallThrough('confirmation_reading_fallthrough');
    }
    if (state.confirmation_pending_slot) {
      // Non-reading junk while a value is pending — a confirmation-directed
      // miss. The FIRST miss always speaks (never silent); the second takes
      // the cap exit.
      state.confirmation_no_progress += 1;
      if (state.confirmation_no_progress >= 2) return takeNegationCapExit();
      emitPendingSlotAlternate();
      logger?.info?.(`${schema.logEventPrefix}_confirmation_pending_junk_miss`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: state.confirmation_pending_slot,
        textPreview: reply.slice(0, 80),
      });
      return { handled: true, fallthrough: false };
    }
    // Plain unclassified idle, no pending slot — clear the stale formality
    // and fall through untouched (replaces the old keep-state
    // `confirmation_idle` fallthrough, whose immortal awaiting_confirmation
    // state was the feedback-90/91 dead-end).
    return clearAndFallThrough('confirmation_idle_cleared');
  }

  // 4. Resolve circuit FIRST if pending. Digit answer preferred,
  //    designation answer falls out via findCircuitsByDesignation.
  //
  //    When `pending_designation_candidates` is set, the previous turn
  //    asked "Which 'sockets' — circuit 2, 4 or 7?". This turn must
  //    pick from that closed set:
  //      - digit answer → must be in the candidate list, else reject
  //        and run one retry. Stops "circuit 5" landing on a circuit
  //        that wasn't even an option.
  //      - non-digit answer → restrict the designation match to the
  //        candidate set. "the kitchen one" against [2, 4, 7] picks
  //        the one whose designation contains "kitchen", if unique.
  const candidateSet =
    Array.isArray(state.pending_designation_candidates) &&
    state.pending_designation_candidates.length >= 2
      ? state.pending_designation_candidates
      : null;
  const writes = [];
  let drainedFromPending = false;
  let circuitResolvedThisTurn = false;
  if (state.circuit_ref === null) {
    let ref = parseCircuitDigit(text);
    if (ref !== null && candidateSet && !candidateSet.includes(ref)) {
      // Digit answer outside the offered set. Reject and re-ask once.
      // Falls through to the existing `circuit_retry_attempted` block
      // below by clearing the digit and treating this turn as
      // unresolvable. Logged separately so CloudWatch can flag
      // inspectors who consistently pick out-of-set numbers.
      logger?.info?.(`${schema.logEventPrefix}_designation_disambiguation_out_of_set`, {
        sessionId,
        offered: candidateSet,
        rejected: ref,
        textPreview: text.slice(0, 80),
      });
      ref = null;
    }
    if (ref === null) {
      // Designation match. When a candidate set is offered, narrow the
      // search to those refs so a noisy designation ("kitchen" when
      // "kitchen" is also somewhere outside the candidate set) doesn't
      // pull a non-candidate ref. When no candidate set, full lookup
      // (existing behaviour).
      const lookup = findCircuitsByDesignation(
        session,
        text,
        candidateSet ? { restrictToRefs: candidateSet } : {}
      );
      if (lookup.matched !== null) {
        ref = lookup.matched;
        logger?.info?.(`${schema.logEventPrefix}_designation_match`, {
          sessionId,
          circuit_ref: ref,
          restricted: candidateSet ? candidateSet : null,
          textPreview: text.slice(0, 80),
        });
      }
    }
    if (ref !== null) {
      state.circuit_ref = ref;
      circuitResolvedThisTurn = true;
      // Clear the candidate set — disambiguation done.
      state.pending_designation_candidates = null;
      state.designation_disambiguation_retry_attempted = false;
      const slotFields = schema.slots.map((s) => s.field);
      const existing = readExistingValues(session, ref, slotFields);
      for (const [f, v] of Object.entries(existing)) {
        if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
          state.values[f] = v;
        }
      }
      // Drain pending_writes onto the now-resolved circuit.
      if (Array.isArray(state.pending_writes) && state.pending_writes.length > 0) {
        for (const w of state.pending_writes) {
          if (state.values[w.field] !== undefined) continue;
          // Defensive IR-LIM canonicalisation on drain (idempotent with the
          // validWrites coercion) — covers pending_writes queued from any
          // origin (seed path + followUpVolunteered) before they hit the
          // snapshot. Scoped to ir_live_* (F1AC26FB #4.2).
          const drainValue = w.field.startsWith('ir_live_')
            ? coerceRecordReadingValue(w.field, w.value)
            : w.value;
          applyWrite(session, schema, ref, w.field, drainValue, now);
          writes.push({ ...w, value: drainValue });
          drainedFromPending = true;
        }
        state.pending_writes = [];
      }
      logger?.info?.(`${schema.logEventPrefix}_circuit_resolved`, {
        sessionId,
        circuit_ref: ref,
        pre_existing_filled: Object.keys(state.values).filter(
          (f) => !writes.some((w) => w.field === f)
        ),
        drained_pending_writes: writes.map((w) => w.field),
        textPreview: text.slice(0, 80),
      });
    } else {
      // Couldn't resolve. Try to queue any volunteered values for a
      // later turn that DOES name the circuit.
      const followUpVolunteered = extractNamedFieldValues(text, schema.slots);
      if (followUpVolunteered.length > 0) {
        for (const w of followUpVolunteered) {
          const alreadyQueued = (state.pending_writes ?? []).some(
            (existing) => existing.field === w.field
          );
          if (alreadyQueued) continue;
          if (!Array.isArray(state.pending_writes)) state.pending_writes = [];
          state.pending_writes.push(w);
        }
        logger?.info?.(`${schema.logEventPrefix}_queued_values`, {
          sessionId,
          textPreview: text.slice(0, 80),
          queued_fields: followUpVolunteered.map((w) => w.field),
          pending_writes_total: state.pending_writes.length,
        });
        return { handled: true, fallthrough: false };
      }
      // First miss: re-ask once before discarding pending_writes. Save
      // the user's text so the re-ask can quote it back ("What's the
      // circuit number for the upstairs sockets?") and flag the retry
      // so a SECOND unresolvable answer falls through as before.
      //
      // Why re-ask instead of immediate fallthrough: 2026-04-30 14
      // Silvertown Road repro (session 842A3289). The inspector said
      // "Ring continuity lives are 0.32" → script enters with R1=0.32
      // queued and asks "Which circuit?". Inspector answers "upstairs
      // socket." (Deepgram dropped the trailing 's'). At THAT moment
      // circuit 4 had no `circuit_designation` on the snapshot —
      // Sonnet's `rename_circuit(4 → "upstairs sockets")` didn't land
      // for another 14s. The lookup returned null, the engine
      // discarded R1=0.32, and the inspector had to redo the entire
      // ring continuity test. Re-asking lets the engine recover when
      // the snapshot is empty / stale or when Deepgram garbled the
      // designation slightly. Two attempts before conceding to Sonnet
      // matches the legacy "Fix C deferred" TODO from the original
      // ring-continuity-script.js (line 798–800 in the legacy file).
      //
      // Why a flag (not a counter): one retry is enough to catch the
      // designation-not-yet-written race without dragging the
      // conversation. If the inspector is genuinely off-topic, the
      // second answer falls through to Sonnet just like before — same
      // exit log row + same discarded_pending_writes payload, plus a
      // `retry_attempted: true` field so CloudWatch can split first-
      // miss-recoveries from genuine fallthroughs.
      if (!state.circuit_retry_attempted) {
        state.circuit_retry_attempted = true;
        // F1AC26FB #3.2 — store the filler-stripped designation so the
        // re-ask echo and CloudWatch never carry raw "for the …" text.
        const stripped = stripDesignationFiller(text);
        state.last_designation_attempt = stripped.slice(0, 60);
        logger?.info?.(`${schema.logEventPrefix}_circuit_retry`, {
          sessionId,
          textPreview: text.slice(0, 80),
          pending_designation_candidates: candidateSet,
          pending_writes: Array.isArray(state.pending_writes)
            ? state.pending_writes.map((w) => w.field)
            : [],
        });
        // When we're still in disambiguation mode, repeat the
        // candidate list rather than asking a freeform "What's the
        // circuit number for the kitchen sockets?" — the inspector
        // already heard a candidate list once and the re-ask should
        // stay anchored to the same options. Re-derive the shared
        // designation from the snapshot (cheap; the candidate set is
        // small) so we keep the quoted-label form.
        let retryQuestion;
        if (candidateSet) {
          // Pull a representative designation from any candidate; if
          // they share, the helper will quote it back.
          const sharedLookup = findCircuitsByDesignation(session, '', {
            restrictToRefs: candidateSet,
          });
          // sharedLookup ignores empty text; fall back to scanning
          // the snapshot directly for the first candidate's designation.
          let sharedLabel = sharedLookup.sharedDesignation;
          if (!sharedLabel) {
            const snap = session?.stateSnapshot?.circuits;
            const firstRef = candidateSet[0];
            const bucket = Array.isArray(snap)
              ? snap.find((c) => Number(c?.circuit_ref) === Number(firstRef))
              : (snap?.[firstRef] ?? snap?.[String(firstRef)]);
            const des = bucket?.circuit_designation || bucket?.designation || null;
            sharedLabel = des ? des.toLowerCase().trim() : null;
            // Only quote it back if every candidate actually shares it.
            if (sharedLabel) {
              const all = candidateSet.every((r) => {
                const b = Array.isArray(snap)
                  ? snap.find((c) => Number(c?.circuit_ref) === Number(r))
                  : (snap?.[r] ?? snap?.[String(r)]);
                const d = b?.circuit_designation || b?.designation || '';
                return d.toLowerCase().trim() === sharedLabel;
              });
              if (!all) sharedLabel = null;
            }
          }
          retryQuestion = buildDisambiguationQuestion(sharedLabel, candidateSet);
        } else {
          retryQuestion = buildCircuitRetryQuestion(schema, state.last_designation_attempt);
        }
        safeSend(
          ws,
          buildScriptAsk({
            toolCallIdPrefix: schema.toolCallIdPrefix,
            sessionId,
            circuit_ref: null,
            missing_field: null,
            whichCircuitQuestion: retryQuestion,
            slotQuestion: null,
            now,
            kind: 'which_circuit',
            responseEpoch,
          })
        );
        return { handled: true, fallthrough: false };
      }

      // Second miss: fall through to Sonnet. Two behaviours:
      //
      // (a) Pause-and-preserve — when the schema opts in via
      //     `resumeAfterCircuitCreation: true` AND there's context
      //     worth resuming later (an ambiguous bare value from entry
      //     or queued pending_writes from named extractors). The
      //     resume hook (post-Sonnet-turn, in stage6 dispatcher)
      //     checks paused state on every create_circuit /
      //     rename_circuit and re-enters the script with the new
      //     circuit_ref bound when designation matches. `active:
      //     false` so the engine's entry-detection treats this as
      //     inactive — a brand-new utterance can still start fresh.
      //
      // (b) Existing behaviour — clear state and fall through. Used
      //     for schemas that haven't opted in (e.g. ring continuity —
      //     Silvertown repro deliberately discards on second miss),
      //     or when there's nothing meaningful to resume. The
      //     `retry_attempted: true` log field distinguishes this from
      //     a first-turn fallthrough either way.
      //
      // The pause path was added 2026-05-02 after field session
      // C3963EA1 (cooker circuit). Inspector said "Insulation
      // resistance for the cooker is 299 milligrams" before the cooker
      // circuit existed. Clear-and-fall-through silently discarded the
      // 299. With pause-and-preserve, Sonnet handles circuit creation
      // and the IR script picks back up with circuit_ref=2 and
      // ambiguous_bare_value still in state, ready for the L-L vs L-E
      // disambiguation step.
      const hasResumableContext =
        state.ambiguous_bare_value !== null ||
        (Array.isArray(state.pending_writes) && state.pending_writes.length > 0);

      if (schema.resumeAfterCircuitCreation === true && hasResumableContext) {
        state.active = false;
        state.paused = true;
        state.paused_designation_hint = text.trim().slice(0, 60);
        state.paused_at = now;
        logger?.info?.(`${schema.logEventPrefix}_paused_for_sonnet`, {
          sessionId,
          textPreview: text.slice(0, 80),
          paused_designation_hint: state.paused_designation_hint,
          ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
          preserved_pending_writes: Array.isArray(state.pending_writes)
            ? state.pending_writes.map((w) => w.field)
            : [],
          retry_attempted: true,
        });
        return { handled: true, fallthrough: true, transcriptText };
      }

      logger?.info?.(`${schema.logEventPrefix}_unresolvable_circuit`, {
        sessionId,
        textPreview: text.slice(0, 80),
        discarded_pending_writes: Array.isArray(state.pending_writes)
          ? state.pending_writes.map((w) => w.field)
          : [],
        retry_attempted: true,
      });
      clearScriptState(session);
      return { handled: true, fallthrough: true, transcriptText };
    }
  }

  // 5. Identify the slot we're currently expecting (next missing).
  // Phase 6.2 — deferredSet lookup keeps re-entered scripts from
  // re-asking a slot the inspector already deferred in an earlier
  // walk-through pass for this (schema, circuit) pair.
  const currentSlot = nextMissingSlot(
    state.values,
    schema.slots,
    state.skipped_slots,
    getDeferredSlots(session, schema.name, state.circuit_ref)
  );

  // 5a. Per-slot skip — schemas that opt in (PR2 OCPD/RCD/RCBO) let
  //     the inspector say "skip that" / "I don't know" to mark the
  //     CURRENT slot as deliberately blank and move on, without
  //     cancelling the whole script. Detected ONLY when there's a
  //     current slot to skip; if all slots are filled the cancel
  //     verbs (whole-script) take the same words via topicSwitchTriggers
  //     anyway.
  if (
    currentSlot &&
    Array.isArray(schema.skipSlotTriggers) &&
    matchesAny(text, schema.skipSlotTriggers)
  ) {
    state.skipped_slots.add(currentSlot.field);
    logger?.info?.(`${schema.logEventPrefix}_slot_skipped`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      field: currentSlot.field,
      textPreview: text.slice(0, 80),
    });
    return askNextOrFinish({ ws, session, sessionId, schema, logger, now, responseEpoch });
  }

  // 5b. Defer answer — when the current slot opts in via
  //     `acceptsDeferAnswer: true` (RCD's bs_en, 2026-05-21), the
  //     inspector can say "fill later" / "later" / "come back to it"
  //     to exit the WHOLE script for this circuit (NOT just blank one
  //     slot). Any values already written at entry — e.g. an
  //     opportunistically-volunteered rcd_trip_time — stay on the
  //     snapshot; only the remaining unfilled slots are abandoned. A
  //     brief "Okay, I'll come back to that later." TTS confirms the
  //     defer, then the script clears state so the next "RCD" trigger
  //     for the same circuit re-engages normally. Per user direction
  //     (293F074F follow-up): defer suppresses only the current
  //     auto-ask cascade, not future explicit re-mentions.
  if (
    currentSlot &&
    currentSlot.acceptsDeferAnswer &&
    Array.isArray(schema.deferTriggers) &&
    matchesAny(text, schema.deferTriggers)
  ) {
    const filledAtDefer = { ...state.values };
    // PLAN-backend-final.md Phase 6.2 — record the deferred slot on
    // the session-scoped map BEFORE clearScriptState wipes the
    // transient state. Next re-entry of this script for the same
    // circuit will skip the slot via nextMissingSlot's deferredSet
    // arg. The clear happens via clearDeferredSlot when the
    // inspector volunteers a value for the slot.
    addDeferredSlot(session, schema.name, state.circuit_ref, currentSlot.field);
    logger?.info?.(`${schema.logEventPrefix}_deferred`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      deferred_at_slot: currentSlot.field,
      filled_before_defer: Object.keys(filledAtDefer),
      textPreview: text.slice(0, 80),
    });
    safeSend(
      ws,
      buildScriptInfo({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        kind: 'defer',
        text: schema.deferMessage ?? "Okay, I'll come back to that later.",
        now,
        responseEpoch,
      })
    );
    clearScriptState(session);
    return { handled: true, fallthrough: false };
  }

  // 6. Schema-specific exclusive-parser hook (for IR voltage phase):
  //    when the current expected slot has `exclusiveWhenExpected: true`,
  //    skip named-field extraction and run only this slot's parser on
  //    the bare text. If nothing parses, finish silently.
  if (currentSlot && currentSlot.exclusiveWhenExpected) {
    const value = currentSlot.parser(text);

    // Local: write the parsed exclusive value (+ any derivations) and finish.
    const writeExclusiveAndFinish = (v) => {
      const r = applyWriteWithDerivations(session, schema, currentSlot, state.circuit_ref, v, now);
      writes.push({ field: currentSlot.field, value: v });
      // Audit-2026-06-02 Phase 2 — IR voltage / similar exclusive-slot parsers
      // don't currently have mirroring derivations, but the wire shape stays
      // consistent across paths if a future schema declares them.
      for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
      for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
      if (writes.length > 0) {
        safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
      }
      finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
      return { handled: true, fallthrough: false };
    };

    // M4 (2026-06-25, field session 6674E8C5): the voltage didn't parse to a
    // usable value. The legacy behaviour finished the script silently here,
    // which ATE any fresh reading the inspector dictated instead of a voltage
    // (e.g. "old house lights 2. Live to earth is 1.8") — dropping the whole
    // utterance AND reading back the prior circuit's stale values. This helper
    // disambiguates three cases (called from BOTH the confirm-gate and the
    // no-confirm-gate value===null paths so the escape hatch is never bypassed):
    //   (1a) fresh IR reading/entry → register the prior circuit's missed
    //        voltage (carrier), finish the prior circuit (read back its two
    //        captured readings once), then REPROCESS the fresh transcript with
    //        overwriteVolunteered so a same-circuit correction overwrites the
    //        seeded snapshot value instead of being skipped at runEntry:612.
    //   (3a) genuine silence/garble ≥30s in the voltage phase → one-shot
    //        in-script voltage re-ask (script stays active).
    //   else → legacy finish-and-consume (brief unparseable, no IR signal, <30s).
    const handleVoltageNoParse = () => {
      const freshVolunteered = extractNamedFieldValues(text, schema.slots);
      const freshEntry = detectEntry(text, schema).matched;
      if (freshVolunteered.length > 0 || freshEntry) {
        const readingSlots = schema.slots.filter((s) => !s.exclusiveWhenExpected);
        const readingsCaptured =
          readingSlots.length > 0 &&
          readingSlots.every((s) => {
            const v = state.values[s.field];
            return v !== undefined && v !== null && v !== '';
          });
        if (readingsCaptured && typeof schema.onExclusiveSlotAbandoned === 'function') {
          schema.onExclusiveSlotAbandoned(session, state.circuit_ref, now);
        }
        logger?.info?.(`${schema.logEventPrefix}_voltage_fresh_reading_escape`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          readings_captured: readingsCaptured,
          textPreview: text.slice(0, 80),
        });
        finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
        return processDialogueTurn({
          ws,
          session,
          sessionId,
          transcriptText,
          schemas: [schema],
          logger,
          now,
          overwriteVolunteered: true,
          responseEpoch,
        });
      }
      if (
        state.voltage_phase_entered_at != null &&
        !state.voltage_reask_done &&
        now - state.voltage_phase_entered_at >= 30_000
      ) {
        state.voltage_reask_done = true;
        logger?.info?.(`${schema.logEventPrefix}_voltage_reask`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          ms_in_phase: now - state.voltage_phase_entered_at,
          textPreview: text.slice(0, 80),
        });
        safeSend(
          ws,
          buildScriptAsk({
            toolCallIdPrefix: schema.toolCallIdPrefix,
            sessionId,
            circuit_ref: state.circuit_ref,
            missing_field: currentSlot.field,
            whichCircuitQuestion: schema.whichCircuitQuestion,
            slotQuestion: currentSlot.question,
            now,
            kind: 'value',
            responseEpoch,
          })
        );
        return { handled: true, fallthrough: false };
      }
      finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
      return { handled: true, fallthrough: false };
    };

    // Standard-value confirm gate (#1 — field report 2026-06-24, session
    // B0F28CFB). When the slot declares `confirmWhenNotIn` and the parsed value
    // is outside that set (a misheard "fifty" for "two fifty"), do NOT
    // write+finish. Re-ask as a one-shot confirmation and STAY in the slot so a
    // spoken correction ("No, 250") lands IN-LOOP on the active circuit. Pre-
    // fix the script finished on the misheard value, so the correction arrived
    // with no active script, fell to Haiku, and was mis-attributed to the
    // most-recently-focused circuit (4) instead of the IR circuit (2). This is
    // the live-engine port of the legacy script's item #2a (which never ran —
    // it lived in the dead insulation-resistance-script.js).
    const confirmSet = currentSlot.confirmWhenNotIn ?? null;
    if (confirmSet) {
      const pending = state.slotPendingConfirm ?? null;
      if (pending !== null) {
        // Replying to a "Did you say N volts?" confirm.
        if (value !== null && value !== undefined && Number(value) === Number(pending)) {
          // Repeated the SAME non-standard value → genuine meter reading, accept.
          state.slotPendingConfirm = null;
          return writeExclusiveAndFinish(value);
        }
        if (value !== null && value !== undefined) {
          // A DIFFERENT value ("No, 250") → clear the pending flag and fall
          // through to the standard decision below so the corrected value is
          // accepted (or re-confirmed if it too is non-standard).
          state.slotPendingConfirm = null;
        } else if (AFFIRMATIVE_RE.test(text)) {
          state.slotPendingConfirm = null;
          return writeExclusiveAndFinish(pending);
        } else if (NEGATIVE_RE.test(text)) {
          // Bare "no" with no value → re-ask, stay active (don't strand empty).
          state.slotPendingConfirm = null;
          state.last_turn_at = now;
          safeSend(
            ws,
            buildScriptAsk({
              toolCallIdPrefix: schema.toolCallIdPrefix,
              sessionId,
              circuit_ref: state.circuit_ref,
              missing_field: currentSlot.field,
              slotQuestion: currentSlot.question,
              now,
              kind: 'value',
              responseEpoch,
            })
          );
          return { handled: true, fallthrough: false };
        } else {
          // Unrecognised reply to the confirm (value===null, not yes/no). Could
          // be a FRESH reading dictated instead of confirming — route through the
          // M4 escape hatch (fresh-reading reprocess / 30s re-ask / finish)
          // rather than always finishing on the unconfirmed value.
          state.slotPendingConfirm = null;
          return handleVoltageNoParse();
        }
      }
      // Standard decision (no pending, or just cleared after a different value).
      if (value !== null && value !== undefined && !confirmSet.has(Number(value))) {
        state.slotPendingConfirm = Number(value);
        state.last_turn_at = now;
        safeSend(
          ws,
          buildScriptAsk({
            toolCallIdPrefix: schema.toolCallIdPrefix,
            sessionId,
            circuit_ref: state.circuit_ref,
            missing_field: currentSlot.field,
            slotQuestion:
              typeof currentSlot.confirmQuestion === 'function'
                ? currentSlot.confirmQuestion(value)
                : currentSlot.question,
            now,
            kind: 'value',
            responseEpoch,
          })
        );
        logger?.info?.(`${schema.logEventPrefix}_value_confirm_prompted`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          field: currentSlot.field,
          pending_value: value,
        });
        return { handled: true, fallthrough: false };
      }
      // Standard value → write + finish. Unparseable → M4 escape hatch
      // (fresh-reading reprocess / 30s re-ask / finish) instead of a silent
      // finish that would eat a fresh reading.
      if (value !== null && value !== undefined) {
        return writeExclusiveAndFinish(value);
      }
      return handleVoltageNoParse();
    }

    // No confirm gate declared — write (if any) + finish; unparseable → the
    // same M4 escape hatch.
    if (value !== null && value !== undefined) {
      return writeExclusiveAndFinish(value);
    }
    return handleVoltageNoParse();
  }

  // 7. Named-field extraction — multiple slots can fill from one
  //    utterance. Track any pivot request from a derivation.
  let pivotTo = null;
  const named = extractNamedFieldValues(text, schema.slots);
  for (const w of named) {
    if (state.values[w.field] !== undefined) continue;
    const slot = schema.slots.find((s) => s.field === w.field);
    const r = applyWriteWithDerivations(session, schema, slot, state.circuit_ref, w.value, now);
    writes.push(w);
    // PLAN-backend-final.md Phase 6.2 — volunteered-write clears the
    // deferred mark for this slot so the engine asks normally on the
    // NEXT re-entry. Inspector phrases the plan calls out — "come back
    // to BS number" / "set BS number" / "the BS code is 60898" — all
    // route through extractNamedFieldValues, so a single clear here
    // covers every override path. Pivot writes (record_reading on the
    // wire) reach this clear via the seed loop in
    // tryEnterScriptFromWrites below, which also calls
    // applyDerivations on each seeded slot.
    clearDeferredSlot(session, schema.name, state.circuit_ref, w.field);
    // Audit-2026-06-02 Phase 2 — mid-walk-through derivation mirrors
    // (e.g. inspector says "BS EN 61009" naming the rcd_bs_en slot;
    // RCBO mirror also fills ocpd_bs_en) ride the same extraction
    // envelope. Pre-Phase-2 only the named write made it to iOS.
    for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
    for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
    if (r.pivotTo) pivotTo = r.pivotTo;
  }

  // 8. Bare-value fallback. If no named matched on this turn, treat a
  //    bare value as the currently-expected slot. Suppressed when:
  //    a) we just drained pending writes (utterance already consumed
  //       by the resolver — e.g. "downstairs sockets" → designation
  //       match → c1 → drained R1).
  //    b) circuit_ref was JUST resolved this turn (the digit that
  //       resolved would otherwise re-parse as a value).
  //    c) the next-expected slot has acceptsBareValue=false.
  if (
    !drainedFromPending &&
    !circuitResolvedThisTurn &&
    named.length === 0 &&
    state.circuit_ref !== null &&
    currentSlot &&
    currentSlot.acceptsBareValue !== false
  ) {
    const bareValue = currentSlot.parser(text);
    // 2026-05-04 (field test 07635782 follow-up): per-slot allowed-value
    // gate. The OCPD breaking-capacity slot now declares the realistic kA
    // set ([1.5, 3, 4.5, 6, 10, 16, 20, 25, 36, 50, 80] — see
    // schemas/ocpd.js). When the inspector said "six" the engine accepted
    // it, then asked the breaking-capacity question, and Deepgram heard
    // the next answer as "66" — a kA value that doesn't exist for any
    // real MCB. The parser was OK with it (range 1..200) and it landed
    // on the cert. With this gate the engine treats out-of-set values
    // like a parser-failure: log + drop + re-ask. Set membership is
    // string-equality on the parser's canonical output so "6" and "6.0"
    // compare correctly (parseKa returns "6" not "6.0").
    if (
      bareValue !== null &&
      bareValue !== undefined &&
      Array.isArray(currentSlot.allowedValues) &&
      !currentSlot.allowedValues.includes(bareValue)
    ) {
      // Optional logger — same defensive pattern as runPivot uses
      // (some unit tests construct sessions without a logger). Drop
      // silently into the re-ask path if no logger is wired.
      logger?.info?.(`${schema.logEventPrefix}_slot_value_out_of_set`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: currentSlot.field,
        rejected_value: bareValue,
        allowed_count: currentSlot.allowedValues.length,
        textPreview: text.slice(0, 80),
      });
      // Fall through with bareValue cleared — engine re-asks the same
      // slot on the next turn (no write, no pivot).
    } else if (bareValue !== null && bareValue !== undefined) {
      const r = applyWriteWithDerivations(
        session,
        schema,
        currentSlot,
        state.circuit_ref,
        bareValue,
        now
      );
      writes.push({ field: currentSlot.field, value: bareValue });
      // Audit-2026-06-02 Phase 2 — bare-value derivation mirrors (e.g.
      // inspector answers a bare BS code while the engine has rcd_bs_en
      // expected; RCBO mirror to ocpd_bs_en) ride the same envelope.
      for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
      for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
      if (r.pivotTo) pivotTo = r.pivotTo;
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
  }

  // 9. Pivot — if a derivation requested a schema transition (e.g.,
  //    OCPD's bs_en slot fills with "BS EN 61009" → pivot to RCBO),
  //    close the current script's state, open the target's, carry
  //    over filled values, and ask the next missing slot for the new
  //    schema. This happens AFTER the writes emit so the wire shape
  //    shows the OCPD-side write before the RCBO ask.
  if (pivotTo) {
    return runPivot({
      ws,
      session,
      sessionId,
      schemas,
      fromSchema: schema,
      toSchemaName: pivotTo,
      logger,
      now,
      responseEpoch,
    });
  }

  // 9b. Per-slot no-progress cap (F1AC26FB #4.3). When we're actively
  //     expecting a slot and this turn produced NO write for it (the
  //     answer didn't parse — any garble, not just LIM), count consecutive
  //     misses on that slot. 2nd consecutive miss → emit a one-line format
  //     hint and re-ask. 3rd → mark the slot skipped and fall through to
  //     Sonnet so the loop can't run forever (the IR-LIM loop in F1AC26FB
  //     re-asked the same slot ~indefinitely until a cancel word). Reset
  //     whenever progress is made or the expected slot changes. Counting
  //     is gated on a resolved circuit_ref so it never collides with the
  //     circuit-resolution retry (#3.3 / circuit_retry_attempted). NOTE:
  //     no replay-corpus scenario hits 2 consecutive misses on one slot,
  //     so this adds no emit there and the legacy-vs-engine parity holds.
  const madeProgress =
    writes.length > 0 || pivotTo || circuitResolvedThisTurn || drainedFromPending;
  if (madeProgress) {
    state.slot_no_progress = null;
  } else if (currentSlot && state.circuit_ref !== null) {
    if (!state.slot_no_progress || state.slot_no_progress.field !== currentSlot.field) {
      state.slot_no_progress = { field: currentSlot.field, misses: 0 };
    }
    state.slot_no_progress.misses += 1;
    const misses = state.slot_no_progress.misses;
    if (misses >= 3) {
      state.skipped_slots.add(currentSlot.field);
      state.slot_no_progress = null;
      logger?.info?.(`${schema.logEventPrefix}_slot_no_progress_skip`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: currentSlot.field,
        textPreview: text.slice(0, 80),
      });
      return { handled: true, fallthrough: true, transcriptText };
    }
    if (misses === 2) {
      logger?.info?.(`${schema.logEventPrefix}_slot_no_progress_hint`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: currentSlot.field,
        textPreview: text.slice(0, 80),
      });
      safeSend(
        ws,
        buildScriptInfo({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          kind: 'no_progress_hint',
          text:
            schema.noProgressHint ??
            "Sorry, I didn't catch that. Say a number, 'greater than X', or 'LIM' — or say 'skip' to move on.",
          now,
          responseEpoch,
        })
      );
    }
  }

  return askNextOrFinish({ ws, session, sessionId, schema, logger, now, responseEpoch });
}

/**
 * Pivot from one schema to another. Carries over circuit_ref + any
 * filled values that the target schema's slot list covers (via
 * `readExistingValues` against the snapshot — derivation `sets` and
 * `mirrors` already wrote to the snapshot, so the target picks them
 * up automatically). Then asks the next missing slot for the new
 * schema.
 */
function runPivot({
  ws,
  session,
  sessionId,
  schemas,
  fromSchema,
  toSchemaName,
  logger,
  now,
  responseEpoch = RESPONSE_EPOCH_REQUIRED, // sentinel default — see askNextOrFinish
}) {
  const target = schemas.find((s) => s.name === toSchemaName);
  if (!target) {
    logger?.warn?.(`${fromSchema.logEventPrefix}_pivot_target_missing`, {
      sessionId,
      from: fromSchema.name,
      to: toSchemaName,
    });
    // Defensive — caller's schemas list missing the pivot target.
    // Fall through to ask the next missing on the source schema.
    return askNextOrFinish({
      ws,
      session,
      sessionId,
      schema: fromSchema,
      logger,
      now,
      responseEpoch,
    });
  }
  const previous = session.dialogueScriptState;
  const circuit_ref = previous?.circuit_ref ?? null;
  logger?.info?.(`${fromSchema.logEventPrefix}_pivot`, {
    sessionId,
    from: fromSchema.name,
    to: toSchemaName,
    circuit_ref,
  });
  initScriptState(session, target, circuit_ref, now);
  const state = session.dialogueScriptState;
  // 2026-04-30 (Codex P2 follow-up): tag the post-pivot state so
  // subsequent enterScriptByName calls hitting the already_active path
  // can report the provenance accurately. Without this, a defensive
  // Sonnet retry while RCBO is active (after an OCPD→RCBO pivot)
  // would receive `pivoted:false` from the dispatcher — wrong, the
  // active script DID arrive via pivot.
  state.entered_via_pivot = true;
  state.pivoted_from = fromSchema.name;
  // Hydrate the target's values from any snapshot fields its slots
  // cover. Includes anything the source schema wrote during this
  // turn (the derivations' sets+mirrors landed before pivot).
  const slotFields = target.slots.map((s) => s.field);
  const existing = circuit_ref ? readExistingValues(session, circuit_ref, slotFields) : {};
  for (const [f, v] of Object.entries(existing)) {
    if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
      state.values[f] = v;
    }
  }
  return askNextOrFinish({ ws, session, sessionId, schema: target, logger, now, responseEpoch });
}

/**
 * After any writes have landed, ask for the next missing slot or
 * finish the script. Shared between entry-path and active-path.
 */
function askNextOrFinish({
  ws,
  session,
  sessionId,
  schema,
  logger,
  now,
  // PLAN-C P4d — sentinel default (NOT null): a caller that forgets to thread
  // the epoch propagates the sentinel to the builder, which THROWS (a loud test
  // failure), instead of silently emitting an unstamped live ask. Entry points
  // (processDialogueTurn/enterScriptByName/tryResume*/tryEnter*) keep the null
  // default — a legacy caller with no arming utterance legitimately passes null.
  responseEpoch = RESPONSE_EPOCH_REQUIRED,
}) {
  const state = session.dialogueScriptState;
  const nextSlot = nextMissingSlot(
    state.values,
    schema.slots,
    state.skipped_slots,
    getDeferredSlots(session, schema.name, state.circuit_ref)
  );
  if (!nextSlot) {
    // Post-completion bulk-apply prompt (RCD, 2026-05-21 fix B
    // slice 3). When the schema declared a `postCompletionAsk` and
    // the engine hasn't emitted it yet on this script-run, emit it
    // instead of going straight to finish. The active-path's bulk-
    // apply intercept will route the inspector's reply on the next
    // turn. Gate on bulkApplyPending so an unparseable answer that
    // routes back through here (after handleBulkApplyReply finished
    // and cleared the flag) doesn't re-prompt.
    if (schema.postCompletionAsk && !state.bulkApplyPending) {
      state.bulkApplyPending = true;
      state.bulkApplyAskedAt = now;
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          now,
          kind: 'bulk_apply',
          slotQuestion: schema.postCompletionAsk.question,
          responseEpoch,
        })
      );
      logger?.info?.(`${schema.logEventPrefix}_bulk_apply_prompted`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        values: { ...state.values },
      });
      return { handled: true, fallthrough: false };
    }
    // End-of-loop confirmation (2026-05-26). Same opt-in pattern as
    // `postCompletionAsk` above: when the schema declares a
    // `confirmation` block and the engine hasn't emitted the prompt
    // yet on this script-run, emit it instead of finishing. The
    // active-path's confirmation intercept routes the inspector's
    // reply on the next turn. Mutually exclusive with bulk-apply in
    // practice (ring-continuity has confirmation; RCD has bulk-apply).
    if (schema.confirmation?.buildMessage && !state.awaiting_confirmation) {
      transitionToConfirmation({ ws, session, sessionId, schema, logger, now, responseEpoch });
      return { handled: true, fallthrough: false };
    }
    finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
    return { handled: true, fallthrough: false };
  }
  // M4 — stamp the moment the exclusive (IR voltage) slot ask is first
  // emitted, so the step-6 voltage block can fire a one-shot 30s in-script
  // re-ask on genuine silence. Stamp once (the slot stays exclusive until a
  // reply), and reset the one-shot flag the first time we enter the phase.
  if (nextSlot.exclusiveWhenExpected && state.voltage_phase_entered_at == null) {
    state.voltage_phase_entered_at = now;
    state.voltage_reask_done = false;
  }
  safeSend(
    ws,
    buildScriptAsk({
      toolCallIdPrefix: schema.toolCallIdPrefix,
      sessionId,
      circuit_ref: state.circuit_ref,
      missing_field: nextSlot.field,
      whichCircuitQuestion: schema.whichCircuitQuestion,
      slotQuestion: nextSlot.question,
      now,
      kind: 'value',
      responseEpoch,
    })
  );
  return { handled: true, fallthrough: false };
}

/**
 * Handle the inspector's reply to a `postCompletionAsk` prompt
 * (RCD bulk-apply, 2026-05-21 fix B slice 3).
 *
 * Parses the reply via `parseCircuitRange`:
 *   - 'none'  → decline / unparseable → no bulk write, normal finish
 *   - 'all'   → copy schema.postCompletionAsk.fields to every
 *               positive-int circuit ref on the snapshot (except the
 *               script's own circuit, already filled)
 *   - 'range' → copy to circuits start..end (creates blanks for
 *               unknown numbers; user direction 2026-05-21)
 *   - 'list'  → copy to the listed circuits (creates blanks)
 *
 * Per user direction: bulk-apply OVERWRITES existing values on
 * target circuits, NEVER skips-and-fills-blanks. The inspector is
 * authoritatively telling the system "these RCD details apply
 * everywhere I just said".
 *
 * Trip time is excluded by virtue of not being in
 * `postCompletionAsk.fields` — per-circuit reading, not a shared
 * device property.
 */
function handleBulkApplyReply({
  ws,
  session,
  sessionId,
  text,
  schema,
  logger,
  now,
  responseEpoch = RESPONSE_EPOCH_REQUIRED, // sentinel default — see askNextOrFinish
}) {
  const state = session.dialogueScriptState;
  const ask = schema.postCompletionAsk;
  const fieldsToPropagate = Array.isArray(ask.fields) ? ask.fields : [];
  const fieldsLabel = ask.fieldsLabel ?? schema.name.toUpperCase();
  const parse = parseCircuitRange(text);

  // Resolve the target circuit set.
  let targetCircuits = [];
  if (parse.scope === 'all') {
    const snapshotRefs = Object.keys(session.stateSnapshot?.circuits ?? {})
      .map((k) => parseInt(k, 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== state.circuit_ref)
      .sort((a, b) => a - b);
    targetCircuits = snapshotRefs;
  } else if (parse.scope === 'range' || parse.scope === 'list') {
    targetCircuits = parse.circuits.filter((n) => n !== state.circuit_ref);
  }

  // Build the value bundle from the script's filled values.
  const values = {};
  for (const field of fieldsToPropagate) {
    const v = state.values[field];
    if (v !== undefined && v !== null && v !== '') values[field] = v;
  }

  // Apply per target circuit. applyReadingToSnapshot auto-creates the
  // bucket if missing — that's exactly the "create blank circuit"
  // behaviour the user asked for.
  let writeCount = 0;
  for (const ref of targetCircuits) {
    const circuitWrites = [];
    for (const [field, value] of Object.entries(values)) {
      applyReadingToSnapshot(session.stateSnapshot, { circuit: ref, field, value });
      circuitWrites.push({ field, value });
      writeCount += 1;
    }
    if (circuitWrites.length > 0) {
      safeSend(ws, buildExtractionPayload(ref, circuitWrites, schema.extractionSource));
    }
  }

  logger?.info?.(`${schema.logEventPrefix}_bulk_applied`, {
    sessionId,
    scope: parse.scope,
    target_count: targetCircuits.length,
    targets: targetCircuits.slice(0, 50),
    fields: Object.keys(values),
    writes: writeCount,
    textPreview: text.slice(0, 80),
  });

  // Confirm out loud (per user direction 2026-05-21) — but ONLY when
  // a write actually happened. Scope 'none' or empty target set →
  // skip the bulk confirm and fall through to the normal finish TTS
  // ("Got it. BS EN 61008, type AC, 30 mA.").
  if (parse.scope !== 'none' && targetCircuits.length > 0) {
    const confirm = formatBulkApplyConfirm(parse.scope, parse, fieldsLabel);
    if (confirm) {
      safeSend(
        ws,
        buildScriptInfo({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          kind: 'bulk_apply_done',
          text: confirm,
          now,
          responseEpoch,
        })
      );
    }
    // Clear the bulk-apply state and the rest of the script. Don't
    // call finishScript here — the bulk-apply confirm IS the closing
    // TTS, and finishScript would emit the redundant "Got it." line.
    clearScriptState(session);
    if (typeof schema.onFinish === 'function') {
      schema.onFinish(session, state.circuit_ref);
    }
    return { handled: true, fallthrough: false };
  }

  // Decline or unparseable — finish normally with the schema's
  // standard completion TTS. The user got asked, said no (or
  // mumbled), so the script wraps up the original circuit's RCD
  // read-out and exits.
  finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
  return { handled: true, fallthrough: false };
}

/**
 * Emit the schema's completion TTS, log, and clear state. The schema
 * supplies its own `finishMessage(values)` for byte-identical output.
 */
function finishScript({
  ws,
  session,
  sessionId,
  schema,
  logger,
  now,
  responseEpoch = RESPONSE_EPOCH_REQUIRED, // sentinel default — see askNextOrFinish
}) {
  const state = session.dialogueScriptState;
  if (!state) return;
  const { circuit_ref, values } = state;
  safeSend(
    ws,
    buildScriptInfo({
      toolCallIdPrefix: schema.toolCallIdPrefix,
      sessionId,
      kind: 'done',
      text: schema.finishMessage({ values }),
      now,
      responseEpoch,
    })
  );
  logger?.info?.(`${schema.logEventPrefix}_completed`, {
    sessionId,
    circuit_ref,
    values: { ...values },
  });
  // Post-completion correction breadcrumb (#1 belt-and-braces, field report
  // 2026-06-24). Leave a short-lived crumb naming the last reading leg written
  // so a "No, <value-only>" within the window re-writes it even after the
  // script clears. Only when a reading field was actually written this run (a
  // voltage-only finish leaves none — voltage corrections are handled in-loop
  // by the confirm gate). Pin the board so a correction after a board switch
  // can't land on the wrong board.
  if (schema.correctionBreadcrumb) {
    const cb = schema.correctionBreadcrumb;
    const fields = Array.isArray(cb.fields) ? cb.fields : [];
    let lastReadingField = null;
    for (const f of fields) {
      if (values[f] !== undefined) lastReadingField = f;
    }
    if (lastReadingField) {
      session.dialogueCorrectionBreadcrumb = {
        schemaName: schema.name,
        circuit_ref,
        field: lastReadingField,
        boardId: session.stateSnapshot?.currentBoardId ?? null,
        at: now,
      };
    }
  }
  clearScriptState(session);
  if (typeof schema.onFinish === 'function') {
    schema.onFinish(session, circuit_ref);
  }
}

function matchesAny(text, patterns) {
  if (typeof text !== 'string' || !text || !Array.isArray(patterns)) return false;
  return patterns.some((p) => p.test(text));
}

/**
 * Server-driven script entry — the back door for the Sonnet
 * `start_dialogue_script` tool (Plan: Silvertown follow-up 2026-04-30).
 *
 * Why this exists: the engine's regex entry triggers (each schema's
 * `triggers` list) inevitably miss garbles and paraphrases that
 * Sonnet's LLM understanding catches. Rather than chase every
 * Deepgram mishearing into the regex (the long tail is unbounded),
 * Sonnet emits a tool call when it recognises a structured walk-
 * through entry the engine missed; the dispatcher (in
 * stage6-dispatchers-script.js) calls this function to set up the
 * script state, and the next user turn flows through the active path
 * normally.
 *
 * Differs from `runEntry`:
 *   - Caller supplies `schemaName` (string) instead of providing the
 *     schema directly via the entry-detection loop.
 *   - There is NO transcript text to parse for designations or named-
 *     field values — Sonnet has already extracted what it could and
 *     either passed `circuit_ref` or expects the engine to ask.
 *   - Idempotent: returns `{ ok: true, status: 'already_active' }`
 *     when a script is in flight, so calling defensively from Sonnet
 *     is safe.
 *   - Returns a structured outcome object instead of the
 *     `{handled, fallthrough}` shape — the dispatcher converts to a
 *     tool_result envelope.
 *
 * Wire emission: the function still calls `safeSend(ws, ...)` to emit
 * the first ask (which-circuit or which-slot) so the inspector hears
 * the question on the SAME response Sonnet is closing. If `ws` is
 * absent (test path), the ask is captured in the return payload but
 * not sent.
 *
 * @param {object} args
 * @param {object} args.session
 * @param {string} args.sessionId
 * @param {Array}  args.schemas      Registered schema list to look up by name.
 * @param {string} args.schemaName   One of: ring_continuity, insulation_resistance, ocpd, rcd, rcbo.
 * @param {?number} [args.circuit_ref]  If known (Sonnet caught a digit), seeds state.circuit_ref.
 * @param {Array<{field: string, value: string}>} [args.pending_writes]
 *        Sonnet-extracted volunteered values from the same utterance ("ring
 *        continuity lives are 0.32" → [{field: 'ring_r1_ohm', value: '0.32'}]).
 *        Without this, the value Sonnet heard would be lost — the existing
 *        regex-driven entry preserved volunteered values via
 *        extractNamedFieldValues; this preserves the same property when
 *        Sonnet enters via the LLM-fallback path. Each entry is silently
 *        dropped if its `field` is not a slot of the chosen schema (defence
 *        against Sonnet hallucinating a field name) — the rest of the entry
 *        still proceeds. Validation logged via the schema's normal
 *        `_seeded_writes` event.
 * @param {object} [args.ws]
 * @param {object} [args.logger]
 * @param {number} [args.now]
 * @returns {{ok: boolean, status?: string, schema?: string, circuit_ref?: ?number, seeded_writes?: string[], error?: object}}
 */
export function enterScriptByName({
  session,
  sessionId,
  schemas,
  schemaName,
  circuit_ref = null,
  pending_writes = [],
  transcriptText = null,
  ws = null,
  logger = null,
  now = Date.now(),
  // PLAN-C P4d (row 1) — creation-time response epoch for the first ask this
  // server-driven entry emits. The dispatcher (stage6-dispatchers-script.js)
  // threads responseEpochRef.current from the live shadow-harness turn.
  responseEpoch = null,
}) {
  if (!session) return { ok: false, error: { code: 'no_session' } };
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return { ok: false, error: { code: 'no_schemas' } };
  }
  const schema = schemas.find((s) => s.name === schemaName);
  if (!schema) {
    return { ok: false, error: { code: 'unknown_schema', schema: schemaName } };
  }

  // Broadcast-intent guard (2026-06-01 — session B95B2EE1 regression).
  //
  // processDialogueTurn at line ~92 already rejects entry when the raw
  // transcript contains "for all circuits" / "across the board" etc.,
  // because the inspector intends a fan-out, not a per-circuit walk-
  // through. Sonnet-initiated start_dialogue_script was a second entry
  // path that DIDN'T see the transcript and so couldn't run the same
  // guard — IR ended up asking "Which circuit?" while
  // set_field_for_all_circuits could and should have handled the read.
  //
  // We trust the call site (stage6-shadow-harness.js stashes the live
  // turn's text onto session.activeTurnTranscript and the script
  // dispatcher threads it through here). Only reject when:
  //   (a) text was supplied (test paths often skip it),
  //   (b) detectBroadcastIntent matches,
  //   (c) no script is currently active — once a script is mid-run, the
  //       active-path block at line ~143 owns the abort-mid-script
  //       semantic and we don't want to fight it.
  // ok:false + dedicated code lets Sonnet retry via
  // set_field_for_all_circuits without re-entering this branch.
  if (
    typeof transcriptText === 'string' &&
    transcriptText.length > 0 &&
    !session.dialogueScriptState?.active &&
    detectBroadcastIntent(transcriptText)
  ) {
    logger?.info?.('stage6.dialogue_script_broadcast_intent_rejected', {
      sessionId,
      requested_schema: schemaName,
      transcript_preview: transcriptText.slice(0, 80),
    });
    return {
      ok: false,
      error: {
        code: 'broadcast_intent_detected',
        schema: schemaName,
        hint: 'Inspector said "for all circuits" / "across the board" — use set_field_for_all_circuits instead of entering a per-circuit walk-through.',
      },
    };
  }

  // Idempotency: if a script is already in flight, return an
  // already_active envelope. Sonnet may emit this tool defensively
  // alongside the engine's own regex entry — we MUST NOT clear
  // existing state and re-enter (would lose values + reset the
  // retry-budget flag from Fix 1).
  const existing = session.dialogueScriptState;
  if (existing?.active) {
    logger?.info?.('stage6.dialogue_script_already_active', {
      sessionId,
      requested_schema: schemaName,
      active_schema: existing.schemaName,
      active_circuit_ref: existing.circuit_ref,
      entered_via_pivot: existing.entered_via_pivot === true,
    });
    return {
      ok: true,
      status: 'already_active',
      schema: existing.schemaName,
      circuit_ref: existing.circuit_ref,
      // Surface the existing script's pivot provenance so the
      // dispatcher's envelope reports `pivoted` correctly even on the
      // defensive-retry path. Codex P2: the prior dispatcher coerced
      // missing → false, which lied when a defensive retry hit RCBO
      // that had been entered via OCPD → RCBO pivot earlier.
      pivoted: existing.entered_via_pivot === true,
    };
  }

  // Validate circuit_ref if supplied. Null is allowed — engine asks.
  let resolvedCircuitRef = null;
  if (circuit_ref !== null && circuit_ref !== undefined) {
    if (!Number.isInteger(circuit_ref) || circuit_ref <= 0) {
      return {
        ok: false,
        error: { code: 'invalid_circuit_ref', circuit_ref },
      };
    }
    // Reject unknown circuit (mirror dispatchRecordReading semantics —
    // strict-mode forces Sonnet to call create_circuit explicitly if
    // it wants a new one, rather than silently creating via this back
    // door).
    //
    // Hotfix slice 4 — use circuitExistsInSnapshot for the dual-shape
    // lookup so the engine respects board scope. Pre-fix: a sub-board
    // flow on currentBoardId='sub-1' would silently accept a ref that
    // existed only on main, because the bare-numeric key lookup hit
    // main's bucket regardless. Now scoped via currentBoardId.
    const snapshot = session.stateSnapshot;
    const circuits = snapshot?.circuits;
    const exists = Array.isArray(circuits)
      ? circuits.some((c) => Number(c?.circuit_ref) === circuit_ref)
      : circuitExistsInSnapshot(snapshot, circuit_ref, snapshot?.currentBoardId);
    if (!exists) {
      return {
        ok: false,
        error: { code: 'unknown_circuit', circuit_ref },
      };
    }
    resolvedCircuitRef = circuit_ref;
  }

  // Validate Sonnet-supplied volunteered values against the schema's
  // slot fields. Drop any entry with an unknown field — Sonnet should
  // not be hallucinating field names (the agentic prompt enumerates
  // them), but defence-in-depth here keeps a single bad entry from
  // poisoning the whole entry. Empty / non-string values also dropped.
  const slotFields = schema.slots.map((s) => s.field);
  const validWrites = [];
  const droppedFields = [];
  if (Array.isArray(pending_writes)) {
    for (const w of pending_writes) {
      if (
        !w ||
        typeof w.field !== 'string' ||
        !slotFields.includes(w.field) ||
        typeof w.value !== 'string' ||
        w.value.length === 0
      ) {
        if (w?.field) droppedFields.push(w.field);
        continue;
      }
      // Canonicalise IR-slot LIM garbles ("limitation"/"limb"/… → "LIM")
      // for seeded pending_writes, which otherwise bypass the megaohms
      // parser entirely (they are applied directly via
      // applyWriteWithDerivations / queued for the drain path). Scoped to
      // `ir_live_*` so bs_en / Y-N seed behaviour is unchanged (F1AC26FB
      // #4.2). coerceRecordReadingValue is a no-op for non-LIM IR values.
      const canonValue = w.field.startsWith('ir_live_')
        ? coerceRecordReadingValue(w.field, w.value)
        : w.value;
      validWrites.push({ field: w.field, value: canonValue });
    }
  }

  // Initialise state. Seed values from the existing snapshot so a
  // partial fill is honoured (mirrors runEntry's skip-already-filled).
  initScriptState(session, schema, resolvedCircuitRef, now);
  const state = session.dialogueScriptState;
  if (resolvedCircuitRef !== null) {
    const existingValues = readExistingValues(session, resolvedCircuitRef, slotFields);
    for (const [f, v] of Object.entries(existingValues)) {
      if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
        state.values[f] = v;
      }
    }
  }

  // Apply or queue Sonnet's volunteered writes. Mirrors runEntry's
  // logic exactly — including derivation processing — so byte-identical
  // state results from regex entry + Sonnet entry on the same utterance
  // shape. Critically, applyWriteWithDerivations is what fires the
  // OCPD/RCD → RCBO pivot when a seed write is `BS EN 61009`. Skipping
  // it (an earlier draft did) was a Codex-flagged regression: an
  // utterance like "OCPD on circuit 4, BS EN 61009" would stay in OCPD
  // and ask the next OCPD slot instead of switching to the RCBO flow.
  // appliedWrites tracks ONLY Sonnet's own seed writes — reported back
  // in `seeded_writes` on the dispatcher envelope so the optimiser /
  // tool-loop attribution stays accurate ("what did this
  // start_dialogue_script call ask the server to seed?").
  //
  // wireWrites is appliedWrites + any derivation mirrors/sets, used for
  // the wire emit so iOS sees ALL columns update on one envelope. The
  // split keeps the dispatcher contract stable while still surfacing
  // mirrors on the wire (Audit-2026-06-02 Phase 2).
  const appliedWrites = [];
  const wireWrites = [];
  let pivotTo = null;
  for (const w of validWrites) {
    if (state.values[w.field] !== undefined) continue; // skip already-filled
    if (resolvedCircuitRef !== null) {
      const slot = schema.slots.find((s) => s.field === w.field);
      const r = applyWriteWithDerivations(session, schema, slot, resolvedCircuitRef, w.value, now);
      appliedWrites.push(w);
      wireWrites.push(w);
      for (const mw of r.mirrorWrites) wireWrites.push({ ...mw, auto_resolved: true });
      for (const sw of r.setWrites) wireWrites.push({ ...sw, auto_resolved: true });
      if (r.pivotTo) pivotTo = r.pivotTo;
    } else {
      // Circuit unknown — queue. The active path drains pending_writes
      // once a digit or designation answer lands.
      state.pending_writes.push(w);
    }
  }

  // Wire-emit the applied extractions so iOS sees the values land
  // immediately. Mirrors runEntry's emit at engine.js:259.
  if (wireWrites.length > 0) {
    safeSend(ws, buildExtractionPayload(resolvedCircuitRef, wireWrites, schema.extractionSource));
  }

  // Pivot — derivation requested a schema transition (e.g. ocpd_bs_en
  // = "BS EN 61009" pivots OCPD → RCBO). Mirrors runEntry's pivot
  // handling at engine.js:293. runPivot clears the current state,
  // initialises the target schema, mirrors any derived values, and
  // emits the next ask itself — so this branch RETURNS early and the
  // normal first-ask emission below is skipped.
  if (pivotTo) {
    runPivot({
      ws,
      session,
      sessionId,
      schemas,
      fromSchema: schema,
      toSchemaName: pivotTo,
      logger,
      now,
      responseEpoch,
    });
    return {
      ok: true,
      status: 'entered',
      schema: pivotTo,
      circuit_ref: resolvedCircuitRef,
      seeded_writes: appliedWrites.map((w) => w.field),
      queued_writes: [],
      dropped_fields: droppedFields,
      pivoted: true,
    };
  }

  logger?.info?.(`${schema.logEventPrefix}_entered`, {
    sessionId,
    circuit_ref: resolvedCircuitRef,
    entry_designation_matched: false,
    pre_existing_filled: Object.keys(state.values).filter(
      (f) => !appliedWrites.some((w) => w.field === f)
    ),
    volunteered_writes: appliedWrites.map((w) => w.field),
    pending_writes: state.pending_writes.map((w) => w.field),
    dropped_fields: droppedFields,
    textPreview: '[server-entered via start_dialogue_script]',
    server_entered: true,
  });

  // Emit the appropriate first ask. If circuit unknown → which_circuit;
  // otherwise next missing slot. With pending_writes possibly already
  // filling the first N slots, we ask about the first slot that is
  // still empty (could be slot[0] if no writes, or a later slot if
  // Sonnet seeded values for the early slots).
  if (resolvedCircuitRef === null) {
    safeSend(
      ws,
      buildScriptAsk({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        circuit_ref: null,
        missing_field: null,
        whichCircuitQuestion: schema.whichCircuitQuestion,
        slotQuestion: null,
        now,
        kind: 'which_circuit',
        responseEpoch,
      })
    );
  } else {
    const nextSlot = nextMissingSlot(
      state.values,
      schema.slots,
      state.skipped_slots,
      getDeferredSlots(session, schema.name, resolvedCircuitRef)
    );
    if (nextSlot) {
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          circuit_ref: resolvedCircuitRef,
          missing_field: nextSlot.field,
          whichCircuitQuestion: schema.whichCircuitQuestion,
          slotQuestion: nextSlot.question,
          now,
          kind: 'value',
          responseEpoch,
        })
      );
    } else {
      // All slots filled (snapshot pre-fill + seeded writes) — finish
      // immediately. Reachable when Sonnet's pending_writes complete
      // an already-partial snapshot, or when an inspector dictates a
      // full reading family in one breath ("ring continuity for circuit
      // 4 lives 0.32 neutrals 0.31 cpc 0.55") and all three slots seed.
      finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
    }
  }

  return {
    ok: true,
    status: 'entered',
    schema: schema.name,
    circuit_ref: resolvedCircuitRef,
    seeded_writes: appliedWrites.map((w) => w.field),
    queued_writes: state.pending_writes ? state.pending_writes.map((w) => w.field) : [],
    dropped_fields: droppedFields,
  };
}

/**
 * Resume a paused dialogue script after Sonnet creates/renames a circuit
 * that matches the script's `paused_designation_hint`. Called by the
 * stage6 dispatcher hook after `runLiveMode` finishes a Sonnet turn,
 * with the per-turn `circuit_updates` list passed in. No-op if no
 * paused state exists, the schema didn't opt in, the pause has timed
 * out, or the hint doesn't designation-match one of the just-created
 * circuits.
 *
 * On successful resume:
 *   - state.circuit_ref bound to the matched ref
 *   - state.active flipped back to true, paused flags cleared
 *   - existing snapshot values on the new circuit seeded into state.values
 *   - pending_writes drained onto the new circuit (extraction_payload
 *     emitted to iOS for each)
 *   - next missing slot asked via askNextOrFinish (the disambiguation
 *     step for ambiguous_bare_value lands in a follow-up commit)
 *
 * Designation matching uses the same `findCircuitByDesignation` helper
 * that runEntry / runActivePath use, so the matcher is byte-identical
 * to what an inline circuit-name answer would have hit.
 *
 * Returns `{ resumed: true, circuit_ref }` on success, otherwise
 * `{ resumed: false, reason }` for telemetry.
 */
export function tryResumePausedScript({
  session,
  ws,
  schemas,
  circuitUpdates,
  logger,
  now = Date.now(),
  // PLAN-C P4d (row 1) — creation-time response epoch for the resume-time
  // disambiguation / next-slot ask. Threaded from responseEpochRef.current at
  // the shadow-harness resume hook.
  responseEpoch = null,
}) {
  const state = session?.dialogueScriptState;
  if (!state || !state.paused) return { resumed: false, reason: 'no_paused_script' };
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return { resumed: false, reason: 'no_schemas' };
  }
  if (!Array.isArray(circuitUpdates) || circuitUpdates.length === 0) {
    return { resumed: false, reason: 'no_circuit_updates' };
  }
  const schema = schemas.find((s) => s.name === state.schemaName);
  if (!schema) return { resumed: false, reason: 'schema_unknown' };
  if (schema.resumeAfterCircuitCreation !== true) {
    return { resumed: false, reason: 'schema_no_opt_in' };
  }

  // Stale-pause sweep — defense in depth (processDialogueTurn also sweeps
  // at the top of every turn). Belt-and-braces because the dispatcher hook
  // may fire on a turn that doesn't go through processDialogueTurn first.
  if (now - (state.paused_at ?? 0) > schema.hardTimeoutMs) {
    logger?.info?.(`${schema.logEventPrefix}_paused_hard_timeout_at_resume`, {
      sessionId: session.sessionId,
      ms_since_paused: now - (state.paused_at ?? 0),
    });
    clearScriptState(session);
    return { resumed: false, reason: 'paused_timeout' };
  }

  const designationHint = state.paused_designation_hint;
  if (typeof designationHint !== 'string' || designationHint.length === 0) {
    return { resumed: false, reason: 'no_designation_hint' };
  }
  const matchedRef = findCircuitByDesignation(session, designationHint);
  if (matchedRef === null) {
    return { resumed: false, reason: 'no_designation_match' };
  }

  // Confirm matchedRef is among the just-created / renamed circuits —
  // guards against accidentally resuming on a pre-existing circuit that
  // happens to designation-match (it would have matched at entry-time
  // and never paused in the first place; if we still get here, Sonnet
  // edited a different circuit and we shouldn't claim its create as
  // the resume trigger).
  const matchingOp = circuitUpdates.find(
    (op) => (op?.op === 'create' || op?.op === 'rename') && op?.circuit_ref === matchedRef
  );
  if (!matchingOp) {
    return { resumed: false, reason: 'matched_ref_not_in_circuit_updates' };
  }

  const previouslyPausedHint = designationHint;
  const previouslyPausedAt = state.paused_at;

  // Re-arm script for the active path on the bound circuit.
  state.active = true;
  state.paused = false;
  state.paused_designation_hint = null;
  state.paused_at = null;
  state.circuit_ref = matchedRef;
  state.last_turn_at = now;
  state.circuit_retry_attempted = false;
  state.last_designation_attempt = null;

  const slotFields = schema.slots.map((s) => s.field);
  const existing = readExistingValues(session, matchedRef, slotFields);
  for (const [f, v] of Object.entries(existing)) {
    if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
      state.values[f] = v;
    }
  }

  const drainedWrites = [];
  if (Array.isArray(state.pending_writes) && state.pending_writes.length > 0) {
    for (const w of state.pending_writes) {
      if (state.values[w.field] !== undefined) continue;
      // Defensive IR-LIM canonicalisation on drain after circuit-create
      // resume (idempotent; scoped to ir_live_* — F1AC26FB #4.2).
      const drainValue = w.field.startsWith('ir_live_')
        ? coerceRecordReadingValue(w.field, w.value)
        : w.value;
      applyWrite(session, schema, matchedRef, w.field, drainValue, now);
      drainedWrites.push({ ...w, value: drainValue });
    }
    state.pending_writes = [];
  }

  if (drainedWrites.length > 0) {
    safeSend(ws, buildExtractionPayload(matchedRef, drainedWrites, schema.extractionSource));
  }

  logger?.info?.(`${schema.logEventPrefix}_resumed_after_circuit_create`, {
    sessionId: session.sessionId,
    circuit_ref: matchedRef,
    matched_via_designation: previouslyPausedHint,
    ms_since_paused: now - previouslyPausedAt,
    drained_pending_writes: drainedWrites.map((w) => w.field),
    ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
    circuit_op: matchingOp.op,
  });

  // Disambiguation pre-step for an ambiguous bare value captured at
  // entry. Three branches:
  //
  //   (1) Both L-L and L-E are still empty → can't infer which slot the
  //       bare value belongs to; ask the inspector. State flips into
  //       `awaiting_disambiguation` mode and the active path's pre-slot
  //       check (added below) routes the next reply through the
  //       schema's `disambiguateBareValue`.
  //   (2) Exactly ONE of L-L/L-E is already filled (existing snapshot
  //       value or a drained pending_write) → auto-assign the bare
  //       value to the OTHER slot and continue. No question needed
  //       because there's only one possible target.
  //   (3) Both L-L and L-E filled → the bare value is redundant.
  //       Discard with a log; the script continues to whatever's
  //       still missing (probably voltage).
  //
  // Schema gates: `bareDisambiguationQuestion` + `disambiguateBareValue`
  // must be functions for branch (1) to fire; otherwise fall through
  // to the standard askNextOrFinish.
  if (
    state.ambiguous_bare_value !== null &&
    typeof schema.bareDisambiguationQuestion === 'function' &&
    typeof schema.disambiguateBareValue === 'function'
  ) {
    const llFilled = state.values.ir_live_live_mohm != null;
    const leFilled = state.values.ir_live_earth_mohm != null;
    const bare = state.ambiguous_bare_value;

    if (!llFilled && !leFilled) {
      // Branch (1): true ambiguity — ask.
      state.awaiting_disambiguation = bare;
      state.ambiguous_bare_value = null;
      const question = schema.bareDisambiguationQuestion(bare.value);
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_asked`, {
        sessionId: session.sessionId,
        circuit_ref: matchedRef,
        bare_value: bare.value,
      });
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId: session.sessionId,
          circuit_ref: matchedRef,
          missing_field: '_ir_disambiguate_bare',
          whichCircuitQuestion: null,
          slotQuestion: question,
          now,
          kind: 'value',
          responseEpoch,
        })
      );
      return { resumed: true, circuit_ref: matchedRef };
    }

    if (llFilled !== leFilled) {
      // Branch (2): exactly one filled — auto-assign the bare value to
      // the other slot. No user question.
      const targetField = llFilled ? 'ir_live_earth_mohm' : 'ir_live_live_mohm';
      applyWrite(session, schema, matchedRef, targetField, bare.value, now);
      state.values[targetField] = bare.value;
      state.ambiguous_bare_value = null;
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_auto_assigned`, {
        sessionId: session.sessionId,
        circuit_ref: matchedRef,
        bare_value: bare.value,
        target_field: targetField,
        reason: llFilled ? 'll_already_filled' : 'le_already_filled',
      });
      safeSend(
        ws,
        buildExtractionPayload(
          matchedRef,
          [{ field: targetField, value: bare.value }],
          schema.extractionSource
        )
      );
      askNextOrFinish({
        ws,
        session,
        sessionId: session.sessionId,
        schema,
        logger,
        now,
        responseEpoch,
      });
      return { resumed: true, circuit_ref: matchedRef };
    }

    // Branch (3): both filled — bare value is redundant. Discard and
    // proceed.
    logger?.info?.(`${schema.logEventPrefix}_disambiguation_discarded`, {
      sessionId: session.sessionId,
      circuit_ref: matchedRef,
      bare_value: bare.value,
      reason: 'both_slots_already_filled',
    });
    state.ambiguous_bare_value = null;
  }

  askNextOrFinish({
    ws,
    session,
    sessionId: session.sessionId,
    schema,
    logger,
    now,
    responseEpoch,
  });

  return { resumed: true, circuit_ref: matchedRef };
}

/**
 * Post-dispatch hook — enter a dialogue script after Sonnet writes a
 * value belonging to one of the schema's slots, when no script is
 * currently active for the session. Symmetric counterpart to
 * tryResumePausedScript: that one resumes a paused script when a
 * circuit gets created mid-walk-through; this one starts a fresh
 * script when a slot-owned value lands without a prior trigger
 * (because runEntry bailed to Sonnet — see hasNumericValueWithUnit
 * branch above) OR without any trigger at all (e.g. Sonnet decided
 * to record_reading after a question outside the script flow).
 *
 * Motivating case: session 87856B72 (2026-05-26). Deepgram garbled
 * "trip time" → "triptan" so the RCD trigger fired but the entry
 * parser harvested nothing. runEntry now bails to Sonnet
 * (handover-to-sonnet branch). Sonnet writes rcd_trip_time=25 via
 * record_reading. This hook then enters rcdSchema with
 * circuit_ref=2, seeds pre_existing from the snapshot (which now
 * includes the 25), and asks the next missing slot (rcd_bs_en) —
 * same UX the inspector would have got on the happy path.
 *
 * Guards:
 *   - no-op if a script is already active (don't disturb)
 *   - skip writes whose field isn't a slot in any registered schema
 *   - only the FIRST matching schema enters per call — multi-domain
 *     volunteered fields are rare; subsequent matches will trigger
 *     on a later turn or via a fresh utterance
 *   - skip when nextMissingSlot returns null (every slot already
 *     filled — silent no-op; no question worth asking)
 *
 * @returns {{entered: boolean, schemaName?: string, circuit_ref?: number, reason?: string}}
 */
export function tryEnterScriptFromWrites({
  session,
  ws,
  schemas,
  readings,
  fieldAliases,
  logger,
  now = Date.now(),
  // PLAN-C P4d (row 1) — creation-time response epoch for the first ask this
  // Sonnet-write-triggered entry emits. Threaded from responseEpochRef.current
  // at the shadow-harness entry hook.
  responseEpoch = null,
}) {
  if (!session) return { entered: false, reason: 'no_session' };
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return { entered: false, reason: 'no_schemas' };
  }
  if (!Array.isArray(readings) || readings.length === 0) {
    return { entered: false, reason: 'no_readings' };
  }
  if (session.dialogueScriptState?.active) {
    return { entered: false, reason: 'script_already_active' };
  }

  // 2026-06-01 — multi-circuit broadcast guard. When the same field
  // appears across ≥2 distinct circuits in this turn's writes, the
  // inspector's intent is batch-set ("RCD trip time for circuits 2,
  // 3, and 4 to 25 ms.") — NOT a walk-through trigger for the first
  // circuit. Pre-guard the hook would enter the schema for the
  // first matching reading and ambush the inspector with "What's
  // the BS number?" while they were mid-batch.
  //
  // Field repro: session D68ACD24-1D3A-4896-A59B-A9D9A888386E
  // (2026-05-31 23:53 BST). Inspector said "RCD, trip time for
  // circuits 2, 3, and 4 to 25 ms.". The `processDialogueTurn`
  // pre-filter correctly recognised the broadcast intent and bailed
  // (`dialogue_broadcast_bypassed_entry` ×3); Sonnet then wrote
  // rcd_time_ms to circuits 2, 3, 4. This hook ran on the post-
  // dispatch readings array, saw circuit 2 first, and entered the
  // RCD walk-through anyway. The inspector heard "What's the BS
  // number?" milliseconds after their batch utterance — UX disaster.
  //
  // Detection: build a {field → Set<circuit>} map; if ANY field
  // crosses ≥2 distinct circuits, treat as broadcast and skip.
  // Multi-field-same-circuit ("circuit 5 trip time 25 ms, type AC")
  // is unaffected — each field appears with one circuit only, so
  // the walk-through still kicks in to fill the remaining slots.
  const fieldCircuits = new Map();
  for (const r of readings) {
    if (!r?.field) continue;
    const c = Number(r?.circuit);
    if (!Number.isInteger(c) || c <= 0) continue;
    const set = fieldCircuits.get(r.field) ?? new Set();
    set.add(c);
    fieldCircuits.set(r.field, set);
  }
  for (const [f, circuits] of fieldCircuits.entries()) {
    if (circuits.size >= 2) {
      logger?.info?.('dialogue_entry_from_write_skipped_broadcast', {
        sessionId: session.sessionId,
        broadcast_field: f,
        circuit_count: circuits.size,
        circuits: [...circuits].sort((a, b) => a - b),
      });
      return { entered: false, reason: 'multi_circuit_broadcast' };
    }
  }

  // Resolve a Sonnet-emitted field name to the name a schema's slot
  // list might use. Some schemas list the canonical Stage-6 wire name
  // Sonnet emits (e.g. IR's `ir_live_live_mohm`); others list the
  // legacy iOS-facing name (e.g. RCD's `rcd_trip_time`). The optional
  // `fieldAliases` map (FIELD_CORRECTIONS at the call site) maps
  // canonical → legacy. We try the raw field first, then the
  // resolved alias, so callers don't have to know which direction
  // any given schema chose.
  //
  // Repro for the alias path: session 904344CD turn-10 (2026-05-26).
  // Sonnet emitted `record_reading {field: 'rcd_time_ms'}`. Direct
  // slot match against rcdSchema (`rcd_trip_time`) failed; the alias
  // lookup resolves `rcd_time_ms` → `rcd_trip_time` and the hook
  // enters the RCD walk-through. validateAndCorrectFields rewrites
  // the wire name post-hook so iOS still sees the legacy name.
  const resolveCandidates = (rawField) => {
    if (!fieldAliases || typeof fieldAliases !== 'object') return [rawField];
    const alias = fieldAliases[rawField];
    return alias ? [rawField, alias] : [rawField];
  };

  // 2026-06-02 — specificity ranking. Codex round 5 empirical
  // finding (matrix harness vs prod 2026-06-01): when Sonnet writes
  // `rcd_bs_en` on a clean snapshot, this hook was entering RCBO
  // unconditionally because RCBO comes before RCD in
  // ALL_DIALOGUE_SCHEMAS and both schemas list `rcd_bs_en` as a slot.
  // That mis-routes the inspector who said "BS EN 61008 for cooker"
  // (intent: standalone RCD) — engine then asks ocpd_type curve,
  // surprising the inspector.
  //
  // Fix: score each schema by total relevance to THIS TURN'S writes
  // (sum across readings: 2 for a normal slot match, 1 for
  // volunteeredOnly, 0 for no slot), sort schemas by score
  // descending (stable so declared order is the tiebreaker), then
  // use the sorted order in the existing per-reading loop. The
  // volunteeredOnly bonus captures the device-class intent:
  // RCBO's `rcd_bs_en` is volunteeredOnly (auxiliary harvest of a
  // mirrored field), while RCD's `rcd_bs_en` is a primary slot.
  // Schemas whose write set includes exclusive slots (e.g. RCD's
  // rcd_trip_time, owned by RCD only) automatically outscore
  // schemas that only share the broader BS-code slot.
  //
  // Worked examples:
  //   - Only rcd_bs_en written:
  //       RCD = 2 (normal); RCBO = 1 (volunteeredOnly). → RCD ✓
  //   - rcd_trip_time + rcd_bs_en + rcd_type + rcd_operating_current_ma:
  //       RCD = 1+2+2+2 = 7; RCBO = 0+1+2+2 = 5. → RCD ✓
  //   - Full RCBO spec (ocpd_bs_en + ocpd_type + ocpd_rating_a +
  //     ocpd_breaking_capacity_ka + rcd_type + rcd_operating_current_ma):
  //       RCBO = 6*2 = 12; OCPD < 12; RCD = 4 (only some slots match).
  //       → RCBO ✓
  //   - Pure ocpd_bs_en alone:
  //       RCBO = 2; OCPD = 2. → declared-order tiebreaker → RCBO.
  //       Acceptable: an isolated BS code without a device class
  //       indicator routes to the superset (RCBO) which captures the
  //       same OCPD properties plus optional RCD properties.
  const schemaScore = (schema) => {
    const slotByField = new Map(schema.slots.map((s) => [s.field, s]));
    let score = 0;
    for (const r of readings) {
      if (!r?.field) continue;
      const candidates = resolveCandidates(r.field);
      for (const c of candidates) {
        const slot = slotByField.get(c);
        if (!slot) continue;
        score += slot.volunteeredOnly ? 1 : 2;
        break; // count this reading once per schema
      }
    }
    return score;
  };
  const orderedSchemas = schemas
    .map((s, i) => ({ s, i, score: schemaScore(s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((entry) => entry.s);

  for (const reading of readings) {
    const field = reading?.field;
    const circuitRef = Number(reading?.circuit);
    if (!field || !Number.isInteger(circuitRef) || circuitRef <= 0) continue;

    const candidates = resolveCandidates(field);

    for (const schema of orderedSchemas) {
      const slotFields = schema.slots.map((s) => s.field);
      const matchedField = candidates.find((c) => slotFields.includes(c));
      if (!matchedField) continue;

      // Circuit must exist on the snapshot before we can read existing
      // slot values; the paused-script resume path covers the
      // value-before-circuit-create case (see tryResumePausedScript).
      if (!circuitExistsInSnapshot(session.stateSnapshot, circuitRef)) continue;

      const existing = readExistingValues(session, circuitRef, slotFields);
      const next = nextMissingSlot(
        existing,
        schema.slots,
        new Set(),
        getDeferredSlots(session, schema.name, circuitRef)
      );
      if (!next) {
        logger?.info?.(`${schema.logEventPrefix}_entry_from_write_skipped_all_filled`, {
          sessionId: session.sessionId,
          circuit_ref: circuitRef,
          trigger_field: field,
          resolved_field: matchedField,
        });
        continue;
      }

      initScriptState(session, schema, circuitRef, now);
      const state = session.dialogueScriptState;
      const mirroredKeys = [];
      // Audit-2026-06-02 Phase 2 — capture every mirror/set write that
      // applyDerivations produces during seeding so the shadow-harness
      // can fold them onto result.extracted_readings BEFORE Sonnet's
      // payload ships to iOS. Pre-Phase-2 these mirrors landed in
      // snapshot + state.values only — iOS never saw the column update
      // until the next user-driven re-render.
      //
      // Why we don't safeSend here: the WS emit for Sonnet's
      // originating writes is still ahead of us (sonnet-stream emits
      // after stage6-shadow-harness returns). A supplemental safeSend
      // here would arrive on the wire BEFORE the originating extraction
      // — wrong order from iOS's perspective. Returning the writes lets
      // the shadow-harness append them to result.extracted_readings, so
      // one envelope carries both columns.
      const seedMirrorWrites = [];
      for (const [f, v] of Object.entries(existing)) {
        if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
          state.values[f] = v;
          // Field-test repro 2026-06-01 (session 65AA5C76, circuit 3):
          // inspector said "RCD BS number is 61008", Sonnet wrote
          // rcd_bs_en via record_reading, tryEnterScriptFromWrites
          // entered RCBO — but the rcbo.js mirror `{ mirrors:
          // ['ocpd_bs_en'] }` on rcd_bs_en never fired because the
          // seed loop above writes directly to state.values without
          // going through the slot-write path that calls
          // applyDerivations. Engine then walked to ocpd_bs_en as the
          // "next missing slot" and asked "What's the BS number?" —
          // the inspector had just answered the same question.
          //
          // Apply derivations for every seeded slot so mirrors land in
          // the snapshot AND in state.values before nextMissingSlot
          // computes. Pivots are intentionally NOT followed here —
          // tryEnterScriptFromWrites already resolved the target
          // schema and chasing a pivot mid-seed would re-enter the
          // loop with the wrong schema.
          const slot = schema.slots.find((s) => s.field === f);
          if (slot && Array.isArray(slot.derivations)) {
            const r = applyDerivations({ session, schema, slot, value: v });
            mirroredKeys.push(f);
            for (const mw of r.mirrorWrites) {
              seedMirrorWrites.push({ field: mw.field, circuit: circuitRef, value: mw.value });
            }
            for (const sw of r.setWrites) {
              seedMirrorWrites.push({ field: sw.field, circuit: circuitRef, value: sw.value });
            }
          }
        }
      }

      // Recompute nextMissingSlot after derivations — the mirrors may
      // have filled the slot we were about to ask about, so the
      // walk-through should skip straight past it.
      const nextAfterMirrors =
        mirroredKeys.length > 0
          ? nextMissingSlot(
              state.values,
              schema.slots,
              new Set(),
              getDeferredSlots(session, schema.name, circuitRef)
            )
          : next;

      logger?.info?.(`${schema.logEventPrefix}_entered_from_sonnet_write`, {
        sessionId: session.sessionId,
        circuit_ref: circuitRef,
        trigger_field: field,
        resolved_field: matchedField,
        pre_existing_filled: Object.keys(existing).filter((f) => slotFields.includes(f)),
        next_slot: nextAfterMirrors ? nextAfterMirrors.field : null,
        mirror_fields_applied: mirroredKeys,
      });

      // All slots filled after mirrors → finish the script straight
      // away instead of walking the inspector through a question for a
      // field the engine just derived from the volunteered value.
      if (!nextAfterMirrors) {
        clearScriptState(session);
        return {
          entered: true,
          schemaName: schema.name,
          circuit_ref: circuitRef,
          finished: true,
          mirrorWrites: seedMirrorWrites,
        };
      }

      askNextOrFinish({
        ws,
        session,
        sessionId: session.sessionId,
        schema,
        logger,
        now,
        responseEpoch,
      });
      return {
        entered: true,
        schemaName: schema.name,
        circuit_ref: circuitRef,
        mirrorWrites: seedMirrorWrites,
      };
    }
  }

  // mirrorWrites omitted on falsy returns — caller uses optional chaining
  // (`entryResult?.mirrorWrites`) so undefined is safe, and keeping the
  // legacy `{entered:false, reason}` shape matches the existing test
  // expectations + the four sibling falsy-return shapes upstream.
  return { entered: false, reason: 'no_matching_schema' };
}

// Test-only exports for unit tests.
export const __testing__ = {
  detectEntry,
  detectDifferentEntry,
  initScriptState,
  clearScriptState,
  hasNumericValueWithUnit,
  // P1 ring-script-hardening confirmation helpers.
  maskCircuitSpans,
  collectCircuitRefsWithPolarity,
  extractRingSafeNamedValues,
  isReadingLikeReply,
};
