/**
 * source-freshness.mjs — machine-checked per-source freshness, recomputed
 * FROM SOURCE BYTES at acceptance (plan Item 1 "Fidelity contract").
 *
 * Why recompute: the reference session's S3 `debug_log.jsonl` was one upload
 * BEHIND (a stale May-9 payload) — a manually edited `freshness: fresh` flag
 * must never be trusted; this module is the machine check that stale-upload
 * failure class demands. Missing identity or mismatched time/session FAILS
 * CLOSED; a human override is a separately attested exception with reason +
 * reviewer (recorded in the private manifest, verified by acceptance).
 *
 * Debug-report linkage is a defined ALGORITHM, not a required field:
 * `dr_*.json` reports contain NO session-ID field and the
 * `debug_report_uploaded` event has NO source field. Linkage: match the
 * event by session, bounded timestamp, and the client's documented
 * 100-CHARACTER ISSUE-PREFIX transformation (the event stores only the
 * first 100 chars of the description — an exact full-description match
 * yields ZERO matches on the real artifacts). Exactly ONE match binds the
 * session id; zero or multiple matches FAIL.
 */

export const FRESHNESS_STATUS = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  UNLINKED: 'unlinked',
  MISSING_IDENTITY: 'missing_identity',
});

/** The client's documented transformation: the uploaded event stores only
 *  the first 100 characters of the report description. */
export const ISSUE_PREFIX_CHARS = 100;

/** Bounded timestamp window for report↔event linkage (report creation and
 *  its upload event are seconds apart; a day-scale bound would cross
 *  sessions). */
export const REPORT_LINK_TOLERANCE_MS = 10 * 60 * 1000;

/** Slack applied to capture-window overlap checks (uploads lag captures). */
const WINDOW_SLACK_MS = 30 * 60 * 1000;

function eventTimeBounds(events) {
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    if (typeof e.timestamp_ms === 'number') {
      if (e.timestamp_ms < min) min = e.timestamp_ms;
      if (e.timestamp_ms > max) max = e.timestamp_ms;
    }
  }
  return min === Infinity ? null : { min, max };
}

/**
 * Freshness for a PARSED session source (cloudwatch / ios): the source's own
 * events must carry the expected session identity and its capture window
 * must overlap the primary window. Recomputed from the normalized events —
 * never from a declared flag.
 */
export function computeSessionSourceFreshness({ events, expectedSessionId, primaryWindow }) {
  const own = events.filter((e) => e.session_id != null);
  const idHit = expectedSessionId == null ? own.length > 0 : own.some((e) => String(e.session_id) === String(expectedSessionId));
  if (expectedSessionId != null && !idHit) {
    return {
      status: FRESHNESS_STATUS.MISSING_IDENTITY,
      reason: 'expected session identity absent from source events',
    };
  }
  if (primaryWindow) {
    const bounds = eventTimeBounds(events);
    if (!bounds) {
      return { status: FRESHNESS_STATUS.STALE, reason: 'source carries no timestamps' };
    }
    const overlaps =
      bounds.max >= primaryWindow.min - WINDOW_SLACK_MS &&
      bounds.min <= primaryWindow.max + WINDOW_SLACK_MS;
    if (!overlaps) {
      return {
        status: FRESHNESS_STATUS.STALE,
        reason: `source capture window [${new Date(bounds.min).toISOString()}, ${new Date(bounds.max).toISOString()}] does not overlap the primary window (stale upload)`,
      };
    }
  }
  return { status: FRESHNESS_STATUS.FRESH, reason: null };
}

/** Predicate for the upload event in the normalized stream. */
function isReportUploadEvent(e) {
  return (
    (e.kind === 'client_event' || e.kind === 'backend') &&
    (e.event === 'debug_report_uploaded' ||
      e.category === 'debug_report_uploaded' ||
      e.data?.event === 'debug_report_uploaded' ||
      e.message === 'debug_report_uploaded')
  );
}

function uploadEventDescription(e) {
  return (
    e.data?.description ??
    e.data?.issue ??
    e.data?.data?.description ??
    e.raw?.description ??
    null
  );
}

/**
 * The report→primary linkage algorithm. `report` is the normalized
 * debug_report event; `events` is the full normalized primary stream.
 * Returns { ok: true, sessionId, event } on EXACTLY one match; otherwise
 * { ok: false, reason: 'zero_matches' | 'ambiguous_matches', matches }.
 */
export function linkDebugReport(report, events, { toleranceMs = REPORT_LINK_TOLERANCE_MS } = {}) {
  const description = report.description;
  if (typeof description !== 'string' || description.length === 0) {
    return { ok: false, reason: 'report_missing_description', matches: 0 };
  }
  const prefix = description.slice(0, ISSUE_PREFIX_CHARS);
  const candidates = events.filter((e) => {
    if (!isReportUploadEvent(e)) return false;
    const evDesc = uploadEventDescription(e);
    if (typeof evDesc !== 'string') return false;
    // The event stores only the first 100 chars — compare prefixes, both
    // truncated to the documented boundary.
    if (evDesc.slice(0, ISSUE_PREFIX_CHARS) !== prefix) return false;
    if (
      typeof report.timestamp_ms === 'number' &&
      typeof e.timestamp_ms === 'number' &&
      Math.abs(e.timestamp_ms - report.timestamp_ms) > toleranceMs
    ) {
      return false;
    }
    return true;
  });
  if (candidates.length === 1) {
    return { ok: true, sessionId: candidates[0].session_id ?? null, event: candidates[0], matches: 1 };
  }
  return {
    ok: false,
    reason: candidates.length === 0 ? 'zero_matches' : 'ambiguous_matches',
    matches: candidates.length,
  };
}

/**
 * Full per-source verdict used by the converter/acceptance. `verdicts` are
 * recorded in the private manifest; ANY non-fresh verdict fails conversion/
 * acceptance closed (a human override is a separately attested exception).
 */
export function computeSourceVerdict({ source, events, expectedSessionId, primaryWindow, primaryEvents }) {
  if (source.type === 'debug_report') {
    const report = events.find((e) => e.kind === 'debug_report');
    if (!report) {
      return { status: FRESHNESS_STATUS.MISSING_IDENTITY, reason: 'unparseable debug report' };
    }
    const link = linkDebugReport(report, primaryEvents ?? []);
    if (!link.ok) {
      return { status: FRESHNESS_STATUS.UNLINKED, reason: `report linkage failed: ${link.reason} (${link.matches} matches)` };
    }
    if (
      expectedSessionId != null &&
      link.sessionId != null &&
      String(link.sessionId) !== String(expectedSessionId)
    ) {
      return { status: FRESHNESS_STATUS.STALE, reason: 'linked upload event belongs to a different session' };
    }
    return { status: FRESHNESS_STATUS.FRESH, reason: null, boundSessionId: link.sessionId };
  }
  return computeSessionSourceFreshness({ events, expectedSessionId, primaryWindow });
}
