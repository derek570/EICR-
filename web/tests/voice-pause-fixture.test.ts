/**
 * PLAN-D — the web voice-pause constants against the shared fixture
 * `config/voice-pause-vectors.json` (Acceptance 1, unit half).
 *
 * The fixture is canonical and read from disk here; the production module
 * compiles the same values in (the Next builder never copies root
 * `config/`). Every assertion reads the fixture's keys and `status` flags —
 * never a literal string.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  VOICE_PAUSE_STRINGS,
  VOICE_PAUSE_PRODUCED_TEXTS,
  VOICE_PAUSE_PATTERN_SOURCE,
  STILL_PAUSED_CUE_THROTTLE_MS,
  VOICE_PAUSE_REMINDER_INTERVAL_MS,
  matchVoicePauseCommand,
  normaliseVoicePauseText,
  containsResumePhrase,
  isCommandWithTrailingContent,
  StillPausedCueThrottle,
} from '@/lib/recording/voice-pause';

interface FixtureString {
  text: string;
  status: 'active' | 'retired' | 'approved';
  retired_for?: string;
  decision: string;
}

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'config', 'voice-pause-vectors.json'), 'utf8')
) as {
  grammar: {
    pause_commands: string[];
    resume_commands: string[];
    pattern: string;
  };
  keyterm_brand_forms: { forms: string[] };
  vectors: {
    accept_pause: string[];
    accept_resume: string[];
    near_miss: Array<{ text: string; kind: string }>;
  };
  strings: Record<string, FixtureString | string>;
  timing: { still_paused_cue_throttle_ms: number; reminder_interval_ms: number };
};

const fixtureStrings = Object.entries(fixture.strings).filter(
  (entry): entry is [string, FixtureString] => !entry[0].startsWith('$')
);

describe('PLAN-D — voice-pause constants pinned to the fixture', () => {
  it('every spoken string byte-equals the fixture, with the same status', () => {
    expect(Object.keys(VOICE_PAUSE_STRINGS).sort()).toEqual(fixtureStrings.map(([k]) => k).sort());
    for (const [key, entry] of fixtureStrings) {
      const mine = VOICE_PAUSE_STRINGS[key as keyof typeof VOICE_PAUSE_STRINGS];
      expect(Buffer.from(mine.text, 'utf8').equals(Buffer.from(entry.text, 'utf8'))).toBe(true);
      expect(mine.status).toBe(entry.status);
    }
  });

  it('the route PRODUCES the non-retired strings, read from the status flag', () => {
    const produced = fixtureStrings
      .filter(([, e]) => e.status !== 'retired')
      .map(([, e]) => e.text);
    expect(produced).toHaveLength(4);
    expect([...VOICE_PAUSE_PRODUCED_TEXTS].sort()).toEqual([...produced].sort());
    const retired = fixtureStrings.filter(([, e]) => e.status === 'retired');
    expect(retired).toHaveLength(1);
    expect(retired[0][1].retired_for).toBe('voice_pause_resume');
    expect(VOICE_PAUSE_PRODUCED_TEXTS.has(retired[0][1].text)).toBe(false);
    const approved = fixtureStrings.filter(([, e]) => e.status === 'approved');
    expect(approved.map(([k]) => k)).toEqual(['resume_line']);
  });

  it('all five strings are byte-distinct', () => {
    const texts = fixtureStrings.map(([, e]) => e.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('pattern and timing equal the fixture', () => {
    expect(VOICE_PAUSE_PATTERN_SOURCE).toBe(fixture.grammar.pattern);
    expect(STILL_PAUSED_CUE_THROTTLE_MS).toBe(fixture.timing.still_paused_cue_throttle_ms);
    expect(VOICE_PAUSE_REMINDER_INTERVAL_MS).toBe(fixture.timing.reminder_interval_ms);
  });

  it('every grammar command word matches its own command (Decision 36: one word each)', () => {
    for (const word of fixture.grammar.pause_commands)
      expect(matchVoicePauseCommand(word)).toBe('pause');
    for (const word of fixture.grammar.resume_commands) {
      expect(matchVoicePauseCommand(word)).toBe('resume');
    }
  });

  it('the brand word is not a command, alone or with a command (Decision 36)', () => {
    for (const form of fixture.keyterm_brand_forms.forms) {
      expect(matchVoicePauseCommand(form)).toBeNull();
      for (const word of [...fixture.grammar.pause_commands, ...fixture.grammar.resume_commands]) {
        expect(matchVoicePauseCommand(`${form} ${word}`)).toBeNull();
      }
    }
  });
});

describe('PLAN-D — the command matcher against the fixture vectors', () => {
  it.each(fixture.vectors.accept_pause)('pause: %s', (text) => {
    expect(matchVoicePauseCommand(text)).toBe('pause');
  });

  it.each(fixture.vectors.accept_resume)('resume: %s', (text) => {
    expect(matchVoicePauseCommand(text)).toBe('resume');
  });

  it.each(fixture.vectors.near_miss.map((v) => [v.kind, v.text]))(
    'near miss (%s): %s',
    (_kind, text) => {
      expect(matchVoicePauseCommand(text)).toBeNull();
    }
  );

  it('no spoken string is ever admitted as a command', () => {
    for (const [, entry] of fixtureStrings) {
      expect(matchVoicePauseCommand(entry.text)).toBeNull();
    }
  });

  it('every string naming a resume command word is flagged for the self-echo disarm, and only those', () => {
    const namesResume = (t: string) =>
      normaliseVoicePauseText(t)
        .split(' ')
        .some((w) => fixture.grammar.resume_commands.includes(w));
    const texts = fixtureStrings.map(([, e]) => e.text);
    // Decision 36: every cue that tells the inspector how to resume names it.
    expect(texts.filter(namesResume).length).toBeGreaterThan(0);
    for (const text of texts) expect(containsResumePhrase(text), text).toBe(namesResume(text));
  });

  it('flags only the command-with-trailing-content near misses', () => {
    for (const v of fixture.vectors.near_miss) {
      expect(isCommandWithTrailingContent(v.text), v.text).toBe(v.kind === 'trailing');
    }
    for (const text of [...fixture.vectors.accept_pause, ...fixture.vectors.accept_resume]) {
      expect(isCommandWithTrailingContent(text)).toBe(false);
    }
  });
});

describe('PLAN-D — the still-paused cue throttle', () => {
  it('first request speaks, a repeat inside 30 s does not, a repeat after 30 s does', () => {
    const throttle = new StillPausedCueThrottle();
    expect(throttle.admit(1_000)).toBe(true);
    expect(throttle.admit(1_000 + STILL_PAUSED_CUE_THROTTLE_MS - 1)).toBe(false);
    // A suppressed request does not re-stamp.
    expect(throttle.admit(1_000 + STILL_PAUSED_CUE_THROTTLE_MS)).toBe(true);
    throttle.reset();
    expect(throttle.admit(1_000 + STILL_PAUSED_CUE_THROTTLE_MS + 1)).toBe(true);
  });
});
