/**
 * Auto-grow side of the RCD-type lookup.
 *
 * Whenever a CCU extraction sees a `(manufacturer, model)` pair that the
 * lookup table doesn't have a `model`-level entry for, we record a
 * "pending review" entry to S3 under `rcd-lookup-pending/`. Each entry
 * accumulates sightings across multiple extractions so a flaky single
 * read doesn't get promoted; the `scripts/promote-rcd-lookup.js` CLI
 * inspects the aggregated votes and lets the operator decide whether to
 * promote a pending entry into `config/rcd-type-lookup.json`.
 *
 * S3 key shape:
 *   rcd-lookup-pending/<manufacturer-slug>/<model-slug>.json
 *
 * Per-file payload shape:
 *   {
 *     schema_version: 1,
 *     manufacturer:  string|null,    // raw, as the classifier returned it
 *     model:         string|null,    // raw, as the classifier returned it
 *     outcome:       'default'|'miss',
 *     first_seen:    ISO timestamp,
 *     last_seen:     ISO timestamp,
 *     sighting_count: integer,
 *     sightings: [                   // last 10
 *       {
 *         extractionId, userId, timestamp,
 *         inferredType, inferredWays,
 *         classifierConfidence, perSlotAvgConfidence,
 *         inferenceSource: 'classifier_only' | 'per_slot_uniform'
 *                        | 'per_slot_majority' | 'web_search'
 *                        | 'inspector_correction',
 *         imageS3Key, notes
 *       }
 *     ],
 *     aggregate: {
 *       type_votes: { 'A': N, 'AC': M, ... },
 *       ways_votes: { 15: N, 16: M, ... }
 *     }
 *   }
 *
 * Skipped silently when `S3_BUCKET` is unset (dev / sandbox).
 */

import logger from '../logger.js';

const PENDING_PREFIX = 'rcd-lookup-pending';
const SIGHTING_HISTORY_CAP = 10;

function manufacturerSlug(name) {
  if (typeof name !== 'string' || name.trim().length === 0) return '_unknown';
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || '_unknown';
}

function modelSlug(model) {
  if (typeof model !== 'string' || model.trim().length === 0) return '_no_model';
  const slug = model
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || '_no_model';
}

/**
 * Compute the S3 key for a pending entry. Exposed for tests + promote CLI.
 */
export function pendingKey(manufacturer, model) {
  return `${PENDING_PREFIX}/${manufacturerSlug(manufacturer)}/${modelSlug(model)}.json`;
}

/**
 * Tally types and ways from sighting history.
 */
function aggregateSightings(sightings) {
  const type_votes = {};
  const ways_votes = {};
  for (const s of sightings) {
    if (s?.inferredType) {
      type_votes[s.inferredType] = (type_votes[s.inferredType] ?? 0) + 1;
    }
    if (Number.isFinite(s?.inferredWays) && s.inferredWays > 0) {
      ways_votes[s.inferredWays] = (ways_votes[s.inferredWays] ?? 0) + 1;
    }
  }
  return { type_votes, ways_votes };
}

/**
 * Record a pending-review entry. Upsert: existing entries are read,
 * appended to (last 10 sightings retained), and re-uploaded.
 *
 * Returns true if the write attempt succeeded (or was deliberately
 * skipped because the entry was already a `model`-level hit; nothing
 * to record). Returns false on S3 errors — non-fatal; caller should
 * not block on this.
 */
export async function writeRcdPendingEntry({
  manufacturer,
  model,
  outcome,
  inferredType,
  inferredWays,
  classifierConfidence,
  perSlotAvgConfidence,
  inferenceSource,
  imageS3Key,
  extractionId,
  userId,
  notes,
}) {
  if (!process.env.S3_BUCKET) {
    return false;
  }
  if (outcome !== 'default' && outcome !== 'miss') {
    // Hits don't need pending entries.
    return false;
  }

  // Lazy-import storage so unit tests that don't exercise this path don't
  // pull in @aws-sdk/client-s3.
  const { uploadBytes, downloadBytes } = await import('../storage.js');

  const key = pendingKey(manufacturer, model);
  let existing = null;
  try {
    const buf = await downloadBytes(key);
    if (buf) {
      const parsed = JSON.parse(buf.toString('utf8'));
      if (parsed && typeof parsed === 'object') existing = parsed;
    }
  } catch (_err) {
    // Treat any read failure as "first sighting". A real S3 outage will
    // also fail the upload below and we'll log there.
  }

  const now = new Date().toISOString();
  const sighting = {
    extractionId: extractionId ?? null,
    userId: userId ?? null,
    timestamp: now,
    inferredType: inferredType ?? null,
    inferredWays: Number.isFinite(inferredWays) && inferredWays > 0 ? inferredWays : null,
    classifierConfidence: typeof classifierConfidence === 'number' ? classifierConfidence : null,
    perSlotAvgConfidence: typeof perSlotAvgConfidence === 'number' ? perSlotAvgConfidence : null,
    inferenceSource: inferenceSource ?? null,
    imageS3Key: imageS3Key ?? null,
    notes: typeof notes === 'string' ? notes : null,
  };

  const payload = existing ?? {
    schema_version: 1,
    manufacturer: manufacturer ?? null,
    model: model ?? null,
    outcome,
    first_seen: now,
    last_seen: now,
    sighting_count: 0,
    sightings: [],
    aggregate: { type_votes: {}, ways_votes: {} },
  };
  // Refresh whichever fields can change between sightings.
  payload.last_seen = now;
  payload.outcome = outcome;
  payload.sighting_count = (payload.sighting_count ?? 0) + 1;
  const history = Array.isArray(payload.sightings) ? payload.sightings : [];
  history.push(sighting);
  payload.sightings = history.slice(-SIGHTING_HISTORY_CAP);
  payload.aggregate = aggregateSightings(payload.sightings);

  try {
    await uploadBytes(JSON.stringify(payload, null, 2), key, 'application/json');
    logger.info('RCD pending entry recorded', {
      manufacturer,
      model,
      outcome,
      sightingCount: payload.sighting_count,
      typeVotes: payload.aggregate.type_votes,
      waysVotes: payload.aggregate.ways_votes,
      s3Key: key,
    });
    return true;
  } catch (err) {
    logger.warn('RCD pending entry write failed (non-fatal)', {
      manufacturer,
      model,
      s3Key: key,
      error: err?.message,
    });
    return false;
  }
}
