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
