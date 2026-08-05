/**
 * Plan 00C §C3 — session-manifest builder/publisher suite.
 *
 * Covers: the C0 contract-artifact ACCEPTANCE test (the builder consuming
 * ONLY the five-key snapshot reproduces the committed expected projections
 * for the eligible, ineligible and lifecycle-contradiction pairs, and the
 * ACK-sequence action fixture driven through the REAL evaluation context),
 * canonical-serialization drift vs the field-replay implementation, the
 * start/completion envelope split, the publisher's 200/412/409/failure
 * receipt matrix (task-role-safe calls only), ECS deployment identity
 * (incl. the non-ECS/local INVALID case), hook integration through the
 * REAL freeze latches, and the PII exclusion rule.
 */

import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  CONFIG_FINGERPRINT_ENV_ALLOWLIST,
  MANIFEST_KEY_PREFIX,
  UNKNOWN_DEPLOYMENT_FINGERPRINT,
  buildCompletionManifest,
  buildManifestCandidate,
  buildStartManifest,
  canonicalManifestBytes,
  computeConfigFingerprint,
  createManifestObserver,
  createManifestPublisher,
  createProductionEvidenceContextFactory,
  deploymentFingerprintOf,
  fetchEcsDeploymentIdentity,
  manifestChecksumBase64,
  manifestContentHash,
} from '../extraction/plan00-session-manifest.js';
import {
  attachEvaluationContext,
  freezeEvidenceCompletion,
  freezeEvidenceStart,
  getCompletionFreeze,
  getStartFreeze,
  normaliseEvaluationContext,
} from '../extraction/plan00-lifecycle-hooks.js';
import { createAskLedger, createDeliveryLedger } from '../extraction/plan00-audibility-ledgers.js';
import { createMutationObserver } from '../extraction/plan00-semantic-capture.js';
import { canonicalBytes } from '../../scripts/field-replay/lib/canonical-crypto.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const contractDir = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'test-contracts',
  'plan00-evidence-contract'
);
const loadJson = (name) => JSON.parse(fs.readFileSync(path.join(contractDir, name), 'utf8'));
const stripComment = ({ _comment, ...rest }) => rest;

const snapshotA = stripComment(loadJson('snapshot-v1.json'));
const projectionA = stripComment(loadJson('projection-v1.json'));
const snapshotB = stripComment(loadJson('snapshot-ineligible-v1.json'));
const projectionB = stripComment(loadJson('projection-ineligible-v1.json'));
const snapshotC = stripComment(loadJson('snapshot-lifecycle-contradiction-v1.json'));
const projectionC = stripComment(loadJson('projection-lifecycle-contradiction-v1.json'));
const ackSequences = loadJson('ack-sequences-v1.json');

const READY_REF = Object.freeze({
  state: 'ready',
  identity: {
    task_arn: 'arn:aws:ecs:eu-west-2:1:task/eicr-cluster-production/abc',
    task_family: 'eicr-backend',
    task_revision: '377',
    image_id: 'sha256:feedface',
  },
  reason: null,
  fingerprint: 'a'.repeat(64),
  prompt_fingerprint: 'p'.repeat(64),
  tool_fingerprint: 't'.repeat(64),
  config_fingerprint: 'c'.repeat(64),
});

const UNAVAILABLE_REF = Object.freeze({
  state: 'unavailable',
  identity: null,
  reason: 'no_ecs_metadata_uri',
  fingerprint: UNKNOWN_DEPLOYMENT_FINGERPRINT,
  prompt_fingerprint: null,
  tool_fingerprint: null,
  config_fingerprint: null,
});

// ── C0 contract-artifact acceptance ────────────────────────────────────────

describe('C0 — builder acceptance against the committed contract artifacts', () => {
  test.each([
    ['eligible fixture A', snapshotA, projectionA],
    ['ineligible fixture B', snapshotB, projectionB],
    ['lifecycle-contradiction fixture C', snapshotC, projectionC],
  ])('completion manifest evidence deep-equals the committed projection (%s)', (_n, snap, proj) => {
    const manifest = buildCompletionManifest({
      snapshot: snap,
      completedAtIso: '2026-08-05T09:00:00.000Z',
      deploymentRef: READY_REF,
    });
    expect(manifest.evidence).toEqual(proj);
  });

  test('the builder consumes ONLY the five-key snapshot (extra keys ignored, missing evidence throws)', () => {
    const withExtra = { ...snapshotA, rogue_extra_key: { secret: true } };
    const manifest = buildCompletionManifest({
      snapshot: withExtra,
      completedAtIso: '2026-08-05T09:00:00.000Z',
      deploymentRef: READY_REF,
    });
    expect(JSON.stringify(manifest)).not.toContain('rogue_extra_key');
    expect(() =>
      buildCompletionManifest({ snapshot: null, completedAtIso: 'x', deploymentRef: READY_REF })
    ).toThrow();
  });

  test('ACK-sequence action fixture drives the REAL context and the built manifest carries the pinned row census', () => {
    const OP = (o) => ({
      extractionTurnId: o.turn,
      field: o.field,
      circuit: o.circuit ?? null,
      boardId: null,
      ordinal: 0,
    });
    for (const kase of ackSequences.cases) {
      const entry = {
        session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
      };
      const ctx = normaliseEvaluationContext(
        {
          observer: createManifestObserver({
            deploymentRef: READY_REF,
            publisher: { publish: async () => ({ ok: true }) },
            nowFn: () => new Date('2026-08-05T09:00:00.000Z'),
          }),
          mutationObserver: createMutationObserver({ sessionId: `sess_${kase.name}` }),
          askLedger: createAskLedger(),
          deliveryLedger: createDeliveryLedger(),
        },
        { sessionId: `sess_${kase.name}` }
      );
      attachEvaluationContext(entry, ctx);
      for (const act of kase.actions) {
        if (act.action === 'delivery') {
          ctx.recordDelivery([OP(act.op)], { producerId: act.producer_id, kind: act.kind });
        } else if (act.action === 'playback') {
          ctx.recordPlayback(act.ack_body, [OP(act.op)], {
            producerId: act.producer_id,
            source: act.source,
          });
        } else if (act.action === 'playback_slot' || act.action === 'playback_slot_miss') {
          ctx.resolvePlaybackFromSlot({
            slot: act.slot,
            ackBody: act.ack_body,
            source: 'ordinary',
          });
        } else if (act.action === 'fast_ack') {
          ctx.stageFastPlaybackAck({ correlationId: act.correlation_id, ackBody: act.ack_body });
        } else {
          throw new Error(`unknown fixture action: ${act.action}`);
        }
      }
      const latch = freezeEvidenceCompletion(entry, {
        sessionId: `sess_${kase.name}`,
        boundary: 'session_stopped',
      });
      const ev = latch.candidate.manifest.evidence;
      const flatPlaybacks = Object.values(ev.playbacks).flat();
      expect(flatPlaybacks).toHaveLength(kase.expected.playback_evidence);
      expect(ev.idempotent_playbacks).toHaveLength(kase.expected.playback_idempotent);
      expect(ev.rejected_playbacks).toHaveLength(kase.expected.playback_rejected);
    }
  });
});

// ── canonical serialization drift ──────────────────────────────────────────

describe('canonical serialization mirrors the field-replay implementation', () => {
  const corpus = [
    { b: 2, a: 1, nested: { z: [3, 1, 2], y: null } },
    { unicode: 'café ☕ é́', empty: {}, arr: [] },
    { num: 1e21, small: 1e-7, zero: -0, big: 9007199254740991 },
    { s: 'line\nbreak\t"quote"\\slash', n: null },
    [],
    ['a', { k: 'v' }, 42],
    'bare string',
    3.14159,
    null,
    true,
  ];
  test.each(corpus.map((v, i) => [i, v]))('corpus value %s byte-identical', (_i, value) => {
    expect(Buffer.compare(canonicalManifestBytes(value), canonicalBytes(value))).toBe(0);
  });
  test('both reject undefined identically', () => {
    expect(() => canonicalManifestBytes(undefined)).toThrow();
    expect(() => canonicalBytes(undefined)).toThrow();
  });
});

// ── envelope split ─────────────────────────────────────────────────────────

describe('start/completion manifest envelopes', () => {
  const startSnap = {
    sessionId: 'sess_env',
    boundary: 'session_started',
    counts: { open_asks_dispatcher: 0 },
    revisions: {},
    sub_records: [],
  };

  test('start manifest: completion/actual-execution fields ABSENT (never null placeholders)', () => {
    const start = buildStartManifest({
      snapshot: startSnap,
      startedAtIso: '2026-08-05T08:00:00.000Z',
      deploymentRef: READY_REF,
    });
    expect(start.manifest_kind).toBe('start');
    expect(start.started_at).toBe('2026-08-05T08:00:00.000Z');
    expect('completed_at' in start).toBe(false);
    expect('evidence' in start).toBe(false);
    expect('status' in start).toBe(false);
    expect(start.deployment.identity.image_id).toBe('sha256:feedface');
  });

  test('configured start values can never satisfy an executed-route requirement (no route keys exist)', () => {
    const start = buildStartManifest({
      snapshot: startSnap,
      startedAtIso: '2026-08-05T08:00:00.000Z',
      deploymentRef: READY_REF,
    });
    const text = JSON.stringify(start);
    expect(text).not.toContain('round_usage');
    expect(text).not.toContain('billing_model');
    expect(text).not.toContain('api_transport');
  });

  test('completion manifest carries trusted status + the projection-derived evidence', () => {
    const completion = buildCompletionManifest({
      snapshot: snapshotA,
      completedAtIso: '2026-08-05T09:00:00.000Z',
      deploymentRef: READY_REF,
    });
    expect(completion.manifest_kind).toBe('completion');
    expect(completion.status).toEqual({
      non_quiescent_at_stop: 0,
      revision_instability: 0,
      eligible_for_family_credit: true,
    });
    expect(completion.evidence.round_usage.rounds).toHaveLength(2);
  });

  test('candidate: content-addressed key + deterministic bytes/hash/checksum', () => {
    const manifest = buildCompletionManifest({
      snapshot: snapshotA,
      completedAtIso: '2026-08-05T09:00:00.000Z',
      deploymentRef: READY_REF,
    });
    const c1 = buildManifestCandidate(manifest, { deploymentFingerprint: READY_REF.fingerprint });
    const c2 = buildManifestCandidate(manifest, { deploymentFingerprint: READY_REF.fingerprint });
    expect(c1.content_hash).toBe(c2.content_hash);
    expect(c1.key).toBe(
      `${MANIFEST_KEY_PREFIX}/${READY_REF.fingerprint}/${snapshotA.sessionId}/completion-${c1.content_hash}.json`
    );
    expect(c1.content_hash).toBe(manifestContentHash(c1.bytes));
    expect(c1.checksum_sha256_base64).toBe(manifestChecksumBase64(c1.bytes));
  });

  test('PII rule: no spoken text / transcript keys reach the manifest bytes', () => {
    const completion = buildCompletionManifest({
      snapshot: snapshotA,
      completedAtIso: '2026-08-05T09:00:00.000Z',
      deploymentRef: READY_REF,
    });
    const text = JSON.stringify(completion);
    expect(text).not.toContain('"transcript"');
    expect(text).not.toContain('"spoken_response"');
    expect(text).not.toContain('"question"');
    expect(text).not.toContain('"text"');
  });
});

// ── publisher receipt matrix ───────────────────────────────────────────────

function makeCandidate() {
  const manifest = buildCompletionManifest({
    snapshot: snapshotA,
    completedAtIso: '2026-08-05T09:00:00.000Z',
    deploymentRef: READY_REF,
  });
  return buildManifestCandidate(manifest, { deploymentFingerprint: READY_REF.fingerprint });
}

function s3Error(status, name) {
  const err = new Error(name);
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

function fakeS3({ putResults = [], stored = new Map() } = {}) {
  const calls = [];
  const sendCommand = async (cmd) => {
    const type = cmd.constructor.name;
    calls.push({ type, input: cmd.input });
    if (type === 'PutObjectCommand') {
      const next = putResults.shift();
      if (next instanceof Error) throw next;
      const versionId = next && 'VersionId' in next ? next.VersionId : 'v1';
      stored.set(cmd.input.Key, {
        bytes: Buffer.from(cmd.input.Body),
        versionId,
        lastModified: new Date('2026-08-05T09:00:01.000Z'),
      });
      return { VersionId: versionId };
    }
    if (type === 'GetObjectCommand') {
      const obj = stored.get(cmd.input.Key);
      if (!obj) throw s3Error(404, 'NoSuchKey');
      return {
        Body: { transformToByteArray: async () => obj.bytes },
        VersionId: obj.versionId,
        LastModified: obj.lastModified,
        ChecksumSHA256: createHash('sha256').update(obj.bytes).digest('base64'),
      };
    }
    throw new Error(`unexpected command ${type}`);
  };
  return { sendCommand, calls, stored };
}

describe('publisher — strict content-addressed conditional receipts', () => {
  test('200 happy path: VersionId + read-back match ⇒ ok receipt', async () => {
    const s3 = fakeS3({ putResults: [{ VersionId: 'vA' }] });
    const pub = createManifestPublisher({ bucket: 'b', sendCommand: s3.sendCommand });
    const res = await pub.publish(makeCandidate());
    expect(res).toMatchObject({ ok: true, version_id: 'vA', idempotent: false });
    expect(res.last_modified).toBeTruthy();
  });

  test('missing/null VersionId on PUT ⇒ session-ineligible failure', async () => {
    for (const bad of [{ VersionId: undefined }, { VersionId: 'null' }, { VersionId: '' }]) {
      const s3 = fakeS3({ putResults: [bad] });
      const pub = createManifestPublisher({ bucket: 'b', sendCommand: s3.sendCommand });
      const res = await pub.publish(makeCandidate());
      expect(res.ok).toBe(false);
      expect(res.error).toBe('put_version_id_invalid');
    }
  });

  test('read-back current-version mismatch ⇒ failure (never a silent receipt)', async () => {
    const candidate = makeCandidate();
    const stored = new Map();
    const s3 = fakeS3({ putResults: [{ VersionId: 'vA' }], stored });
    const pub = createManifestPublisher({ bucket: 'b', sendCommand: s3.sendCommand });
    // Interleave: another version becomes current between PUT and read-back.
    const origSend = s3.sendCommand;
    let putDone = false;
    const send = async (cmd) => {
      const out = await origSend(cmd);
      if (cmd.constructor.name === 'PutObjectCommand' && !putDone) {
        putDone = true;
        stored.set(candidate.key, {
          bytes: Buffer.from('{"tampered":true}'),
          versionId: 'vB',
          lastModified: new Date(),
        });
      }
      return out;
    };
    const res = await createManifestPublisher({ bucket: 'b', sendCommand: send }).publish(
      candidate
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('readback_version_id_mismatch');
  });

  test('412 duplicate with MATCHING read-back ⇒ idempotent success recording the existing VersionId', async () => {
    const candidate = makeCandidate();
    const stored = new Map([
      [
        candidate.key,
        {
          bytes: Buffer.from(candidate.bytes),
          versionId: 'vExisting',
          lastModified: new Date('2026-08-05T09:00:00.500Z'),
        },
      ],
    ]);
    const s3 = fakeS3({ putResults: [s3Error(412, 'PreconditionFailed')], stored });
    const pub = createManifestPublisher({ bucket: 'b', sendCommand: s3.sendCommand });
    const res = await pub.publish(candidate);
    expect(res).toMatchObject({ ok: true, version_id: 'vExisting', idempotent: true });
  });

  test('412 with MISMATCHED read-back ⇒ only this session ineligible', async () => {
    const candidate = makeCandidate();
    const stored = new Map([
      [
        candidate.key,
        { bytes: Buffer.from('{"other":true}'), versionId: 'vX', lastModified: new Date() },
      ],
    ]);
    const s3 = fakeS3({ putResults: [s3Error(412, 'PreconditionFailed')], stored });
    const res = await createManifestPublisher({ bucket: 'b', sendCommand: s3.sendCommand }).publish(
      candidate
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('readback_content_mismatch');
  });

  test('409 conflict ⇒ bounded same-key/body retry, then success', async () => {
    const s3 = fakeS3({
      putResults: [s3Error(409, 'ConditionalRequestConflict'), { VersionId: 'vR' }],
    });
    const pub = createManifestPublisher({
      bucket: 'b',
      sendCommand: s3.sendCommand,
      sleep: async () => {},
    });
    const res = await pub.publish(makeCandidate());
    expect(res).toMatchObject({ ok: true, version_id: 'vR' });
    const puts = s3.calls.filter((c) => c.type === 'PutObjectCommand');
    expect(puts).toHaveLength(2);
    expect(puts[0].input.Body.equals(puts[1].input.Body)).toBe(true);
  });

  test('publisher NEVER throws — transport explosion becomes a failure result', async () => {
    const pub = createManifestPublisher({
      bucket: 'b',
      sendCommand: async () => {
        throw new Error('socket blew up');
      },
      sleep: async () => {},
    });
    const res = await pub.publish(makeCandidate());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^publish_failed:/);
  });

  test('no bucket configured ⇒ failure result, never a throw', async () => {
    const pub = createManifestPublisher({ bucket: null, sendCommand: async () => ({}) });
    const res = await pub.publish(makeCandidate());
    expect(res).toMatchObject({ ok: false, error: 'no_bucket_configured' });
  });

  test('task-role safety: only PutObject + GetObject are ever issued', async () => {
    const s3 = fakeS3({ putResults: [{ VersionId: 'vA' }] });
    await createManifestPublisher({ bucket: 'b', sendCommand: s3.sendCommand }).publish(
      makeCandidate()
    );
    const types = new Set(s3.calls.map((c) => c.type));
    expect([...types].sort()).toEqual(['GetObjectCommand', 'PutObjectCommand']);
  });
});

// ── deployment identity ────────────────────────────────────────────────────

describe('ECS deployment identity', () => {
  const TASK_JSON = {
    TaskARN: 'arn:aws:ecs:eu-west-2:1:task/eicr-cluster-production/abc',
    Family: 'eicr-backend',
    Revision: '377',
    Containers: [
      { Name: 'sidecar', ImageID: 'sha256:other' },
      { Name: 'eicr-backend', ImageID: 'sha256:feedface' },
    ],
  };

  test('resolves identity from the /task endpoint, picking the backend container', async () => {
    const { identity, reason } = await fetchEcsDeploymentIdentity({
      env: { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.2.2/v4/x' },
      fetchImpl: async (url) => {
        expect(url).toBe('http://169.254.2.2/v4/x/task');
        return { ok: true, json: async () => TASK_JSON };
      },
    });
    expect(reason).toBeNull();
    expect(identity).toEqual({
      task_arn: TASK_JSON.TaskARN,
      task_family: 'eicr-backend',
      task_revision: '377',
      image_id: 'sha256:feedface',
    });
  });

  test('non-ECS/local: no metadata URI ⇒ null identity + unknown fingerprint (session INVALID by design)', async () => {
    const { identity, reason } = await fetchEcsDeploymentIdentity({ env: {} });
    expect(identity).toBeNull();
    expect(reason).toBe('no_ecs_metadata_uri');
    expect(deploymentFingerprintOf(identity)).toBe(UNKNOWN_DEPLOYMENT_FINGERPRINT);
  });

  test('incomplete metadata ⇒ metadata_incomplete, never a partial identity', async () => {
    const { identity, reason } = await fetchEcsDeploymentIdentity({
      env: { ECS_CONTAINER_METADATA_URI_V4: 'http://x' },
      fetchImpl: async () => ({ ok: true, json: async () => ({ TaskARN: 'arn:x' }) }),
    });
    expect(identity).toBeNull();
    expect(reason).toBe('metadata_incomplete');
  });

  test('metadata HTTP failure ⇒ reasoned null', async () => {
    const { identity, reason } = await fetchEcsDeploymentIdentity({
      env: { ECS_CONTAINER_METADATA_URI_V4: 'http://x' },
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    expect(identity).toBeNull();
    expect(reason).toBe('metadata_http_500');
  });

  test('fingerprint is deterministic over the identity triple', () => {
    const fp1 = deploymentFingerprintOf(READY_REF.identity);
    const fp2 = deploymentFingerprintOf({ ...READY_REF.identity });
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('config fingerprint folds exactly the allowlisted env keys', () => {
    const a = computeConfigFingerprint({ STAGE6_TOOL_CALLS_MODE: 'live' });
    const b = computeConfigFingerprint({ STAGE6_TOOL_CALLS_MODE: 'live', UNRELATED: 'x' });
    const c = computeConfigFingerprint({ STAGE6_TOOL_CALLS_MODE: 'shadow' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(CONFIG_FINGERPRINT_ENV_ALLOWLIST).toContain('OPENAI_EXTRACT_PROMPT_CACHE');
    expect(CONFIG_FINGERPRINT_ENV_ALLOWLIST).toContain('OPENAI_EXTRACT_SERVICE_TIER');
    expect(CONFIG_FINGERPRINT_ENV_ALLOWLIST).toContain('OPENAI_OBSERVATION_REASONING_EFFORT');
  });
});

// ── hook integration (the REAL freeze latches) ─────────────────────────────

function makeHookEntry(observer) {
  const entry = {
    session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
  };
  const ctx = normaliseEvaluationContext(
    {
      observer,
      mutationObserver: createMutationObserver({ sessionId: 'sess_hook' }),
      askLedger: createAskLedger(),
      deliveryLedger: createDeliveryLedger(),
    },
    { sessionId: 'sess_hook' }
  );
  attachEvaluationContext(entry, ctx);
  return { entry, ctx };
}

describe('hook integration — the observer through the REAL latches', () => {
  test('start + completion freezes latch content-addressed candidates and ONE publish promise each', async () => {
    const published = [];
    const observer = createManifestObserver({
      deploymentRef: READY_REF,
      publisher: { publish: async (c) => (published.push(c.key), { ok: true, key: c.key }) },
      nowFn: () => new Date('2026-08-05T08:00:00.000Z'),
    });
    const { entry } = makeHookEntry(observer);
    const start = freezeEvidenceStart(entry, { sessionId: 'sess_hook' });
    expect(start.candidate.kind).toBe('start');
    expect(start.candidate.key).toContain(`/${READY_REF.fingerprint}/sess_hook/start-`);
    const completion = freezeEvidenceCompletion(entry, {
      sessionId: 'sess_hook',
      boundary: 'session_stopped',
    });
    expect(completion.candidate.kind).toBe('completion');
    expect(completion.eligible).toBe(true);
    // Single-flight: the second freeze returns the SAME latch and publishes nothing new.
    const again = freezeEvidenceCompletion(entry, { sessionId: 'sess_hook', boundary: 'x' });
    expect(again).toBe(completion);
    await Promise.all([start.publishPromise, completion.publishPromise]);
    expect(published).toHaveLength(2);
    expect(getStartFreeze(entry)).toBe(start);
    expect(getCompletionFreeze(entry)).toBe(completion);
  });

  test('builder throw is isolated as candidate_builder_threw — the freeze survives (fail-open live)', () => {
    const observer = {
      buildCandidate() {
        throw new Error('builder exploded');
      },
      publish: async () => ({ ok: true }),
    };
    const { entry } = makeHookEntry(observer);
    const latch = freezeEvidenceCompletion(entry, {
      sessionId: 'sess_hook',
      boundary: 'session_stopped',
    });
    expect(latch.eligible).toBe(false);
    expect(latch.reason).toBe('candidate_builder_threw');
    expect(latch.candidate).toBeNull();
    expect(latch.publishPromise).toBeNull();
  });

  test('publisher rejection is latched and swallowed — teardown can never crash on evidence', async () => {
    const observer = createManifestObserver({
      deploymentRef: READY_REF,
      publisher: {
        publish: async () => {
          throw new Error('S3 down');
        },
      },
      nowFn: () => new Date(),
    });
    const { entry } = makeHookEntry(observer);
    const latch = freezeEvidenceCompletion(entry, {
      sessionId: 'sess_hook',
      boundary: 'session_stopped',
    });
    await expect(
      Promise.race([latch.publishPromise, Promise.resolve('ok')])
    ).resolves.toBeDefined();
    // The latched promise must not become an unhandled rejection.
    await new Promise((r) => setTimeout(r, 10));
  });

  test('a non-quiescent stop still builds + publishes the durable audit candidate (always evidence-INELIGIBLE)', () => {
    const observer = createManifestObserver({
      deploymentRef: READY_REF,
      publisher: { publish: async () => ({ ok: true }) },
      nowFn: () => new Date(),
    });
    const { entry } = makeHookEntry(observer);
    entry.isExtracting = true; // in-flight work at stop
    const latch = freezeEvidenceCompletion(entry, {
      sessionId: 'sess_hook',
      boundary: 'session_stopped',
    });
    expect(latch.eligible).toBe(false);
    expect(latch.reason).toBe('non_quiescent_at_stop');
    expect(latch.candidate).not.toBeNull();
    expect(latch.candidate.manifest.status.non_quiescent_at_stop).toBe(1);
    // The audit candidate is durable but ALWAYS evidence-ineligible.
    expect(latch.candidate.manifest.evidence.eligible_for_family_credit).toBe(false);
    expect(latch.candidate.manifest.status.eligible_for_family_credit).toBe(false);
  });

  test('unavailable deployment identity publishes under the unknown fingerprint (honest INVALID, never fabricated)', () => {
    const observer = createManifestObserver({
      deploymentRef: UNAVAILABLE_REF,
      publisher: { publish: async () => ({ ok: true }) },
      nowFn: () => new Date(),
    });
    const { entry } = makeHookEntry(observer);
    const latch = freezeEvidenceCompletion(entry, {
      sessionId: 'sess_hook',
      boundary: 'session_stopped',
    });
    expect(latch.candidate.key).toContain(`/${UNKNOWN_DEPLOYMENT_FINGERPRINT}/`);
    expect(latch.candidate.manifest.deployment.identity).toBeNull();
    expect(latch.candidate.manifest.deployment.identity_unavailable_reason).toBe(
      'no_ecs_metadata_uri'
    );
  });
});

// ── the production factory ─────────────────────────────────────────────────

describe('createProductionEvidenceContextFactory', () => {
  test('returns the full four-role context per session', () => {
    const factory = createProductionEvidenceContextFactory({
      env: { S3_BUCKET: 'b' },
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    const roles = factory({ sessionId: 'sess_f', userId: 'u1' });
    expect(typeof roles.observer.buildCandidate).toBe('function');
    expect(typeof roles.observer.publish).toBe('function');
    expect(roles.askLedger).toBeTruthy();
    expect(roles.deliveryLedger).toBeTruthy();
    expect(roles.mutationObserver).toBeTruthy();
  });

  test('never throws with a hostile environment (broken fetch, no bucket)', () => {
    const factory = createProductionEvidenceContextFactory({
      env: {},
      fetchImpl: () => {
        throw new Error('no network');
      },
    });
    expect(() => factory({ sessionId: 'sess_g', userId: 'u1' })).not.toThrow();
  });
});

// ── Codex cycle-1 fix coverage ─────────────────────────────────────────────

describe('cycle-1: publisher checksum verification', () => {
  test('a read-back checksum mismatch fails BOTH the 200 and the 412 path', async () => {
    const candidate = makeCandidate();
    // 200 path: stored object reports a WRONG checksum.
    const send200 = async (cmd) => {
      if (cmd.constructor.name === 'PutObjectCommand') return { VersionId: 'vA' };
      return {
        Body: { transformToByteArray: async () => Buffer.from(candidate.bytes) },
        VersionId: 'vA',
        LastModified: new Date(),
        ChecksumSHA256: 'WRONGCHECKSUM=',
      };
    };
    const res200 = await createManifestPublisher({ bucket: 'b', sendCommand: send200 }).publish(
      candidate
    );
    expect(res200).toMatchObject({ ok: false, error: 'readback_checksum_mismatch' });

    // 412 path: existing object bytes match but the reported checksum lies.
    const send412 = async (cmd) => {
      if (cmd.constructor.name === 'PutObjectCommand') {
        const err = new Error('PreconditionFailed');
        err.name = 'PreconditionFailed';
        err.$metadata = { httpStatusCode: 412 };
        throw err;
      }
      return {
        Body: { transformToByteArray: async () => Buffer.from(candidate.bytes) },
        VersionId: 'vB',
        LastModified: new Date(),
        ChecksumSHA256: 'WRONGCHECKSUM=',
      };
    };
    const res412 = await createManifestPublisher({ bucket: 'b', sendCommand: send412 }).publish(
      candidate
    );
    expect(res412).toMatchObject({ ok: false, error: 'readback_checksum_mismatch' });
  });
});

describe('cycle-1: guardEvidenceRole — fail-open live, fail-closed evidence', () => {
  test('a double enterTurnScope no longer throws through; the invalid latch is preserved', async () => {
    const { guardEvidenceRole } = await import('../extraction/plan00-session-manifest.js');
    const raw = createMutationObserver({ sessionId: 'sess_guard' });
    const guarded = guardEvidenceRole(raw, 'mutation');
    guarded.enterTurnScope('turn_1');
    // The raw observer THROWS here (turn_scope_reentered latched first);
    // the guard must swallow the throw so a live turn cannot be aborted.
    expect(() => guarded.enterTurnScope('turn_2')).not.toThrow();
    expect(guarded.invalid?.reason).toBe('turn_scope_reentered');
    // Non-throwing methods pass through untouched.
    guarded.exitTurnScope();
    expect(guarded.openTurnId).toBeNull();
  });

  test('the production factory wraps ALL evidence roles defensively', () => {
    const factory = createProductionEvidenceContextFactory({
      env: { S3_BUCKET: 'b' },
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    const roles = factory({ sessionId: 'sess_gf', userId: 'u1' });
    roles.mutationObserver.enterTurnScope('t1');
    expect(() => roles.mutationObserver.enterTurnScope('t2')).not.toThrow();
    expect(roles.mutationObserver.invalid?.reason).toBe('turn_scope_reentered');
  });
});
