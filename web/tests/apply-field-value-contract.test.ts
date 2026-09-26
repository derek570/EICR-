/**
 * PLAN-W2 (Decision 7 wrong-value wave, audit rows I-22 / I-23 / W2-N1 /
 * W2-N2) — the apply-field VALUE contract, web side.
 *
 * `config/apply-field-value-vectors.json` is the cross-client contract that
 * decides whether a locally parsed apply-field value is ACCEPTED (and what is
 * stored and spoken) or UNRESOLVED (handed to the model, never guessed). The
 * iOS repo carries a byte-identical copy whose XCTest pins the SAME digest;
 * `scripts/check-apply-field-value-fixture-sync.sh` byte-compares the two.
 * Every vector here runs through the real web code: value vectors through
 * `resolveApplyFieldValue`, utterance vectors through `parseVoiceCommand`,
 * lag-line vectors through `buildApplyFieldLagLine`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  __applyFieldValueContractForTests as contract,
  APPLY_FIELD_VALUE_CONTRACT_FIELDS,
  buildApplyFieldLagLine,
  parseVoiceCommand,
  resolveApplyFieldValue,
  type ApplyFieldLagTail,
} from '@certmate/shared-utils';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', 'config', 'apply-field-value-vectors.json');

type Fixture = {
  leading_trim_pattern: string;
  trailing_trim_pattern: string;
  number_pattern: string;
  fields: Array<{
    kind: 'boolean' | 'numeric';
    ios_key: string;
    web_field: string;
    units: string[];
  }>;
  boolean_vocabulary: Array<{ token: string; stored: string; spoken: string }>;
  labels: Array<{ ios_key: string; web_field: string; label: string }>;
  lag_line: { template: string; tails: Record<ApplyFieldLagTail, string> };
  value_vectors: Array<{
    field: string;
    raw: string;
    outcome: 'accepted' | 'unresolved';
    stored?: string;
    spoken?: string;
  }>;
  utterance_vectors: Array<{
    utterance: string;
    field: string;
    heard: string;
    outcome: 'accepted' | 'unresolved';
    stored?: string;
    spoken?: string;
  }>;
  lag_line_vectors: Array<{ field: string; heard: string; tail: ApplyFieldLagTail; text: string }>;
};

const fixture = require('../../config/apply-field-value-vectors.json') as Fixture;
const webField = (iosKey: string): string => {
  const hit =
    fixture.fields.find((f) => f.ios_key === iosKey) ??
    fixture.labels.find((l) => l.ios_key === iosKey);
  if (!hit) throw new Error(`no web field for iOS key ${iosKey}`);
  return hit.web_field;
};

describe('apply-field value contract — cross-client pins', () => {
  /** When the vectors legitimately change: rerun
   *  scripts/generate-apply-field-value-vectors.py, copy the file to
   *  CertMateUnified's Fixtures, `shasum -a 256` it, and update BOTH this
   *  constant and the iOS `ApplyFieldValueContractTests` constant together. */
  it('fixture bytes match the pinned cross-client digest', () => {
    const digest = createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex');
    expect(digest).toBe('ecc1916ef0c27977e4a411971143398d066089df554390e43e2b46b08574a055');
  });

  it('the code constants track the fixture (fields, units, vocabulary, patterns, labels, tails)', () => {
    expect([...APPLY_FIELD_VALUE_CONTRACT_FIELDS].sort()).toEqual(
      fixture.fields.map((f) => f.web_field).sort()
    );
    for (const f of fixture.fields) {
      if (f.kind === 'numeric') {
        expect(contract.numericUnits[f.web_field], f.web_field).toEqual(f.units);
      } else {
        expect(contract.booleanFields.has(f.web_field), f.web_field).toBe(true);
      }
    }
    expect(
      [...contract.booleanVocabulary.entries()]
        .map(([token, v]) => ({ token, ...v }))
        .sort((a, b) => a.token.localeCompare(b.token))
    ).toEqual([...fixture.boolean_vocabulary].sort((a, b) => a.token.localeCompare(b.token)));
    expect(contract.leadingTrim.source).toBe(fixture.leading_trim_pattern);
    expect(contract.trailingTrim.source).toBe(fixture.trailing_trim_pattern);
    expect(contract.numberPattern.source).toBe(fixture.number_pattern);
    expect(contract.lagLabels).toEqual(
      Object.fromEntries(fixture.labels.map((l) => [l.web_field, l.label]))
    );
    expect(contract.lagTails).toEqual(fixture.lag_line.tails);
    expect(buildApplyFieldLagLine('polarity_confirmed', '{heard}', 'ask')).toBe(
      fixture.lag_line.template
        .replace('{label}', 'polarity')
        .replace('{tail}', fixture.lag_line.tails.ask)
    );
  });
});

describe('apply-field value contract — value vectors', () => {
  it.each(fixture.value_vectors.map((v) => [`${v.field} ${JSON.stringify(v.raw)}`, v] as const))(
    '%s',
    (_name, v) => {
      const out = resolveApplyFieldValue(webField(v.field), v.raw);
      if (v.outcome === 'accepted') {
        expect(out).toEqual({ stored: v.stored, spoken: v.spoken });
      } else {
        expect(out).toBeNull();
      }
    }
  );

  it('a field outside the contract is not resolved here', () => {
    expect(resolveApplyFieldValue('wiring_type', 'a')).toBeUndefined();
  });
});

describe('apply-field value contract — utterance vectors through the real parser', () => {
  it.each(fixture.utterance_vectors.map((v) => [v.utterance, v] as const))('%s', (_name, v) => {
    const cmd = parseVoiceCommand(v.utterance);
    if (v.outcome === 'accepted') {
      expect(cmd).toMatchObject({
        type: 'apply_field',
        value: v.stored,
        spokenValue: v.spoken,
        heard: v.heard,
      });
    } else {
      expect(cmd).toMatchObject({
        type: 'apply_field_unresolved',
        field: webField(v.field),
        heard: v.heard,
      });
    }
  });
});

describe('apply-field value contract — lag-line vectors', () => {
  it.each(fixture.lag_line_vectors.map((v) => [v.text, v] as const))('%s', (_name, v) => {
    expect(buildApplyFieldLagLine(webField(v.field), v.heard, v.tail)).toBe(v.text);
  });
});
