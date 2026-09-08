import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  classifyConversationAdmission,
  type ConversationAdmissionClass,
} from '@/lib/recording/conversation-admission';
import { normalise, SPOKEN_ABBREVIATION_SOURCES } from '@/lib/recording/number-normaliser';

const require = createRequire(import.meta.url);
const fixturePath = require.resolve('../../config/conversation-admission-vectors.json');
const fixture = require(fixturePath) as {
  spoken_abbreviations: Array<{ pattern: string; replacement: string }>;
  vectors: Array<{
    id: string;
    raw: string;
    classification: ConversationAdmissionClass;
    bypass_mutation: boolean;
    admits: boolean;
    normalised: string;
    normalised_web?: string;
    protected?: string[];
  }>;
};

const PINNED_DIGEST = '4d60771946a9df048dcc1cf44809abd50454deb14f5b99ccaa71af98d6475120';

describe('ConversationAdmissionV1 cross-client vectors', () => {
  it('pins the exact shared fixture bytes and a non-trivial corpus', () => {
    expect(createHash('sha256').update(readFileSync(fixturePath)).digest('hex')).toBe(
      PINNED_DIGEST
    );
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(70);
  });

  it('pins the production spoken-abbreviation source table', () => {
    expect(
      SPOKEN_ABBREVIATION_SOURCES.map(([pattern, replacement]) => ({ pattern, replacement }))
    ).toEqual(fixture.spoken_abbreviations);
  });

  for (const vector of fixture.vectors) {
    it(vector.id, () => {
      const decision = classifyConversationAdmission(vector.raw);
      expect(decision.classification).toBe(vector.classification);
      expect(decision.bypassMutation).toBe(vector.bypass_mutation);
      expect(decision.admits).toBe(vector.admits);
      expect(
        decision.protectedOrdinalSpans.map((span) => vector.raw.slice(span.start, span.end))
      ).toEqual(vector.protected ?? []);
      expect(normalise(vector.raw, decision.protectedOrdinalSpans)).toBe(
        vector.normalised_web ?? vector.normalised
      );
    });
  }
});

describe('ordinal protection is opt-in at the raw-final boundary', () => {
  it('retains the audio-import Flux repair for callers without protected spans', () => {
    expect(normalise('Second one is a cooker')).toBe('circuit 1 is a cooker');
  });
});

// A01P (2026-09-08) — two-stage whole-Calculate carve-out. The shared vectors
// above pin the classification contract; these rows pin the MECHANISM.
describe('[invariant] A01P — whole-Calculate carve-out is a probe of the real parser, not a grammar', () => {
  it('rescues a punctuated complete Calculate to ORDINARY with bypassMutation false (both spellings, spoken numbers)', () => {
    for (const raw of [
      'Calculate Zs for circuit one?',
      'calculate Zs for circuit 1.',
      'calculate impedance for all?',
      'calculate z s for all!',
      'Calculate R1 plus R2 for circuits one to four?',
    ]) {
      const decision = classifyConversationAdmission(raw);
      expect(decision.classification, raw).toBe('ORDINARY');
      expect(decision.bypassMutation, raw).toBe(false);
      expect(decision.admits, raw).toBe(false);
    }
  });

  it('never overrides on an unconsumed remainder (board-qualified or mixed query)', () => {
    for (const raw of [
      'Calculate Zs for circuit one on the garage board?',
      'calculate Zs for circuit one, what did I say?',
    ]) {
      const decision = classifyConversationAdmission(raw);
      expect(decision.classification, raw).not.toBe('ORDINARY');
      expect(decision.bypassMutation, raw).toBe(true);
    }
  });

  it('a probe that parses only because an unprotected ordinal was rewritten never overrides', () => {
    const decision = classifyConversationAdmission('Calculate Zs for second one?');
    expect(decision.classification).toBe('QUESTION_SHAPED');
    expect(decision.bypassMutation).toBe(true);
    expect(
      decision.protectedOrdinalSpans.map((s) =>
        'Calculate Zs for second one?'.slice(s.start, s.end)
      )
    ).toEqual(['second one']);
    expect(normalise('Calculate Zs for second one?', decision.protectedOrdinalSpans)).toBe(
      'Calculate Zs for second one?'
    );
    // Without the protection the normaliser WOULD rewrite it into a circuit —
    // which is exactly the parse the carve-out must not trust.
    expect(normalise('Calculate Zs for second one?')).toBe('Calculate Zs for circuit 1?');
  });

  it('QUERY_TRIGGER, REFERENCE_TRIGGER and MIXED are never probed on web (calculate is not an auxiliary)', () => {
    expect(classifyConversationAdmission('Is Zs for circuit one?').classification).toBe(
      'QUERY_TRIGGER'
    );
    expect(classifyConversationAdmission('The second one').classification).toBe(
      'REFERENCE_TRIGGER'
    );
    expect(
      classifyConversationAdmission('calculate Zs for circuit one and what did you hear?')
        .classification
    ).not.toBe('ORDINARY');
  });
});
