/**
 * AlertManager — ported from CertMateUnified/Sources/Whisper/AlertManager.swift
 *
 * Manages validation alerts from Claude Sonnet during recording.
 * Two delivery channels:
 *   1. Voice via ElevenLabs TTS backend proxy (falls back to Web Speech API)
 *   2. On-screen card (managed by React component via state callbacks)
 *
 * Echo suppression: isTTSSpeaking flag + 0.8s cooldown after TTS finishes.
 * Question dedup: tracks asked questions by field+circuit key, max 2 asks per key.
 */

import type { ValidationAlert, UserQuestion } from './types';
import { normalise as normaliseNumber } from './number-normaliser';

// ============= Types =============

export interface AlertManagerDelegate {
  onAlertPresented(alert: ValidationAlert): void;
  onAlertDismissed(): void;
  onAlertQueueChanged(count: number): void;
  onTTSSpeakingChanged(speaking: boolean): void;
}

export interface AlertCallbacks {
  onAlertAccepted?: (alert: ValidationAlert) => void;
  onAlertRejected?: (alert: ValidationAlert) => void;
  onCorrectionReceived?: (
    field: string | null,
    circuit: number | null,
    correctedValue: string
  ) => void;
}

// ============= Constants =============

const TTS_COOLDOWN_DELAY = 800; // ms
const AUTO_DISMISS_DELAY = 15_000; // ms
const INTER_ALERT_DELAY = 1500; // ms
const RESOLUTION_DELAY = 1200; // ms

// TTS abbreviation expansion — matches iOS AlertManager.expandForTTS()
// so ElevenLabs pronounces EICR technical terms correctly.
const TTS_EXPANSIONS: Array<[RegExp, string]> = [
  [/\bZe\/Zs\b/g, 'zed E over zed S'],
  [/\bZe\b/g, 'zed E'],
  [/\bZs\b/g, 'zed S'],
  [/mm²/g, 'millimetres squared'],
  [/mm2\b/g, 'millimetres squared'],
  [/\bMΩ\b/g, 'megohms'],
  [/\bmΩ\b/g, 'milliohms'],
  [/\bkA\b/g, 'kiloamps'],
  [/\bmA\b/g, 'milliamps'],
  [/\bΩ\b/g, 'ohms'],
  [/\bRCD\b/g, 'R C D'],
  [/\bRCBO\b/g, 'R C B O'],
  [/\bMCB\b/g, 'M C B'],
  [/\bSPD\b/g, 'S P D'],
  [/\bBSEN\b/g, 'B S E N'],
  [/\bBS\s*EN\b/g, 'B S E N'],
  [/\bBS\s*7671\b/g, 'B S 7671'],
  [/\bR1\+R2\b/g, 'R1 plus R2'],
  [/\bR2\b/g, 'R 2'],
  [/\bR1\b/g, 'R 1'],
  [/\bTN-C-S\b/g, 'T N C S'],
  [/\bTN-S\b/g, 'T N S'],
  [/\bTT\b/g, 'T T'],
  [/\bPME\b/g, 'P M E'],
  [/\bPFC\b/g, 'P F C'],
  [/\bPSCC\b/g, 'P S C C'],
  [/\bEICR\b/g, 'E I C R'],
  [/\bEIC\b/g, 'E I C'],
  [/\bCPC\b/g, 'C P C'],
  [/\bAFDD\b/g, 'A F D D'],
];

function expandForTTS(text: string): string {
  let expanded = text;
  for (const [pattern, replacement] of TTS_EXPANSIONS) {
    expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

const AFFIRMATIVE_KEYWORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'correct',
  'right',
  'move it',
  'that one',
  'do it',
  'go ahead',
  'sure',
  'okay',
  'ok',
  'absolutely',
  'affirmative',
  'confirmed',
]);

const NEGATIVE_KEYWORDS = new Set([
  'no',
  'nah',
  'nope',
  'keep it',
  'leave it',
  "it's right",
  'its right',
  'ignore',
  'skip',
  'cancel',
  "don't",
  'dont',
  'negative',
  'wrong',
  'not that',
]);

const CORRECTION_PREFIXES = [
  "no it's ",
  'no its ',
  "it's actually ",
  'its actually ',
  'should be ',
  "actually it's ",
  'actually its ',
  'actually ',
  "it's ",
  'its ',
];

const NUMBER_WORDS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
  14: 'fourteen',
  15: 'fifteen',
  16: 'sixteen',
  17: 'seventeen',
  18: 'eighteen',
  19: 'nineteen',
  20: 'twenty',
};

// ============= Service =============

export class AlertManager {
  private delegate: AlertManagerDelegate;
  private callbacks: AlertCallbacks = {};

  // Public state
  private _currentAlert: ValidationAlert | null = null;
  private _isAwaitingResponse = false;
  private _isTTSSpeaking = false;

  // Private state
  private alertQueue: ValidationAlert[] = [];
  private isResolving = false;
  private autoDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private ttsCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;

  // Question dedup
  private askedQuestionKeys = new Set<string>();
  private questionAskCounts = new Map<string, number>();
  private static readonly MAX_ASKS_PER_KEY = 2;

  constructor(delegate: AlertManagerDelegate) {
    this.delegate = delegate;
  }

  // ---- Getters ----

  get currentAlert(): ValidationAlert | null {
    return this._currentAlert;
  }

  get isAwaitingResponse(): boolean {
    return this._isAwaitingResponse;
  }

  get isTTSSpeaking(): boolean {
    return this._isTTSSpeaking;
  }

  get queuedCount(): number {
    return this.alertQueue.length;
  }

  // ---- Configuration ----

  setCallbacks(callbacks: AlertCallbacks): void {
    this.callbacks = callbacks;
  }

  // ---- Question Dedup ----

  /**
   * Check if a question should be asked (respects dedup limits).
   * Returns true if the question should be asked.
   */
  shouldAskQuestion(question: UserQuestion): boolean {
    const key = `${question.fieldKey ?? ''}:${question.circuitRef ?? ''}`;
    const count = this.questionAskCounts.get(key) ?? 0;
    return count < AlertManager.MAX_ASKS_PER_KEY;
  }

  /**
   * Record that a question was asked for dedup tracking.
   */
  recordQuestionAsked(question: UserQuestion): void {
    const key = `${question.fieldKey ?? ''}:${question.circuitRef ?? ''}`;
    this.askedQuestionKeys.add(key);
    this.questionAskCounts.set(key, (this.questionAskCounts.get(key) ?? 0) + 1);
  }

  /**
   * Get descriptions of already-asked questions (passed to Sonnet).
   */
  getAskedQuestionDescriptions(): string[] {
    return Array.from(this.askedQuestionKeys);
  }

  /**
   * Reset dedup tracking (call on recording start/stop).
   */
  resetQuestionTracking(): void {
    this.askedQuestionKeys.clear();
    this.questionAskCounts.clear();
  }

  // ---- Public API ----

  /**
   * Queue a validation alert. If no alert is showing, presents immediately.
   */
  queueAlert(alert: ValidationAlert): void {
    if (!this._currentAlert) {
      this.presentAlert(alert);
    } else {
      this.alertQueue.push(alert);
      this.delegate.onAlertQueueChanged(this.alertQueue.length);
    }
  }

  /**
   * Queue a user question as an alert.
   */
  queueQuestion(question: UserQuestion): void {
    if (!this.shouldAskQuestion(question)) return;
    this.recordQuestionAsked(question);

    const alert: ValidationAlert = {
      type: question.type,
      severity: 'info',
      message: question.question,
      suggestedAction: undefined,
    };
    this.queueAlert(alert);
  }

  /**
   * Process transcript text for voice responses to a pending alert.
   */
  processTranscriptForResponse(text: string): void {
    if (!this._currentAlert || !this._isAwaitingResponse || this.isResolving) {
      return;
    }

    const lowered = text.toLowerCase();

    // Check for correction value
    const correction = this.extractCorrectionValue(lowered);
    if (correction) {
      this.resolveWithCorrection(correction);
      return;
    }

    // Check for circuit redirect
    const circuit = this.extractCircuitRedirect(lowered);
    if (circuit !== null) {
      this.resolveWithCircuitMove(circuit);
      return;
    }

    // Check for affirmative keywords
    for (const keyword of AFFIRMATIVE_KEYWORDS) {
      if (lowered.includes(keyword)) {
        this.resolveCurrentAlert(true);
        return;
      }
    }

    // Check for negative keywords
    for (const keyword of NEGATIVE_KEYWORDS) {
      if (lowered.includes(keyword)) {
        this.resolveCurrentAlert(false);
        return;
      }
    }
  }

  /**
   * Handle a tap response from the UI card.
   */
  handleTapResponse(accepted: boolean): void {
    if (!this._currentAlert || this.isResolving) return;
    this.resolveCurrentAlert(accepted);
  }

  /**
   * Dismiss the current alert without accept/reject.
   */
  dismissCurrentAlert(): void {
    if (!this._currentAlert) return;
    this.cancelAutoDismiss();
    this.stopAllSpeech();
    this._currentAlert = null;
    this._isAwaitingResponse = false;
    this.isResolving = false;
    this.delegate.onAlertDismissed();
    this.scheduleNextAlert();
  }

  /**
   * Clear all queued alerts and dismiss current.
   */
  clearAll(): void {
    this.alertQueue = [];
    this.delegate.onAlertQueueChanged(0);
    if (this._currentAlert) {
      this.dismissCurrentAlert();
    }
  }

  /**
   * Stop all speech and clean up timers.
   */
  destroy(): void {
    this.clearAll();
    this.stopAllSpeech();
    this.cancelAutoDismiss();
    if (this.ttsCooldownTimer) {
      clearTimeout(this.ttsCooldownTimer);
      this.ttsCooldownTimer = null;
    }
  }

  // ---- Correction Extraction ----

  private extractCorrectionValue(text: string): string | null {
    const lowered = text.toLowerCase().trim();

    // Check for correction prefix patterns
    for (const prefix of CORRECTION_PREFIXES) {
      if (lowered.startsWith(prefix)) {
        const remainder = lowered.slice(prefix.length).trim();
        if (/\d/.test(remainder)) {
          const normalised = normaliseNumber(remainder);
          const match = normalised.match(/[\d]+\.?[\d]*/);
          if (match) return match[0];
        }
      }
    }

    // Bare number during active alert (short utterance only)
    if (this._currentAlert && this._isAwaitingResponse) {
      const wordCount = lowered.split(/\s+/).length;
      if (wordCount < 5) {
        const normalised = normaliseNumber(lowered);
        const trimmed = normalised.trim().replace(/[.?!]+$/, '');
        if (/^[\d]+\.?[\d]*$/.test(trimmed)) {
          return trimmed;
        }
      }
    }

    return null;
  }

  private extractCircuitRedirect(text: string): number | null {
    const lowered = text.toLowerCase();
    if (!lowered.includes('circuit')) return null;

    // Match "circuit N" with digits
    const digitMatch = lowered.match(/circuit\s*(\d+)/);
    if (digitMatch) {
      return parseInt(digitMatch[1], 10);
    }

    // Match "circuit five" — iterate longest words first
    for (let num = 20; num >= 1; num--) {
      const word = NUMBER_WORDS[num] ?? String(num);
      if (lowered.includes(`circuit ${word}`) || lowered.includes(`circuit${word}`)) {
        return num;
      }
    }

    return null;
  }

  // ---- Presentation ----

  private presentAlert(alert: ValidationAlert): void {
    this.cancelAutoDismiss();
    this.stopAllSpeech();
    this.isResolving = false;

    this._currentAlert = alert;
    this._isAwaitingResponse = true;
    this.delegate.onAlertPresented(alert);

    // Speak the alert message
    this.speakAlertMessage(alert.message);
  }

  // ---- Resolution ----

  private resolveCurrentAlert(accepted: boolean): void {
    const alert = this._currentAlert;
    if (!alert || this.isResolving) return;
    this.isResolving = true;
    this.cancelAutoDismiss();
    this.stopAllSpeech();
    this._isAwaitingResponse = false;

    if (accepted) {
      this.callbacks.onAlertAccepted?.(alert);
      this.speakResponse('Updated');
    } else {
      this.callbacks.onAlertRejected?.(alert);
      this.speakResponse('Okay, keeping it');
    }

    setTimeout(() => {
      this._currentAlert = null;
      this.isResolving = false;
      this.delegate.onAlertDismissed();
      this.scheduleNextAlert();
    }, RESOLUTION_DELAY);
  }

  private resolveWithCorrection(value: string): void {
    const alert = this._currentAlert;
    if (!alert || this.isResolving) return;
    this.isResolving = true;
    this.cancelAutoDismiss();
    this.stopAllSpeech();
    this._isAwaitingResponse = false;

    this.callbacks.onCorrectionReceived?.(
      alert.type === 'orphaned' || alert.type === 'out_of_range' ? alert.type : null,
      null,
      value
    );
    this.speakResponse(`Got it, ${value}`);

    setTimeout(() => {
      this._currentAlert = null;
      this.isResolving = false;
      this.delegate.onAlertDismissed();
      this.scheduleNextAlert();
    }, RESOLUTION_DELAY);
  }

  private resolveWithCircuitMove(toCircuit: number): void {
    const alert = this._currentAlert;
    if (!alert || this.isResolving) return;
    this.isResolving = true;
    this.cancelAutoDismiss();
    this.stopAllSpeech();
    this._isAwaitingResponse = false;

    if (alert.suggestedAction) {
      this.callbacks.onCorrectionReceived?.(alert.type, toCircuit, alert.suggestedAction);
      this.speakResponse(`Moved to circuit ${toCircuit}`);
    } else {
      this.speakResponse('Okay, noted');
    }

    setTimeout(() => {
      this._currentAlert = null;
      this.isResolving = false;
      this.delegate.onAlertDismissed();
      this.scheduleNextAlert();
    }, RESOLUTION_DELAY);
  }

  private scheduleNextAlert(): void {
    if (this.alertQueue.length === 0) return;

    setTimeout(() => {
      if (this._currentAlert || this.alertQueue.length === 0) return;
      const next = this.alertQueue.shift()!;
      this.delegate.onAlertQueueChanged(this.alertQueue.length);
      this.presentAlert(next);
    }, INTER_ALERT_DELAY);
  }

  private cancelAutoDismiss(): void {
    if (this.autoDismissTimer) {
      clearTimeout(this.autoDismissTimer);
      this.autoDismissTimer = null;
    }
  }

  // ---- Voice Playback ----

  private speakAlertMessage(message: string): void {
    this.speakWithElevenLabs(message, 1.1, 0.9);
  }

  private speakResponse(text: string): void {
    this.speakWithElevenLabs(text, 1.0, 0.8);
  }

  /**
   * Speak text via ElevenLabs TTS backend proxy. Falls back to Web Speech API.
   */
  private speakWithElevenLabs(text: string, fallbackRate: number, volume: number): void {
    const expanded = expandForTTS(text);
    this.markTTSStarted();

    this.fetchElevenLabsTTS(expanded)
      .then((audioBlob) => {
        const url = URL.createObjectURL(audioBlob);
        const audio = new Audio(url);
        audio.volume = volume;
        this.currentAudio = audio;

        audio.onended = () => {
          URL.revokeObjectURL(url);
          this.currentAudio = null;
          this.markTTSFinished();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          this.currentAudio = null;
          // Fall back to Web Speech
          this.speakWithWebSpeech(expanded, fallbackRate, volume);
        };

        audio.play().catch(() => {
          URL.revokeObjectURL(url);
          this.currentAudio = null;
          this.speakWithWebSpeech(expanded, fallbackRate, volume);
        });
      })
      .catch(() => {
        this.speakWithWebSpeech(expanded, fallbackRate, volume);
      });
  }

  private speakWithWebSpeech(text: string, rate: number, volume: number): void {
    if (!('speechSynthesis' in window)) {
      this.markTTSFinished();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-GB';
    utterance.rate = rate;
    utterance.volume = volume;
    this.currentUtterance = utterance;

    utterance.onend = () => {
      this.currentUtterance = null;
      this.markTTSFinished();
    };
    utterance.onerror = () => {
      this.currentUtterance = null;
      this.markTTSFinished();
    };

    window.speechSynthesis.speak(utterance);
  }

  private async fetchElevenLabsTTS(text: string): Promise<Blob> {
    // Route through backend proxy — the backend injects the ElevenLabs API key,
    // voice ID, and voice settings server-side.
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const res = await fetch(`${apiBaseUrl}/api/proxy/elevenlabs-tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs TTS proxy returned status ${res.status}`);
    }

    return res.blob();
  }

  // ---- TTS State Tracking ----

  private markTTSStarted(): void {
    if (this.ttsCooldownTimer) {
      clearTimeout(this.ttsCooldownTimer);
      this.ttsCooldownTimer = null;
    }
    this._isTTSSpeaking = true;
    this.delegate.onTTSSpeakingChanged(true);
  }

  private markTTSFinished(): void {
    if (this.ttsCooldownTimer) {
      clearTimeout(this.ttsCooldownTimer);
    }
    this.ttsCooldownTimer = setTimeout(() => {
      this._isTTSSpeaking = false;
      this.delegate.onTTSSpeakingChanged(false);
      this.ttsCooldownTimer = null;
    }, TTS_COOLDOWN_DELAY);

    // Start auto-dismiss timer after TTS finishes
    if (this._currentAlert && this._isAwaitingResponse && !this.isResolving) {
      this.cancelAutoDismiss();
      this.autoDismissTimer = setTimeout(() => {
        if (this._currentAlert && this._isAwaitingResponse) {
          this.dismissCurrentAlert();
        }
      }, AUTO_DISMISS_DELAY);
    }
  }

  private stopAllSpeech(): void {
    // Stop ElevenLabs audio
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }

    // Stop Web Speech
    if (this.currentUtterance) {
      window.speechSynthesis?.cancel();
      this.currentUtterance = null;
    }

    this.markTTSFinished();
  }
}
