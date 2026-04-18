// question-gate.js
// Holds Sonnet questions for 2.5 seconds before sending to iOS,
// allowing incomplete readings to be completed without interruption.

import logger from '../logger.js';

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

export class QuestionGate {
  constructor(sendCallback) {
    this.sendCallback = sendCallback; // function(questions) -- sends to iOS via WS
    this.pendingQuestions = [];
    this.gateTimer = null;
    this.GATE_DELAY_MS = 2500;
  }

  // Sonnet returned questions -- enqueue and start/reset timer
  enqueue(questions) {
    if (!questions || questions.length === 0) return;
    this.pendingQuestions.push(...questions);
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
    // resolvedFields: Set of "field:circuit" strings
    const before = this.pendingQuestions.length;
    this.pendingQuestions = this.pendingQuestions.filter((q) => {
      const key = `${q.field || 'unknown'}:${q.circuit || 'unknown'}`;
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
      logger.info('Flushing questions to iOS', { count: this.pendingQuestions.length });
      this.sendCallback(this.pendingQuestions);
      this.pendingQuestions = [];
    }
  }

  // Clean up on session stop
  destroy() {
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.pendingQuestions = [];
    this.gateTimer = null;
  }
}
