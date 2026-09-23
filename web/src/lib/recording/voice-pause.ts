/**
 * PLAN-D (feedback wave 2026-09-17) — hands-free pause and resume by voice.
 *
 * "CertMate pause" stops INPUT: the transcript final is not acted on, not
 * forwarded, not chimed. It does nothing to the spoken channel — speech is
 * never held, muted or dropped because the session is paused
 * (WAVE-CONTEXT Decision 8). "CertMate carry on" (or the Resume button)
 * ends the pause through ONE origin-aware exit.
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
    text: "Paused. Say 'CertMate, carry on' when you're ready.",
    status: 'active',
  },
  resume_ack: {
    text: 'Carrying on.',
    status: 'retired',
  },
  reminder: {
    text: "Still paused. Say 'CertMate, carry on' to resume.",
    status: 'active',
  },
  still_paused_cue: {
    text: "Still paused — say 'CertMate, carry on' on its own to resume.",
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

const OPTIONAL_PREFIXES = ['hey', 'okay', 'ok'] as const;
const BRAND_FORMS_NORMALISED = ['certmate', 'cert mate', 'sert mate'] as const;
const PAUSE_COMMANDS = ['pause', 'pause listening', 'hold on'] as const;
const RESUME_COMMANDS = ['carry on', 'resume', 'im back', 'listen'] as const;

/** The fixture's `grammar.pattern`, compiled once. */
export const VOICE_PAUSE_PATTERN_SOURCE =
  '^(?:(?:hey|okay|ok) )?(?:certmate|cert mate|sert mate) (?<command>pause|pause listening|hold on|carry on|resume|im back|listen)$';
const PATTERN = new RegExp(VOICE_PAUSE_PATTERN_SOURCE);

/** Normalisation, in the fixture's order: lowercase; delete apostrophes
 *  (U+0027, U+2019); every character outside [a-z0-9] becomes a space;
 *  collapse whitespace and trim. */
export function normaliseVoicePauseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type VoicePauseCommand = 'pause' | 'resume';

/** Whole-utterance match. The brand word is required and nothing else may
 *  be in the utterance. No fuzzy matching (the 2026-06-24 hard rule). */
export function matchVoicePauseCommand(text: string): VoicePauseCommand | null {
  const match = PATTERN.exec(normaliseVoicePauseText(text));
  const command = match?.groups?.command;
  if (!command) return null;
  return (PAUSE_COMMANDS as readonly string[]).includes(command) ? 'pause' : 'resume';
}

function brandCommandPhrases(commands: readonly string[]): string[] {
  const out: string[] = [];
  for (const brand of BRAND_FORMS_NORMALISED) {
    for (const command of commands) out.push(`${brand} ${command}`);
  }
  return out;
}

const RESUME_PHRASES = brandCommandPhrases(RESUME_COMMANDS);
const ALL_COMMAND_PHRASES = brandCommandPhrases([...PAUSE_COMMANDS, ...RESUME_COMMANDS]);

function containsPhrase(normalised: string, phrase: string): boolean {
  return ` ${normalised} `.includes(` ${phrase} `);
}

/** True when a spoken text CONTAINS an accepted resume phrase. Such a cue
 *  disarms the resume matcher from its playback start through the post-TTS
 *  echo window (D1 self-echo), by playback lifecycle, not by string. */
export function containsResumePhrase(text: string): boolean {
  const normalised = normaliseVoicePauseText(text);
  return RESUME_PHRASES.some((phrase) => containsPhrase(normalised, phrase));
}

/** The branded-with-trailing-content near-miss ("certmate carry on, circuit
 *  two now"): an optional prefix, the brand, a command, then MORE words.
 *  Feeds only the `voice_pause_trailing_content_cue` diagnostic — the cue
 *  itself fires on every non-command final. */
export function isBrandedCommandWithTrailingContent(text: string): boolean {
  // An accepted command is never "trailing content" ("certmate pause
  // listening" is the command, not "pause" plus a trailing word).
  if (matchVoicePauseCommand(text) !== null) return false;
  let normalised = normaliseVoicePauseText(text);
  for (const prefix of OPTIONAL_PREFIXES) {
    if (normalised.startsWith(`${prefix} `)) {
      normalised = normalised.slice(prefix.length + 1);
      break;
    }
  }
  return ALL_COMMAND_PHRASES.some(
    (phrase) => normalised.startsWith(`${phrase} `) && normalised.length > phrase.length + 1
  );
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
