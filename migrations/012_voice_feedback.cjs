/**
 * voice_feedback — inspector "feedback" / "end feedback" voice markers.
 *
 * Phase 1.6.3 of PLAN-backend-final.md (sessions DC321DBC + 60754E4D
 * field-test fixes, 2026-06-04). Inspectors voice frustrations during
 * a recording session using a sentence-anchored "feedback ... end
 * feedback" pattern; the iOS multipart `/api/debug-report` upload
 * lands in S3 today but there's no UI surface for the inspector or
 * admin to browse them. This table indexes those uploads so the
 * voice-feedback router (Phase 1.6.4) can list / filter / paginate
 * efficiently.
 *
 * Design points:
 *   - `user_id` is TEXT (not UUID). The existing `users.id` shape is
 *     `"user_..."` per src/db.js — a UUID column would reject every
 *     INSERT with `invalid input syntax for type uuid`.
 *   - `issue_text` stays a plain TEXT column (the voiced complaint).
 *     `transcript_window` is a SEPARATE optional JSONB carrying the
 *     rolling pre-trigger buffer iOS uploads alongside (iOS slice
 *     §1.6.1). Collapsing the two into one structured column would
 *     prevent fast full-text search on the complaint text alone, and
 *     the access patterns differ (issue_text is rendered prominently
 *     on the list view; transcript_window only loads on the detail
 *     view).
 *   - `s3_key` is the existing S3 prefix for the debug_report.json /
 *     context.json pair the multipart route already writes — the
 *     table stores the index, the bucket holds the bytes.
 *   - `status` is a CHECK constraint enumerated
 *     ('open','reviewed','actioned','wontfix') so the v1 review
 *     workflow can't drift via free-form values.
 *   - Two indexes: `(user_id, created_at DESC)` for the per-user
 *     newest-first list (most common query), and a partial index on
 *     `job_id WHERE NOT NULL` for the "show this job's voice
 *     feedback" detail page (many rows have null job_id when the
 *     inspector triggered the marker outside a job context).
 *
 * Migration 012 in the sequence — runs after 011_cert_attestations.cjs.
 * Auto-applies via the Fargate migration task that runs before the
 * service-update in the deploy workflow (per changelog 2026-05-29 entry).
 */

exports.up = (pgm) => {
  pgm.createTable('voice_feedback', {
    id: { type: 'serial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    session_id: { type: 'text', notNull: true },
    job_id: { type: 'text' },
    address: { type: 'text' },
    issue_text: { type: 'text', notNull: true },
    transcript_window: { type: 'jsonb' },
    review_note: { type: 'text' },
    s3_key: { type: 'text', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    reviewed_at: { type: 'timestamptz' },
    status: {
      type: 'text',
      notNull: true,
      default: 'open',
    },
  });

  pgm.addConstraint('voice_feedback', 'voice_feedback_status_check', {
    check: "status IN ('open','reviewed','actioned','wontfix')",
  });

  pgm.createIndex('voice_feedback', ['user_id', { name: 'created_at', sort: 'DESC' }], {
    name: 'idx_voice_feedback_user_created',
  });

  pgm.createIndex('voice_feedback', ['job_id'], {
    name: 'idx_voice_feedback_job',
    where: 'job_id IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('voice_feedback');
};
