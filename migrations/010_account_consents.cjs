/**
 * account_consents — UK GDPR Art. 28(3) clickwrap evidence layer.
 *
 * Records every inspector's acceptance of the Beta Tester Agreement
 * (the processor agreement that makes the dormant controller/processor
 * relationship active). Without this evidence we cannot lawfully
 * process customer-homeowner data on the inspector's behalf.
 *
 * Schema mirrors the spec in
 *   .planning/compliance/in-app-consent-screen.md §Implementation.
 *
 * Design points worth pinning here:
 *   - ON DELETE CASCADE from `users.id` — when an inspector account is
 *     hard-deleted (the Task 18 / Apple 5.1.1(v) flow), the clickwrap
 *     evidence for that inspector is no longer probative and is removed
 *     along with the rest of their personal data. Contrast with
 *     `cert_attestations` (migration 011) which uses ON DELETE RESTRICT
 *     because attestations are a *cert*-level audit trail that has to
 *     survive account deletion as a controller legal-obligation
 *     retention. The two tables look superficially similar but have
 *     opposite deletion semantics on purpose.
 *   - UNIQUE on `(user_id, agreement_kind, agreement_version)` — a user
 *     can only accept a given version of a given agreement once. A new
 *     version of the BTA creates a new accepted row, not a replacement.
 *   - `ip_address` and `user_agent` are captured server-side from the
 *     request (the client cannot lie about them) — these are the
 *     evidential anchors that support "the acceptance came from a
 *     real session by this user", which is what the ICO would ask for.
 *   - `accepted_at` is the client-submitted ISO8601 timestamp; the
 *     server also stamps `recorded_at` (DEFAULT CURRENT_TIMESTAMP) so a
 *     clock-skewed client can't shift the evidential moment.
 *
 * Migration ordering: this is migration 010, sequenced after
 * 009_users_is_active_boolean.cjs. The cert_attestations migration
 * (011) follows immediately. They are intentionally separate so a
 * future hotfix to one table doesn't risk reversing the other.
 */

exports.up = (pgm) => {
  pgm.createTable('account_consents', {
    id: { type: 'serial', primaryKey: true },
    user_id: {
      type: 'varchar(255)',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'CASCADE',
    },
    agreement_kind: { type: 'text', notNull: true },
    agreement_version: { type: 'text', notNull: true },
    accepted_at: { type: 'timestamp', notNull: true },
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

  pgm.addConstraint('account_consents', 'account_consents_user_kind_version_unique', {
    unique: ['user_id', 'agreement_kind', 'agreement_version'],
  });

  pgm.createIndex('account_consents', ['user_id', 'agreement_kind'], {
    name: 'idx_account_consents_user_kind',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('account_consents');
};
