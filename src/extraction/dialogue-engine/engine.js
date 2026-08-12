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

import { MUTATION_OBSERVER } from '../plan00-semantic-capture.js';
import {
  parseCircuitDigitWithSpan,
  findCircuitByDesignation,
  findCircuitsByDesignation,
  readExistingValues,
  stripDesignationFiller,
} from './helpers/circuit-resolution.js';
import {
  extractNamedFieldValues,
  nextMissingSlot,
  countFilledForCancel,
  maskCircuitSpans,
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
// Plan 00B-2 C2.5 — evaluation-only audibility descriptors for the engine's
// SPOKEN payloads (dormant: attached only when the per-turn delivery
// observer Symbol is stamped on the ws).
import {
  attachAudibilityDescriptor,
  PLAN00_DELIVERY_EMIT_OBSERVER,
} from '../plan00-audibility-ledgers.js';
import { circuitExistsInSnapshot } from '../stage6-multi-board-shape.js';
import { applyReadingToSnapshot, applyReadingFlagAware } from '../stage6-snapshot-mutators.js';
import {
  parseCircuitRange,
  formatBulkApplyConfirm,
  detectBroadcastIntent,
} from './parsers/circuit-range.js';
import { OBSERVATION_PATTERN } from '../pre-llm-gate.js';
import { normaliseDialogueSlotWrite } from './helpers/dialogue-slot-normalise.js';
// Plan D (feedback id 100(b)) — the impedance clamp's band resolver (shared with
// the Stage-6 dispatchers so the engine can never disagree about the band) and
// the state-scoped correction store that carries `16 → 1.6` provenance from the
// write turn to the LATER turn that speaks the read-back.
import {
  clampReadingForDispatch,
  logImpedanceClamp,
  resolveBoardAwareEarthing,
} from '../impedance-clamp.js';
import { canonicaliseNumericReadingField } from '../value-enum-validator.js';
import { formatCorrectionClause } from '../confirmation-text.js';
// NOTE: `clearValueCorrection` (lifecycle rule 2 — the slot itself was cleared)
// is deliberately NOT imported here: the dialogue engine has no per-slot clear
// path. Within an episode a slot is only ever OVERWRITTEN, which routes through
// applyWrite → recordValueCorrection(null) (rule 1), and ending/re-entering a
// script replaces the whole state object (rule 3). The helper stays exported and
// unit-pinned as the API for a future clear path; wiring an unused import here
// would be dead code.
import { recordValueCorrection, consumeValueCorrection } from './helpers/value-corrections.js';
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
    // Cross-utterance destructive-intent suppression (feedback id 93,
    // 2026-07-27). sonnet-stream OWNS the token lifecycle (arrival stamping,
    // arming at the model-commit seam, one-shot consumption + window
    // arbitration); the engine only HONOURS the flag: when true, entry
    // detection is skipped for any schema that carries an
    // entryExclusionPattern, so the scoped trigger that FOLLOWED a
    // standalone "delete" utterance falls through to the model (which owns
    // clear_reading) instead of the script hijacking the turn with its
    // confirmation. Active-path handling is deliberately unaffected — an
    // in-flight episode keeps processing its own turns.
    suppressDestructiveEntry = false,
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
      // Codex diff-review r2 (silent-path lens) — cross-wrapper isolation.
      // Production calls all three domain wrappers (ring, IR, protective-
      // device) on EVERY turn in sequence (sonnet-stream.js), each with its
      // own narrow `schemas` list. Without this check, a broadcast-intent
      // utterance while e.g. RCD is active would hit the RING wrapper
      // FIRST: `state.active` is true (SOME script is active) but
      // `state.schemaName` ('rcd') isn't in ring's schemas list, so
      // `preFilterSchema` is undefined — yet the code below still cleared
      // the ACTIVE RCD state via `clearScriptState`, skipping
      // `renderTerminalReadback` (gated on `preFilterSchema`) entirely and
      // silently discarding any uncovered dictated operation. This mirrors
      // the SAME isolation the active-path handler already applies at
      // ~line 310 ("Don't touch its state — return handled:false... The
      // legacy two-wrapper call pattern in sonnet-stream.js depends on this
      // isolation") — that established pattern was simply missing here.
      const preFilterSchema = schemas.find((s) => s.name === state.schemaName);
      if (!preFilterSchema) {
        return { handled: false };
      }
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
        // PLAN A2 §A2.5 site table (L236-class) — TERMINAL: the model owns
        // this turn's audibility, but any uncovered EARLIER dictation still
        // needs its read-back before the silent clear. Any still-queued
        // pending write is explicitly discarded here (per the comment
        // above) and becomes abandoned, never spoken.
        if (Array.isArray(state.pending_writes)) {
          for (const w of state.pending_writes) {
            const op = w[OPERATION_REF];
            if (op) markAbandoned(op);
          }
        }
        if (preFilterSchema) {
          renderTerminalReadback({
            ws,
            session,
            sessionId,
            schema: preFilterSchema,
            logger,
            now,
            responseEpoch,
            siteLabel: 'broadcast_aborted_mid_script',
          });
        }
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
      // PLAN A2 §A2.5 site table (L262-class) — TERMINAL: the paused episode
      // is discarded; any still-queued pending write becomes abandoned, and
      // any uncovered applied/satisfied_existing operation is read back
      // before the silent clear.
      if (Array.isArray(state.pending_writes)) {
        for (const w of state.pending_writes) {
          const op = w[OPERATION_REF];
          if (op) markAbandoned(op);
        }
      }
      renderTerminalReadback({
        ws,
        session,
        sessionId,
        schema,
        logger,
        now,
        responseEpoch,
        siteLabel: 'paused_hard_timeout',
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
        // PLAN A2 §A2.5 site table (L297-class) — TERMINAL: a hard timeout
        // discards the episode; any still-queued pending write becomes
        // abandoned, and any uncovered dictation is read back before the
        // silent clear (the model owns the FOLLOW-UP turn's audibility, but
        // nothing else will ever speak an already-dictated value from the
        // now-abandoned episode).
        if (Array.isArray(state.pending_writes)) {
          for (const w of state.pending_writes) {
            const op = w[OPERATION_REF];
            if (op) markAbandoned(op);
          }
        }
        renderTerminalReadback({
          ws,
          session,
          sessionId,
          schema,
          logger,
          now,
          responseEpoch,
          siteLabel: 'active_hard_timeout',
        });
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
            // Plan D Seam C (2026-07-25, feedback id 100(b)) — this breadcrumb is
            // a FOURTH dialogue write producer: it touches neither `applyWrite`
            // (Seam B) nor `normaliseDialogueSlotWrite` (Seam A), so both of those
            // clamps miss it. And it is a DICTATED impedance correction — exactly
            // the class this plan exists to fix — so an unclamped write here would
            // store a raw 16 while the server advertises `server_impedance_clamp`
            // and the client has stopped clamping.
            //
            // Unlike Seams A/B the write turn IS the speech turn here (the
            // snapshot write, the extraction frame, the spoken line and the log
            // row are all emitted below), so the correction needs no state-scoped
            // transport — it is consumed inline and cannot outlive this block.
            //
            // COVERAGE NOTE (verified 2026-07-25): the ONLY schema declaring a
            // `correctionBreadcrumb` today is insulation-resistance, whose
            // `fields` are the two megaohm IR legs — neither is in an impedance
            // clamp band, so on the live path this clamp is currently a
            // pass-through. It is wired anyway because the breadcrumb config is
            // schema-driven: the moment ring continuity (or any other
            // continuity-field schema) gains a breadcrumb, this producer would
            // otherwise start storing raw values while the server advertises
            // `server_impedance_clamp` and the client has stopped clamping. The
            // §7 matrix pins BOTH halves — IR passes through byte-unchanged, and
            // a continuity-field breadcrumb clamps and names the correction.
            const clamped = clampReadingForDispatch({
              // Canonical name: the clamp sets are keyed canonically, and a
              // breadcrumb field is a dialogue slot name (ring_r2_ohm, r1_r2).
              field: canonicaliseNumericReadingField(crumb.field),
              value: corrected,
              // The guard above already proved `crumb.boardId === currentBoardId`,
              // so resolving on the crumb's board is the same board the reading
              // was taken on — a TT sub-board keeps its own band.
              earthing: resolveBoardAwareEarthing(session.stateSnapshot, currentBoardId),
            });
            const effective = clamped.value;
            // Plan 00B §B2 — resume-drained dialogue write.
            const crumbObserver = session.stateSnapshot?.[MUTATION_OBSERVER] ?? null;
            if (crumbObserver) {
              crumbObserver.setOriginFrame({
                origin: 'dialogue_script_direct',
                meta: { resume_drained: true, field: crumb.field },
              });
            }
            try {
              applyReadingFlagAware(session.stateSnapshot, {
                circuit: crumb.circuit_ref,
                field: crumb.field,
                value: effective,
              });
            } finally {
              if (crumbObserver) crumbObserver.clearOriginFrame();
            }
            safeSend(
              ws,
              buildExtractionPayload(
                crumb.circuit_ref,
                [{ field: crumb.field, value: effective }],
                crumbSchema.extractionSource
              )
            );
            const label = cbCfg.fieldLabels?.[crumb.field] ?? crumb.field;
            // The clause is APPENDED as its own sentence rather than spliced into
            // the "Got it, …" line, matching the ring triple's shape: an
            // UNCORRECTED breadcrumb therefore renders byte-identically to
            // pre-Plan-D and only a clamped one grows the extra sentence.
            const correctionClause = formatCorrectionClause(clamped.correction);
            const correctionInfoPayload = buildScriptInfo({
              toolCallIdPrefix: crumbSchema.toolCallIdPrefix,
              sessionId,
              kind: 'correction',
              text:
                correctionClause === null
                  ? `Got it, ${label} ${effective}.`
                  : `Got it, ${label} ${effective}. ${correctionClause}.`,
              now,
              responseEpoch,
            });
            // Plan 00B-2 C2.5 — the SPOKEN payload carries the audibility
            // descriptor (the extraction payload above is UI-only and never
            // prepares/commits). Dormant: attach only when the delivery
            // observer is stamped for this turn.
            if (ws && ws[PLAN00_DELIVERY_EMIT_OBSERVER]) {
              attachAudibilityDescriptor(correctionInfoPayload, [
                { field: crumb.field, circuit: crumb.circuit_ref, value: effective },
              ]);
            }
            safeSend(ws, correctionInfoPayload);
            // The script's own row keeps its shape and now reports the STORED
            // value (it previously reported the raw dictated one).
            logger?.info?.(`${crumbSchema.logEventPrefix}_post_completion_correction`, {
              sessionId,
              circuit_ref: crumb.circuit_ref,
              field: crumb.field,
              value: effective,
            });
            // A divide additionally emits the shared clamp row, so every
            // server-altered number is greppable from one event name regardless
            // of which seam altered it.
            if (clamped.correction) {
              logImpedanceClamp(logger, {
                sessionId,
                seam: 'dialogue_correction_breadcrumb',
                field: crumb.field,
                circuit: crumb.circuit_ref,
                board_id: currentBoardId,
                original: clamped.correction.original,
                corrected: clamped.correction.corrected,
                divisor: clamped.correction.divisor,
              });
            }
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
  //
  // Detection + entry extraction parse the RAW reply (replyText), never the
  // annotated transcript (Codex diff-review r1): the `[In response to TTS
  // question: "…"] ` prefix (a) defeats the leading patterns' clause-start
  // anchor exactly when the entry answers a TTS question, and (b) exposes
  // the QUOTED question's own words to trigger matching and to
  // extractNamedFieldValues (a quoted "What are the lives?" plus a leading
  // "Circuit 14" in the reply would extract 14 as a lives value). replyText
  // falls back to the annotated text for direct callers that pass no raw
  // reply, so the replay harness and unit paths are byte-unchanged.
  for (const schema of schemas) {
    const entry = detectEntry(replyText, schema);
    if (!entry.matched) continue;

    // Cross-utterance destructive suppression (id 93) — a standalone
    // "delete" on the PREVIOUS utterance armed a one-shot token in
    // sonnet-stream; within the arrival-delta window the follow-up scoped
    // trigger ("recontinuity readings for circuit 13") must reach the model
    // with the delete intent intact, not enter a script. Scoped to schemas
    // that opted into the entry guard (entryExclusionPattern) — the same
    // schemas whose SAME-utterance destructive entries already fall through.
    if (suppressDestructiveEntry === true && schema.entryExclusionPattern) {
      logger?.info?.(`${schema.name}_entry_suppressed_cross_utterance_destructive`, {
        sessionId,
        textPreview: text.slice(0, 80),
      });
      continue;
    }

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
    if (schema.entryExclusionPattern && schema.entryExclusionPattern.test(replyText)) {
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
      // RAW reply — see the loop comment above (annotation must not feed
      // designation lookup / extraction / the bare parser).
      text: replyText,
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
  `\\b${RING_ANCHOR_SRC}\\b(?:[^.?!]|(?<=\\d)\\.(?=\\d)){0,30}?\\b${NON_RING_ADJ_SRC}\\b|\\b${NON_RING_ADJ_SRC}\\b(?:[^.?!]|(?<=\\d)\\.(?=\\d)){0,30}?\\b${RING_ANCHOR_SRC}\\b`,
  'i'
);
const R1_PLUS_R2_COMPOUND_RE = /\bR\s*1\s*(?:\+|\s+plus\s+)\s*R\s*2\b/i;
const NON_RING_EARTH_COMPOUND_RE =
  /\b(?:earth\s+fault\s+loop|loop\s+impedance|earth\s+electrode|electrode\s+resistance|earth\s+leakage)\b/i;

// `maskCircuitSpans` (a circuit ref must never be captured as a reading value
// by the named extractors — "ring continuity earths for circuit 17 are 1.19"
// must never write 17) moved to helpers/extraction.js as the canonical shared
// copy (feedback id 109 wave, 2026-07-29): stage6-shadow-harness.js now masks
// its reparse input with the SAME function, so the two sites cannot drift.

/**
 * Group C fix 1 (feedback id 105, 2026-07-29) — mask the RESOLUTION text out
 * of a circuit-answer reply before the exclusive (IR voltage) parser runs on
 * the remainder. Rules, per the resolution metadata's kind:
 *   - bare whole-reply numeric ("56") → mask the WHOLE reply (the entire
 *     utterance IS the circuit ref; a 56-circuit board's "56" must never
 *     parse as a voltage);
 *   - explicit `circuit N` → mask only that span, so "circuit 4, tested at
 *     500" keeps 500 parseable;
 *   - matched designation → mask the first case-insensitive occurrence of
 *     the matched designation text (same keeps-the-remainder property).
 * All masking is length-preserving; residual `circuit N` spans elsewhere in
 * the reply are masked too (a second circuit mention's digits must not be
 * misread as a voltage), matching the step-7/8 extraction convention.
 */
function maskCircuitResolution(replyText, meta) {
  if (typeof replyText !== 'string' || !replyText) return '';
  if (!meta) return maskCircuitSpans(replyText);
  if (meta.kind === 'digit') {
    if (meta.wholeReply) return ' '.repeat(replyText.length);
    const masked =
      replyText.slice(0, meta.start) +
      ' '.repeat(meta.end - meta.start) +
      replyText.slice(meta.end);
    return maskCircuitSpans(masked);
  }
  if (meta.kind === 'designation') {
    // id 116 (2026-08-12): a pass-2 (fold-table) designation match carries
    // the RAW span of the user text that matched ("Upstairs lights" against
    // designation "Upstairs Lighting" — the stored designation string is NOT
    // findable in the reply). Consume the span BEFORE the literal search:
    // without it we'd fall to the mask-the-entire-reply branch and a
    // co-dictated voltage ("Upstairs lights, tested at 500") would be lost.
    if (
      meta.matchedUserSpan &&
      Number.isInteger(meta.matchedUserSpan.start) &&
      Number.isInteger(meta.matchedUserSpan.end) &&
      meta.matchedUserSpan.start >= 0 &&
      meta.matchedUserSpan.end > meta.matchedUserSpan.start &&
      meta.matchedUserSpan.end <= replyText.length
    ) {
      const masked =
        replyText.slice(0, meta.matchedUserSpan.start) +
        ' '.repeat(meta.matchedUserSpan.end - meta.matchedUserSpan.start) +
        replyText.slice(meta.matchedUserSpan.end);
      return maskCircuitSpans(masked);
    }
    if (typeof meta.matchedDesignation === 'string' && meta.matchedDesignation) {
      // Whitespace-TOLERANT span search (mini-review c1): the resolver
      // compares whitespace-collapsed strings, so the raw reply may hold the
      // designation with different spacing ("upstairs  sockets") — a plain
      // indexOf would miss it and over-mask, dropping a dictated voltage in
      // the same reply. Escape regex metachars, then let each space match
      // any whitespace run.
      const spanPattern = meta.matchedDesignation
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/ /g, '\\s+');
      const m = replyText.match(new RegExp(spanPattern, 'i'));
      if (m) {
        const masked =
          replyText.slice(0, m.index) +
          ' '.repeat(m[0].length) +
          replyText.slice(m.index + m[0].length);
        return maskCircuitSpans(masked);
      }
    }
    // SHORTENED designation answer (Codex cycle 1): the bidirectional
    // substring match also fires when the NORMALISED reply is a substring
    // of the stored designation ("the 56" against "56 sockets", "500 volt"
    // against "500 volt control supply") — the stored string is then not
    // findable in the reply, but the whole reply IS the resolution text.
    // Mask it all: without this, a designation's own digits parse as the
    // test voltage ("Did you say 56 volts?" / a silent voltage=500 write).
    // Fail direction is the voltage ASK — audible, re-answerable — never a
    // designation digit written as a voltage.
    return ' '.repeat(replyText.length);
  }
  return maskCircuitSpans(replyText);
}

// Scope-conflict provenance marker on a queued pending write (Codex
// diff-review r1). A value dictated ON the conflict utterance is an explicit
// fresh reading — when the which_circuit answer resolves onto a circuit that
// ALREADY holds that field, the drain must OVERWRITE, not skip (the
// skip-if-seeded guard exists for values the inspector did NOT restate).
// A Symbol property so it can never cross a JSON wire boundary; ordinary
// (non-conflict) pending writes never carry it and keep today's skip
// semantics. Mirrored per-file in both legacy twins.
const CONFLICT_OVERWRITE = Symbol('conflictOverwrite');

// PLAN A2 (feedback id 117) — carries a queued pending-write's provenance
// operation record across to the drain that eventually resolves it, so the
// drain calls markWritten/markSatisfiedExisting/markAbandoned on the SAME
// operation the enqueue site created rather than fabricating a new one.
// Symbol-keyed for the same reason as CONFLICT_OVERWRITE: it must never
// cross a JSON wire boundary.
const OPERATION_REF = Symbol('operationRef');

/**
 * Attach OPERATION_REF non-enumerably — mirrors the codebase's established
 * convention for symbol markers that must never appear in a structural
 * equality check (Jest's `toEqual` walks own enumerable symbol keys too) or
 * cross a JSON wire boundary (see EFFECTIVE_CIRCUIT_SLOT et al. in
 * stage6-per-turn-writes.js).
 */
function attachOperationRef(target, op) {
  Object.defineProperty(target, OPERATION_REF, {
    value: op,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return target;
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
 * Collect the unique, valid circuit refs bound by EVERY matching trigger
 * pattern (feedback id 98, 2026-07-27). The old first-match-return shape
 * silently picked whichever pattern sat earlier in the list — with the new
 * leading-circuit patterns placed first, "Circuit 10, ring continuity for
 * circuit 13" would have silently won as 10, the exact silent-winner bug
 * the scope-conflict resolver exists to prevent. Every pattern keeps its
 * circuit capture at m[1], so this is the ONLY reader of the group index.
 * Mirrored behaviourally in both legacy twins (ring-continuity-script.js /
 * insulation-resistance-script.js) so contradiction scenarios stay
 * replay-parity-eligible.
 */
function collectTriggerCircuitRefs(text, patterns) {
  let matched = false;
  const refs = [];
  const addRef = (raw) => {
    const ref = Number(raw);
    if (Number.isInteger(ref) && ref > 0 && !refs.includes(ref)) refs.push(ref);
  };
  // ^-anchored patterns (the terse triggers) stay START-ONLY for entry —
  // "Zs is 0.62. Ring on circuit 13." must NOT enter and swallow the Zs
  // reading (Codex cycle 2). But a REPEATED anchored trigger in a later
  // sentence still contributes its ref to CONTRADICTION collection, so the
  // collectors scan punctuation-delimited clause segments (horizontal
  // whitespace only, same newline rules as the leading patterns) with the
  // anchored pattern for refs only.
  const clauseSegments = text.split(/(?<=[.?!])[ \t]+/);
  for (const pattern of patterns) {
    if (pattern.source.startsWith('^')) {
      const m = text.match(pattern);
      if (m) {
        matched = true;
        if (m[1]) addRef(m[1]);
      }
      for (let i = 1; i < clauseSegments.length; i++) {
        const cm = clauseSegments[i].match(pattern);
        if (cm && cm[1]) addRef(cm[1]); // refs only — never entry
      }
      continue;
    }
    // Non-anchored patterns: EVERY occurrence via a fresh /g clone (never
    // matchAll a shared global RegExp — stateful lastIndex).
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    );
    for (const m of text.matchAll(global)) {
      matched = true;
      if (m[1]) addRef(m[1]);
    }
  }
  return { matched, refs };
}

/**
 * Test if a transcript matches a schema's entry triggers. Returns the
 * common detection shape { matched, circuit_ref, scope_conflict }:
 *   - circuit_ref is the SINGLE unambiguous circuit the trigger patterns
 *     bound (same number stated twice is unambiguous), or null;
 *   - scope_conflict=true when DIFFERENT circuits were bound by different
 *     patterns (an explicit contradiction — the caller must ask
 *     which_circuit, never pick a silent winner).
 *
 * Each trigger regex is expected to have an optional capture group at
 * position 1 for the circuit number.
 */
function detectEntry(text, schema) {
  if (typeof text !== 'string' || !text) {
    return { matched: false, circuit_ref: null, scope_conflict: false };
  }
  const { matched, refs } = collectTriggerCircuitRefs(text, schema.triggers);
  if (!matched) return { matched: false, circuit_ref: null, scope_conflict: false };
  if (refs.length >= 2) return { matched: true, circuit_ref: null, scope_conflict: true };
  return { matched: true, circuit_ref: refs[0] ?? null, scope_conflict: false };
}

/**
 * Detect a different entry on a NEW circuit while one is already
 * active. Used so an inspector mid-script can seamlessly switch to a
 * different circuit by re-stating the entry phrase with a new ref.
 * Returns the same { matched, circuit_ref, scope_conflict } shape as
 * detectEntry: matched=true ONLY for a single ref different from the
 * current circuit, or for a scope conflict (≥2 distinct refs — the
 * conflict is reported regardless of whether the current circuit is
 * among them; the caller owns the ask).
 */
function detectDifferentEntry(text, schema, currentCircuitRef) {
  if (typeof text !== 'string' || !text) {
    return { matched: false, circuit_ref: null, scope_conflict: false };
  }
  const { matched, refs } = collectTriggerCircuitRefs(text, schema.triggers);
  // A refs-only collection (later-sentence terse segment, no entry-eligible
  // trigger match) is NOT a switch (Codex cycle 3): "Zs is 0.62. Ring on
  // circuit 13." during an active episode must fall through to the model,
  // never clear the episode and discard its queued readings.
  if (!matched) return { matched: false, circuit_ref: null, scope_conflict: false };
  if (refs.length >= 2) return { matched: true, circuit_ref: null, scope_conflict: true };
  if (refs.length === 1 && refs[0] !== currentCircuitRef) {
    return { matched: true, circuit_ref: refs[0], scope_conflict: false };
  }
  return { matched: false, circuit_ref: null, scope_conflict: false };
}

function clearScriptState(session) {
  if (session) session.dialogueScriptState = null;
}

// ── PLAN A2 (feedback id 117) — per-run dictation-provenance ledger. ──
//
// The engine must know, per script run, what was DICTATED, what was WRITTEN,
// and who OWNS each value's speech, across a write topology with 8
// applyWriteWithDerivations call sites, queue/drain seams, state replacements
// (pivots), a Sonnet-ingestion route, and 17 clearScriptState exits. An
// ORDERED list of operation records lives on `state.operations` (see
// initScriptState). The circuit lives ON the operation (queued operations
// start circuit-less; replacements can cross circuits); `covered_by` is a
// PER-OPERATION coverage marker so a finish summary only claims the
// operations it actually rendered.
let __dialogueOperationCounter = 0;
function nextDialogueOperationId() {
  __dialogueOperationCounter += 1;
  return `dop_${__dialogueOperationCounter}`;
}

/**
 * Record a dictated value BEFORE any seeded-value skip decision. Returns the
 * operation record; callers hold onto it to call markWritten/
 * markSatisfiedExisting/markRejected/markAbandoned as the write resolves.
 * `circuit_ref: null` is valid — a queued (circuit-unresolved) dictation
 * starts circuit-less and gets its circuit bound at drain time.
 */
function markDictated(
  state,
  field,
  value,
  { source = null, circuit_ref = null, schema = null } = {}
) {
  if (!state) return null;
  if (!Array.isArray(state.operations)) state.operations = [];
  // Codex diff-review r1 (edge-interactions lens) — capture the spoken
  // LABEL at dictation time, from the ORIGINATING schema. A REPLACEMENT
  // (runPivot) carries this operation into a state whose CURRENT schema
  // may not even declare this field as a slot (e.g. rcd_trip_time after an
  // RCD->RCBO pivot) — re-resolving the label against the current schema
  // at speech time would silently fall back to the raw field name.
  const label = schema?.slots?.find((s) => s.field === field)?.label ?? null;
  const op = {
    operation_id: nextDialogueOperationId(),
    field,
    dictated_value: value,
    written_value: null,
    effective_circuit_ref: circuit_ref,
    source,
    origin_schema_slot: field,
    label,
    spoken_owner: null,
    disposition: 'queued',
    covered_by: null,
  };
  state.operations.push(op);
  return op;
}

/** Bind a successful write (+ its effective circuit) to an existing operation. */
function markWritten(op, value, circuit_ref = null) {
  if (!op) return op;
  op.written_value = value;
  if (circuit_ref !== null && circuit_ref !== undefined) op.effective_circuit_ref = circuit_ref;
  op.disposition = 'applied';
  return op;
}

/** A canonical-EQUAL dictation that skipped the write — still read-back-eligible. */
function markSatisfiedExisting(op, value, circuit_ref = null) {
  if (!op) return op;
  op.written_value = value;
  if (circuit_ref !== null && circuit_ref !== undefined) op.effective_circuit_ref = circuit_ref;
  op.disposition = 'satisfied_existing';
  return op;
}

/** Failed validation — never read back. */
function markRejected(op) {
  if (!op) return op;
  op.disposition = 'rejected';
  return op;
}

/** An unresolved clear discarded a still-queued value before it ever wrote. */
function markAbandoned(op) {
  if (!op) return op;
  op.disposition = 'abandoned';
  return op;
}

/**
 * Canonicalise both sides through the slot's own parser before comparing —
 * a bare string/number mismatch ("0.62" vs 0.62) must never be treated as a
 * genuine correction. Falls back to strict equality when the slot has no
 * parser or either side fails to parse.
 */
function canonicaliseSlotValue(slot, value) {
  if (!slot || typeof slot.parser !== 'function') return value;
  if (value === null || value === undefined) return value;
  try {
    const parsed = slot.parser(typeof value === 'string' ? value : String(value));
    return parsed === null || parsed === undefined ? value : parsed;
  } catch {
    return value;
  }
}

// Exported (Codex diff-review r2) so the dispatcher's ownership resolver
// (stage6-dispatchers-script.js) can canonicalise-compare a per-turn prior
// winner against a seed's value through the SAME slot parser the engine
// itself uses, instead of a raw String() comparison that treats
// representationally-different-but-semantically-equal values (e.g. a
// record_reading's canonical "BS EN 61008" vs a Sonnet seed's raw "61008")
// as different — which silently produced a double-speak (the bundler
// confirms the record_reading value, then the resolver's false negative
// leaves the seed script-owned, and it gets spoken again).
export function valuesCanonicallyEqual(slot, existingValue, candidateValue) {
  const a = canonicaliseSlotValue(slot, existingValue);
  const b = canonicaliseSlotValue(slot, candidateValue);
  return a === b || String(a) === String(b);
}

/**
 * §A2.5 terminal-sink rule — the ONE canonical helper that computes uncovered
 * operations and renders their read-back. Called before every TERMINAL
 * clearScriptState site (never before a REPLACEMENT site, which copies the
 * operation list across instead). Marks rendered operations `covered_by` so
 * a later call in the same turn can never re-speak them. No-op when there is
 * nothing uncovered (the common case).
 */
/**
 * Compute (and mark covered) the read-back text for every uncovered
 * operation, WITHOUT sending anything. `null` when there is nothing
 * uncovered. Callers that already have a terminal frame of their own
 * (cancel, defer, bulk-apply-done, finish, the confirmation cap exit)
 * APPEND this text to that frame — one combined wire message, per §A2.5
 * point 3 ("appended to the existing terminal frame where one exists").
 * Marks `covered_by` as a side effect so a later call in the same turn can
 * never re-speak the same operation.
 */
function computeUncoveredReadback(state, schema, siteLabel) {
  const ops = Array.isArray(state?.operations) ? state.operations : [];
  // Codex diff-review r1 (round 1) tried excluding a superseded same-
  // (field,circuit) APPLIED operation from ever being spoken. Codex
  // diff-review r2 (cycle 2, 2/3 independent lenses convergent) reversed
  // this: the plan's own test (l) — "two same-field dictations -> two
  // operations, each spoken per its own coverage" — and its refine-log
  // round 2 rationale ("per-operation coverage, not field-level;
  // superseded QUEUED ops -> abandoned") deliberately distinguish a
  // superseded QUEUED write (which never landed, correctly abandoned and
  // silent) from two genuinely APPLIED writes (both landed on the snapshot
  // at some point this run and both get their own read-back). Coverage
  // here is per-OPERATION, not per-field — `findCoveringOp`/
  // `transitionToConfirmation` already mark only the LATEST matching
  // operation `covered_by` (since that's the one whose value the legacy
  // finish/confirmation text actually renders); an earlier, uncovered
  // APPLIED operation is not excluded, it is simply also spoken here.
  const uncovered = ops.filter(
    (op) =>
      (op.disposition === 'applied' || op.disposition === 'satisfied_existing') &&
      op.spoken_owner !== 'bundler' &&
      op.covered_by == null
  );
  if (uncovered.length === 0) return null;
  // Codex diff-review r1 (edge-interactions lens) — a REPLACEMENT site
  // (runPivot, scope-conflict clear+reinit) carries operations across a
  // circuit change; an uncovered operation from a DIFFERENT circuit than
  // the one this state is now scoped to must be attributed by circuit, or
  // the read-back would be ambiguous about which circuit it names.
  const currentCircuitRef = state.circuit_ref ?? null;
  const parts = uncovered.map((op) => {
    // Prefer the label captured at dictation time (survives a schema
    // REPLACEMENT where the field is no longer one of the CURRENT
    // schema's slots); fall back to a live lookup for older/legacy
    // operations that predate the label capture, then the raw field name.
    const slot = schema?.slots?.find((s) => s.field === op.field);
    const label = op.label ?? slot?.label ?? op.field;
    const value = op.written_value ?? op.dictated_value;
    const opCircuit = op.effective_circuit_ref ?? null;
    const circuitPrefix =
      opCircuit !== null && opCircuit !== currentCircuitRef ? `circuit ${opCircuit} ` : '';
    return `${circuitPrefix}${label} ${value}`;
  });
  const text = parts.length === 1 ? `Also got ${parts[0]}.` : `Also got: ${parts.join(', ')}.`;
  for (const op of uncovered) op.covered_by = siteLabel;
  return { text, uncovered };
}

/**
 * §A2.5 point 3 — for a TERMINAL site with NO existing spoken frame (the
 * model owns the turn's audibility, or the clear is otherwise silent):
 * emit the uncovered read-back as one distinct info frame before the clear.
 * No-op when there's nothing uncovered.
 */
function renderTerminalReadback({
  ws,
  session,
  sessionId,
  schema,
  logger,
  now,
  responseEpoch,
  siteLabel,
}) {
  const state = session?.dialogueScriptState;
  if (!state) return;
  const readback = computeUncoveredReadback(state, schema, siteLabel);
  if (!readback) return;
  const payload = buildScriptInfo({
    toolCallIdPrefix: schema.toolCallIdPrefix,
    sessionId,
    kind: 'terminal_readback',
    text: readback.text,
    now,
    responseEpoch,
  });
  if (ws && ws[PLAN00_DELIVERY_EMIT_OBSERVER]) {
    attachAudibilityDescriptor(
      payload,
      readback.uncovered.map((op) => ({
        field: op.field,
        circuit: op.effective_circuit_ref,
        value: op.written_value ?? op.dictated_value,
      }))
    );
  }
  safeSend(ws, payload);
  logger?.info?.(`${schema.logEventPrefix}_terminal_readback`, {
    sessionId,
    site: siteLabel,
    fields: readback.uncovered.map((op) => op.field),
  });
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
    // Plan D (2026-07-25) — impedance-clamp provenance, field-keyed, exactly
    // parallel to `values`. Lives HERE (not on the session) so lifecycle rule 3
    // is structural: a new/cancelled/abandoned script replaces this whole
    // object and the corrections go with it, so a stale "I corrected 16 to 1.6"
    // can never survive into an unrelated episode. See
    // helpers/value-corrections.js.
    valueCorrections: {},
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
    // §2.2.2 (feedback id 110b, 2026-07-29): a bare "No. 0.85" (negation +
    // ONE anchored value, no slot label, no pending slot) retains the value
    // here while the negation re-ask asks WHICH slot is wrong; the slot
    // answer ("R1") applies it via the 5c write path — a two-turn correction
    // instead of P1's three-turn No. → R1. → 0.85 machine. Cleared on every
    // exit (clearScriptState kills the whole object) AND on every
    // mid-episode continuation (5b amend, 5c pending-slot write, value-less
    // 5g re-entry) so a stale value can never land on a slot the inspector
    // didn't pair it with.
    confirmation_pending_value: null,
    // M4 (2026-06-25, field session 6674E8C5): IR voltage-phase tracking.
    // `voltage_phase_entered_at` is stamped (once) by askNextOrFinish the
    // first time it emits the exclusive voltage ask; the step-6 voltage block
    // uses it for a one-shot 30s in-script re-ask on genuine silence. Do NOT
    // reuse last_turn_at for this — it resets to `now` at the top of every
    // active turn, so `now - last_turn_at ≈ 0` and the check would never fire.
    // `voltage_reask_done` makes that re-ask one-shot.
    voltage_phase_entered_at: null,
    voltage_reask_done: false,
    // PLAN A2 (feedback id 117) — ordered dictation-operation ledger. See the
    // markDictated/markWritten/markSatisfiedExisting/markRejected/
    // markAbandoned helpers above initScriptState and the terminal-sink rule
    // in renderTerminalReadback.
    operations: [],
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
  // The guard runs BEFORE the corrections are consumed — consuming on a path
  // that then emits nothing would silently discard the provenance and the
  // clamp would never be named aloud (a spoken-but-not-heard bug).
  if (!state || !schema?.confirmation?.buildMessage) return;
  state.awaiting_confirmation = true;
  // Plan D (id-100(b)) — CONSUME the clamp provenance for every slot this
  // message reads back. Consume, not peek: this confirmation is the read-back
  // that names the correction, and the amend/re-confirm loop re-enters here, so
  // peeking would repeat "I corrected 16 to 1.6" on every subsequent
  // re-confirmation (Audio-First #1 is exactly once, not at-least-once). A slot
  // corrected by a LATER amend records a fresh correction and is named then.
  //
  // The value the caller is composing from is `state.values`, which applyWrite
  // fills with the CLAMPED value — so the spoken number is the stored number by
  // construction, and this only adds the explanation.
  //
  // …but consume ONLY when this message can actually reach the inspector.
  // `safeSend` silently returns on an absent/closed socket (by design — "the
  // script's persistent state is the source of truth, not the wire"), so
  // consuming unconditionally would empty the ledger on a turn that spoke
  // NOTHING. The clause would then be owed and unpayable: the confirmation
  // re-emit path below (case (c), an inspector re-stating the entry trigger)
  // routes back through here, finds an empty ledger, and reads the value back
  // BARE — a clamp applied and never named, which is the failure this plan
  // exists to prevent. Nothing was spoken, so the ledger legitimately still
  // owes the clause; leave it there for whoever speaks next.
  //
  // The predicate mirrors `safeSend`'s own gate (wire-emit.js is deliberately
  // untouched by this plan, and it reports no success signal to callers). It is
  // the same `readyState !== undefined && readyState !== OPEN` idiom used by the
  // two legacy scripts. RESIDUAL, accepted: a socket that is OPEN but whose
  // `send` THROWS still consumes — closing that needs `safeSend` to return
  // delivery status, which is a wire-emit change and a follow-up.
  const canDeliver =
    !!ws &&
    typeof ws.send === 'function' &&
    (ws.readyState === undefined || ws.readyState === ws.OPEN);
  const corrections = {};
  if (canDeliver) {
    for (const slot of schema.slots ?? []) {
      const correction = consumeValueCorrection(state, slot.field);
      if (correction) corrections[slot.field] = correction;
    }
  }
  safeSend(
    ws,
    buildScriptConfirm({
      toolCallIdPrefix: schema.toolCallIdPrefix,
      sessionId,
      circuit_ref: state.circuit_ref,
      // The CALLER composes the finished string (wire-emit.js takes a prebuilt
      // question and is deliberately left unchanged).
      question: schema.confirmation.buildMessage({ values: state.values, corrections }),
      reason: schema.confirmation.reason,
      now,
      responseEpoch,
    })
  );
  // PLAN A2 (feedback id 117) — schemas with a `confirmation` block (ring,
  // IR) read back EVERY filled slot via this message, not via finishScript's
  // "done" text. Mark those operations covered here — same "consume only
  // when it can actually reach the inspector" gate as the corrections above
  // — so a LATER terminal exit (cap exit, delete exit, cancel) never
  // re-speaks a value this confirmation prompt already named.
  if (canDeliver) {
    const ops = Array.isArray(state.operations) ? state.operations : [];
    for (const op of ops) {
      if (
        (op.disposition === 'applied' || op.disposition === 'satisfied_existing') &&
        op.spoken_owner !== 'bundler' &&
        op.covered_by == null &&
        // Codex diff-review r1 — circuit-scoped: an operation carried
        // across a REPLACEMENT (runPivot / scope-conflict reinit) from a
        // DIFFERENT circuit must never be marked covered by THIS circuit's
        // confirmation message just because the field name matches.
        op.effective_circuit_ref === state.circuit_ref &&
        state.values[op.field] !== undefined
      ) {
        op.covered_by = 'confirmation';
      }
    }
  }
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
  // PLAN A2 (feedback id 117) — an ordered operation list carried over from a
  // REPLACEMENT site (e.g. the confirmation_circuit_switch clear+runEntry
  // seam). null for every ordinary entry (the common case).
  carriedOperations = null,
}) {
  // Scope-conflict entry (feedback id 98, 2026-07-27): the trigger patterns
  // bound DIFFERENT circuits ("Circuit 10, ring continuity for circuit 13").
  // An explicit contradiction must never pick a silent winner — skip the
  // designation fallback entirely (a designation match would just be a third
  // candidate), queue any volunteered readings against the UNRESOLVED
  // episode, and emit the schema's existing which_circuit ask. Volunteered
  // extraction runs on the circuit-span-MASKED text: the raw extractors
  // accept the first digit within their char-bound after a conductor label,
  // so "Circuit 5, ring continuity earths for circuit 3 are 1.19" would
  // otherwise capture 3 as the CPC value and write it once the scope
  // resolves (same masking contract as the confirmation 5a seed path).
  if (entry.scope_conflict === true) {
    initScriptState(session, schema, null, now);
    const conflictState = session.dialogueScriptState;
    if (Array.isArray(carriedOperations)) conflictState.operations = carriedOperations;
    // Conflict-origin episode: the position-4 resolver re-asks on silent
    // value-only follow-ups and the drain OVERWRITES pre-filled fields for
    // the marker-carrying writes (see CONFLICT_OVERWRITE).
    conflictState.scope_conflict_origin = true;
    const queued = extractNamedFieldValues(maskCircuitSpans(text), schema.slots);
    // Compound value-first entry (feedback id 123, 2026-08-12): consulted
    // ONLY when named extraction found neither slot (for IR the only slots
    // with namedExtractors are L-L/L-E, so length 0 ⟺ neither IR slot).
    // Receives the RAW text — this path masks circuit spans before named
    // extraction, and masked text would erase the evidence the extractor's
    // scope guard needs to refuse "…for circuit 2…" shapes.
    if (queued.length === 0 && typeof schema.compoundEntryExtractor === 'function') {
      queued.push(...schema.compoundEntryExtractor(text));
    }
    for (const w of queued) {
      w[CONFLICT_OVERWRITE] = true;
      // PLAN A2 §A2.2 — entry scope-conflict queue: mark at enqueue
      // (disposition 'queued'), circuit-less until the which_circuit answer
      // drains it.
      attachOperationRef(
        w,
        markDictated(conflictState, w.field, w.value, {
          schema,
          source: 'runEntry_scope_conflict_queue',
          circuit_ref: null,
        })
      );
      conflictState.pending_writes.push(w);
    }
    logger?.info?.(`${schema.logEventPrefix}_entry_scope_conflict`, {
      sessionId,
      pending_writes: conflictState.pending_writes.map((w) => w.field),
      textPreview: text.slice(0, 80),
    });
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
    return { handled: true, fallthrough: false };
  }

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
  // Circuit-span-MASKED extraction on the ORDINARY entry path too (Codex
  // diff-review r1) — not only the conflict branch: with an unambiguous
  // repeated scope ("Circuit 13, ring continuity earths for circuit 13 are
  // 1.19") the raw extractors accept the trailing span's digit as the
  // conductor value (13 → clamped 1.3) exactly as they would on a conflict.
  // Length-preserving, and a legitimate reading value never sits inside a
  // `circuit N` span, so masking can only remove corruption.
  const maskedEntryText = maskCircuitSpans(text);
  const volunteered = extractNamedFieldValues(maskedEntryText, schema.slots);
  // Compound value-first entry (feedback id 123, 2026-08-12): same
  // consultation rule as the scope-conflict branch above — only on a
  // neither-slot named result, and on the RAW text so the extractor's
  // whole-span circuit scope guard sees the evidence masking would erase.
  if (volunteered.length === 0 && typeof schema.compoundEntryExtractor === 'function') {
    volunteered.push(...schema.compoundEntryExtractor(text));
  }

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
    schema.bareEntryParser(maskedEntryText) != null;
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
  if (Array.isArray(carriedOperations)) state.operations = carriedOperations;
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
    // PLAN A2 (§A2.2 direct-parse-apply row) — mark the dictation BEFORE any
    // seeded-value skip decision, at parse time.
    const op = markDictated(state, w.field, w.value, {
      schema,
      source: 'runEntry_volunteered',
      circuit_ref: circuitRef,
    });
    const slot = circuitRef !== null ? schema.slots.find((s) => s.field === w.field) : null;
    // PLAN A2 §A2.3 — the seeded-value skip is no longer a blanket skip.
    // overwriteVolunteered (the voltage-phase escape-hatch reprocess) keeps
    // bypassing it entirely — an explicitly-spoken fresh value MUST overwrite.
    // Otherwise: canonicalise both sides; EQUAL → satisfied_existing, no
    // write; DIFFERENT → fall through and overwrite (a stale seeded value
    // must never silently win over a genuinely different dictated one).
    if (!overwriteVolunteered && state.values[w.field] !== undefined) {
      if (circuitRef !== null && valuesCanonicallyEqual(slot, state.values[w.field], w.value)) {
        markSatisfiedExisting(op, state.values[w.field], circuitRef);
        continue;
      }
      if (circuitRef === null) {
        // No circuit yet to compare against — queue as before.
        state.pending_writes.push(w);
        attachOperationRef(w, op);
        continue;
      }
      // canonical-DIFFERENT → overwrite below.
    }
    if (circuitRef !== null) {
      const r = applyWriteWithDerivations(session, schema, slot, circuitRef, w.value, now);
      markWritten(op, r.effectiveValue, circuitRef);
      // Plan D Seam B — the WIRE entry carries the value that was STORED, not
      // the raw dictated one, or the client writes 16 into a cell the server
      // holds at 1.6.
      writes.push({ ...w, value: r.effectiveValue });
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
      attachOperationRef(w, op);
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
    const bare = schema.bareEntryParser(maskedEntryText);
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
 *
 * Plan D Seam B (2026-07-25) — also returns `effectiveValue`: the value
 * `applyWrite` actually STORED after the impedance clamp. Callers must use it
 * for the wire entry they hand to `buildExtractionPayload` and for their log
 * row, or the frame carries the raw dictated 16 while the snapshot holds 1.6
 * and the client writes 16 into the cell.
 *
 * Derivations are fed the EFFECTIVE value too: a derivation computed from the
 * raw 16 (e.g. an OCPD-rating → max-Zs comparison) would be reasoning about a
 * magnitude that was never stored.
 */
function applyWriteWithDerivations(session, schema, slot, circuit_ref, value, now) {
  const written = applyWrite(session, schema, circuit_ref, slot.field, value, now);
  const derived = applyDerivations({ session, schema, slot, value: written.value });
  return { ...derived, effectiveValue: written.value, correction: written.correction };
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
    // Scope-conflict preflight (Codex diff-review r1): a contradictory
    // scoped ENTRY ("Circuit 5, insulation resistance … for circuit 3 is
    // 200") is NOT a disambiguation answer — without this check
    // disambiguateBareValue would treat it as the L-L/L-E routing reply and
    // write the previously buffered bare value to the OLD circuit with no
    // which_circuit ask. Fall through to the position-2 conflict branch,
    // which replaces the episode and asks. Non-conflict replies keep
    // today's disambiguation handling unchanged.
    // WIDENED twice (mini-review r1 + Codex cycle 2): ANY fresh entry-shaped
    // reply supersedes the routing question — "Circuit 5, insulation
    // resistance live to live is 200" (different circuit), "Circuit 13,
    // insulation resistance live to live is 200" (SAME circuit), and the
    // unscoped "insulation resistance live to live is 200" are all
    // definitive fresh dictation, not L-L/L-E routing answers; consuming
    // them here wrote the stale buffered value and dropped the dictated
    // one. A genuine routing answer ("live to live") matches no entry
    // trigger and is handled below unchanged. Different-circuit/conflict
    // shapes fall through to position 2; same-current/unscoped shapes clear
    // the routing state and continue to normal named-value extraction.
    const disambiguationEntry = detectEntry(reply, schema);
    if (disambiguationEntry.matched === true) {
      const differs = detectDifferentEntry(reply, schema, state.circuit_ref);
      if (differs.matched !== true) {
        logger?.info?.(`${schema.logEventPrefix}_disambiguation_superseded_by_entry`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          dropped_bare_value: state.awaiting_disambiguation?.value ?? null,
          textPreview: reply.slice(0, 80),
        });
        state.awaiting_disambiguation = null;
        state.disambiguation_retry_attempted = false;
        // Continue through the normal active path below (named extraction
        // applies the dictated reading).
      }
      // differs.matched === true (different circuit or conflict) → position
      // 2 owns the turn; fall through without touching the routing state
      // (the conflict/switch branch replaces the episode wholesale).
    } else {
      const bare = state.awaiting_disambiguation;
      // RAW reply (mini-review r1): the annotated text QUOTES the routing
      // question ("Was that L-L or L-E?"), whose own tokens could satisfy
      // the router regardless of what the inspector actually said.
      const verdict = schema.disambiguateBareValue(reply);
      // Plan D Seam B — the clamped value actually stored, for the log row below.
      let disambiguatedValue = null;
      if (verdict && verdict.field) {
        // Belt-and-braces: don't overwrite if the inspector somehow
        // filled the chosen slot in the meantime (rare but possible if
        // a parallel write landed).
        if (state.values[verdict.field] == null) {
          // PLAN A2 §A2.2 — "buffered bare IR at queue-acceptance": the bare
          // value was captured circuit-less/field-less at entry
          // (ambiguous_bare_value); it becomes a known-field dictation only
          // HERE, where the inspector's routing answer resolves it to a slot.
          const op = markDictated(state, verdict.field, bare.value, {
            schema,
            source: 'ir_bare_disambiguation',
            circuit_ref: state.circuit_ref,
          });
          // Plan D Seam B — capture the return value. The raw re-assignment that
          // used to sit on the next line (`state.values[...] = bare.value`) is
          // DELETED: applyWrite already writes state.values, and re-assigning the
          // raw value would undo the clamp so the NEXT turn's read-back re-reads
          // the uncorrected magnitude.
          const written = applyWrite(
            session,
            schema,
            state.circuit_ref,
            verdict.field,
            bare.value,
            now
          );
          markWritten(op, written.value, state.circuit_ref);
          disambiguatedValue = written.value;
          safeSend(
            ws,
            buildExtractionPayload(
              state.circuit_ref,
              [{ field: verdict.field, value: written.value }],
              schema.extractionSource
            )
          );
        }
        logger?.info?.(`${schema.logEventPrefix}_disambiguation_resolved`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          bare_value: disambiguatedValue ?? bare.value,
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
    } // end scope-conflict-preflight guard — a conflict falls through to position 2
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
    // PLAN A2 §A2.5 site table (L1833-class) — TERMINAL: the model owns this
    // turn's audibility from here, but any uncovered dictation from EARLIER
    // in this episode still needs its read-back before the state vanishes.
    renderTerminalReadback({
      ws,
      session,
      sessionId,
      schema,
      logger,
      now,
      responseEpoch,
      siteLabel: 'confirmation_delete_exit',
    });
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
    // PLAN A2 §A2.5 site table (L1870-class) — TERMINAL, appended to the
    // cancel frame (one combined message — the schema's own "N of M saved"
    // count is not a value read-back, so anything genuinely uncovered still
    // needs to be named).
    const cancelReadback = computeUncoveredReadback(state, schema, 'cancel');
    const cancelBaseText =
      filled > 0 ? schema.cancelMessage({ filled, total }) : schema.cancelMessageEmpty;
    safeSend(
      ws,
      buildScriptInfo({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        kind: 'cancel',
        text: cancelReadback ? `${cancelBaseText} ${cancelReadback.text}` : cancelBaseText,
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
  //
  // SCOPE-CONFLICT exception (feedback id 98, 2026-07-27): a reply whose
  // trigger patterns bind TWO different circuits ("Circuit 10, ring
  // continuity for circuit 13") is an explicit contradiction and IS handled
  // here in BOTH states — awaiting_confirmation is NOT exempt, because the
  // 5a preflight filters out the CURRENT circuit from its target set, so
  // with current circuit 10 the conflicting pair {10, 13} would silently
  // switch to 13. Non-conflicting different-circuit replies keep today's
  // routing (generic switch below when collecting; 5a during confirmation).
  // Detection parses the RAW reply in EVERY state (Codex diff-review r1,
  // superseding the older annotated-text stance for THIS check): the
  // `[In response to …]` annotation defeats the leading patterns'
  // clause-start anchor, so an annotated "Circuit 14, ring continuity"
  // reply to a script ask would miss the switch and step-7 extraction
  // would eat the 14 as a conductor value. Positions 1 (cancel) and 3
  // (topic switch) deliberately keep parsing the annotated text (P1 Fix-4
  // note — their trigger words never appear in quoted questions).
  const diffEntry = detectDifferentEntry(reply, schema, state.circuit_ref);
  if (diffEntry.scope_conflict === true) {
    const wasConfirmation = state.awaiting_confirmation === true;
    // Volunteered values from the conflict utterance, extraction-safe: the
    // circuit-span mask stops "…earths for circuit 3 are 1.19" capturing 3
    // as a conductor value; in confirmation mode the full ring-safe
    // qualification also rejects explicit non-ring contexts (mirrors 5a/5b).
    let queued;
    if (wasConfirmation) {
      const safe = extractRingSafeNamedValues(reply, schema);
      queued = safe.rejected ? [] : safe.values;
    } else {
      queued = extractNamedFieldValues(maskCircuitSpans(reply), schema.slots);
    }
    // An UNRESOLVED prior episode (circuit never answered) may still hold
    // queued dictated values — they are real readings; carry them into the
    // replacement episode instead of deleting them (Codex diff-review r1).
    // Fields the conflict utterance restates take precedence.
    const priorPending =
      state.circuit_ref === null && Array.isArray(state.pending_writes)
        ? state.pending_writes.filter((pw) => !queued.some((q) => q.field === pw.field))
        : [];
    // PLAN A2 §A2.1 — a queued write the conflict utterance RESTATES (same
    // field, now superseded by `queued`) is dropped from priorPending; its
    // operation becomes abandoned rather than being silently orphaned at
    // disposition 'queued' forever.
    if (state.circuit_ref === null && Array.isArray(state.pending_writes)) {
      for (const pw of state.pending_writes) {
        if (queued.some((q) => q.field === pw.field)) {
          const op = pw[OPERATION_REF];
          if (op) markAbandoned(op);
        }
      }
    }
    logger?.info?.(`${schema.logEventPrefix}_different_entry_scope_conflict`, {
      sessionId,
      from_ref: state.circuit_ref,
      was_confirmation: wasConfirmation,
      pending_writes: queued.map((w) => w.field),
      carried_pending_writes: priorPending.map((w) => w.field),
      textPreview: reply.slice(0, 80),
    });
    // Audio-First purge contract: abandoning an in-flight confirmation makes
    // the queued "All correct?" prompt stale — purge before the replacement
    // ask (same srv- prefix; purge must go first so the ask isn't swallowed).
    if (wasConfirmation) sendScriptPurge(ws, schema, sessionId);
    // Replace the old episode with an UNRESOLVED one: never write the
    // volunteered values to the OLD circuit; the target stays open until the
    // which_circuit answer drains pending_writes via the position-4 resolver.
    // PLAN A2 §A2.5 site table (L1934-class) — REPLACEMENT: carry the full
    // ordered operation list across, no render.
    const priorOperations = Array.isArray(state.operations) ? state.operations : [];
    clearScriptState(session);
    initScriptState(session, schema, null, now);
    const conflictState = session.dialogueScriptState;
    conflictState.operations = priorOperations;
    conflictState.scope_conflict_origin = true;
    for (const w of queued) {
      w[CONFLICT_OVERWRITE] = true;
      // PLAN A2 §A2.2 — same enqueue contract as the entry scope-conflict
      // queue: mark at enqueue, circuit-less.
      attachOperationRef(
        w,
        markDictated(conflictState, w.field, w.value, {
          schema,
          source: 'runActivePath_scope_conflict_queue',
          circuit_ref: null,
        })
      );
      conflictState.pending_writes.push(w);
    }
    for (const w of priorPending) conflictState.pending_writes.push(w);
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
    return { handled: true, fallthrough: false };
  }
  const newRef = state.awaiting_confirmation || !diffEntry.matched ? null : diffEntry.circuit_ref;
  if (newRef !== null) {
    const { filled } = countFilledForCancel(state.values, schema.slots);
    logger?.info?.(`${schema.logEventPrefix}_switched_circuit`, {
      sessionId,
      from_ref: state.circuit_ref,
      to_ref: newRef,
      partial_filled_on_old: filled,
      textPreview: text.slice(0, 80),
    });
    // PLAN A2 §A2.5 site table (L1969-class) — TERMINAL: this episode ends
    // here (the recursive processDialogueTurn call below starts a genuinely
    // fresh entry, not a continuation), so any uncovered dictation must be
    // read back before the clear.
    renderTerminalReadback({
      ws,
      session,
      sessionId,
      schema,
      logger,
      now,
      responseEpoch,
      siteLabel: 'switched_circuit',
    });
    clearScriptState(session);
    // Recurse so the fresh entry runs on the same transcript. rawReplyText
    // rides along (Codex diff-review r1) so the fresh entry's detection AND
    // extraction parse the un-annotated reply — without it the recursion
    // would re-derive replyText from the ANNOTATED transcript and the
    // quoted question's words would feed extractNamedFieldValues.
    return processDialogueTurn({
      ws,
      session,
      sessionId,
      transcriptText,
      rawReplyText: reply,
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
    // PLAN A2 §A2.5 site table (L2048-class) — TERMINAL: the model owns this
    // turn's audibility, but any uncovered EARLIER dictation still needs its
    // read-back before the silent clear.
    renderTerminalReadback({
      ws,
      session,
      sessionId,
      schema,
      logger,
      now,
      responseEpoch,
      siteLabel: 'topic_switch',
    });
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
      // PLAN A2 §A2.5 site table (L2102-class) — TERMINAL, shared helper so
      // every caller is covered.
      renderTerminalReadback({
        ws,
        session,
        sessionId,
        schema,
        logger,
        now,
        responseEpoch,
        siteLabel: 'confirmation_clear_and_fallthrough',
      });
      clearScriptState(session);
      return { handled: true, fallthrough: true, transcriptText };
    };

    // Audible cap exit — purge FIRST (the replacement line shares the
    // `srv-…` prefix and must not be swallowed by its own purge), then the
    // schema's cap-exit wording, then full clear. The cap turn speaks ONLY
    // this line.
    const takeNegationCapExit = () => {
      sendScriptPurge(ws, schema, sessionId);
      // PLAN A2 §A2.5 site table (L2128-class) — TERMINAL, appended to the
      // cap-exit wording (one combined message). In practice this is
      // normally a no-op here: transitionToConfirmation already covered
      // every confirmable field on the way into awaiting_confirmation.
      const capExitReadback = computeUncoveredReadback(state, schema, 'confirmation_cap_exit');
      const capExitBaseText = confirmCfg.negationCapExit({ circuit_ref: state.circuit_ref });
      safeSend(
        ws,
        buildScriptInfo({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          kind: 'confirmation_cap_exit',
          text: capExitReadback ? `${capExitBaseText} ${capExitReadback.text}` : capExitBaseText,
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
          // PLAN A2 §A2.5 site table (L2294-class) — REPLACEMENT: clears then
          // runs runEntry fresh, so carry the operation list across (never
          // render here — runEntry's own episode owns the eventual read-back).
          const carriedOperationsForSwitch = Array.isArray(state.operations)
            ? state.operations
            : [];
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
            carriedOperations: carriedOperationsForSwitch,
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
        // PLAN A2 §A2.2 — 5b fires on EVERY parsed named amend; mark at parse,
        // then bind the write (this branch is an explicit overwrite/amend, no
        // seeded-value skip applies here).
        const op = markDictated(state, w.field, w.value, {
          schema,
          source: 'confirmation_5b_named_amend',
          circuit_ref: state.circuit_ref,
        });
        const r = applyWriteWithDerivations(session, schema, slot, state.circuit_ref, w.value, now);
        markWritten(op, r.effectiveValue, state.circuit_ref);
        // Plan D Seam B — the raw `state.values[w.field] = w.value` that used to
        // sit here is DELETED. applyWrite has already written the CLAMPED value;
        // re-assigning the raw one undid the clamp, so the next confirmation
        // read-back re-read the uncorrected magnitude.
        overwrites.push({ ...w, value: r.effectiveValue });
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
      // amend also satisfies any pending slot AND supersedes a retained
      // bare value (§2.2.2 lifecycle — "No. 0.85" → "Actually R1 is 0.9"
      // must never later apply the stale 0.85).
      state.confirmation_no_progress = 0;
      state.confirmation_pending_slot = null;
      state.confirmation_pending_value = null;
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
          // PLAN A2 §A2.2 — 5c fires when a confirmation_pending_slot is
          // consumed. Mark at parse (this branch is a correction/write, no
          // seeded-value skip applies).
          const op = markDictated(state, slot.field, parsed, {
            schema,
            source: 'confirmation_5c_pending_slot',
            circuit_ref: state.circuit_ref,
          });
          const r = applyWriteWithDerivations(
            session,
            schema,
            slot,
            state.circuit_ref,
            parsed,
            now
          );
          markWritten(op, r.effectiveValue, state.circuit_ref);
          // Plan D Seam B — raw re-assignment DELETED (applyWrite already stored
          // the clamped value); the wire entry carries the effective value.
          const writes = [{ field: slot.field, value: r.effectiveValue }];
          for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
          for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
          safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
          logger?.info?.(`${schema.logEventPrefix}_confirmation_pending_slot_amended`, {
            sessionId,
            circuit_ref: state.circuit_ref,
            field: slot.field,
            // Plan D Seam B — log the value that was STORED.
            value: r.effectiveValue,
          });
          state.confirmation_no_progress = 0;
          state.confirmation_pending_slot = null;
          // §2.2.2 lifecycle — a 5c pending-slot write is a mid-episode
          // continuation; any retained bare value is superseded by it.
          state.confirmation_pending_value = null;
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
      // §2.2.2 consume site (feedback id 110b): when a bare "No. 0.85"
      // retained a value on the previous turn, the slot name the inspector
      // now gives is the missing half of that correction — apply the
      // retained value via the 5c write path (write + extraction frame +
      // re-confirm) instead of asking "What should R1 be?" for a number
      // already dictated. One write, one frame, retained state cleared.
      const retainedValue = state.confirmation_pending_value ?? null;
      if (retainedValue !== null) {
        state.confirmation_pending_value = null;
        const retainedSlot = schema.slots.find((s) => s.field === selected.field);
        const retainedParsed =
          retainedSlot && typeof retainedSlot.parser === 'function'
            ? retainedSlot.parser(retainedValue)
            : null;
        if (retainedParsed !== null && retainedParsed !== undefined) {
          // PLAN A2 §A2.2 — 5d fires when a confirmation_pending_value is
          // paired with a newly-selected field, commonly with NO pending slot
          // outstanding. Mark at parse.
          const op = markDictated(state, retainedSlot.field, retainedParsed, {
            schema,
            source: 'confirmation_5d_retained_value',
            circuit_ref: state.circuit_ref,
          });
          const r = applyWriteWithDerivations(
            session,
            schema,
            retainedSlot,
            state.circuit_ref,
            retainedParsed,
            now
          );
          markWritten(op, r.effectiveValue, state.circuit_ref);
          const retainedWrites = [{ field: retainedSlot.field, value: r.effectiveValue }];
          for (const mw of r.mirrorWrites) retainedWrites.push({ ...mw, auto_resolved: true });
          for (const sw of r.setWrites) retainedWrites.push({ ...sw, auto_resolved: true });
          safeSend(
            ws,
            buildExtractionPayload(state.circuit_ref, retainedWrites, schema.extractionSource)
          );
          logger?.info?.(`${schema.logEventPrefix}_confirmation_retained_value_applied`, {
            sessionId,
            circuit_ref: state.circuit_ref,
            field: retainedSlot.field,
            value: r.effectiveValue,
          });
          state.confirmation_no_progress = 0;
          state.confirmation_pending_slot = null;
          transitionToConfirmation({ ws, session, sessionId, schema, logger, now, responseEpoch });
          return { handled: true, fallthrough: false };
        }
        // Unparseable retained value (the anchor pattern is digits-only, so
        // this is defensive) — already cleared; fall to the normal ask.
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

    // ── 5e. Bare negation (reply-initial NEGATIVE_RE). Three arms (§2.2.2,
    // feedback id 110b). Arm 1 — labelled value(s) — never reaches here:
    // ladder order means 5b consumed it ("No, 0.85 on the lives" is an
    // amend, not a denial). Arm 2 — negation + ONE bare anchored value
    // ("No. 0.85") — the slot is genuinely unknown, so do NOT write: retain
    // the value and let handleNegation ask WHICH slot is wrong (the 5d
    // consume site applies it when the inspector answers "R1"). The anchor
    // is the schema's existing pendingValuePattern — negation-tolerant and
    // digits-only, so "No, infinite" stays arm 3 byte-identically. 5c
    // consumes this same shape first whenever a pending slot IS already
    // set, so this arm is reachable only with no pending slot. The ask goes
    // THROUGH handleNegation so the P1 bookkeeping (per-episode reask
    // latch, no-progress counter, cap) is shared — an immediately-following
    // bare "No." takes the CAP EXIT per the counter contract. Arm 3 — no
    // value at all — today's handleNegation byte-identically.
    if (NEGATIVE_RE.test(reply)) {
      if (!state.confirmation_pending_slot && confirmCfg.pendingValuePattern) {
        const pv = reply.match(confirmCfg.pendingValuePattern);
        if (pv) {
          state.confirmation_pending_value = pv[1];
          logger?.info?.(`${schema.logEventPrefix}_confirmation_negation_value_retained`, {
            sessionId,
            circuit_ref: state.circuit_ref,
            textPreview: reply.slice(0, 80),
          });
        }
      }
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
      // §2.2.2 lifecycle — a value-less re-entry CONTINUES the episode via
      // transitionToConfirmation, so a value retained by a prior "No. 0.85"
      // must die here: a later "Rn" must draw "What should Rn be?", never
      // apply the stale 0.85 to a slot the inspector didn't pair it with.
      state.confirmation_pending_value = null;
      // 5g latch rule (round-7): PRESERVE confirmation_negation_reask_emitted.
      // Resetting it (the pre-2026-07-29 behaviour) let "No. 0.85" →
      // value-less re-entry → "No." re-emit the byte-identical original
      // negation prompt inside the client 30 s text-keyed dedupe window —
      // the exact feedback-91 silence class the per-episode latch exists to
      // prevent. The counter still resets: re-entry is genuine engagement,
      // so the miss cap starts fresh, and a post-re-entry negation draws the
      // full-string-distinct alternate (or the cap per the counter).
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
  // Group C fix 1 (feedback id 105, 2026-07-29) — resolution METADATA: the
  // span that established the circuit this turn, consumed by the step-6
  // exclusive-voltage masking rule (a whole-reply bare numeric answer masks
  // the WHOLE reply; an explicit `circuit N` or a matched designation masks
  // only that resolution text, so a separate "tested at 500" in the same
  // reply stays parseable). Additive — the scalar resolution behaviour is
  // unchanged.
  let circuitResolutionMeta = null;
  if (state.circuit_ref === null) {
    // Resolution reads the RAW reply (round-6): production answer turns
    // prepend an `[In response to TTS question…]` annotation to `text`,
    // which defeats parseCircuitDigit's whole-reply numeric alternative
    // (an annotated "56" is no longer a bare-numeric reply) and pollutes
    // designation matching with the quoted question's words. `reply` falls
    // back to `text` for direct callers without rawReplyText, so
    // non-production paths are byte-identical.
    const digitRes = parseCircuitDigitWithSpan(reply);
    let ref = digitRes ? digitRes.ref : null;
    if (ref !== null) {
      circuitResolutionMeta = {
        kind: 'digit',
        start: digitRes.start,
        end: digitRes.end,
        wholeReply: digitRes.wholeReply,
      };
    }
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
      circuitResolutionMeta = null;
    }
    if (ref === null) {
      // Designation match. When a candidate set is offered, narrow the
      // search to those refs so a noisy designation ("kitchen" when
      // "kitchen" is also somewhere outside the candidate set) doesn't
      // pull a non-candidate ref. When no candidate set, full lookup
      // (existing behaviour).
      const lookup = findCircuitsByDesignation(
        session,
        reply,
        candidateSet ? { restrictToRefs: candidateSet } : {}
      );
      if (lookup.matched !== null) {
        ref = lookup.matched;
        circuitResolutionMeta = {
          kind: 'designation',
          matchedDesignation: lookup.matchedDesignation,
          // id 116: raw-offset span of the user text that established a
          // pass-2 (fold-table) match — null on pass-1 matches. The mask
          // branch consumes this BEFORE its literal-designation search,
          // because a morphologically-folded designation is not literally
          // findable in the reply.
          matchedUserSpan: lookup.matchedUserSpan ?? null,
        };
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
      // Combined circuit-answer + correction (Codex cycle 2): for a
      // conflict-origin episode, "Circuit 5, lives are 0.63" both resolves
      // the circuit AND restates a value. The drain below would otherwise
      // apply the OLDER queued value first and step-7 would then skip the
      // newer one (field already filled) — silently discarding the newest
      // dictation. Upsert the same-reply masked values (marked, so they
      // overwrite) before draining once.
      if (state.scope_conflict_origin === true) {
        const sameReplyValues = extractNamedFieldValues(maskCircuitSpans(reply), schema.slots);
        for (const w of sameReplyValues) {
          w[CONFLICT_OVERWRITE] = true;
          if (!Array.isArray(state.pending_writes)) state.pending_writes = [];
          const idx = state.pending_writes.findIndex((e) => e.field === w.field);
          // PLAN A2 §A2.1/A2.2 — same-reply upsert: a superseded queued
          // operation becomes abandoned; the newer dictation gets its own op.
          if (idx >= 0) {
            const superseded = state.pending_writes[idx][OPERATION_REF];
            if (superseded) markAbandoned(superseded);
            attachOperationRef(
              w,
              markDictated(state, w.field, w.value, {
                schema,
                source: 'runActivePath_same_reply_upsert',
                circuit_ref: null,
              })
            );
            state.pending_writes[idx] = w;
          } else {
            attachOperationRef(
              w,
              markDictated(state, w.field, w.value, {
                schema,
                source: 'runActivePath_same_reply_upsert',
                circuit_ref: null,
              })
            );
            state.pending_writes.push(w);
          }
        }
      }
      // Drain pending_writes onto the now-resolved circuit.
      if (Array.isArray(state.pending_writes) && state.pending_writes.length > 0) {
        // PLAN A2 §A2.2 DRAIN row — complete drain algorithm: resolve the
        // schema slot → applyWriteWithDerivations (never the plain applyWrite
        // the drain used to call — that silently dropped mirrors/pivots) →
        // preserve any pre-normalisation correction → append the direct write
        // PLUS mirror/set writes → collect pivotTo → clear the queue →
        // runPivot ONCE after the whole drain.
        let drainPivotTo = null;
        for (const w of state.pending_writes) {
          const op = w[OPERATION_REF] ?? null;
          const slot = schema.slots.find((s) => s.field === w.field);
          // P3 — normalise seeded pending_writes for the WHOLE numeric reading
          // field set (was scoped to ir_live_* only). Coerces four-form LIM →
          // "LIM", then validates range / numeric-validity / allowedValues; a
          // near-match / alternate-sentinel / out-of-range / off-ladder value is
          // REJECTED (dropped) instead of persisted verbatim. Non-numeric fields
          // (bs_en / Y-N) pass through unchanged.
          // Plan D Seam A — the normaliser also clamps impedances; pass the
          // session's board-aware earthing so it picks the right band.
          const norm = normaliseDialogueSlotWrite(
            schema,
            w.field,
            w.value,
            resolveBoardAwareEarthing(session?.stateSnapshot, null)
          );
          if (!norm.ok) {
            markRejected(op);
            logger?.info?.(`${schema.logEventPrefix}_pending_write_rejected`, {
              sessionId,
              circuit_ref: ref,
              field: w.field,
              reason: norm.reason,
            });
            continue;
          }
          // PLAN A2 §A2.3 CONFLICT_OVERWRITE composition — CONFLICT_OVERWRITE
          // never bare-skips and never writes unconditionally: BOTH the
          // conflict-origin and the ordinary queued write go through the same
          // canonicalise-and-compare gate. canonical-EQUAL → no write,
          // satisfied_existing (still read-back-eligible); canonical-DIFFERENT
          // → overwrite.
          if (
            state.values[w.field] !== undefined &&
            valuesCanonicallyEqual(slot, state.values[w.field], norm.value)
          ) {
            markSatisfiedExisting(op, state.values[w.field], ref);
            continue;
          }
          const drainValue = norm.value;
          // PROPAGATE Seam A's correction — do NOT let the write re-derive it.
          // applyWrite re-clamps by design, but by now the value is already 1.6,
          // which clamps cleanly to `{kind:'ok'}` and returns a null correction,
          // so the 16 → 1.6 provenance would be LOST and the clause could never
          // be spoken. Recording Seam A's object AFTER the write overwrites that
          // null with the real provenance.
          // `w.correction` first: a seed queued by enterScriptByName was ALREADY
          // clamped there, so this turn's re-normalise reports no correction and
          // only the queued object still knows it was 16. A raw entry queued by
          // named extraction has no `correction` and gets its provenance from
          // this turn's clamp instead.
          const drainCorrection = w.correction ?? norm.correction;
          const r = applyWriteWithDerivations(session, schema, slot, ref, drainValue, now);
          markWritten(op, r.effectiveValue, ref);
          if (drainCorrection) {
            recordValueCorrection(session.dialogueScriptState, w.field, drainCorrection);
          }
          writes.push({ field: w.field, value: r.effectiveValue });
          for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
          for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
          if (r.pivotTo) drainPivotTo = r.pivotTo;
          drainedFromPending = true;
        }
        state.pending_writes = [];
        if (drainPivotTo) {
          runPivot({
            ws,
            session,
            sessionId,
            schemas,
            fromSchema: schema,
            toSchemaName: drainPivotTo,
            logger,
            now,
            responseEpoch,
          });
          return { handled: true, fallthrough: false };
        }
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
      // later turn that DOES name the circuit. Masked (Codex diff-review
      // r1): a follow-up like "earths for circuit 99 are 1.19" with an
      // out-of-set/unmatchable ref must never capture the ref digit as the
      // conductor value.
      const followUpVolunteered = extractNamedFieldValues(maskCircuitSpans(text), schema.slots);
      if (followUpVolunteered.length > 0) {
        for (const w of followUpVolunteered) {
          if (!Array.isArray(state.pending_writes)) state.pending_writes = [];
          if (state.scope_conflict_origin === true) {
            // Conflict-origin episodes UPSERT (mini-review r1): a follow-up
            // restatement is the newest dictated value and must both replace
            // an already-queued entry for the field and carry the
            // overwrite marker for the drain.
            w[CONFLICT_OVERWRITE] = true;
            const idx = state.pending_writes.findIndex((e) => e.field === w.field);
            // PLAN A2 §A2.1/A2.2 — a superseded queued operation becomes
            // abandoned; the newer dictation gets its own op.
            if (idx >= 0) {
              const superseded = state.pending_writes[idx][OPERATION_REF];
              if (superseded) markAbandoned(superseded);
              attachOperationRef(
                w,
                markDictated(state, w.field, w.value, {
                  schema,
                  source: 'runActivePath_unresolved_follow_up_upsert',
                  circuit_ref: null,
                })
              );
              state.pending_writes[idx] = w;
            } else {
              attachOperationRef(
                w,
                markDictated(state, w.field, w.value, {
                  schema,
                  source: 'runActivePath_unresolved_follow_up_upsert',
                  circuit_ref: null,
                })
              );
              state.pending_writes.push(w);
            }
            continue;
          }
          // Codex diff-review r2 (silent-path lens, 2/3 cycle-2 lenses
          // convergent with a cycle-1 finding this session had originally
          // deferred citing the 361A638D replay fixture — re-checked: that
          // fixture dictates each field ONLY ONCE while unresolved, so it
          // pins the RE-ASK decision a few lines below, not this dedup).
          // A same-field follow-up while unresolved is a genuine
          // correction ("trip time 25" then "trip time 27" before the
          // circuit resolves), not a defensive duplicate — silently
          // dropping it is exactly id 117's class of bug. Upsert like the
          // scope-conflict branch above: the superseded queued operation
          // becomes abandoned, the newer dictation gets its own.
          const idx = state.pending_writes.findIndex((existing) => existing.field === w.field);
          if (idx >= 0) {
            const superseded = state.pending_writes[idx][OPERATION_REF];
            if (superseded) markAbandoned(superseded);
            attachOperationRef(
              w,
              markDictated(state, w.field, w.value, {
                schema,
                source: 'runActivePath_unresolved_entry_queue',
                circuit_ref: null,
              })
            );
            state.pending_writes[idx] = w;
            continue;
          }
          attachOperationRef(
            w,
            markDictated(state, w.field, w.value, {
              schema,
              source: 'runActivePath_unresolved_entry_queue',
              circuit_ref: null,
            })
          );
          state.pending_writes.push(w);
        }
        logger?.info?.(`${schema.logEventPrefix}_queued_values`, {
          sessionId,
          textPreview: text.slice(0, 80),
          queued_fields: followUpVolunteered.map((w) => w.field),
          pending_writes_total: state.pending_writes.length,
        });
        // Conflict-origin episodes RE-ASK after queueing (Codex diff-review
        // r1): the inspector answered the which_circuit ask with a value
        // instead of a circuit; staying silent strands the queue behind an
        // unanswered question they may not remember. Ordinary unresolved
        // episodes keep the pre-existing queue-silently behaviour (pinned
        // by the 361A638D replay scenario). Residual: a byte-identical
        // repeat within the client's 30 s text-keyed TTS dedupe may be
        // swallowed on some clients — accepted D-2 class.
        if (state.scope_conflict_origin === true) {
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
        }
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
      // PLAN A2 §A2.5 site table (L2982-class) — TERMINAL for applied/
      // satisfied_existing operations; the discarded queued value(s) become
      // abandoned, never read back.
      if (Array.isArray(state.pending_writes)) {
        for (const w of state.pending_writes) {
          const op = w[OPERATION_REF];
          if (op) markAbandoned(op);
        }
      }
      renderTerminalReadback({
        ws,
        session,
        sessionId,
        schema,
        logger,
        now,
        responseEpoch,
        siteLabel: 'unresolvable_circuit',
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
    // PLAN A2 §A2.5 site table (L3022-class) — TERMINAL, appended to the
    // defer ack (one combined message).
    const deferReadback = computeUncoveredReadback(state, schema, 'defer');
    const deferBaseText = schema.deferMessage ?? "Okay, I'll come back to that later.";
    safeSend(
      ws,
      buildScriptInfo({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        kind: 'defer',
        text: deferReadback ? `${deferBaseText} ${deferReadback.text}` : deferBaseText,
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
  //    the bare text.
  //
  //    Group C (feedback id 105, 2026-07-29): two defects lived here when
  //    BOTH readings were volunteered BEFORE the circuit was named. (1) The
  //    reply being processed was the CIRCUIT ANSWER, but it was fed to the
  //    voltage parser raw — "56" answering which_circuit on a 56-circuit
  //    board would have parsed as a voltage, and a genuinely voltage-less
  //    circuit answer fell into handleVoltageNoParse, whose 30 s re-ask is
  //    armed only by an ask that was never emitted, so the script FINISHED
  //    with the voltage never asked. (2) Every non-writeExclusiveAndFinish
  //    exit returned BEFORE the step-8 wire emit, so the drained LL/LE
  //    writes were spoken and stored server-side but never wire-emitted
  //    (inverse Audio-First — the client cells stayed empty).
  if (currentSlot && currentSlot.exclusiveWhenExpected) {
    // Group C fix 2 — exactly-once wire flush for the drained writes. Every
    // enumerated exit out of this branch calls this (writeExclusiveAndFinish
    // inlines it below; handleVoltageNoParse flushes at its top, BEFORE the
    // fresh-reading finish+reprocess recursion; the confirm-gate prompt, the
    // confirm-gate bare-no re-ask, and the new post-resolution voltage ask
    // flush before their sends) — so no path can emit zero times and no
    // path can emit twice. The step-8 general emit is UNREACHABLE from this
    // branch (every path returns first) and stays untouched.
    let exclusiveWritesFlushed = false;
    const flushWritesOnce = () => {
      if (exclusiveWritesFlushed) return;
      exclusiveWritesFlushed = true;
      if (writes.length > 0) {
        safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
      }
    };

    // §4.2.3 fail-audible backstop, STRUCTURAL (Codex cycle 1): the whole
    // decision tree runs inside runExclusiveBranch below, so this assertion
    // executes on EVERY return out of the branch — including any exit a
    // future edit adds — not just the paths that remember to call it.
    // Dev/test throws (NODE_ENV !== 'production'; ECS pins
    // NODE_ENV=production in ecs/task-def-backend.json); prod EMITS rather
    // than throws (a delivered frame beats a crashed turn —
    // fail-audible-and-delivered, never fail-stop).
    const assertWritesFlushed = () => {
      if (exclusiveWritesFlushed || writes.length === 0) return;
      if (process.env.NODE_ENV !== 'production') {
        throw new Error('dialogue-engine exclusive branch exited without flushing drained writes');
      }
      flushWritesOnce();
    };

    const runExclusiveBranch = () => {
      // Local: write the parsed exclusive value (+ any derivations) and finish.
      const writeExclusiveAndFinish = (v) => {
        // PLAN A2 §A2.2 — direct parse→apply (step-6 exclusive branch);
        // currentSlot is by construction not-yet-filled, so no seeded-value
        // skip applies here.
        const op = markDictated(state, currentSlot.field, v, {
          schema,
          source: 'exclusive_slot',
          circuit_ref: state.circuit_ref,
        });
        const r = applyWriteWithDerivations(
          session,
          schema,
          currentSlot,
          state.circuit_ref,
          v,
          now
        );
        markWritten(op, r.effectiveValue, state.circuit_ref);
        // Plan D — emit the EFFECTIVE (clamped) value, not the local `v`, so the
        // frame the client renders matches what the server stored.
        writes.push({ field: currentSlot.field, value: r.effectiveValue });
        // Audit-2026-06-02 Phase 2 — IR voltage / similar exclusive-slot parsers
        // don't currently have mirroring derivations, but the wire shape stays
        // consistent across paths if a future schema declares them.
        for (const mw of r.mirrorWrites) writes.push({ ...mw, auto_resolved: true });
        for (const sw of r.setWrites) writes.push({ ...sw, auto_resolved: true });
        flushWritesOnce();
        finishScript({ ws, session, sessionId, schema, logger, now, responseEpoch });
        return { handled: true, fallthrough: false };
      };

      // Group C fix 1 — the circuit answer carried NO parseable voltage: emit
      // the voltage ask through the normal ask path instead of falling into
      // handleVoltageNoParse (whose 30 s re-ask branch is gated on
      // voltage_phase_entered_at, stamped only when the exclusive ask was
      // EMITTED — never true on this path, so it silently finished). Stamping
      // here arms the existing 30 s re-ask + onExclusiveSlotAbandoned
      // machinery for free.
      const emitVoltageAskAfterResolution = () => {
        flushWritesOnce();
        if (state.voltage_phase_entered_at == null) {
          state.voltage_phase_entered_at = now;
          state.voltage_reask_done = false;
        }
        logger?.info?.(`${schema.logEventPrefix}_voltage_ask_after_circuit_resolution`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          drained_writes: writes.map((w) => w.field),
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
        // Group C fix 2 — flush the drained writes FIRST (exactly-once via the
        // latch): every one of this helper's three exits (fresh-reading
        // finish+reprocess recursion, 30 s re-ask, legacy finish) previously
        // returned without reaching the step-8 emit, stranding the writes.
        // Ordinary voltage-phase turns have an empty `writes` and this no-ops.
        flushWritesOnce();
        // RAW reply + masked (mini-review r1) — mirrors the entry loop; the
        // annotation must not defeat the leading patterns or feed extraction.
        const freshVolunteered = extractNamedFieldValues(maskCircuitSpans(reply), schema.slots);
        // id 123 companion (ep-diff-review cycle 1): a COMPOUND restatement
        // is a fresh reading too — without this the legacy finish below
        // would swallow the correction silently. Circuit-masked for the
        // same reason as the guard above: the reply's own circuit token is
        // the consumed resolution, and this predicate only routes to the
        // finish+reprocess escape (the model then owns the fresh text) —
        // it never writes directly.
        const freshCompound =
          typeof schema.compoundEntryExtractor === 'function'
            ? schema.compoundEntryExtractor(maskCircuitSpans(reply))
            : [];
        const freshEntry = detectEntry(reply, schema).matched;
        if (freshVolunteered.length > 0 || freshCompound.length > 0 || freshEntry) {
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
            rawReplyText: reply,
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

      // On the circuit-resolution turn, parse the voltage from the RAW reply
      // with the resolution text masked (whole reply for a bare numeric
      // answer; only the `circuit N` / matched-designation span otherwise, so
      // a separate "tested at 500" in the same reply stays parseable). On
      // ordinary voltage-phase turns the annotated `text` path is unchanged.
      //
      // Classify BEFORE the exclusive parse (Codex cycle 1): a NAMED IR
      // reading in the circuit answer ("circuit 4, live to earth is 500") is a
      // fresh reading/correction, not a test voltage — parseVoltage would
      // otherwise grab its in-range magnitude and write the WRONG field, then
      // finish. Route it through the M4 escape hatch, which flushes the
      // drained writes, finishes the prior episode audibly, and reprocesses
      // the fresh transcript. "tested at 500" carries no named-extractor hit,
      // so rows (e)/(g)/(h) are untouched.
      let value;
      if (circuitResolvedThisTurn) {
        const resolutionMasked = maskCircuitResolution(reply, circuitResolutionMeta);
        // id 123 companion (ep-diff-review cycle 1, Codex-sanctioned plan
        // deviation WITHIN the original Audio-First intent): a COMPOUND IR
        // restatement co-dictated with the circuit answer ("circuit 7,
        // greater than 250 L-L and L-E") is a fresh reading, exactly like a
        // NAMED one — parseVoltage would otherwise grab its magnitude and
        // certify it as the test voltage. Route it through the same M4
        // escape hatch. The masked text is deliberate on THIS path: the
        // blanked circuit span IS the consumed resolution, and firing leads
        // only to reprocessing (never a direct write), so masking cannot
        // cause a wrong write.
        if (
          extractNamedFieldValues(resolutionMasked, schema.slots).length > 0 ||
          (typeof schema.compoundEntryExtractor === 'function' &&
            schema.compoundEntryExtractor(resolutionMasked).length > 0)
        ) {
          return handleVoltageNoParse();
        }
        value = currentSlot.parser(resolutionMasked);
      } else {
        value = currentSlot.parser(text);
      }

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
            // Group C fix 2 — flush first (legitimately empty `writes` on this
            // second-turn path; the latch's conditional makes it a no-op, but
            // the exit is enumerated so no future reordering can strand a
            // drained write here).
            flushWritesOnce();
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
          // Group C fix 2 — the confirm-gate prompt return is a write-stranding
          // exit on the circuit-resolution turn: "circuit 4 at 350" drains
          // LL/LE then hits confirmWhenNotIn, and the LATER confirm turn has a
          // fresh empty `writes` local — flush the drained readings NOW, on
          // the turn they were drained (§6 row (g): exactly one extraction
          // frame here; the confirm resolution later writes only the voltage).
          flushWritesOnce();
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
        // Standard value → write + finish. Unparseable on the circuit-
        // resolution turn → the voltage ask (Group C fix 1 — the reply's job
        // was to resolve the circuit; absence of a voltage draws the ask,
        // never handleVoltageNoParse's silent finish). Unparseable on an
        // ordinary voltage-phase turn → M4 escape hatch (fresh-reading
        // reprocess / 30s re-ask / finish) instead of a silent finish that
        // would eat a fresh reading.
        if (value !== null && value !== undefined) {
          return writeExclusiveAndFinish(value);
        }
        if (circuitResolvedThisTurn) {
          return emitVoltageAskAfterResolution();
        }
        return handleVoltageNoParse();
      }

      // No confirm gate declared — write (if any) + finish; unparseable → the
      // voltage ask on the circuit-resolution turn, else the same M4 escape
      // hatch.
      if (value !== null && value !== undefined) {
        return writeExclusiveAndFinish(value);
      }
      if (circuitResolvedThisTurn) {
        return emitVoltageAskAfterResolution();
      }
      return handleVoltageNoParse();
    };

    // The ONE structural exit of the exclusive branch — the assertion runs
    // on every path out of runExclusiveBranch (§4.2.3, Codex cycle 1).
    // Exceptional exits (mini-review c1): a thrown parser/writer must not
    // strand drained writes either — prod flushes BEFORE the error
    // propagates (fail-audible-and-delivered); dev/test rethrows the
    // ORIGINAL error un-masked (the assertion must never shadow the real
    // failure).
    let exclusiveResult;
    try {
      exclusiveResult = runExclusiveBranch();
    } catch (err) {
      if (process.env.NODE_ENV === 'production') flushWritesOnce();
      throw err;
    }
    assertWritesFlushed();
    return exclusiveResult;
  }

  // 7. Named-field extraction — multiple slots can fill from one
  //    utterance. Track any pivot request from a derivation.
  let pivotTo = null;
  // Masked (Codex diff-review r1): a mid-collection reply mentioning a
  // circuit span ("earths for circuit 13 are 1.19", or a quoted TTS
  // question containing "circuit N" in the annotation) must never capture
  // the span's digit as a conductor value.
  const named = extractNamedFieldValues(maskCircuitSpans(text), schema.slots);
  for (const w of named) {
    // PLAN A2 §A2.2 — direct parse→apply (step-7 named). Mark at parse,
    // BEFORE the seeded-value skip decision.
    const op = markDictated(state, w.field, w.value, {
      schema,
      source: 'step7_named',
      circuit_ref: state.circuit_ref,
    });
    const slot = schema.slots.find((s) => s.field === w.field);
    // PLAN A2 §A2.3 — canonicalise-compare instead of a blanket skip.
    if (state.values[w.field] !== undefined) {
      if (valuesCanonicallyEqual(slot, state.values[w.field], w.value)) {
        markSatisfiedExisting(op, state.values[w.field], state.circuit_ref);
        continue;
      }
      // canonical-DIFFERENT → fall through and overwrite.
    }
    const r = applyWriteWithDerivations(session, schema, slot, state.circuit_ref, w.value, now);
    markWritten(op, r.effectiveValue, state.circuit_ref);
    // Plan D — the wire entry carries the EFFECTIVE (clamped) value; `w.value`
    // is the raw parsed magnitude and would put 16 in the cell while the
    // snapshot holds 1.6.
    writes.push({ ...w, value: r.effectiveValue });
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
    // Masked for the same reason as step 7 — a "circuit N" span's digit is
    // never a bare reading value.
    const bareValue = currentSlot.parser(maskCircuitSpans(text));
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
      // PLAN A2 §A2.1 — a genuinely dictated value that fails validation is
      // a rejected operation (never read back), not a non-event.
      markRejected(
        markDictated(state, currentSlot.field, bareValue, { source: 'step8_bare', schema })
      );
      // Fall through with bareValue cleared — engine re-asks the same
      // slot on the next turn (no write, no pivot).
    } else if (bareValue !== null && bareValue !== undefined) {
      // PLAN A2 §A2.2 — direct parse→apply (step-8 bare); currentSlot is by
      // construction not-yet-filled, so no seeded-value skip applies here.
      const op = markDictated(state, currentSlot.field, bareValue, {
        schema,
        source: 'step8_bare',
        circuit_ref: state.circuit_ref,
      });
      const r = applyWriteWithDerivations(
        session,
        schema,
        currentSlot,
        state.circuit_ref,
        bareValue,
        now
      );
      markWritten(op, r.effectiveValue, state.circuit_ref);
      // Plan D — EFFECTIVE (clamped) value on the wire, not the raw bareValue.
      writes.push({ field: currentSlot.field, value: r.effectiveValue });
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
  // PLAN A2 §A2.5 site table — runPivot is REPLACEMENT: carry the full
  // ordered operation list across (ops carry their own values — a
  // pivoted-away field's read-back renders from the op, not the new
  // schema's state.values).
  const priorOperations = Array.isArray(previous?.operations) ? previous.operations : [];
  logger?.info?.(`${fromSchema.logEventPrefix}_pivot`, {
    sessionId,
    from: fromSchema.name,
    to: toSchemaName,
    circuit_ref,
  });
  initScriptState(session, target, circuit_ref, now);
  const state = session.dialogueScriptState;
  state.operations = priorOperations;
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
    // PLAN A2 §A2.5 point 1 (feedback id 117) — the bulk-apply ceremony ask
    // must never fire on a circuit whose device slots were entirely
    // snapshot-filled (nothing dictated this run) — that is exactly the id
    // 117 ceremony bug. Fire only when at least one dictated operation
    // (applied or satisfied_existing) intersects postCompletionAsk.fields.
    // Codex diff-review r2 — circuit-scoped: a REPLACEMENT site (the ring
    // confirmation circuit-switch) carries `state.operations` across a
    // circuit change, so an unscoped check let a DIFFERENT circuit's stale
    // dictated operation wrongly fire this ask for a circuit whose own
    // device slots were never dictated this run.
    const dictatedIntersectsBulkAsk =
      Array.isArray(state.operations) &&
      Array.isArray(schema.postCompletionAsk?.fields) &&
      state.operations.some(
        (op) =>
          (op.disposition === 'applied' || op.disposition === 'satisfied_existing') &&
          op.effective_circuit_ref === state.circuit_ref &&
          schema.postCompletionAsk.fields.includes(op.field)
      );
    if (schema.postCompletionAsk && !state.bulkApplyPending && dictatedIntersectsBulkAsk) {
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
      // Plan 00B §B2 — bulk propagation is a dialogue-direct write per ref.
      const bulkObserver = session.stateSnapshot?.[MUTATION_OBSERVER] ?? null;
      if (bulkObserver) {
        bulkObserver.setOriginFrame({
          origin: 'dialogue_script_direct',
          meta: { bulk_propagation: true, field },
        });
      }
      try {
        applyReadingToSnapshot(session.stateSnapshot, { circuit: ref, field, value });
      } finally {
        if (bulkObserver) bulkObserver.clearOriginFrame();
      }
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
      // PLAN A2 §A2.5 site table (L3868-class) — TERMINAL, appended to the
      // bulk-apply confirm (one combined message). Codex diff-review r1:
      // formatBulkApplyConfirm names only the field-GROUP label and circuit
      // scope ("Applied RCD to all circuits.") — it never names the actual
      // dictated VALUES, so fieldsToPropagate must NOT be pre-marked
      // covered here (that silently suppressed the one place BS/type/mA
      // would ever be spoken on the bulk-accept path, since finishScript is
      // deliberately skipped below). Every genuinely dictated field —
      // including the propagated device fields and anything else like RCD
      // trip time — is named via the normal uncovered-operations computation.
      const bulkReadback = computeUncoveredReadback(state, schema, 'bulk_apply_done');
      const bulkDonePayload = buildScriptInfo({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        kind: 'bulk_apply_done',
        text: bulkReadback ? `${confirm} ${bulkReadback.text}` : confirm,
        now,
        responseEpoch,
      });
      // Plan 00B-2 C2.5 — ONE grouped spoken frame acknowledging every
      // bulk-applied write forms ONE multi-operation audibility unit; the
      // per-ref extraction payloads above are UI-only.
      if (ws && ws[PLAN00_DELIVERY_EMIT_OBSERVER]) {
        const bulkOps = [];
        for (const ref of targetCircuits) {
          for (const [field, value] of Object.entries(values)) {
            bulkOps.push({ field, circuit: ref, value });
          }
        }
        if (bulkReadback) {
          for (const op of bulkReadback.uncovered) {
            bulkOps.push({
              field: op.field,
              circuit: op.effective_circuit_ref,
              value: op.written_value ?? op.dictated_value,
            });
          }
        }
        attachAudibilityDescriptor(bulkDonePayload, bulkOps);
      }
      safeSend(ws, bulkDonePayload);
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
  // PLAN A2 §A2.4/A2.5 (feedback id 117) — finish rendering is OPERATION-
  // AWARE. `schema.finishCoveredFields` is the set of value-bearing fields
  // the schema's finishMessage() actually speaks (mirror coverage included —
  // e.g. RCBO's finish text speaks ocpd_bs_en's value only, so rcd_bs_en is
  // still "covered" even though it's never separately named). Schemas
  // without the declaration fall back to every filled value field
  // (byte-identical to pre-A2 behaviour).
  const finishCoveredFields = Array.isArray(schema.finishCoveredFields)
    ? schema.finishCoveredFields
    : Object.keys(values ?? {});
  const operations = Array.isArray(state.operations) ? state.operations : [];
  // Codex diff-review r1 — the LATEST matching operation, not the first: a
  // repeated same-field dictation (a correction dictated twice before
  // finish) must cover the operation whose value actually ended up in
  // `values[field]` (the one the legacy text renders), not an earlier,
  // superseded one — else the corrected value gets spoken TWICE (once via
  // the legacy summary, once via the uncovered-readback append) while the
  // stale one is silently forgotten.
  const findCoveringOp = (field) => {
    for (let i = operations.length - 1; i >= 0; i -= 1) {
      const op = operations[i];
      if (
        op.field === field &&
        (op.disposition === 'applied' || op.disposition === 'satisfied_existing') &&
        op.effective_circuit_ref === circuit_ref
      ) {
        return op;
      }
    }
    return undefined;
  };
  // Operation-aware gating is OPT-IN via `schema.finishCoveredFields` (RCD/
  // RCBO — id 117's exact class, where finishScript IS the first and only
  // device-summary readback: a field with no covering operation at all,
  // e.g. BS/type/mA snapshot-filled but never dictated this run, is neither
  // script- nor bundler-owned, and speaking it anyway is the unwanted
  // ceremony this plan exists to stop). Schemas that DON'T declare it
  // (ring, IR) keep finishScript's pre-A2 behaviour — unconditionally
  // verbatim — unchanged: ring/IR always spoke every filled value
  // regardless of dictation provenance (IR's own "we still finish" comment
  // below), and for ring/IR-with-`confirmation` specifically,
  // transitionToConfirmation's mandatory pre-finish readback already named
  // them, so finishScript's text here is a positive-finish ACKNOWLEDGMENT,
  // not a competing summary.
  const opGatingOptIn = Array.isArray(schema.finishCoveredFields);
  // Codex diff-review r1 (§A2.4/A2.5 correctness) — a field is "covered"
  // for the verbatim-summary check when EITHER it has its own script-owned
  // dictated operation, OR it is the declared mirror TARGET of another
  // field that does (mirrors are the by-design silent exception — they
  // never get their own operation). Checking only fields that HAPPEN to
  // have an operation, and treating an ABSENT one as vacuously fine, let a
  // PARTIAL dictation (e.g. only BS said this run; type/current still
  // snapshot-only) through as "all covered" — reopening id 117's exact bug
  // for every field that was never checked.
  // Codex diff-review r2 — circuit-scoped: a REPLACEMENT site carries
  // `state.operations` across a circuit change (e.g. the ring confirmation
  // circuit-switch), so an unscoped check let a stale operation from a
  // DIFFERENT circuit satisfy coverage here and speak the CURRENT circuit's
  // never-dictated, snapshot-only value as if it had been said this run.
  const scriptOwnedDictatedFields = new Set();
  for (const op of operations) {
    if (
      (op.disposition === 'applied' || op.disposition === 'satisfied_existing') &&
      op.spoken_owner !== 'bundler' &&
      op.effective_circuit_ref === circuit_ref
    ) {
      scriptOwnedDictatedFields.add(op.field);
    }
  }
  const mirrorCoveredFields = new Set();
  for (const field of scriptOwnedDictatedFields) {
    const slot = schema.slots?.find((s) => s.field === field);
    const dictatedValue = findCoveringOp(field)?.written_value;
    for (const derivation of slot?.derivations ?? []) {
      // Only credit an UNCONDITIONAL mirror, or one whose value condition
      // the dictated value actually satisfies — a value-gated mirror that
      // never fired must never be treated as covering its target.
      if (derivation.value !== undefined && derivation.value !== dictatedValue) continue;
      for (const m of derivation.mirrors ?? []) mirrorCoveredFields.add(m);
    }
  }
  const coveredOps = finishCoveredFields.map((f) => findCoveringOp(f)).filter(Boolean);
  const allCoveredScriptOwned =
    !opGatingOptIn ||
    finishCoveredFields.every(
      (f) => scriptOwnedDictatedFields.has(f) || mirrorCoveredFields.has(f)
    );
  // Mark BEFORE computing the uncovered set below, so the device-summary
  // fields (when spoken) are excluded from it — else they'd double.
  if (allCoveredScriptOwned) {
    for (const op of coveredOps) op.covered_by = 'finish';
  }
  // else: every finish-covered field is either bundler-owned or never
  // dictated this run — the legacy "Got it, …" line is suppressed entirely
  // (id 117's exact scenario). Any INDIVIDUALLY script-owned field among a
  // mixed set still surfaces below via the generic uncovered-operations text.
  const finishReadback = computeUncoveredReadback(state, schema, 'finish');
  if (allCoveredScriptOwned || finishReadback) {
    // PLAN A2 §A2.5 point 3 — ONE combined frame: the legacy verbatim text
    // (when spoken) with the uncovered read-back appended, or — when the
    // legacy text is suppressed entirely — the read-back text stands alone
    // (test (a): "exactly ONE value-scoped finish frame").
    const baseText = allCoveredScriptOwned ? schema.finishMessage({ values }) : null;
    const text = baseText
      ? finishReadback
        ? `${baseText} ${finishReadback.text}`
        : baseText
      : finishReadback.text;
    const donePayload = buildScriptInfo({
      toolCallIdPrefix: schema.toolCallIdPrefix,
      sessionId,
      kind: 'done',
      text,
      now,
      responseEpoch,
    });
    // Plan 00B-2 C2.5 — the completion read-back acknowledges every slot the
    // script wrote for this circuit: one multi-operation audibility unit.
    // PLAN A2 — re-scoped to the finish-covered set (was every filled value
    // field, including snapshot-seeded ones nobody dictated) plus whatever
    // the uncovered-readback computation named.
    if (ws && ws[PLAN00_DELIVERY_EMIT_OBSERVER]) {
      const audibilityOps = allCoveredScriptOwned
        ? finishCoveredFields
            .filter((f) => values?.[f] !== undefined)
            .map((field) => ({ field, circuit: circuit_ref, value: values[field] }))
        : [];
      if (finishReadback) {
        for (const op of finishReadback.uncovered) {
          audibilityOps.push({
            field: op.field,
            circuit: op.effective_circuit_ref,
            value: op.written_value ?? op.dictated_value,
          });
        }
      }
      attachAudibilityDescriptor(donePayload, audibilityOps);
    }
    safeSend(ws, donePayload);
  }
  logger?.info?.(`${schema.logEventPrefix}_completed`, {
    sessionId,
    circuit_ref,
    values: { ...values },
    finish_summary_spoken: allCoveredScriptOwned,
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
    // PLAN A2 §A2.2 (feedback id 117) — "finishScript's correction breadcrumb
    // derives from written operations intersected with the breadcrumb's
    // fields — never from seeded values." A field that only ever held a
    // snapshot-pre-existing value (no 'applied' operation this run) must
    // never become the crumb target — a later bare "No, 0.47" would
    // otherwise correct a reading the inspector never actually re-said this
    // episode.
    // Codex diff-review r2 — track the OPERATION, not just its field name.
    // A cross-circuit REPLACEMENT can carry an operation whose
    // effective_circuit_ref differs from this finish's (current) circuit_ref;
    // stamping the breadcrumb with the outer circuit_ref regardless would
    // point a later "No, <value>" correction at the WRONG circuit.
    let lastReadingOp = null;
    for (const op of operations) {
      if (op.disposition === 'applied' && fields.includes(op.field)) {
        lastReadingOp = op;
      }
    }
    if (lastReadingOp) {
      session.dialogueCorrectionBreadcrumb = {
        schemaName: schema.name,
        circuit_ref: lastReadingOp.effective_circuit_ref ?? circuit_ref,
        field: lastReadingOp.field,
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
  // PLAN A2 §A2.4 (feedback id 117) — dispatcher-resolved ownership verdict:
  // (field, circuit_ref, canonicalValue) => 'bundler' | null. The caller
  // (stage6-dispatchers-script.js) does the canonical comparison itself,
  // since it alone holds the prior winner's value — it returns 'bundler'
  // ONLY when a same-turn prior winner's value is canonical-EQUAL to this
  // seed (the bundler already speaks that exact value this turn, no
  // rewrite needed); a canonical-DIFFERENT prior winner is NOT authoritative
  // — the resolver returns null and the seed falls through to the normal
  // canonicalise-compare-against-snapshot rule below, overwriting it and
  // becoming the latest (bundler-backfilled) winner. Codex diff-review r1,
  // 3/3 lenses: an earlier "any prior winner wins unconditionally" draft
  // silently discarded a genuinely different same-turn correction — id
  // 117's exact bug class, just via a same-turn double-call instead of a
  // cross-turn dictation. null/undefined-returning when the caller has no
  // per-turn-writes context (test paths / legacy callers) — every seed is
  // then script-owned.
  ownershipResolver = null,
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
  // Codex diff-review r2 — §(w)'s "a validation-REJECTED operation →
  // `rejected`, no read-back" requires an actual ledger entry, not just the
  // `dropped_fields` envelope. Only a KNOWN schema field can get one (an
  // unrecognised/hallucinated field name or an empty value has no slot to
  // attach a rejection to); tracked here and marked once `initScriptState`
  // below has created `state.operations`.
  const rejectedKnownFieldWrites = [];
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
      // P3 — normalise seeded pending_writes for the WHOLE numeric reading field
      // set (was scoped to ir_live_*), which otherwise bypass the slot parsers
      // entirely. Coerces four-form LIM → "LIM" then validates range /
      // numeric-validity / allowedValues; a near-match / alternate-sentinel /
      // out-of-range / off-ladder value is REJECTED (dropped) instead of
      // persisted verbatim. Non-numeric fields (bs_en / Y-N) pass through
      // unchanged, preserving the prior seed behaviour.
      // Plan D Seam A — the normaliser also clamps impedances (band chosen from
      // the session's board-aware earthing), so a seeded `ze` of 16 on a TN-C-S
      // installation becomes 1.6 instead of being REJECTED as out-of-range.
      const norm = normaliseDialogueSlotWrite(
        schema,
        w.field,
        w.value,
        resolveBoardAwareEarthing(session?.stateSnapshot, null)
      );
      if (!norm.ok) {
        droppedFields.push(w.field);
        rejectedKnownFieldWrites.push({ field: w.field, value: w.value });
        continue;
      }
      // `correction` rides the local entry so the provenance survives to
      // whichever consumer writes it: applied immediately below (recorded into
      // the state store) or queued into pending_writes and recorded at the
      // drain. It is NEVER re-derived downstream — by then the value is 1.6,
      // which clamps cleanly and reports no correction.
      //
      // Attached CONDITIONALLY: an entry may be queued verbatim into
      // `state.pending_writes`, and the uncorrected case is ~every real write,
      // so omitting the key keeps the queued shape byte-identical to pre-Plan-D
      // (a `correction: null` would churn every pending_writes pin for nothing).
      const entry = { field: w.field, value: norm.value };
      if (norm.correction) entry.correction = norm.correction;
      validWrites.push(entry);
    }
  }

  // Initialise state. Seed values from the existing snapshot so a
  // partial fill is honoured (mirrors runEntry's skip-already-filled).
  initScriptState(session, schema, resolvedCircuitRef, now);
  const state = session.dialogueScriptState;
  // Codex diff-review r2 — record the ledger's `rejected` disposition for
  // every KNOWN-field write the normaliser refused (invalid/out-of-range/
  // off-ladder), now that `state.operations` exists to hold it.
  for (const w of rejectedKnownFieldWrites) {
    markRejected(
      markDictated(state, w.field, w.value, {
        schema,
        source: 'sonnet_start_dialogue_script',
        circuit_ref: resolvedCircuitRef,
      })
    );
  }
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
  // Codex diff-review r2 — a `pending_writes` array can (rarely) name the
  // SAME field twice in one call. The dispatcher's prior-winner projection
  // is frozen BEFORE this call runs, so it cannot see the first copy's own
  // write; without this, the second copy would fall through to the
  // canonical-EQUAL-with-no-winner branch and be marked script-owned even
  // though the resolver's guaranteed post-call backfill covers it exactly
  // like the first copy — producing a genuine double-speak (bundler AND
  // script both confirming the same value).
  const writtenThisLoopFields = new Set();
  for (const w of validWrites) {
    // PLAN A2 §A2.2 — Sonnet start_dialogue_script pending_writes: mark at
    // validation, BEFORE the seeded-value skip.
    const op = markDictated(state, w.field, w.value, {
      schema,
      source: 'sonnet_start_dialogue_script',
      circuit_ref: resolvedCircuitRef,
    });
    const slot = resolvedCircuitRef !== null ? schema.slots.find((s) => s.field === w.field) : null;
    // PLAN A2 §A2.4 — ownership triad (Codex diff-review r1, 3/3 lenses
    // convergent: reverted from an earlier "any prior winner wins
    // unconditionally" draft, which silently discarded a genuinely
    // DIFFERENT same-turn correction — exactly id 117's class of bug, just
    // manifesting via a same-turn Sonnet double-call instead of a cross-
    // turn dictation). The resolver ITSELF does the canonical comparison
    // (it has the prior winner's value in scope) and returns the VERDICT
    // 'bundler' | null — canonical-EQUAL → the bundler already speaks this
    // value this turn, no write, bundler-owned. Anything else (verdict
    // null, or no resolver at all) falls through to the normal
    // canonicalise-compare-against-snapshot rule below, and a genuinely
    // different value always overwrites — never silently discarded.
    const priorWinnerOwnsIt =
      resolvedCircuitRef !== null &&
      typeof ownershipResolver === 'function' &&
      ownershipResolver(w.field, resolvedCircuitRef, w.value) === 'bundler';
    if (priorWinnerOwnsIt) {
      const satisfiedOp = markSatisfiedExisting(op, w.value, resolvedCircuitRef);
      satisfiedOp.spoken_owner = 'bundler';
      continue;
    }
    // PLAN A2 §A2.3 — the skip at "state.values[w.field] !== undefined" is
    // rewritten to the canonical-equal/different rule: a literal
    // mark-ordering-only implementation would discard a DIFFERENT
    // Sonnet-forwarded value from the snapshot while the ledger records it
    // dictated and the finish speech claims it.
    if (resolvedCircuitRef !== null && state.values[w.field] !== undefined) {
      if (valuesCanonicallyEqual(slot, state.values[w.field], w.value)) {
        // canonical-EQUAL seed with NO winner (start_dialogue_script-only)
        // → nobody else speaks it this turn → script-owned. UNLESS an
        // earlier write in THIS SAME pending_writes array already applied
        // this exact field — that earlier write's bundler-owned guarantee
        // (a resolver being present) covers this duplicate too.
        const satisfiedOp = markSatisfiedExisting(op, state.values[w.field], resolvedCircuitRef);
        satisfiedOp.spoken_owner =
          writtenThisLoopFields.has(w.field) && typeof ownershipResolver === 'function'
            ? 'bundler'
            : 'script';
        continue;
      }
      // canonical-DIFFERENT → fall through and overwrite.
    }
    if (resolvedCircuitRef !== null) {
      const r = applyWriteWithDerivations(session, schema, slot, resolvedCircuitRef, w.value, now);
      // Plan D — PROPAGATE Seam A's provenance (applyWrite's own re-clamp of the
      // already-corrected value reports null and would retire it), and strip the
      // `correction` key from the outgoing entries so it can never appear on the
      // dispatcher's `seeded_writes` envelope or the extraction frame.
      if (w.correction) {
        recordValueCorrection(state, w.field, w.correction);
      }
      const writtenOp = markWritten(op, r.effectiveValue, resolvedCircuitRef);
      // PLAN A2 §A2.4 — APPLIED seed (guaranteed backfilled as the latest
      // winner): the guarantee only holds for a caller that actually
      // PERFORMS that backfill — signalled by a non-null ownershipResolver
      // (the dispatcher gates this to null when it has no perTurnWrites
      // context to backfill into, so a resolver's mere presence always
      // means the guarantee holds). A direct/test/legacy caller with no
      // resolver has no such guarantee, so the seed stays script-owned.
      writtenOp.spoken_owner = typeof ownershipResolver === 'function' ? 'bundler' : 'script';
      writtenThisLoopFields.add(w.field);
      appliedWrites.push({ field: w.field, value: r.effectiveValue });
      wireWrites.push({ field: w.field, value: r.effectiveValue });
      for (const mw of r.mirrorWrites) wireWrites.push({ ...mw, auto_resolved: true });
      for (const sw of r.setWrites) wireWrites.push({ ...sw, auto_resolved: true });
      if (r.pivotTo) pivotTo = r.pivotTo;
    } else {
      // Circuit unknown — queue. The active path drains pending_writes
      // once a digit or designation answer lands. The queued entry keeps its
      // `correction` so the drain can record the provenance it can no longer
      // re-derive (Plan D); pending_writes is only ever read for `.field`
      // (logging) and `.value` (the drain), so the extra key is inert.
      attachOperationRef(w, op);
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
    // PLAN A2 §A2.5 site table (L4430-class) — TERMINAL: any queued value
    // still pending (never reached a circuit) becomes abandoned; anything
    // already applied/satisfied_existing gets its read-back before the
    // discard (ws/responseEpoch are this function's own params — resume has
    // no responseEpoch arming context beyond what was threaded in).
    if (Array.isArray(state.pending_writes)) {
      for (const w of state.pending_writes) {
        const op = w[OPERATION_REF];
        if (op) markAbandoned(op);
      }
    }
    renderTerminalReadback({
      ws,
      session,
      sessionId: session.sessionId,
      schema,
      logger,
      now,
      responseEpoch,
      siteLabel: 'paused_hard_timeout_at_resume',
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
    // PLAN A2 §A2.2 DRAIN row — the SAME complete drain algorithm as the
    // position-4 circuit-resolution drain: resolve slot →
    // applyWriteWithDerivations → preserve correction → append direct +
    // mirror/set writes → collect pivotTo → clear queue → runPivot once.
    let resumeDrainPivotTo = null;
    for (const w of state.pending_writes) {
      const op = w[OPERATION_REF] ?? null;
      const slot = schema.slots.find((s) => s.field === w.field);
      // P3 — normalise seeded pending_writes for the WHOLE numeric reading field
      // set on the circuit-create resume drain (was scoped to ir_live_*).
      // Coerce four-form LIM → "LIM", validate, and REJECT a near-match /
      // alternate-sentinel / out-of-range / off-ladder value. Non-numeric fields
      // pass through unchanged.
      // Plan D Seam A — clamp band from the session's board-aware earthing.
      const norm = normaliseDialogueSlotWrite(
        schema,
        w.field,
        w.value,
        resolveBoardAwareEarthing(session?.stateSnapshot, null)
      );
      if (!norm.ok) {
        markRejected(op);
        logger?.info?.(`${schema.logEventPrefix}_pending_write_rejected`, {
          sessionId: session.sessionId,
          circuit_ref: matchedRef,
          field: w.field,
          reason: norm.reason,
        });
        continue;
      }
      // PLAN A2 §A2.3 — canonicalise-and-compare, same composition as the
      // position-4 drain (marker-aware: the resume drain is a SECOND drain
      // site and must honour CONFLICT_OVERWRITE identically).
      if (
        state.values[w.field] !== undefined &&
        valuesCanonicallyEqual(slot, state.values[w.field], norm.value)
      ) {
        markSatisfiedExisting(op, state.values[w.field], matchedRef);
        continue;
      }
      const drainValue = norm.value;
      // See the circuit-resolution drain above: a seed queued by
      // enterScriptByName was already clamped there, so only its own
      // `correction` still carries the 16 → 1.6 provenance.
      const drainCorrection = w.correction ?? norm.correction;
      const r = applyWriteWithDerivations(session, schema, slot, matchedRef, drainValue, now);
      markWritten(op, r.effectiveValue, matchedRef);
      if (drainCorrection) {
        recordValueCorrection(state, w.field, drainCorrection);
      }
      drainedWrites.push({ field: w.field, value: r.effectiveValue });
      for (const mw of r.mirrorWrites) drainedWrites.push({ ...mw, auto_resolved: true });
      for (const sw of r.setWrites) drainedWrites.push({ ...sw, auto_resolved: true });
      if (r.pivotTo) resumeDrainPivotTo = r.pivotTo;
    }
    state.pending_writes = [];
    if (resumeDrainPivotTo) {
      runPivot({
        ws,
        session,
        sessionId: session.sessionId,
        schemas,
        fromSchema: schema,
        toSchemaName: resumeDrainPivotTo,
        logger,
        now,
        responseEpoch,
      });
      return { resumed: true, circuit_ref: matchedRef };
    }
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
      // PLAN A2 §A2.2 — "buffered bare IR at queue-acceptance": resolved to a
      // known field here (the only-empty-slot auto-assign), so this is where
      // the dictation becomes trackable.
      const bareOp = markDictated(state, targetField, bare.value, {
        schema,
        source: 'ir_bare_auto_assign',
        circuit_ref: matchedRef,
      });
      // Plan D — applyWrite is authoritative: it clamps, writes the clamped
      // value into BOTH the snapshot and state.values, and records the
      // correction. The raw `state.values[targetField] = bare.value` that used
      // to follow was a split-brain generator (snapshot 1.6, local map 16) and
      // is deleted in favour of the returned effective value.
      const written = applyWrite(session, schema, matchedRef, targetField, bare.value, now);
      markWritten(bareOp, written.value, matchedRef);
      state.ambiguous_bare_value = null;
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_auto_assigned`, {
        sessionId: session.sessionId,
        circuit_ref: matchedRef,
        bare_value: written.value,
        target_field: targetField,
        reason: llFilled ? 'll_already_filled' : 'le_already_filled',
      });
      safeSend(
        ws,
        buildExtractionPayload(
          matchedRef,
          [{ field: targetField, value: written.value }],
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
      // PLAN A2 §A2.2 (feedback id 117) — Sonnet incoming readings: mark
      // ONLY the triggering field. No applyWriteWithDerivations call exists
      // here — the real write happened upstream in the dispatcher's
      // per-turn-write path (record_reading), so this is an ANCHOR: mark
      // dictated+written immediately using the already-known
      // reading/matchedField/existing values. Always bundler-owned — the
      // triggering field arrived via record_reading, which the bundler
      // already reads back this turn (per §A2.4, "never mark values merely
      // read from the snapshot" — every OTHER field seeded below from
      // `existing` is the by-design silent mirror/snapshot exception).
      const triggerOp = markDictated(state, matchedField, existing[matchedField], {
        schema,
        source: 'sonnet_record_reading_trigger',
        circuit_ref: circuitRef,
      });
      markWritten(triggerOp, existing[matchedField], circuitRef);
      triggerOp.spoken_owner = 'bundler';
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
        // PLAN A2 §A2.5 site table (L4937-class) — TERMINAL: run the shared
        // helper before the clear. It normally renders NOTHING (the only
        // operation present is the triggering field, marked bundler-owned
        // above), but runs unconditionally so a hypothetical non-bundler op
        // can never be silently discarded.
        renderTerminalReadback({
          ws,
          session,
          sessionId: session.sessionId,
          schema,
          logger,
          now,
          responseEpoch,
          siteLabel: 'sonnet_write_all_slots_filled',
        });
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
