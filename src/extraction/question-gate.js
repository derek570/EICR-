// question-gate.js
// Holds Sonnet questions for 2.5 seconds before sending to iOS,
// allowing incomplete readings to be completed without interruption.

import logger from '../logger.js';

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

  // Sonnet extracted one or more observations on this turn. Drop any queued
  // observation-related questions (observation_confirmation, observation_code,
  // observation_unclear, and generic unclear/field-null questions) — they
  // would fire AFTER the observation is already on-screen, which was the
  // kitchen-observation regression seen in session B607831E.
  //
  // resolveByFields is keyed on `field:circuit`, but observations set both
  // to null so those keys collide across unrelated defects. This method is
  // type-aware and drops any question that can only be about "this
  // observation we just captured".
  resolveObservationQuestions(observationCount = 1) {
    if (observationCount <= 0 || this.pendingQuestions.length === 0) return;
    const before = this.pendingQuestions.length;
    this.pendingQuestions = this.pendingQuestions.filter((q) => {
      const type = (q.type || '').toLowerCase();
      if (type.startsWith('observation_')) return false;
      // Also drop unclear questions with no field/circuit — they are almost
      // always "what's the observation?" from the unclear/too-short path.
      if (type === 'unclear' && !q.field && !q.circuit) return false;
      return true;
    });
    const dropped = before - this.pendingQuestions.length;
    if (dropped > 0) {
      logger.info('Observation questions resolved by extraction', {
        dropped,
        observationCount,
        remaining: this.pendingQuestions.length,
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
