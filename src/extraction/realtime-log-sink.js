// realtime-log-sink.js
//
// Per-session buffer + S3 flush primitives for the `client_log_batch`
// channel that iOS streams over the Sonnet WebSocket (see PLAN-backend
// Phase 1.3). The sink owns:
//   - the in-memory ring of sanitised JSONL lines pinned to an
//     activeSessions entry (`entry.realtimeLogBuffer`)
//   - the cost-cap downsampling state (Phase 1.4)
//   - the S3 flush primitive (collision-proof timestamp keys; never
//     overwrites because every key includes a 4-byte random suffix)
//   - the periodic flusher tick (one global setInterval that walks
//     activeSessions every FLUSH_INTERVAL_MS)
//   - the shutdown-safe `flushAllSessions(...)` helper called from
//     gracefulShutdown BEFORE process.exit so a SIGTERM during deploy
//     doesn't drop up to 30 s of buffered telemetry.
//
// The case-arm in sonnet-stream.js owns audit-integrity (stripping
// client-provided userId/sessionId/timestamp fields) and per-entry
// CloudWatch row emission. This module is deliberately ignorant of
// CloudWatch — its only side-effect is the S3 upload + a couple of
// info/error rows around it. Storage helper is `uploadBytes(...)` with
// content-type `application/x-ndjson` — the only helper in storage.js
// that takes a 3rd content-type arg without pretty-printing or
// hardcoding text/plain.

import crypto from 'crypto';
import logger from '../logger.js';

// storage.js uses `import.meta.dirname` which is undefined under jest's
// `--experimental-vm-modules` runner (see active-sessions.js header
// comment for the broader context — same issue, same shape of workaround).
// Loading lazily means tests that pass their own `uploadFn` never trigger
// the storage.js import + path.resolve crash, while production callers
// (no uploadFn arg) get the real S3 upload on first flush.
let _cachedDefaultUploader = null;
async function resolveDefaultUploader() {
  if (_cachedDefaultUploader) return _cachedDefaultUploader;
  const mod = await import('../storage.js');
  _cachedDefaultUploader = mod.uploadBytes;
  return _cachedDefaultUploader;
}

export const MAX_LINES_PER_SESSION = 20_000;
export const FLUSH_INTERVAL_MS = 30_000;
export const FLUSH_BYTES_THRESHOLD = 100 * 1024; // 100 KB

function shortUuid() {
  return crypto.randomBytes(4).toString('hex');
}

function sampleHit(oneInN) {
  if (!Number.isInteger(oneInN) || oneInN <= 1) return true;
  return crypto.randomInt(oneInN) === 0;
}

// Downsampling policy (Phase 1.4): once a session passes
// MAX_LINES_PER_SESSION, keep ALL error/warn lines, sample info 1-in-10,
// sample debug 1-in-100. The whole point of streaming is mid-session
// visibility on stuck sessions — those are precisely the sessions most
// likely to hit the cap, so the cap MUST NOT silently kill telemetry.
// Unknown levels are treated as info-tier (1-in-10) so an iOS field
// rename never silently flips a level into the keep-all bucket.
export function shouldKeepInDownsampling(parsed) {
  const lvl =
    parsed && typeof parsed === 'object' && typeof parsed.level === 'string'
      ? parsed.level.toLowerCase()
      : null;
  if (lvl === 'error' || lvl === 'warn') return true;
  if (lvl === 'debug') return sampleHit(100);
  return sampleHit(10);
}

export function ensureRealtimeLogBuffer(entry) {
  if (!entry) return;
  if (!Array.isArray(entry.realtimeLogBuffer)) entry.realtimeLogBuffer = [];
  if (typeof entry.realtimeLogBufferBytes !== 'number') entry.realtimeLogBufferBytes = 0;
  if (typeof entry.realtimeLogLineCount !== 'number') entry.realtimeLogLineCount = 0;
  if (typeof entry.realtimeLogDownsamplingActive !== 'boolean') {
    entry.realtimeLogDownsamplingActive = false;
  }
  if (typeof entry.realtimeLogLastFlushAt !== 'number') {
    entry.realtimeLogLastFlushAt = Date.now();
  }
}

// Push one already-sanitised JSONL line into the buffer. Bytes accounting
// includes the +1 for the join '\n' so shouldFlush threshold is honest.
export function appendOneToBuffer(entry, sanitisedLine) {
  ensureRealtimeLogBuffer(entry);
  if (typeof sanitisedLine !== 'string' || sanitisedLine.length === 0) return;
  entry.realtimeLogBuffer.push(sanitisedLine);
  entry.realtimeLogBufferBytes += Buffer.byteLength(sanitisedLine, 'utf8') + 1;
  entry.realtimeLogLineCount += 1;
}

// Returns true when the per-session buffer should flush right now. Caller
// is the periodic flusher tick OR the per-batch case arm that wants to
// catch the 100 KB burst case ahead of the next 30 s tick.
export function shouldFlush(entry, { now = Date.now() } = {}) {
  if (!entry || !Array.isArray(entry.realtimeLogBuffer)) return false;
  if (entry.realtimeLogBuffer.length === 0) return false;
  if (entry.realtimeLogBufferBytes >= FLUSH_BYTES_THRESHOLD) return true;
  if (now - (entry.realtimeLogLastFlushAt || 0) >= FLUSH_INTERVAL_MS) return true;
  return false;
}

// Drain the per-session buffer and upload as one JSONL object. Returns
// the S3 key on success, or null when there's nothing to flush. On
// upload failure the batch is restored to the head of the buffer so the
// next tick can retry — putObject is idempotent at the key level (every
// key is unique by ms+uuid) so a retry never overwrites a prior batch.
export async function flushSession(
  sessionId,
  entry,
  { reason = 'periodic', uploadFn = null, now = Date.now() } = {}
) {
  ensureRealtimeLogBuffer(entry);
  if (!sessionId || !entry || entry.realtimeLogBuffer.length === 0) return null;
  const userId = entry.userId;
  if (!userId) return null;

  const batch = entry.realtimeLogBuffer;
  entry.realtimeLogBuffer = [];
  const drainedBytes = entry.realtimeLogBufferBytes;
  entry.realtimeLogBufferBytes = 0;
  entry.realtimeLogLastFlushAt = now;

  const body = batch.join('\n') + '\n';
  const key = `session-logs/${userId}/${sessionId}/realtime/${now}-${shortUuid()}.jsonl`;

  const upload = uploadFn || (await resolveDefaultUploader());
  try {
    const ok = await upload(body, key, 'application/x-ndjson');
    if (ok === false) throw new Error('uploadBytes returned false');
    logger.info('Client log batch flushed', {
      sessionId,
      userId,
      key,
      lines: batch.length,
      bytes: Buffer.byteLength(body, 'utf8'),
      reason,
    });
    return key;
  } catch (e) {
    logger.error('Client log batch flush failed', {
      sessionId,
      userId,
      key,
      reason,
      error: e?.message || String(e),
    });
    // Restore the lost batch so the next tick can retry. Pre-pend so the
    // chronological order is preserved against any entries that arrived
    // during the upload.
    entry.realtimeLogBuffer = batch.concat(entry.realtimeLogBuffer);
    entry.realtimeLogBufferBytes = drainedBytes + entry.realtimeLogBufferBytes;
    return null;
  }
}

// Drain every session in the registry. Used by gracefulShutdown so a
// SIGTERM during ECS deploys doesn't lose the last 30 s of telemetry
// (Phase 1.3 acceptance criterion). Iteration is sequential to avoid
// racing the activeSessions map; flush volumes are small (<100 KB each).
export async function flushAllSessions(
  activeSessions,
  { reason = 'shutdown', uploadFn = null } = {}
) {
  if (!activeSessions || typeof activeSessions.entries !== 'function') return [];
  const keys = [];
  for (const [sessionId, entry] of activeSessions.entries()) {
    if (!entry || !Array.isArray(entry.realtimeLogBuffer)) continue;
    if (entry.realtimeLogBuffer.length === 0) continue;
    const key = await flushSession(sessionId, entry, { reason, uploadFn });
    if (key) keys.push(key);
  }
  return keys;
}

// Long-running ticker that walks activeSessions every intervalMs and
// flushes anything whose age/bytes crossed shouldFlush. Returns the
// interval handle so the server can clear it on shutdown.
export function startPeriodicFlusher(
  activeSessions,
  { intervalMs = FLUSH_INTERVAL_MS, uploadFn = null } = {}
) {
  if (!activeSessions || typeof activeSessions.entries !== 'function') return null;
  const interval = setInterval(async () => {
    try {
      for (const [sessionId, entry] of activeSessions.entries()) {
        if (shouldFlush(entry)) {
          await flushSession(sessionId, entry, { reason: 'periodic', uploadFn });
        }
      }
    } catch (e) {
      logger.error('Periodic realtime-log flush failed', { error: e?.message || String(e) });
    }
  }, intervalMs);
  interval.unref?.();
  return interval;
}
