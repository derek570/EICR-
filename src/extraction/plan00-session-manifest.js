/**
 * Plan 00C §C3 — server-authored deployment/session manifests.
 *
 * The ONE 00C-owned production module: a PURE candidate builder plus a
 * content-addressed S3 publisher, registered through Plan 00B's frozen
 * lifecycle chokepoint (`plan00-lifecycle-hooks.js`) as the evaluation
 * context's `observer` role at server boot. 00C edits NO enumerated
 * semantic-oracle input — this file is covered by the deployed evidence
 * RUNTIME digest (the deployed image), never by `semantic_oracle_digest`.
 *
 * Layer split (schema-v1 contract): the builder derives EVERY session fact
 * from 00B's immutable five-key allowlisted snapshot {sessionId, boundary,
 * counts, revisions, sub_records} via `buildEvidenceProjectionV1` — one
 * derivation, never a parallel ledger read. The manifest ENVELOPE (trusted
 * timestamps/status, deployment identity, content addressing, publication
 * receipts) is 00C's, captured from boot-time frozen state and an injected
 * clock — never from mutable session state.
 *
 * Fail-open live / fail-closed evidence: every failure here (metadata
 * fetch, builder input surprise, S3 publish) makes ONLY the session's Plan
 * 00 evidence ineligible. Nothing in this module may throw into the
 * inspector's live extraction/audible turn — the hook layer additionally
 * isolates `buildCandidate` throws as `candidate_builder_threw` and latches
 * the publish promise with a swallowed rejection, but this module still
 * never relies on that net for the publisher path.
 *
 * PII rule: manifests carry NO transcript, model prose, tool payloads or
 * customer data. The projection's op_keys/live_ask_keys carry field names,
 * circuit refs and board ids only (certificate-slot identity, not customer
 * content) — the sub_records bridge excludes spoken text by 00B's design.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import canonicalize from 'canonicalize';
import logger from '../logger.js';
import { buildEvidenceProjectionV1 } from './plan00-evidence-projection.js';
import { createAskLedger, createDeliveryLedger } from './plan00-audibility-ledgers.js';
import { createMutationObserver } from './plan00-semantic-capture.js';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_KEY_PREFIX = 'plan00-session-manifests';
/** Deployment identity placeholder when ECS metadata is unavailable —
 *  the manifest still publishes (durable audit) but the session is INVALID
 *  for Plan 00 evidence (plan §C3: "Missing metadata … makes the session
 *  invalid"; "non-ECS/local invalid" is a pinned test case). */
export const UNKNOWN_DEPLOYMENT_FINGERPRINT = 'unknown-deployment';

// ── canonical serialization (RFC 8785 via the pinned `canonicalize`) ──────
//
// Mirror rule: `scripts/field-replay/lib/canonical-crypto.mjs#canonicalBytes`
// is the corpus-side implementation of the SAME spec, but `scripts/` is not
// copied into the backend Docker image (`Dockerfile.backend` copies only
// src/config/assets/python), so the server side calls the same pinned
// package directly. A reciprocal drift test byte-compares the two over an
// edge-case corpus (`plan00-session-manifest.test.js`).

/** RFC 8785 canonical UTF-8 bytes. Throws on undefined / non-JSON values —
 *  a silent `undefined` would hash an empty message and collide inputs. */
export function canonicalManifestBytes(value) {
  const s = canonicalize(value);
  if (typeof s !== 'string') {
    throw new Error('canonicalManifestBytes: value is not JCS-serializable (got undefined)');
  }
  return Buffer.from(s, 'utf8');
}

/** Full lowercase-hex SHA-256 of the canonical bytes. */
export function manifestContentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Base64 SHA-256 of the exact bytes — the S3 ChecksumSHA256 form. */
export function manifestChecksumBase64(bytes) {
  return createHash('sha256').update(bytes).digest('base64');
}

// ── deployment identity (boot-time frozen envelope facts) ────────────────

const REPO_CONFIG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'config',
  'prompts'
);

/** Allowlisted runtime-config keys folded into the config fingerprint.
 *  VALUES are hashed, never logged raw; every key is deployment
 *  configuration (model/tier/cache routing), never customer data. */
export const CONFIG_FINGERPRINT_ENV_ALLOWLIST = Object.freeze([
  'STAGE6_TOOL_CALLS_MODE',
  'SONNET_EXTRACT_MODEL',
  'SHADOW_MODEL',
  'OBSERVATION_EXTRACT_MODEL',
  'OBSERVATION_TIER_ROUTING',
  'EXTRACTION_PROVIDER',
  'OPENAI_EXTRACT_MODEL',
  'OPENAI_EXTRACT_SERVICE_TIER',
  'OPENAI_EXTRACT_PROMPT_CACHE',
  'OPENAI_EXTRACT_REASONING_EFFORT',
  'OPENAI_OBSERVATION_MODEL',
  'OPENAI_OBSERVATION_SERVICE_TIER',
  'OPENAI_OBSERVATION_REASONING_EFFORT',
  'VOICE_LATENCY_LOADED_BARREL',
  'VOICE_AGENTIC_ANSWERS',
  'LIM_RANGED_WRITE_DISABLED',
  'BOARD_CLEAR_DISABLED',
]);

/** Hash the committed prompt templates shipped in the image (config/ is
 *  COPY'd into the Docker image). Sorted name+sha rows → one digest. */
export function computePromptFingerprint({ promptDir = REPO_CONFIG_DIR } = {}) {
  try {
    const names = readdirSync(promptDir)
      .filter((n) => n.endsWith('.md'))
      .sort();
    const rows = names.map((n) => {
      const digest = createHash('sha256')
        .update(readFileSync(path.join(promptDir, n)))
        .digest('hex');
      return `${n}\n${digest}\n`;
    });
    return createHash('sha256').update(rows.join('')).digest('hex');
  } catch (err) {
    logger.warn('plan00-session-manifest: prompt fingerprint unavailable', {
      error: err?.message,
    });
    return null;
  }
}

/** Hash the served Stage-6 tool schemas (both agentic-answers variants). */
export async function computeToolFingerprint() {
  try {
    const { buildSessionTools } = await import('./stage6-tool-schemas.js');
    return manifestContentHash(
      canonicalManifestBytes({
        agentic_on: buildSessionTools(true),
        agentic_off: buildSessionTools(false),
      })
    );
  } catch (err) {
    logger.warn('plan00-session-manifest: tool fingerprint unavailable', {
      error: err?.message,
    });
    return null;
  }
}

/** Hash the allowlisted runtime configuration (values folded, not stored). */
export function computeConfigFingerprint(env = process.env) {
  const subset = {};
  for (const key of CONFIG_FINGERPRINT_ENV_ALLOWLIST) {
    subset[key] = env[key] ?? null;
  }
  return manifestContentHash(canonicalManifestBytes(subset));
}

/**
 * Fetch the ECS task metadata (ECS_CONTAINER_METADATA_URI_V4/task) and
 * reduce it to the manifest's deployment identity. Returns null (with a
 * reason) off-ECS — a locally-run backend produces INVALID sessions by
 * design, never fabricated identity.
 */
export async function fetchEcsDeploymentIdentity({
  env = process.env,
  fetchImpl = globalThis.fetch,
  containerName = 'eicr-backend',
} = {}) {
  const uri = env.ECS_CONTAINER_METADATA_URI_V4;
  if (!uri) return { identity: null, reason: 'no_ecs_metadata_uri' };
  try {
    // Bounded: a hung metadata endpoint must never wedge boot-time
    // resolution (sessions started before resolution are honestly INVALID).
    const res = await fetchImpl(`${uri}/task`, {
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
    });
    if (!res.ok) return { identity: null, reason: `metadata_http_${res.status}` };
    const task = await res.json();
    const taskArn = task?.TaskARN ?? null;
    const family = task?.Family ?? null;
    const revision = task?.Revision ?? null;
    const containers = Array.isArray(task?.Containers) ? task.Containers : [];
    const container =
      containers.find((c) => c?.Name === containerName) ??
      (containers.length === 1 ? containers[0] : null);
    const imageId = container?.ImageID ?? null;
    if (!taskArn || !family || !revision || !imageId) {
      return { identity: null, reason: 'metadata_incomplete' };
    }
    return {
      identity: {
        task_arn: taskArn,
        task_family: family,
        task_revision: String(revision),
        image_id: imageId,
      },
      reason: null,
    };
  } catch (err) {
    return { identity: null, reason: `metadata_fetch_failed:${err?.message ?? 'unknown'}` };
  }
}

/** Deterministic deployment fingerprint from the identity triple; the
 *  operator collector later maps image_id → ECR ${github.sha} tag. */
export function deploymentFingerprintOf(identity) {
  if (!identity) return UNKNOWN_DEPLOYMENT_FINGERPRINT;
  return manifestContentHash(
    canonicalManifestBytes({
      image_id: identity.image_id,
      task_family: identity.task_family,
      task_revision: identity.task_revision,
    })
  );
}

/**
 * Resolve the full boot-time deployment envelope ONCE. The returned ref is
 * `pending` until resolution; builders read whatever state is frozen at
 * freeze time (a start manifest built before resolution carries a null
 * identity and the session is INVALID — honest, never blocked on the
 * fetch). All failures resolve the ref; the promise never rejects.
 */
export function resolveDeploymentRef({
  env = process.env,
  fetchImpl = globalThis.fetch,
  promptDir,
} = {}) {
  const ref = {
    state: 'pending',
    identity: null,
    reason: 'pending',
    fingerprint: UNKNOWN_DEPLOYMENT_FINGERPRINT,
    prompt_fingerprint: null,
    tool_fingerprint: null,
    config_fingerprint: null,
  };
  ref.ready = (async () => {
    try {
      const [{ identity, reason }, toolFp] = await Promise.all([
        fetchEcsDeploymentIdentity({ env, fetchImpl }),
        computeToolFingerprint(),
      ]);
      ref.identity = identity;
      ref.reason = reason;
      ref.fingerprint = deploymentFingerprintOf(identity);
      ref.prompt_fingerprint = computePromptFingerprint(promptDir ? { promptDir } : {});
      ref.tool_fingerprint = toolFp;
      ref.config_fingerprint = computeConfigFingerprint(env);
      ref.state = identity ? 'ready' : 'unavailable';
    } catch (err) {
      ref.state = 'unavailable';
      ref.reason = `deployment_ref_failed:${err?.message ?? 'unknown'}`;
    }
    return ref;
  })();
  return ref;
}

// ── pure manifest builders ───────────────────────────────────────────────

function deploymentSection(deploymentRef) {
  return {
    identity: deploymentRef.identity
      ? {
          task_arn: deploymentRef.identity.task_arn,
          task_family: deploymentRef.identity.task_family,
          task_revision: deploymentRef.identity.task_revision,
          image_id: deploymentRef.identity.image_id,
        }
      : null,
    identity_unavailable_reason: deploymentRef.identity ? null : deploymentRef.reason,
    fingerprint: deploymentRef.fingerprint,
    prompt_fingerprint: deploymentRef.prompt_fingerprint,
    tool_fingerprint: deploymentRef.tool_fingerprint,
    config_fingerprint: deploymentRef.config_fingerprint,
  };
}

/**
 * The START manifest: opaque session id, trusted start timestamp, schema
 * version and the deployment identity/fingerprints ONLY. Completion /
 * actual-execution fields are ABSENT — never null placeholders and never
 * config-derived (plan §C3; an executed-route gate can never be satisfied
 * from a start manifest because the keys do not exist).
 */
export function buildStartManifest({ snapshot, startedAtIso, deploymentRef }) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('buildStartManifest: snapshot required');
  }
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    manifest_kind: 'start',
    session_id: snapshot.sessionId,
    boundary: snapshot.boundary,
    started_at: startedAtIso,
    deployment: deploymentSection(deploymentRef),
  };
}

/**
 * The COMPLETION manifest: trusted completion timestamp/status, the SAME
 * deployment identity, and the complete `evidence_projection_v1` derived
 * from the five-key snapshot — the per-family ask-lifecycle/delivery/
 * playback fields, the round_usage (actual provider/model/tier/cache route)
 * evidence and the confirmation/ACK ledgers all ride the projection; no
 * field is ever read from live session state or configuration.
 */
export function buildCompletionManifest({ snapshot, completedAtIso, deploymentRef }) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('buildCompletionManifest: snapshot required');
  }
  const evidence = buildEvidenceProjectionV1(snapshot);
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    manifest_kind: 'completion',
    session_id: snapshot.sessionId,
    boundary: snapshot.boundary,
    completed_at: completedAtIso,
    status: {
      non_quiescent_at_stop: snapshot.counts?.non_quiescent_at_stop ?? null,
      revision_instability: snapshot.counts?.revision_instability ?? null,
      eligible_for_family_credit: evidence.eligible_for_family_credit,
    },
    deployment: deploymentSection(deploymentRef),
    evidence,
  };
}

/** Content-address a built manifest: canonical bytes → hash → key/checksum,
 *  computed exactly once, synchronously. */
export function buildManifestCandidate(manifest, { deploymentFingerprint }) {
  const bytes = canonicalManifestBytes(manifest);
  const contentHash = manifestContentHash(bytes);
  return Object.freeze({
    kind: manifest.manifest_kind,
    session_id: manifest.session_id,
    manifest,
    bytes,
    content_hash: contentHash,
    checksum_sha256_base64: manifestChecksumBase64(bytes),
    key: `${MANIFEST_KEY_PREFIX}/${deploymentFingerprint}/${manifest.session_id}/${manifest.manifest_kind}-${contentHash}.json`,
  });
}

// ── the task-role-bounded publisher ──────────────────────────────────────

const CONDITIONAL_CONFLICT_RETRIES = 3;
const CONDITIONAL_CONFLICT_BACKOFF_MS = 250;

function httpStatusOf(err) {
  return err?.$metadata?.httpStatusCode ?? null;
}

/**
 * Publish one latched candidate with strict content-addressed conditional
 * semantics, using ONLY task-role-safe calls: conditional PutObject
 * (If-None-Match: *) and current-version GetObject read-back. It MUST NOT
 * call GetBucketVersioning / ListObjectVersions / GetObjectVersion — the
 * deployed task role intentionally lacks them; the operator collector owns
 * the full version/delete-marker audit (plan §C3).
 *
 * Receipt rules (each failure makes ONLY this session ineligible):
 *  - 200: VersionId must be non-empty and not the literal 'null'; the
 *    immediate current-version read-back must return the SAME VersionId,
 *    matching content hash/checksum, and a LastModified.
 *  - 412: possible idempotent duplicate — same read-back; matching content
 *    plus valid version evidence makes the EXISTING object the receipt.
 *  - 409: conditional-write conflict — bounded same-key/same-body retry,
 *    never a content rewrite.
 * Never throws; always returns a result object.
 */
export function createManifestPublisher({
  bucket,
  s3Client,
  sendCommand,
  log = logger,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const send = sendCommand ?? (async (cmd) => s3Client.send(cmd));

  async function readBack(candidate) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await send(
      new GetObjectCommand({ Bucket: bucket, Key: candidate.key, ChecksumMode: 'ENABLED' })
    );
    const bodyBytes = Buffer.from(await res.Body.transformToByteArray());
    return {
      version_id: res.VersionId ?? null,
      last_modified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
      content_hash: manifestContentHash(bodyBytes),
      checksum_sha256_base64: res.ChecksumSHA256 ?? null,
    };
  }

  function versionEvidenceValid(versionId) {
    return typeof versionId === 'string' && versionId.length > 0 && versionId !== 'null';
  }

  function receiptFromReadBack(candidate, back, { idempotent }) {
    if (!versionEvidenceValid(back.version_id)) {
      return { ok: false, error: 'readback_version_id_invalid', key: candidate.key };
    }
    if (back.content_hash !== candidate.content_hash) {
      return { ok: false, error: 'readback_content_mismatch', key: candidate.key };
    }
    // Codex cycle-1: the checksum must be VERIFIED, not merely requested —
    // both the 200 and the idempotent-412 receipt require the read-back
    // ChecksumSHA256 to be present and byte-equal to the candidate's.
    if (back.checksum_sha256_base64 !== candidate.checksum_sha256_base64) {
      return { ok: false, error: 'readback_checksum_mismatch', key: candidate.key };
    }
    if (back.last_modified == null) {
      return { ok: false, error: 'readback_last_modified_missing', key: candidate.key };
    }
    return {
      ok: true,
      key: candidate.key,
      version_id: back.version_id,
      last_modified: back.last_modified,
      content_hash: candidate.content_hash,
      checksum_sha256_base64: back.checksum_sha256_base64,
      idempotent,
    };
  }

  async function publish(candidate) {
    if (!candidate || !candidate.bytes) {
      return { ok: false, error: 'no_candidate' };
    }
    if (!bucket) {
      return { ok: false, error: 'no_bucket_configured', key: candidate.key };
    }
    try {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      for (let attempt = 0; ; attempt += 1) {
        try {
          const put = await send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: candidate.key,
              Body: candidate.bytes,
              ContentType: 'application/json',
              ChecksumSHA256: candidate.checksum_sha256_base64,
              IfNoneMatch: '*',
            })
          );
          if (!versionEvidenceValid(put.VersionId ?? null)) {
            return { ok: false, error: 'put_version_id_invalid', key: candidate.key };
          }
          const back = await readBack(candidate);
          if (back.version_id !== put.VersionId) {
            return { ok: false, error: 'readback_version_id_mismatch', key: candidate.key };
          }
          return receiptFromReadBack(candidate, back, { idempotent: false });
        } catch (err) {
          const status = httpStatusOf(err);
          if (status === 412 || err?.name === 'PreconditionFailed') {
            // Possible idempotent duplicate (completion-path re-entry after
            // reconnect): matching read-back = the existing object IS the
            // successful receipt; a mismatch makes only this session
            // ineligible.
            const back = await readBack(candidate);
            return receiptFromReadBack(candidate, back, { idempotent: true });
          }
          if (
            (status === 409 || err?.name === 'ConditionalRequestConflict') &&
            attempt < CONDITIONAL_CONFLICT_RETRIES
          ) {
            await sleep(CONDITIONAL_CONFLICT_BACKOFF_MS * (attempt + 1));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      log.warn('plan00-session-manifest: publish failed', {
        key: candidate.key,
        error: err?.message,
      });
      return { ok: false, error: `publish_failed:${err?.name ?? 'error'}`, key: candidate.key };
    }
  }

  return { publish };
}

// ── the observer (00B hook role) ─────────────────────────────────────────

/**
 * Compose the hook observer for one session. `buildCandidate` is invoked
 * synchronously by the freeze latches with the immutable five-key snapshot;
 * `publish` is invoked once with the latched candidate and its promise is
 * latched by the hook. Envelope inputs (clock, boot-frozen deployment ref,
 * publisher) are closures — never mutable session state.
 */
export function createManifestObserver({ deploymentRef, publisher, nowFn = () => new Date() }) {
  return {
    buildCandidate(snapshot) {
      const atIso = nowFn().toISOString();
      const manifest =
        snapshot.boundary === 'session_started'
          ? buildStartManifest({ snapshot, startedAtIso: atIso, deploymentRef })
          : buildCompletionManifest({ snapshot, completedAtIso: atIso, deploymentRef });
      return buildManifestCandidate(manifest, {
        deploymentFingerprint: deploymentRef.fingerprint,
      });
    },
    async publish(candidate) {
      if (!candidate) return { ok: false, error: 'no_candidate' };
      const result = await publisher.publish(candidate);
      if (result.ok) {
        logger.info('plan00-session-manifest: published', {
          key: result.key,
          version_id: result.version_id,
          idempotent: result.idempotent === true,
        });
      } else {
        // A structured failure (bad VersionId, read-back mismatch, no
        // bucket) must be VISIBLE, never a silently-ineligible session.
        logger.warn('plan00-session-manifest: publish ineligible', {
          key: result.key ?? null,
          error: result.error ?? null,
        });
      }
      return result;
    },
  };
}

/**
 * The server-boot registration entry (plan §C3): compose the FULL
 * production evaluation-context factory — the manifest observer plus the
 * 00B mutation observer and ask/delivery ledgers whose sub_records bridge
 * the completion manifest's family evidence derives from. Passed as
 * `initSonnetStream(..., { evaluationContextFactory })` from src/server.js
 * (registration-site wiring — deployed_evidence_runtime_digest only).
 *
 * NEVER throws: a broken environment yields a factory whose sessions are
 * evidence-ineligible, not a broken session_start.
 */
export function createProductionEvidenceContextFactory({
  env = process.env,
  fetchImpl = globalThis.fetch,
  s3Client,
  nowFn = () => new Date(),
  promptDir,
} = {}) {
  let deploymentRef;
  let publisher;
  try {
    deploymentRef = resolveDeploymentRef({ env, fetchImpl, promptDir });
  } catch (err) {
    logger.warn('plan00-session-manifest: deployment ref init failed', { error: err?.message });
    deploymentRef = {
      state: 'unavailable',
      identity: null,
      reason: 'deployment_ref_init_failed',
      fingerprint: UNKNOWN_DEPLOYMENT_FINGERPRINT,
      prompt_fingerprint: null,
      tool_fingerprint: null,
      config_fingerprint: null,
    };
  }
  try {
    const bucket = env.S3_BUCKET || null;
    const makeClient = async () => {
      if (s3Client) return s3Client;
      const { S3Client } = await import('@aws-sdk/client-s3');
      s3Client = new S3Client({ region: env.AWS_REGION || 'eu-west-2' });
      return s3Client;
    };
    publisher = createManifestPublisher({
      bucket,
      sendCommand: async (cmd) => (await makeClient()).send(cmd),
    });
  } catch (err) {
    logger.warn('plan00-session-manifest: publisher init failed', { error: err?.message });
    publisher = { publish: async () => ({ ok: false, error: 'publisher_init_failed' }) };
  }

  return function evaluationContextFactory({ sessionId }) {
    const observer = createManifestObserver({ deploymentRef, publisher, nowFn });
    try {
      return {
        observer,
        // ONLY the mutation observer is guard-wrapped: it is the one role
        // that deliberately THROWS on contract violations, and no caller
        // dereferences a PROPERTY off one of its return values. The
        // ask/delivery ledgers return verdict objects that enumerated
        // callers dereference immediately (row.op_keys, verdict.accepted)
        // — a guard returning undefined there would CREATE a throw path.
        //
        // Plan 00B-3 C2 narrowed that premise deliberately: `enterTurnScope`
        // now returns a CLOSED success token (`true`) and its four call
        // sites DO read that value — but only to compare it against `true`,
        // never to dereference it. That is exactly why the token is a
        // primitive and why this guard's caught-failure result stays
        // `undefined`: the swallow degrades a refused enter to "not
        // entered", which is precisely what the call site must conclude,
        // and it can never produce a TypeError. Keep any future return
        // value of a guarded method in that shape — a primitive whose
        // falsy value is the correct fail-closed reading.
        mutationObserver: guardEvidenceRole(createMutationObserver({ sessionId }), 'mutation'),
        askLedger: createAskLedger(),
        deliveryLedger: createDeliveryLedger(),
      };
    } catch (err) {
      // Evidence composition failed — the session still gets manifests
      // (observer-only context; family evidence absent means the gates
      // simply cannot pass), never a silent null and never a broken start.
      logger.warn('plan00-session-manifest: role composition failed — observer-only', {
        sessionId,
        error: err?.message,
      });
      return { observer, mutationObserver: null, askLedger: null, deliveryLedger: null };
    }
  };
}

/**
 * Codex cycle-1 (fail-open-live) — a defensive no-throw boundary around an
 * evidence role. 00B's mutation observer deliberately THROWS on evaluation
 * contract violations (e.g. `enterTurnScope` while a scope is open — it
 * latches `invalid` FIRST, then throws so the eval lanes fail loud). Two of
 * its production call sites sit OUTSIDE their try/finally, so with the
 * context now active on LIVE sessions such a throw could abort a live
 * extraction turn. This wrapper preserves the evidence verdict (the invalid
 * latch is already set before the throw) while guaranteeing nothing
 * propagates into the inspector's turn. Getters/properties pass through
 * untouched; only function calls are guarded.
 */
export function guardEvidenceRole(role, label) {
  if (!role || typeof role !== 'object') return role;
  return new Proxy(role, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function guarded(...args) {
        try {
          return value.apply(target, args);
        } catch (err) {
          try {
            target.markInvalid?.('evidence_role_threw', {
              role: label,
              method: String(prop),
              error: err?.message ?? null,
            });
          } catch {
            /* the latch itself must never throw through */
          }
          logger.warn('plan00-session-manifest: evidence role threw (isolated)', {
            role: label,
            method: String(prop),
            error: err?.message,
          });
          return undefined;
        }
      };
    },
  });
}
