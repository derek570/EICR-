// question-gate.js
// Holds Sonnet questions for 2 seconds before sending to iOS,
// allowing incomplete readings to be completed without interruption.

export class QuestionGate {
  constructor(sendCallback) {
    this.sendCallback = sendCallback; // function(questions) -- sends to iOS via WS
    this.pendingQuestions = [];
    this.gateTimer = null;
    this.GATE_DELAY_MS = 2000;
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
    this.pendingQuestions = this.pendingQuestions.filter(q => {
      const key = `${q.field || 'unknown'}:${q.circuit || 'unknown'}`;
      return !resolvedFields.has(key);
    });
    if (this.pendingQuestions.length < before) {
      console.log(`[QuestionGate] Resolved ${before - this.pendingQuestions.length} questions, ${this.pendingQuestions.length} remaining`);
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
      console.log(`[QuestionGate] Flushing ${this.pendingQuestions.length} questions to iOS`);
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
