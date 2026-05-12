/**
 * cert_attestations — per-PDF inspector audit trail.
 *
 * Two rows per certificate issuance: one attesting that the inspector
 * has personally reviewed every reading on the cert, one attesting they
 * have personally reviewed every observation. Captures the evidential
 * moment that supports the "the named inspector is the responsible
 * professional" position in Beta Tester Agreement §4.3.1 and DPIA
 * mitigation M1.5.
 *
 * Full spec at .planning/compliance/pdf-issuance-attestations.md.
 *
 * Design points (some intentionally inverted from account_consents):
 *   - ON DELETE RESTRICT on both `user_id` and `job_id`. Attestations
 *     are a regulatory-retention bundle paired with the certificate PDF
 *     itself (Retention Policy R15 — cert lifetime + 7 years). The
 *     SAR / Erasure Playbook §6.3 carve-out moves them under
 *     archive/{userId}/ on account deletion rather than dropping. The
 *     RESTRICT here is the database-level safety net that prevents an
 *     accidental cascade-delete (or naive admin DELETE) from silently
 *     destroying the audit trail.
 *   - NO UNIQUE constraint. Re-issuance of the same cert writes fresh
 *     rows on every render — including unchanged re-prints, per the
 *     spec's §4.1 "every PDF that leaves CertMate carries its own
 *     fresh attestations" principle. A UNIQUE on
 *     (user_id, job_id, attestation_kind) would silently coalesce these
 *     into one row and defeat the per-issuance evidential design.
 *   - Two rows per issuance, not one row with two columns. The
 *     independent-attestation design at the UI level is mirrored in
 *     the data layer so a future schema reader sees the two acts as
 *     two events.
 *   - `attestation_text_version` is the calendar-versioned wording
 *     identifier. Backend serves the wording-by-version map so
 *     historical reads can show the inspector exactly what they
 *     agreed to at the time. Validated server-side against a
 *     KNOWN_TEXT_VERSIONS allow-list to prevent client spoofing of
 *     older / softer wording.
 *   - `pdf_s3_key` is nullable. The attestation is captured BEFORE the
 *     PDF render fires, so the key may not exist at insert time. The
 *     route handler updates the key after a successful render via a
 *     separate UPDATE.
 *
 * Migration 011 in the sequence — runs after 010_account_consents.cjs.
 */

exports.up = (pgm) => {
  pgm.createTable('cert_attestations', {
    id: { type: 'serial', primaryKey: true },
    user_id: {
      type: 'varchar(255)',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'RESTRICT',
    },
    job_id: {
      type: 'varchar(255)',
      notNull: true,
      references: '"jobs"(id)',
      onDelete: 'RESTRICT',
    },
    pdf_s3_key: { type: 'text' },
    attestation_kind: { type: 'text', notNull: true },
    attestation_text_version: { type: 'text', notNull: true },
    attested_at: { type: 'timestamp', notNull: true },
    recorded_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    platform: { type: 'text', notNull: true },
    platform_version: { type: 'text' },
    ip_address: { type: 'inet' },
    user_agent: { type: 'text' },
  });

  // Enforce that attestation_kind is only ever 'readings' or 'observations'.
  // Belt-and-braces over the route-level validation; protects against
  // direct-SQL admin operations and future code paths.
  pgm.addConstraint('cert_attestations', 'cert_attestations_kind_check', {
    check: "attestation_kind IN ('readings', 'observations')",
  });

  pgm.createIndex('cert_attestations', ['user_id', 'job_id'], {
    name: 'idx_cert_attestations_user_job',
  });
  pgm.createIndex('cert_attestations', ['recorded_at'], {
    name: 'idx_cert_attestations_recorded',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('cert_attestations');
};
