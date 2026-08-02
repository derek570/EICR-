/**
 * jobs.address_mirror_asked — one-shot per-job flag for the
 * site↔client address mirror ask.
 *
 * PLAN voice-feedback-2026-06-05 Group H (W1.6). Voice-feedback
 * marker #8 (session 84CE2125 at 10:42:09 BST, 2026-06-05): inspector
 * dictated client address; the system silently mirrored onto site.
 * Derek's locked decision is to replace the silent mirror with a
 * one-shot ask per job — ambiguous slot defaults to SITE, the ask
 * fires the FIRST time an address-family slot fills, and the flag
 * persists across WebSocket reconnects so a drop-then-reconnect
 * never re-fires the ask.
 *
 * Design points:
 *   - Column lives on `jobs` (one row per job-scoped recording
 *     lifetime). Reset is implicit — a brand new `jobs` row defaults
 *     to false. iOS creates a new jobs row per inspection so the
 *     reset boundary aligns with what the inspector experiences as
 *     "a new job".
 *   - `boolean DEFAULT false NOT NULL` so reading the flag at turn
 *     start cannot trip a null-coalescing surprise. Pre-existing
 *     rows backfill to false on migration apply (which is correct —
 *     they predate the feature; ask never fired so flag is false).
 *   - The flag is SET transactionally with a durable pending intent
 *     immediately BEFORE the question is emitted. This claim-before-send,
 *     at-most-once semantic survives reconnect/process restart. A rare send
 *     failure may therefore omit the convenience question rather than risk
 *     asking it twice; the durable row remains the answer authority.
 *
 * Migration 013 in the sequence — runs after 012_voice_feedback.cjs.
 * Auto-applies via the Fargate migration task that runs before the
 * service-update in the deploy workflow (per changelog 2026-05-29
 * entry).
 */

exports.up = (pgm) => {
  pgm.addColumn('jobs', {
    address_mirror_asked: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('jobs', 'address_mirror_asked');
};
