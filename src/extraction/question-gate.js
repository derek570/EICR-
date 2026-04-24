// question-gate.js
// Holds Sonnet questions for 1.5 seconds before sending to iOS,
// allowing incomplete readings to be completed without interruption.
// Shortened 2500 -> 1500 (2026-04-20, TTS-timing fix): this delay is on the
// critical path for every question, stacking on top of Deepgram
// utterance_end_ms (1200ms) + Sonnet turn (~3-5s) + ElevenLabs proxy
// round-trip (~1-2s). At 2500ms the end-to-end user-stops -> TTS-plays
// gap hit 8-12s, long enough that inspectors resumed dictating before
// the question arrived and the `in_response_to` anchor mis-attributed
// replies. 1500ms still covers the common "...pause... 4XW" continuation
// pattern but cuts a full second off every turn.

import logger from '../logger.js';

// Stage 6 Phase 5 Plan 05-01 — single-source-of-truth for the question debounce.
// Used both by QuestionGate.GATE_DELAY_MS (instance property below, line ~92)
// and by stage6-ask-gate-wrapper.js's createAskGateWrapper default delay so
// the new tool-call gate inherits the production tuning automatically. If
// the TTS-timing trade-off ever moves again (history: 2500ms → 1500ms in
// commit b606e21, 2026-04-20 — see ROADMAP §Phase 5 SC #1 for the stale
// 2500 reference) both surfaces follow in lockstep.
//
// Why exported as a module-level constant rather than a class static: the
// wrapper imports this BEFORE constructing any QuestionGate instance, and
// keeping the value at module scope avoids a circular dependency on the
// class shape during Jest module init (the wrapper is purely
// composition-over-the-class — never instantiates QuestionGate).
export const QUESTION_GATE_DELAY_MS = 1500;

// Phase D: stop-word list used when comparing a question's `heard_value`
// against newly-extracted observation text. These tokens would otherwise
// false-match almost anything (e.g. "the kitchen" and "the bathroom" share
// "the") and falsely conclude a question has been resolved.
const COMMON_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'in',
  'on',
  'at',
  'to',
  'of',
  'for',
  'with',
  'and',
  'or',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'has',
  'have',
  'that',
  'this',
  'it',
  'its',
  'by',
  'from',
  'as',
  'near',
  'into',
]);

// Installation-field whitelist for null-circuit wildcard resolution.
//
// The postcode double-ask fix (14 Chichester Rd, session EE0A697A, 2026-04-20)
// rewrote `resolveByFields` so a question with `circuit: null` resolves against
// ANY circuit reading for the same field name. That fix is correct ONLY for
// install-level fields, whose readings land at circuit 0 per the Sonnet prompt
// rule — so `{ field: postcode, circuit: null }` is semantically the same as
// `{ field: postcode, circuit: 0 }`.
//
// For circuit-specific fields (e.g. `zs`, `r1_plus_r2`, `insulation_resistance`,
// `rcd_trip_time`) a null circuit means "I heard this reading but don't know
// which circuit it belongs to" — an orphan. If the wildcard applied to those,
// a later unrelated `zs:4` reading would silently drop the orphan question
// and the inspector would never be asked to assign the first reading.
//
// Fields NOT in this set fall through to the pre-fix strict-match behaviour
// (which may duplicate the TTS ask for that field — the acceptable failure
// mode). Membership is the safer side to err on.
//
// Scope: address/postcode/town/county (+ client_* variants) from the original
// regression, and `ze` / `pfc` which eicr-extraction-session.js:263-275
// confirms are supply-level fields seeded at circuit 0.
const INSTALLATION_FIELDS = new Set([
  'address',
  'postcode',
  'town',
  'county',
  'client_address',
  'client_postcode',
  'client_town',
  'client_county',
  'client_name',
  'ze',
  'pfc',
]);

export class QuestionGate {
  constructor(sendCallback, sessionId = null) {
    this.sendCallback = sendCallback; // function(questions) -- sends to iOS via WS
    this.pendingQuestions = [];
    this.gateTimer = null;
    this.GATE_DELAY_MS = QUESTION_GATE_DELAY_MS;
    this.sessionId = sessionId; // for log correlation
    // De-dupe: signatures of questions flushed within the last DEDUPE_TTL_MS
    // window. Prevents Sonnet re-asking the same question in quick succession
    // when a multi-turn re-extraction lands after the first flush but before
    // the user has finished replying.
    this.recentlyFlushedSigs = new Map(); // sig -> expiryMs
    this.DEDUPE_TTL_MS = 15000;
  }

  // Stable signature for "same question": type+field+circuit+heard_value.
  // Used for intra-session de-dupe so a re-emitted identical question does
  // not produce a second TTS ask within DEDUPE_TTL_MS.
  _questionSig(q) {
    const type = (q.type || '').toLowerCase();
    const field = q.field || '';
    const circuit = q.circuit === null || q.circuit === undefined ? '' : String(q.circuit);
    const heard = (q.heard_value || '').toLowerCase().trim();
    return `${type}|${field}|${circuit}|${heard}`;
  }

  _pruneRecentSigs() {
    const now = Date.now();
    for (const [sig, expiry] of this.recentlyFlushedSigs) {
      if (expiry <= now) this.recentlyFlushedSigs.delete(sig);
    }
  }

  // Sonnet returned questions -- enqueue and start/reset timer
  enqueue(questions) {
    if (!questions || questions.length === 0) return;
    this._pruneRecentSigs();
    const existingSigs = new Set(this.pendingQuestions.map((q) => this._questionSig(q)));
    const fresh = [];
    let droppedAsDupes = 0;
    for (const q of questions) {
      const sig = this._questionSig(q);
      if (existingSigs.has(sig) || this.recentlyFlushedSigs.has(sig)) {
        droppedAsDupes += 1;
        continue;
      }
      existingSigs.add(sig);
      fresh.push(q);
    }
    if (droppedAsDupes > 0) {
      logger.info('Questions de-duped', {
        sessionId: this.sessionId,
        dropped: droppedAsDupes,
        pendingBefore: this.pendingQuestions.length,
      });
    }
    if (fresh.length === 0) return;
    this.pendingQuestions.push(...fresh);
    this.resetTimer();
  }

  // New utterance arrived -- reset the timer (user might be completing a reading)
  onNewUtterance() {
    if (this.pendingQuestions.length > 0) {
      this.resetTimer();
    }
  }

  // Sonnet resolved some pending questions in its latest response
  resolveByFields(resolvedFields) {
    // resolvedFields: Set of "field:circuit" strings (readings always carry a
    // specific numeric circuit — installation fields use circuit 0, physical
    // circuits use 1..N).
    //
    // A pending question with circuit === null/undefined is an install-field
    // question (Sonnet's question schema permits null circuit and it often
    // emits that for address/postcode/town/county). Under the old strict key
    // match `postcode:unknown` never hit `postcode:0`, so the partial reading
    // from turn N+1 failed to clear the pending question and the 2.5s gate
    // fired a duplicate TTS ask. Fix: null-circuit questions resolve when ANY
    // reading for the same field name lands — safe because install fields
    // live at circuit 0 and circuit-specific questions always carry a numeric
    // circuit on their emission path (validated in tests).
    //
    // A question with q.circuit === 0 is ALSO a real installation question;
    // the old code used `q.circuit || 'unknown'` which coerced 0 → 'unknown'
    // because 0 is falsy in JS. The explicit null/undefined check below
    // resolves that latent bug too: circuit 0 now builds key `field:0`.
    //
    // Wildcard is GATED by INSTALLATION_FIELDS. The first cut of this fix
    // wildcard-resolved every null-circuit question; codex review flagged
    // (correctly) that orphan questions like `{ field: 'zs', circuit: null }`
    // — "I heard a Zs reading but don't know which circuit" — would be
    // silently dropped the moment any `zs:<N>` reading arrived for a
    // DIFFERENT circuit. Restricting the wildcard to fields whose readings
    // genuinely land at a fixed circuit (installation fields → circuit 0)
    // keeps the postcode fix intact without suppressing legitimate
    // circuit-disambiguation prompts.
    const resolvedFieldNames = new Set();
    for (const key of resolvedFields) {
      const idx = key.indexOf(':');
      if (idx > 0) resolvedFieldNames.add(key.slice(0, idx));
    }
    const before = this.pendingQuestions.length;
    this.pendingQuestions = this.pendingQuestions.filter((q) => {
      const field = q.field || 'unknown';
      if (q.circuit === null || q.circuit === undefined) {
        // Null-circuit question on a known install field → wildcard resolve.
        // Non-install fields fall through to strict match (will miss because
        // readings always carry a numeric circuit), preserving orphan-question
        // survival for circuit-disambiguation prompts.
        if (INSTALLATION_FIELDS.has(field)) {
          return !resolvedFieldNames.has(field);
        }
        return true; // keep: strict key would be `field:` which never matches
      }
      const key = `${field}:${q.circuit}`;
      return !resolvedFields.has(key);
    });
    if (this.pendingQuestions.length < before) {
      logger.info('Questions resolved', {
        resolved: before - this.pendingQuestions.length,
        remaining: this.pendingQuestions.length,
      });
    }
    // If all resolved, cancel timer
    if (this.pendingQuestions.length === 0 && this.gateTimer) {
      clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
  }

  // Phase D #6 — Narrow gate resolution to observations the new extraction actually
  // refers to, instead of a blanket drop of every queued observation-style question.
  //
  // Original bug (B607831E): `resolveByFields` is keyed on `field:circuit`, but
  // observations set both to null, so unrelated obs-style questions collided and
  // fired AFTER the observation landed. Blanket drop was the quick fix.
  //
  // Regression (#6 from 2026-04-18 review): blanket drop also nukes UNRELATED
  // turn-N obs_confirmation questions the moment turn-N+1 extracts a different
  // explicit observation. The inspector never hears the turn-N question.
  //
  // This version takes the actual `newObservations` array and keeps any queued
  // obs-style question whose `heard_value` (the 4-10 word defect summary Sonnet
  // emits for observation_confirmation / observation_code) does NOT overlap
  // meaningfully with any of the new observations' `observation_text`.
  //
  // Fallback for D3: a queued obs-style question with no usable `heard_value`
  // falls through to the old blanket drop so non-tagged clients / older prompt
  // versions don't start leaking phantom questions.
  resolveObservationQuestions(newObservations = []) {
    // Backward-compat: callers still passing a number drop straight to legacy
    // blanket behaviour — preserves the old call-site semantics (observationCount).
    if (typeof newObservations === 'number') {
      return this._legacyBlanketDrop(newObservations);
    }
    const count = Array.isArray(newObservations) ? newObservations.length : 0;
    if (count <= 0 || this.pendingQuestions.length === 0) return;

    const obsTexts = newObservations
      .map((o) => (o && typeof o.observation_text === 'string' ? o.observation_text : ''))
      .filter((t) => t.length > 0)
      .map((t) => t.toLowerCase().trim());

    const before = this.pendingQuestions.length;
    this.pendingQuestions = this.pendingQuestions.filter((q) => {
      const type = (q.type || '').toLowerCase();
      const isObsLike =
        type.startsWith('observation_') || (type === 'unclear' && !q.field && !q.circuit);
      if (!isObsLike) return true;

      // D3 fallback: question has no heard_value → blanket drop (old behaviour).
      // `heard_value` is the Sonnet-emitted defect summary; without it we have
      // no way to tell whether the question is about the just-extracted
      // observation or an unrelated earlier one.
      const heard = (q.heard_value || '').toLowerCase().trim();
      if (!heard || obsTexts.length === 0) return false;

      // Drop iff any new observation meaningfully overlaps with heard_value.
      // Threshold chosen low (≥30% of heard_value tokens present in the obs text)
      // because `heard_value` is already a short summary and Sonnet's final
      // `observation_text` is usually a reworded superset of the same keywords.
      const heardTokens = new Set(
        heard.split(/\s+/).filter((w) => w.length >= 3 && !COMMON_STOP_WORDS.has(w))
      );
      if (heardTokens.size === 0) return false; // all stopwords → fallback drop
      const heardTokensArr = Array.from(heardTokens);
      const overlapsSomeNew = obsTexts.some((obsText) => {
        const obsTokens = new Set(obsText.split(/\s+/));
        const hits = heardTokensArr.filter((w) => obsTokens.has(w)).length;
        return hits / heardTokensArr.length >= 0.3;
      });
      return !overlapsSomeNew;
    });

    const dropped = before - this.pendingQuestions.length;
    if (dropped > 0) {
      logger.info('Observation questions resolved by extraction', {
        dropped,
        newObservationCount: count,
        remaining: this.pendingQuestions.length,
        mode: 'narrowed',
      });
    }
    if (this.pendingQuestions.length === 0 && this.gateTimer) {
      clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
  }

  // Legacy blanket-drop path — kept internal so callers passing a number
  // (old signature) keep the pre-Phase-D behaviour.
  _legacyBlanketDrop(observationCount) {
    if (observationCount <= 0 || this.pendingQuestions.length === 0) return;
    const before = this.pendingQuestions.length;
    this.pendingQuestions = this.pendingQuestions.filter((q) => {
      const type = (q.type || '').toLowerCase();
      if (type.startsWith('observation_')) return false;
      if (type === 'unclear' && !q.field && !q.circuit) return false;
      return true;
    });
    const dropped = before - this.pendingQuestions.length;
    if (dropped > 0) {
      logger.info('Observation questions resolved by extraction', {
        dropped,
        observationCount,
        remaining: this.pendingQuestions.length,
        mode: 'legacy_blanket',
      });
    }
    if (this.pendingQuestions.length === 0 && this.gateTimer) {
      clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
  }

  resetTimer() {
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.gateTimer = setTimeout(() => this.flush(), this.GATE_DELAY_MS);
  }

  flush() {
    this.gateTimer = null;
    if (this.pendingQuestions.length > 0) {
      // Record signatures in the recent-flush map so an identical question
      // re-emitted within DEDUPE_TTL_MS is suppressed in enqueue(). TTL is
      // short enough that a legitimately-repeated ask later in the session
      // still fires.
      const expiry = Date.now() + this.DEDUPE_TTL_MS;
      for (const q of this.pendingQuestions) {
        this.recentlyFlushedSigs.set(this._questionSig(q), expiry);
      }
      // Log full question payload (type/field/circuit/question-text/heard_value)
      // so CloudWatch can reconstruct *exactly* what Sonnet asked per session,
      // pairing with the ElevenLabs TTS success log (keys.js) to see the full
      // Sonnet-question -> TTS-text chain. Previously this log only carried
      // `count`, so when the inspector reported "it asked something weird" we
      // had no record of the question wording on the server side (iOS
      // debug-log upload is still broken — see MEMORY.md).
      logger.info('Flushing questions to iOS', {
        sessionId: this.sessionId,
        count: this.pendingQuestions.length,
        questions: this.pendingQuestions.map((q) => ({
          type: q.type || null,
          field: q.field || null,
          circuit: q.circuit === null || q.circuit === undefined ? null : q.circuit,
          question: typeof q.question === 'string' ? q.question.slice(0, 200) : null,
          heard_value: q.heard_value || null,
        })),
      });
      this.sendCallback(this.pendingQuestions);
      this.pendingQuestions = [];
    }
  }

  // Clean up on session stop
  destroy() {
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.pendingQuestions = [];
    this.gateTimer = null;
    this.recentlyFlushedSigs.clear();
  }
}
