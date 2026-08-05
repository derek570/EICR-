/**
 * Plan 00C §C1 — the version-audited store.
 *
 * Operator-credential S3 access. The AUTHORITATIVE reader uses
 * ListObjectVersions (never ListObjectsV2) and folds EVERY visible version
 * and delete marker. Any same-key version with different bytes/hash, any
 * delete marker, any inaccessible version is HOLD/BLOCKED — never omission.
 * Byte-identical versions of one key collapse to ONE semantic record whose
 * authoritative `published_at` is the EARLIEST LastModified (later
 * identical versions are idempotent receipt duplicates and can never move
 * an event to a later Europe/London day).
 *
 * Every publisher and every fold verifies bucket versioning FIRST and fails
 * closed if absent. Writes are conditional creates (If-None-Match: *) with
 * read-back; nothing here can overwrite or delete.
 *
 * The store interface is injectable — tests run against an in-memory fake
 * with full version/delete-marker semantics; the real implementation wraps
 * @aws-sdk/client-s3 with the operator's credentials.
 */

import { createHash } from 'node:crypto';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Real S3-backed store (operator credentials). */
export function createS3Store({ bucket, region = process.env.AWS_REGION || 'eu-west-2' }) {
  let clientPromise = null;
  const client = async () => {
    if (!clientPromise) {
      clientPromise = import('@aws-sdk/client-s3').then((sdk) => ({
        sdk,
        s3: new sdk.S3Client({ region }),
      }));
    }
    return clientPromise;
  };

  return {
    bucket,
    async getBucketVersioningStatus() {
      const { sdk, s3 } = await client();
      const res = await s3.send(new sdk.GetBucketVersioningCommand({ Bucket: bucket }));
      return res.Status ?? null;
    },
    async putObjectIfAbsent({ key, bytes }) {
      const { sdk, s3 } = await client();
      try {
        const res = await s3.send(
          new sdk.PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: 'application/json',
            ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
            IfNoneMatch: '*',
          })
        );
        return { status: 200, versionId: res.VersionId ?? null };
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode ?? null;
        if (status === 412 || err?.name === 'PreconditionFailed') return { status: 412 };
        if (status === 409 || err?.name === 'ConditionalRequestConflict') return { status: 409 };
        throw err;
      }
    },
    async getObjectCurrent({ key }) {
      const { sdk, s3 } = await client();
      try {
        const res = await s3.send(
          new sdk.GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' })
        );
        const bytes = Buffer.from(await res.Body.transformToByteArray());
        return {
          found: true,
          bytes,
          versionId: res.VersionId ?? null,
          lastModified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
          checksumSha256: res.ChecksumSHA256 ?? null,
        };
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode ?? null;
        if (status === 404 || err?.name === 'NoSuchKey') return { found: false };
        throw err;
      }
    },
    async getObjectVersion({ key, versionId }) {
      const { sdk, s3 } = await client();
      const res = await s3.send(
        new sdk.GetObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: versionId,
          ChecksumMode: 'ENABLED',
        })
      );
      const bytes = Buffer.from(await res.Body.transformToByteArray());
      return {
        bytes,
        versionId: res.VersionId ?? versionId,
        lastModified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
        checksumSha256: res.ChecksumSHA256 ?? null,
      };
    },
    async listAllVersions({ prefix }) {
      const { sdk, s3 } = await client();
      const versions = [];
      const deleteMarkers = [];
      let KeyMarker;
      let VersionIdMarker;
      for (;;) {
        const res = await s3.send(
          new sdk.ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker,
            VersionIdMarker,
          })
        );
        for (const v of res.Versions ?? []) {
          versions.push({
            key: v.Key,
            versionId: v.VersionId,
            lastModified: v.LastModified ? new Date(v.LastModified).toISOString() : null,
            isLatest: v.IsLatest === true,
          });
        }
        for (const d of res.DeleteMarkers ?? []) {
          deleteMarkers.push({
            key: d.Key,
            versionId: d.VersionId,
            lastModified: d.LastModified ? new Date(d.LastModified).toISOString() : null,
          });
        }
        if (!res.IsTruncated) break;
        KeyMarker = res.NextKeyMarker;
        VersionIdMarker = res.NextVersionIdMarker;
      }
      return { versions, deleteMarkers };
    },
  };
}

/** Fail-closed bucket-versioning guard shared by publishers and folds. */
export async function assertBucketVersioned(store) {
  const status = await store.getBucketVersioningStatus();
  if (status !== 'Enabled') {
    const err = new Error(
      `evidence bucket versioning is "${status ?? 'unset'}" — must be Enabled; refusing to act`
    );
    err.code = 'bucket_versioning_absent';
    throw err;
  }
}

/**
 * Durable conditional publish with read-back receipt. 412 = possible
 * idempotent duplicate: matching bytes ⇒ the existing object is the
 * receipt; mismatched bytes ⇒ integrity failure (fail closed). 409 =
 * bounded exact-same-key/body retry. Returns {ok, versionId, lastModified,
 * publishedAt, idempotent} or {ok:false, error}.
 */
export async function publishDurable(store, { key, bytes }, { retries = 3, sleepMs = 200 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; ; attempt += 1) {
    const put = await store.putObjectIfAbsent({ key, bytes });
    if (put.status === 200) {
      if (typeof put.versionId !== 'string' || put.versionId.length === 0 || put.versionId === 'null') {
        return { ok: false, error: 'put_version_id_invalid', key };
      }
      const back = await store.getObjectCurrent({ key });
      if (!back.found) return { ok: false, error: 'readback_missing', key };
      if (back.versionId !== put.versionId) {
        return { ok: false, error: 'readback_version_id_mismatch', key };
      }
      if (sha256Hex(back.bytes) !== sha256Hex(bytes)) {
        return { ok: false, error: 'readback_content_mismatch', key };
      }
      return {
        ok: true,
        key,
        versionId: put.versionId,
        lastModified: back.lastModified,
        publishedAt: back.lastModified,
        idempotent: false,
      };
    }
    if (put.status === 412) {
      const back = await store.getObjectCurrent({ key });
      if (!back.found) return { ok: false, error: 'precondition_but_missing', key };
      if (sha256Hex(back.bytes) !== sha256Hex(bytes)) {
        return { ok: false, error: 'existing_content_mismatch', key };
      }
      if (typeof back.versionId !== 'string' || back.versionId.length === 0 || back.versionId === 'null') {
        return { ok: false, error: 'existing_version_id_invalid', key };
      }
      return {
        ok: true,
        key,
        versionId: back.versionId,
        lastModified: back.lastModified,
        publishedAt: back.lastModified,
        idempotent: true,
      };
    }
    if (put.status === 409) {
      // A 409 is not proof another writer won — retry the EXACT same
      // key/body, then the 412 path above resolves the truth.
      if (attempt < retries) {
        await sleep(sleepMs * (attempt + 1));
        continue;
      }
      return { ok: false, error: 'conditional_conflict_unresolved', key };
    }
    return { ok: false, error: `unexpected_put_status_${put.status}`, key };
  }
}

/**
 * The authoritative version-audited reader for a prefix. Returns
 * { records, holds } where each record is ONE semantic object
 * {key, bytes, payload, published_at, version_ids[]} whose versions were all
 * byte-identical, and holds carries every integrity violation (delete
 * marker, divergent same-key bytes, inaccessible version). JSON parse
 * failures surface as holds, never omissions.
 */
export async function loadAuditedPrefix(store, prefix) {
  const { versions, deleteMarkers } = await store.listAllVersions({ prefix });
  const holds = [];
  for (const d of deleteMarkers) {
    holds.push({ code: 'delete_marker_present', key: d.key, version_id: d.versionId });
  }
  const byKey = new Map();
  for (const v of versions) {
    if (!byKey.has(v.key)) byKey.set(v.key, []);
    byKey.get(v.key).push(v);
  }
  const records = [];
  for (const [key, vlist] of byKey) {
    let firstBytes = null;
    let earliest = null;
    const versionIds = [];
    let held = false;
    for (const v of vlist) {
      let got;
      try {
        got = await store.getObjectVersion({ key, versionId: v.versionId });
      } catch (err) {
        holds.push({ code: 'version_inaccessible', key, version_id: v.versionId, error: err?.message });
        held = true;
        continue;
      }
      // Codex cycle-1 — when the store reports a checksum, it must MATCH
      // the bytes (an S3-side checksum divergence is a HOLD, not trust).
      if (got.checksumSha256 != null) {
        const computed = createHash('sha256').update(got.bytes).digest('base64');
        if (computed !== got.checksumSha256) {
          holds.push({ code: 'version_checksum_mismatch', key, version_id: v.versionId });
          held = true;
          continue;
        }
      }
      if (firstBytes == null) {
        firstBytes = got.bytes;
      } else if (sha256Hex(got.bytes) !== sha256Hex(firstBytes)) {
        holds.push({ code: 'same_key_divergent_bytes', key, version_id: v.versionId });
        held = true;
        continue;
      }
      versionIds.push(v.versionId);
      const lm = got.lastModified ?? v.lastModified;
      if (lm != null && (earliest == null || Date.parse(lm) < Date.parse(earliest))) {
        earliest = lm;
      }
    }
    if (held) continue;
    if (firstBytes == null) {
      holds.push({ code: 'key_without_readable_version', key });
      continue;
    }
    let payload = null;
    try {
      payload = JSON.parse(firstBytes.toString('utf8'));
    } catch {
      holds.push({ code: 'unparseable_object', key });
      continue;
    }
    records.push({
      key,
      bytes: firstBytes,
      payload,
      published_at: earliest,
      version_ids: versionIds,
    });
  }
  records.sort((a, b) => a.key.localeCompare(b.key));
  return { records, holds };
}
