/**
 * PLAN-D (feedback wave 2026-09-17) — hands-free pause and resume by voice.
 *
 * Saying "pause" (or "paws") on its own stops INPUT: the transcript final is
 * not acted on, not forwarded, not chimed. It does nothing to the spoken
 * channel — speech is never held, muted or dropped because the session is
 * paused (WAVE-CONTEXT Decision 8). Saying "resume" on its own (or tapping
 * Resume) ends the pause through ONE origin-aware exit. WAVE-CONTEXT
 * Decision 36 (2026-09-24) made each command exactly one word: Flux never
 * transcribed the old brand word "CertMate" in Derek's voice.
 *
 * This module is the pure half: the command grammar, the five spoken
 * strings and the cue throttle. The session wiring lives in
 * `recording-context.tsx`.
 *
 * CONTRACT: `config/voice-pause-vectors.json` is canonical. The production
 * web bundle cannot import root `config/` (the Next builder never copies
 * it), so the constants below are compiled in and
 * `tests/voice-pause-fixture.test.ts` pins them byte-for-byte against the
 * fixture. iOS carries the same constants, pinned the same way against its
 * byte-identical copy (`scripts/check-voice-pause-fixture-sync.sh`).
 */

export type VoicePauseStringStatus = 'active' | 'retired' | 'approved';

export interface VoicePauseString {
  readonly text: string;
  readonly status: VoicePauseStringStatus;
}

/** Decision 10's four strings plus Decision 24(c)'s approved fifth.
 *  `resume_ack` stays pinned but is RETIRED for the voice-pause route: the
 *  approved resume line opens with the acknowledgement, so the route speaks
 *  ONE line per resume. Code that enumerates what the route produces reads
 *  `status`, never a literal. */
export const VOICE_PAUSE_STRINGS = {
  pause_ack: {
    text: "Paused. Say 'resume' when you're ready.",
    status: 'active',
  },
  resume_ack: {
    text: 'Carrying on.',
    status: 'retired',
  },
  reminder: {
    text: "Still paused. Say 'resume' to carry on.",
    status: 'active',
  },
  still_paused_cue: {
    text: "Still paused — say 'resume' on its own to carry on.",
    status: 'active',
  },
  resume_line: {
    text: "Carrying on — anything said while paused wasn't recorded.",
    status: 'approved',
  },
} as const satisfies Record<string, VoicePauseString>;

export type VoicePauseStringKey = keyof typeof VOICE_PAUSE_STRINGS;

/** The texts the voice-pause route can PRODUCE (every non-retired entry). */
export const VOICE_PAUSE_PRODUCED_TEXTS: ReadonlySet<string> = new Set(
  Object.values(VOICE_PAUSE_STRINGS)
    .filter((entry: VoicePauseString) => entry.status !== 'retired')
    .map((entry) => entry.text)
);

/** Throttle on the still-paused cue: at most once per window, stamped at
 *  ADMISSION of the final that requested it. */
export const STILL_PAUSED_CUE_THROTTLE_MS = 30_000;

/** Period of the still-paused reminder while a voice pause holds. */
export const VOICE_PAUSE_REMINDER_INTERVAL_MS = 15 * 60 * 1000;

// ── Grammar ────────────────────────────────────────────────────────────
//
// Decision 36 (TAKEN 2026-09-24, with Derek's "also paws" addendum): the
// command is exactly one word said on its own. No prefix, no brand word, no
// aliases, no fuzzy matching (the 2026-06-24 hard rule).

const PAUSE_COMMANDS = ['pause', 'paws'] as const;
const RESUME_COMMANDS = ['resume'] as const;
const ALL_COMMANDS: readonly string[] = [...PAUSE_COMMANDS, ...RESUME_COMMANDS];

/** The fixture's `grammar.pattern`, compiled once. */
export const VOICE_PAUSE_PATTERN_SOURCE = '^(?<command>pause|paws|resume)$';
const PATTERN = new RegExp(VOICE_PAUSE_PATTERN_SOURCE);

/** Normalisation, in the fixture's order: lowercase; delete apostrophes
 *  (U+0027, U+2019); every character outside [a-z0-9] becomes a space;
 *  collapse whitespace and trim. */
export function normaliseVoicePauseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type VoicePauseCommand = 'pause' | 'resume';

/** Whole-utterance match: the command word and nothing else. */
export function matchVoicePauseCommand(text: string): VoicePauseCommand | null {
  const match = PATTERN.exec(normaliseVoicePauseText(text));
  const command = match?.groups?.command;
  if (!command) return null;
  return (PAUSE_COMMANDS as readonly string[]).includes(command) ? 'pause' : 'resume';
}

/** True when a spoken text contains a resume command WORD. Such a cue — and
 *  since Decision 36 every cue that names the command ("Say 'resume' …")
 *  is one — disarms the resume matcher from its playback start through the
 *  post-TTS echo window (D1 self-echo), by playback lifecycle: this only
 *  decides WHICH cues arm the disarm; the heard final is never string-
 *  matched against the cue. */
export function containsResumePhrase(text: string): boolean {
  const words = normaliseVoicePauseText(text).split(' ');
  return RESUME_COMMANDS.some((command) => words.includes(command));
}

/** A command word followed by MORE words ("pause the RCD test", "resume
 *  the ring test"). Feeds only the `voice_pause_trailing_content_cue`
 *  diagnostic — the cue itself fires on every non-command final. */
export function isCommandWithTrailingContent(text: string): boolean {
  if (matchVoicePauseCommand(text) !== null) return false;
  const words = normaliseVoicePauseText(text).split(' ');
  return words.length > 1 && ALL_COMMANDS.includes(words[0]);
}

// ── Still-paused cue throttle ──────────────────────────────────────────

/** At most one still-paused cue per `STILL_PAUSED_CUE_THROTTLE_MS`, keyed on
 *  the cue text and stamped at admission. A suppressed request does NOT
 *  re-stamp. `reset()` runs at session start and stop and at voice-pause entry. */
export class StillPausedCueThrottle {
  private lastAdmittedAtMs: number | null = null;

  constructor(private readonly windowMs: number = STILL_PAUSED_CUE_THROTTLE_MS) {}

  /** Returns true (and stamps) when the cue should be spoken now. */
  admit(nowMs: number): boolean {
    if (this.lastAdmittedAtMs !== null && nowMs - this.lastAdmittedAtMs < this.windowMs) {
      return false;
    }
    this.lastAdmittedAtMs = nowMs;
    return true;
  }

  reset(): void {
    this.lastAdmittedAtMs = null;
  }
}
