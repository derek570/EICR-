/**
 * Plan 00C test double — an in-memory VERSIONED S3 fake with full
 * version/delete-marker semantics, conditional-create behaviour and fault
 * injection. Committed beside the real store so the Stage-A verification
 * matrix (crash boundaries, 412/409 recovery, delete-marker-hidden FAIL,
 * shuffled rebuild, midnight-straddling receipts) runs hermetically.
 *
 * Semantics mirrored from S3:
 *  - Versioning Enabled: every PUT creates a new version id; delete writes
 *    a delete marker version.
 *  - PutObject If-None-Match:* returns 412 when a CURRENT (non-delete-
 *    marker) version exists; succeeds over a delete marker.
 *  - GetObject (no VersionId) returns the latest version, or 404 when the
 *    latest is a delete marker.
 *  - ListObjectVersions returns every version and delete marker.
 */

import { createHash } from 'node:crypto';

let versionCounter = 0;
function nextVersionId() {
  versionCounter += 1;
  return `v${String(versionCounter).padStart(8, '0')}`;
}

export function createMemoryStore({ bucket = 'test-bucket', versioning = 'Enabled', now } = {}) {
  const clock = { now: now ?? (() => new Date().toISOString()) };
  /** key → [{versionId, bytes|null(deleteMarker), lastModified}] (append order) */
  const objects = new Map();
  const faults = { conflictsRemaining: 0, loseNext200: false };

  const versionsOf = (key) => objects.get(key) ?? [];
  const latestOf = (key) => {
    const list = versionsOf(key);
    return list.length ? list[list.length - 1] : null;
  };

  const store = {
    bucket,
    _objects: objects,
    _faults: faults,
    _clock: clock,

    async getBucketVersioningStatus() {
      return versioning;
    },

    async putObjectIfAbsent({ key, bytes }) {
      if (faults.conflictsRemaining > 0) {
        faults.conflictsRemaining -= 1;
        return { status: 409 };
      }
      const latest = latestOf(key);
      if (latest && latest.bytes != null) return { status: 412 };
      const version = {
        versionId: nextVersionId(),
        bytes: Buffer.from(bytes),
        lastModified: clock.now(),
      };
      if (!objects.has(key)) objects.set(key, []);
      objects.get(key).push(version);
      if (faults.loseNext200) {
        faults.loseNext200 = false;
        // The write DURABLY happened but the 200 response was lost.
        const err = new Error('simulated network loss after successful write');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return { status: 200, versionId: version.versionId };
    },

    async getObjectCurrent({ key }) {
      const latest = latestOf(key);
      if (!latest || latest.bytes == null) return { found: false };
      return {
        found: true,
        bytes: Buffer.from(latest.bytes),
        versionId: latest.versionId,
        lastModified: latest.lastModified,
        checksumSha256: createHash('sha256').update(latest.bytes).digest('base64'),
      };
    },

    async getObjectVersion({ key, versionId }) {
      const v = versionsOf(key).find((x) => x.versionId === versionId);
      if (!v || v.bytes == null) {
        const err = new Error('NoSuchVersion');
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {
        bytes: Buffer.from(v.bytes),
        versionId: v.versionId,
        lastModified: v.lastModified,
        checksumSha256: createHash('sha256').update(v.bytes).digest('base64'),
      };
    },

    async listAllVersions({ prefix }) {
      const versions = [];
      const deleteMarkers = [];
      for (const [key, list] of objects) {
        if (!key.startsWith(prefix)) continue;
        for (let i = 0; i < list.length; i += 1) {
          const v = list[i];
          const row = {
            key,
            versionId: v.versionId,
            lastModified: v.lastModified,
            isLatest: i === list.length - 1,
          };
          if (v.bytes == null) deleteMarkers.push(row);
          else versions.push(row);
        }
      }
      return { versions, deleteMarkers };
    },

    // ── test hooks (operator-mistake simulation) ──
    /** Overwrite-style PUT (no condition) — creates a divergent version. */
    _putUnconditional(key, bytes) {
      if (!objects.has(key)) objects.set(key, []);
      const version = {
        versionId: nextVersionId(),
        bytes: Buffer.from(bytes),
        lastModified: clock.now(),
      };
      objects.get(key).push(version);
      return version;
    },
    /** Simulate a DELETE (writes a delete marker). */
    _delete(key) {
      if (!objects.has(key)) objects.set(key, []);
      objects.get(key).push({ versionId: nextVersionId(), bytes: null, lastModified: clock.now() });
    },
    _injectConflicts(n) {
      faults.conflictsRemaining = n;
    },
    _loseNext200() {
      faults.loseNext200 = true;
    },
    _setNow(fn) {
      clock.now = fn;
    },
  };
  return store;
}
