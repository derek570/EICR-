// alert-manager.ts
// Port of iOS AlertManager.swift — manages question queue, ElevenLabs TTS
// via backend proxy, and echo suppression for the web recording UI.

import type { UserQuestion } from './server-ws-service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const AUTO_DISMISS_MS = 15_000;
const INTER_ALERT_MS = 1_500;
const TTS_COOLDOWN_MS = 800;
const MAX_ASKS_PER_FIELD = 2;

// ---------------------------------------------------------------------------
// TTS Abbreviation Expansion
// ---------------------------------------------------------------------------

const TTS_EXPANSIONS: Array<[RegExp, string]> = [
  [/\bEICR\b/g, 'E I C R'],
  [/\bEIC\b/g, 'E I C'],
  [/\bBS\s*EN\b/g, 'B S E N'],
  [/\bBS\b/g, 'B S'],
  [/\bR1\+R2\b/g, 'R1 plus R2'],
  [/\bRCBO\b/g, 'R C B O'],
  [/\bRCD\b/g, 'R C D'],
  [/\bMCB\b/g, 'M C B'],
  [/\bSPD\b/g, 'S P D'],
  [/\bAFDD\b/g, 'A F D D'],
  [/\bCPC\b/g, 'C P C'],
  [/\bPFC\b/g, 'P F C'],
  [/\bPME\b/g, 'P M E'],
  [/\bTN-C-S\b/g, 'T N C S'],
  [/\bTN-S\b/g, 'T N S'],
  [/\bTT\b/g, 'T T'],
  [/\bZe\b/g, 'zed E'],
  [/\bZs\b/g, 'zed S'],
  [/mm²/g, 'millimetres squared'],
  [/MΩ/g, 'megohms'],
  [/\bkA\b/g, 'kiloamps'],
  [/\bmA\b/g, 'milliamps'],
];

function expandForTTS(text: string): string {
  let expanded = text;
  for (const [pattern, replacement] of TTS_EXPANSIONS) {
    expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface AlertManagerCallbacks {
  onQuestionDisplayed: (question: UserQuestion) => void;
  onQuestionDismissed: (question: UserQuestion) => void;
  onTTSSpeakingChange: (isSpeaking: boolean) => void;
}

// ---------------------------------------------------------------------------
// AlertManager
// ---------------------------------------------------------------------------

export class AlertManager {
  private callbacks: AlertManagerCallbacks;

  // Question queue
  private queue: UserQuestion[] = [];
  private currentQuestion: UserQuestion | null = null;
  private isProcessing = false;

  // TTS state
  private _isTTSSpeaking = false;
  private audioElement: HTMLAudioElement | null = null;
  private ttsCooldownTimerId: ReturnType<typeof setTimeout> | null = null;
  private ttsSafetyTimerId: ReturnType<typeof setTimeout> | null = null;

  // Auto-dismiss timer
  private autoDismissTimerId: ReturnType<typeof setTimeout> | null = null;

  // Dedup tracking
  private askedQuestionKeys = new Set<string>();
  private questionAskCounts = new Map<string, number>();

  constructor(callbacks: AlertManagerCallbacks) {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  get isTTSSpeaking(): boolean {
    return this._isTTSSpeaking;
  }

  // ---------------------------------------------------------------------------
  // Enqueue
  // ---------------------------------------------------------------------------

  enqueueQuestion(question: UserQuestion): void {
    const dedupKey = `${question.field}:${question.circuit ?? 'supply'}`;

    // Skip if already at max asks for this field/circuit
    const count = this.questionAskCounts.get(dedupKey) ?? 0;
    if (count >= MAX_ASKS_PER_FIELD) return;

    // Skip if already asked this exact key
    if (this.askedQuestionKeys.has(dedupKey)) return;

    this.askedQuestionKeys.add(dedupKey);
    this.questionAskCounts.set(dedupKey, count + 1);

    this.queue.push(question);
    this.processQueue();
  }

  // ---------------------------------------------------------------------------
  // Queue Processing
  // ---------------------------------------------------------------------------

  private processQueue(): void {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;

    const question = this.queue.shift()!;
    this.currentQuestion = question;
    this.callbacks.onQuestionDisplayed(question);

    // Speak the question
    this.speak(question.question);

    // Auto-dismiss after timeout
    this.autoDismissTimerId = setTimeout(() => {
      this.autoDismissTimerId = null;
      this.dismissCurrent();
    }, AUTO_DISMISS_MS);
  }

  private dismissCurrent(): void {
    if (!this.currentQuestion) return;

    const question = this.currentQuestion;
    this.currentQuestion = null;
    this.callbacks.onQuestionDismissed(question);

    // Inter-alert gap before processing next
    this.isProcessing = false;
    if (this.queue.length > 0) {
      setTimeout(() => this.processQueue(), INTER_ALERT_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // TTS
  // ---------------------------------------------------------------------------

  private async speak(text: string): Promise<void> {
    const expanded = expandForTTS(text);
    this.setTTSSpeaking(true);

    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

      const response = await fetch(`${API_BASE_URL}/api/proxy/elevenlabs-tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text: expanded }),
      });

      if (!response.ok) {
        throw new Error(`TTS proxy returned ${response.status}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      this.audioElement = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.audioElement = null;
        this.startTTSCooldown();
      };

      audio.onerror = () => {
        URL.revokeObjectURL(url);
        this.audioElement = null;
        this.setTTSSpeaking(false);
      };

      await audio.play();
    } catch {
      // Fallback: use browser speech synthesis
      this.speakFallback(expanded);
    }
  }

  private speakFallback(text: string): void {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      this.setTTSSpeaking(false);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-GB';

    utterance.onend = () => {
      this.startTTSCooldown();
    };

    utterance.onerror = () => {
      this.setTTSSpeaking(false);
    };

    window.speechSynthesis.speak(utterance);
  }

  private startTTSCooldown(): void {
    this.ttsCooldownTimerId = setTimeout(() => {
      this.ttsCooldownTimerId = null;
      this.setTTSSpeaking(false);
    }, TTS_COOLDOWN_MS);
  }

  private setTTSSpeaking(speaking: boolean): void {
    if (this._isTTSSpeaking === speaking) return;
    this._isTTSSpeaking = speaking;
    this.callbacks.onTTSSpeakingChange(speaking);

    // Safety watchdog: force-clear TTS state after 30s to prevent stuck echo suppression
    if (this.ttsSafetyTimerId !== null) {
      clearTimeout(this.ttsSafetyTimerId);
      this.ttsSafetyTimerId = null;
    }
    if (speaking) {
      this.ttsSafetyTimerId = setTimeout(() => {
        this.ttsSafetyTimerId = null;
        if (this._isTTSSpeaking) {
          console.warn('[AlertManager] TTS stuck for 30s — force-clearing isTTSSpeaking');
          this._isTTSSpeaking = false;
          this.callbacks.onTTSSpeakingChange(false);
        }
      }, 30_000);
    }
  }

  // ---------------------------------------------------------------------------
  // Stop All
  // ---------------------------------------------------------------------------

  stopAll(): void {
    // Clear queue
    this.queue = [];

    // Clear auto-dismiss timer
    if (this.autoDismissTimerId !== null) {
      clearTimeout(this.autoDismissTimerId);
      this.autoDismissTimerId = null;
    }

    // Clear TTS cooldown
    if (this.ttsCooldownTimerId !== null) {
      clearTimeout(this.ttsCooldownTimerId);
      this.ttsCooldownTimerId = null;
    }

    // Clear TTS safety watchdog
    if (this.ttsSafetyTimerId !== null) {
      clearTimeout(this.ttsSafetyTimerId);
      this.ttsSafetyTimerId = null;
    }

    // Stop audio playback
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.onended = null;
      this.audioElement.onerror = null;
      this.audioElement = null;
    }

    // Stop browser speech synthesis
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    // Dismiss current
    if (this.currentQuestion) {
      const q = this.currentQuestion;
      this.currentQuestion = null;
      this.callbacks.onQuestionDismissed(q);
    }

    this.isProcessing = false;
    this.setTTSSpeaking(false);
  }

  // ---------------------------------------------------------------------------
  // Reset Dedup
  // ---------------------------------------------------------------------------

  resetDedup(): void {
    this.askedQuestionKeys.clear();
    this.questionAskCounts.clear();
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.stopAll();
    this.resetDedup();
  }
}
