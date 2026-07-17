/**
 * canonical-crypto.test.js — pinned literal vectors for the field-replay
 * identity spec (plan: replay-corpus-gate-2026-07 Item 1).
 *
 * The plan requires literal input-byte, full-digest, and final-ID test
 * vectors for EVERY identity class, plus JCS conformance vectors (Unicode
 * escaping, negative zero, exponent formatting, numeric boundaries) and
 * golden vectors proving YAML formatting/key order never changes a hash
 * while any immutable value does.
 */

import {
  canonicalBytes,
  domainHash,
  keyedCommitment,
  mintSessionId,
  mintGenerationId,
  mintUtteranceId,
  mintTurnAlias,
  attestationPayloadHash,
  evidenceEventHash,
  sourceCommitment,
  generateCommitmentKey,
  mintOpaqueRef,
  rawSha256,
} from '../../../scripts/field-replay/lib/canonical-crypto.mjs';
import {
  DOMAINS,
  OPAQUE_REF_CLASSES,
  SOURCE_COMMITMENT_KEY_BYTES,
} from '../../../scripts/field-replay/lib/identity-constants.mjs';
import {
  validateOpaqueRef,
  validateFixReference,
  hasPlausibleEntropy,
  ID_REJECT_REASONS,
} from '../../../scripts/field-replay/lib/id-validation.mjs';

const CID = 'frc_0123456789abcdef0123456789abcdef';

describe('RFC 8785 (JCS) conformance vectors', () => {
  test('key sorting', () => {
    expect(canonicalBytes({ b: 2, a: 1 }).toString('utf8')).toBe('{"a":1,"b":2}');
  });
  test('negative zero serializes as 0', () => {
    expect(canonicalBytes({ x: -0 }).toString('utf8')).toBe('{"x":0}');
  });
  test('exponent boundary: 1e21 uses exponent form', () => {
    expect(canonicalBytes({ n: 1e21 }).toString('utf8')).toBe('{"n":1e+21}');
  });
  test('exponent boundary: 1e20 stays positional', () => {
    expect(canonicalBytes({ n: 100000000000000000000 }).toString('utf8')).toBe(
      '{"n":100000000000000000000}',
    );
  });
  test('array order PRESERVED, null literal', () => {
    expect(canonicalBytes({ arr: [3, 1, 2], z: null }).toString('utf8')).toBe(
      '{"arr":[3,1,2],"z":null}',
    );
  });
  test('non-ASCII keys sort by UTF-16 code units, no Unicode normalization', () => {
    expect(canonicalBytes({ '€': 'e', a: 'x' }).toString('utf8')).toBe(
      '{"a":"x","€":"e"}',
    );
  });
  test('control-character escaping (backspace)', () => {
    expect(canonicalBytes({ c: '\u0008' }).toString('utf8')).toBe('{"c":"\\b"}');
  });
  test('undefined input throws instead of hashing an empty message', () => {
    expect(() => canonicalBytes(undefined)).toThrow(/JCS-serializable/);
  });
});

describe('deterministic identity classes — pinned literal vectors', () => {
  test('sessionId (domain field-replay/session, tuple [corpusId])', () => {
    expect(mintSessionId(CID)).toBe('frsess_72512f3509e2532968cfe4752c342893');
  });
  test('sessionId equals prefixed truncation of the raw domain hash', () => {
    const full = domainHash(DOMAINS.SESSION, [CID]);
    expect(full).toBe('72512f3509e2532968cfe4752c3428939f33a5efc372783cfd85aca47723114a');
    expect(mintSessionId(CID)).toBe(`frsess_${full.slice(0, 32)}`);
  });
  test('generationId per turn — distinct across turnIndex', () => {
    expect(mintGenerationId(CID, 1)).toBe('frgen_2904f1778da5f8c020c06f247a2d68bd');
    expect(mintGenerationId(CID, 2)).toBe('frgen_4698e3e4cde05bc27c9f1c869900ec32');
  });
  test('utteranceId has its own domain (differs from generation over same tuple)', () => {
    expect(mintUtteranceId(CID, 1)).toBe('frutt_3d865d49ee0c011275a0382d5b838966');
    expect(mintUtteranceId(CID, 1).slice('frutt_'.length)).not.toBe(
      mintGenerationId(CID, 1).slice('frgen_'.length),
    );
  });
  test('turn alias vector', () => {
    expect(mintTurnAlias(CID, 1)).toBe('frturn_7be4b62a0195fd1891bf986dfb85b083');
  });
  test('attestation payload hash — full 64-hex, no prefix', () => {
    expect(attestationPayloadHash({ corpus_id: CID, purpose: 'regression' })).toBe(
      'c1d7283d832fd8d9b612b74fcdf7e08e20039875d7ca9190c87cb7c5294ba1ef',
    );
  });
  test('evidence event hash vector', () => {
    expect(evidenceEventHash({ run_id: 12345, outcome: 'red' })).toBe(
      'a426f62c6eaceff927a4c291113a835e00f48f6703c90e8e8d397961eeca57ca',
    );
  });
  test('sessionId is constant across turns (ONE identity per fixture)', () => {
    expect(mintSessionId(CID)).toBe(mintSessionId(CID));
  });
  test('domain separation: same tuple, different domain, different digest', () => {
    expect(domainHash(DOMAINS.SESSION, [CID])).not.toBe(domainHash(DOMAINS.GENERATION, [CID]));
  });
});

describe('keyed source commitments (class 3)', () => {
  const key = Buffer.alloc(SOURCE_COMMITMENT_KEY_BYTES);
  for (let i = 0; i < SOURCE_COMMITMENT_KEY_BYTES; i++) key[i] = i + 1;

  test('pinned literal vector', () => {
    expect(
      sourceCommitment(key, { content_sha256: 'a'.repeat(64), role: 'primary', type: 'cloudwatch' }),
    ).toBe('da9c424c0deb8018d37bbb1fb564f3c2f4f43d9c737faa3bf182a83897e59bbc');
  });
  test('commitment differs from the unkeyed domain hash (a bare hash is a correlator)', () => {
    const tuple = { content_sha256: 'a'.repeat(64), role: 'primary', type: 'cloudwatch' };
    expect(sourceCommitment(key, tuple)).not.toBe(
      domainHash(DOMAINS.SOURCE_COMMITMENT, {
        content_sha256: tuple.content_sha256,
        role: tuple.role,
        type: tuple.type,
      }),
    );
  });
  test('different keys produce different commitments over the same tuple', () => {
    const k2 = generateCommitmentKey();
    const tuple = { content_sha256: 'a'.repeat(64), role: 'primary', type: 'cloudwatch' };
    expect(sourceCommitment(key, tuple)).not.toBe(sourceCommitment(k2, tuple));
  });
  test('wrong key size rejected', () => {
    expect(() => keyedCommitment(Buffer.alloc(16), DOMAINS.SOURCE_COMMITMENT, {})).toThrow(/32-byte/);
  });
  test('malformed content fingerprint rejected', () => {
    expect(() => sourceCommitment(key, { content_sha256: 'zz', role: 'primary', type: 'x' })).toThrow(
      /64 lowercase hex/,
    );
  });
});

describe('golden hash-stability vectors (formatting never changes a hash; values do)', () => {
  test('key order / object identity does not change the hash', () => {
    const a = { corpus_id: CID, purpose: 'regression', turns: [{ at_ms: 0, transcript: 'x' }] };
    const b = { turns: [{ transcript: 'x', at_ms: 0 }], purpose: 'regression', corpus_id: CID };
    expect(attestationPayloadHash(a)).toBe(attestationPayloadHash(b));
  });
  test('any immutable value change changes the hash', () => {
    const a = { corpus_id: CID, purpose: 'regression' };
    expect(attestationPayloadHash(a)).not.toBe(
      attestationPayloadHash({ ...a, purpose: 'triage' }),
    );
    expect(attestationPayloadHash(a)).not.toBe(
      attestationPayloadHash({ ...a, red_proof_failure_id: 'audibility.output.out_1' }),
    );
  });
});

describe('opaque public references (class 1 — RANDOM ONLY)', () => {
  test('format: prefix + 32 lowercase hex', () => {
    const id = mintOpaqueRef('corpus');
    expect(id).toMatch(OPAQUE_REF_CLASSES.corpus.pattern);
    expect(mintOpaqueRef('fix')).toMatch(OPAQUE_REF_CLASSES.fix.pattern);
  });
  test('two mints differ (never derived)', () => {
    expect(mintOpaqueRef('corpus')).not.toBe(mintOpaqueRef('corpus'));
  });
  test('entropy sanity', () => {
    expect(hasPlausibleEntropy(mintOpaqueRef('corpus'))).toBe(true);
    expect(hasPlausibleEntropy('frc_00000000000000000000000000000000')).toBe(false);
  });
  test('unknown class throws', () => {
    expect(() => mintOpaqueRef('nope')).toThrow(/unknown class/);
  });
});

describe('id validation — positive/negative vectors', () => {
  test('canonical corpus id accepted', () => {
    expect(validateOpaqueRef('corpus', CID).ok).toBe(true);
  });
  test('UUID-shaped rejected', () => {
    const r = validateOpaqueRef('corpus', 'frc_550e8400-e29b-41d4-a716-446655440000');
    expect(r).toEqual({ ok: false, reason: ID_REJECT_REASONS.UUID_SHAPED });
  });
  test('date-bearing rejected', () => {
    expect(validateOpaqueRef('corpus', 'field-2026-07-16-f1').reason).toBe(
      ID_REJECT_REASONS.CONTAINS_DATE,
    );
  });
  test('F-number marker rejected', () => {
    expect(validateOpaqueRef('corpus', 'frc-marker-f7-case').reason).toBe(
      ID_REJECT_REASONS.CONTAINS_MARKER,
    );
  });
  test('session/job prefixes rejected', () => {
    expect(validateOpaqueRef('corpus', 'frc_sess_abcd1234').reason).toBe(
      ID_REJECT_REASONS.RAW_PREFIX,
    );
  });
  test('manifest-listed fragment rejected (acceptance-time)', () => {
    expect(validateOpaqueRef('corpus', CID, ['0123456789abcdef']).reason).toBe(
      ID_REJECT_REASONS.MANIFEST_FRAGMENT,
    );
  });
  test('uppercase hex / base64 rejected as bad format', () => {
    expect(validateOpaqueRef('corpus', 'frc_ABCDEF0123456789ABCDEF0123456789').reason).toBe(
      ID_REJECT_REASONS.BAD_FORMAT,
    );
  });
  test('fix_reference: opaque + github forms admissible, private paths not', () => {
    expect(validateFixReference('fix_0123456789abcdef0123456789abcdef').ok).toBe(true);
    expect(validateFixReference('https://github.com/derek570/EICR-/pull/91').ok).toBe(true);
    expect(validateFixReference('#91').ok).toBe(true);
    expect(validateFixReference('~/.claude/handoffs/some-plan/PLAN.md').ok).toBe(false);
    expect(validateFixReference('fix_2026-07-16-plan').ok).toBe(false);
  });
});

describe('rawSha256 (private-manifest fingerprints only)', () => {
  test('matches known SHA-256 of empty buffer', () => {
    expect(rawSha256(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
