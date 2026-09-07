import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  classifyConversationAdmission,
  type ConversationAdmissionClass,
} from '@/lib/recording/conversation-admission';
import {
  normalise,
  SPOKEN_ABBREVIATION_SOURCES,
} from '@/lib/recording/number-normaliser';

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

const PINNED_DIGEST = 'a1499b09511ba230d56b015169eb0052fe778a4ff018fd99668606efe98b196d';

describe('ConversationAdmissionV1 cross-client vectors', () => {
  it('pins the exact shared fixture bytes and a non-trivial corpus', () => {
    expect(createHash('sha256').update(readFileSync(fixturePath)).digest('hex')).toBe(PINNED_DIGEST);
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
