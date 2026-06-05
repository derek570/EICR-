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
 *   - The flag is SET when the ask is EMITTED (server-side, by the
 *     ask-resolver), NOT when the inspector answers. This is the
 *     load-bearing semantic: if WebSocket drops between the ask
 *     hitting the wire and the answer landing, reconnect must not
 *     re-fire the ask, and the answer path only does copy/no-copy,
 *     it does NOT gate the flag. Reads happen at the start of each
 *     address-related dispatch turn.
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
