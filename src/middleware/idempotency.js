/**
 * Idempotency middleware for cost-sensitive routes.
 *
 * Why this exists:
 *   `/api/analyze-ccu` runs a Sonnet + GPT Vision pipeline that costs ~$0.07
 *   per call. iOS retries (URL session timeout, NWPathMonitor flap, queue
 *   replay on network restore) used to fire the full pipeline 3-6× per
 *   single user-initiated capture — see logs 2026-04-29 17:11-17:13 UTC,
 *   five extractions of the same image in two minutes. This middleware
 *   short-circuits duplicates so one capture = one paid extraction,
 *   regardless of how the client retries.
 *
 * Protocol:
 *   Client sends `X-Idempotency-Key: <uuid>` (one UUID per capture, reused
 *   across all retries of that capture). Server responds:
 *     - 200 + cached body, with `X-Idempotency-Replay: 1` — duplicate of a
 *       completed call within the result TTL window
 *     - 409 + `Retry-After: 5` — original request is still in flight; the
 *       client should wait and retry rather than fire a parallel call
 *     - normal handler response — first call wins, result is cached for
 *       future duplicates
 *
 * Backwards-compat:
 *   If the header is missing (older iOS builds), the middleware is a
 *   no-op and the handler runs unprotected. Same if Redis is unavailable —
 *   we log a warning and fall through rather than failing the request.
 *
 * Storage:
 *   Single Redis key per (prefix, userId, idempotencyKey). Value is a JSON
 *   envelope with phase=`inflight` (TTL 120s, longer than the slowest CCU
 *   pipeline observed in prod) or phase=`done` (TTL 600s — covers any
 *   reasonable client retry window without keeping stale results forever).
 *   On non-2xx response we DEL the key so the next retry can re-attempt
 *   the original work.
 */

import { getConnection, isRedisAvailable } from '../queue.js';
import logger from '../logger.js';

const INFLIGHT_TTL_SECONDS = 120;
const RESULT_TTL_SECONDS = 600;

/**
 * @param {string} prefix Namespace for the Redis key (e.g. "ccu"). Lets us
 *   safely apply the same middleware to multiple routes without collisions.
 */
export function withIdempotency(prefix) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get('X-Idempotency-Key');
    if (!key || typeof key !== 'string' || key.length < 8 || key.length > 128) {
      // Missing or malformed key — pass through unprotected. We accept
      // anything 8-128 chars to allow UUIDs (36) and other reasonable IDs
      // without enforcing a specific format.
      return next();
    }

    if (!isRedisAvailable()) {
      logger.warn('Idempotency middleware: Redis unavailable — skipping', { prefix });
      return next();
    }

    const userId = req.user?.id || 'anon';
    const redisKey = `idem:${prefix}:${userId}:${key}`;
    const conn = getConnection();

    let wonRace;
    try {
      const marker = JSON.stringify({ phase: 'inflight', at: Date.now() });
      // Atomic SET NX EX: returns "OK" if we created the key, null if it
      // already exists. Either we win the race and own this key for the
      // TTL window, or someone else already started.
      wonRace = await conn.set(redisKey, marker, 'NX', 'EX', INFLIGHT_TTL_SECONDS);
    } catch (err) {
      logger.warn('Idempotency middleware: Redis SET failed — skipping', {
        prefix,
        error: err.message,
      });
      return next();
    }

    if (wonRace !== 'OK') {
      // Lost the race — read the existing entry to decide what to return.
      let existing;
      try {
        existing = await conn.get(redisKey);
      } catch (err) {
        logger.warn('Idempotency middleware: Redis GET failed — skipping', {
          prefix,
          error: err.message,
        });
        return next();
      }

      if (!existing) {
        // Race expired between SET NX and GET (unlikely but possible).
        // Fall through and run the handler unprotected for this attempt.
        return next();
      }

      let state;
      try {
        state = JSON.parse(existing);
      } catch (err) {
        // Corrupt cache entry — drop it and run the handler.
        await conn.del(redisKey).catch(() => {});
        logger.warn('Idempotency middleware: corrupt cache entry, dropped', {
          prefix,
          error: err.message,
        });
        return next();
      }

      if (state.phase === 'done') {
        logger.info('idempotency_hit', {
          prefix,
          userId,
          key,
          ageMs: Date.now() - (state.cachedAt || 0),
          statusCode: state.statusCode,
        });
        res.set('X-Idempotency-Replay', '1');
        return res.status(state.statusCode || 200).json(state.body);
      }

      if (state.phase === 'inflight') {
        logger.info('idempotency_inflight', {
          prefix,
          userId,
          key,
          inflightAgeMs: Date.now() - (state.at || 0),
        });
        res.set('Retry-After', '5');
        res.set('X-Idempotency-Status', 'inflight');
        return res.status(409).json({
          error: 'idempotency_inflight',
          message: 'Original request is still being processed',
          retryable: true,
        });
      }

      // Unknown phase — drop and pass through.
      await conn.del(redisKey).catch(() => {});
      return next();
    }

    // We won the race — patch res.json to cache the response on success
    // and clear the marker on failure. Patching res.json (rather than
    // res.send/res.end) is sufficient because every response path in
    // /api/analyze-ccu uses res.json.
    const originalJson = res.json.bind(res);
    let alreadyHandled = false;

    res.json = function patchedJson(body) {
      if (alreadyHandled) {
        return originalJson(body);
      }
      alreadyHandled = true;

      const code = res.statusCode || 200;
      if (code >= 200 && code < 300) {
        const cached = JSON.stringify({
          phase: 'done',
          statusCode: code,
          body,
          cachedAt: Date.now(),
        });
        // Fire-and-forget: a cache write failure must not block the
        // response. Worst case is a duplicate retry pays again — bad, but
        // not as bad as making the user wait on Redis.
        conn.set(redisKey, cached, 'EX', RESULT_TTL_SECONDS).catch((err) => {
          logger.warn('Idempotency cache write failed (non-fatal)', {
            prefix,
            userId,
            error: err.message,
          });
        });
        logger.info('idempotency_miss_cached', {
          prefix,
          userId,
          key,
          statusCode: code,
        });
      } else {
        // Non-2xx — clear the marker so the next retry can re-run the
        // pipeline. Without this, a transient handler failure would
        // poison the key for INFLIGHT_TTL_SECONDS and reject all retries.
        conn.del(redisKey).catch((err) => {
          logger.warn('Idempotency marker clear failed (non-fatal)', {
            prefix,
            userId,
            error: err.message,
          });
        });
        logger.info('idempotency_miss_error', {
          prefix,
          userId,
          key,
          statusCode: code,
        });
      }

      return originalJson(body);
    };

    // Defensive: if the response closes without going through res.json
    // (e.g. handler crashed before sending anything, or used res.end()),
    // clear the marker so retries aren't stuck waiting INFLIGHT_TTL_SECONDS.
    res.on('close', () => {
      if (alreadyHandled) return;
      conn.del(redisKey).catch(() => {});
    });

    return next();
  };
}
