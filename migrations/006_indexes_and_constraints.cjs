/**
 * D8, D9, D12, D23: Add missing indexes, FK constraints, and unique constraint.
 *
 * Indexes (D8):
 *   - jobs(company_id), jobs(status), users(email), users(company_id)
 *   (jobs(user_id) already exists in 004_jobs_indexes.cjs)
 *
 * Composite indexes (D23):
 *   - properties(user_id, address)
 *   - jobs(user_id, status)
 *   - job_versions(job_id, user_id)
 *
 * FK constraints (D9):
 *   - subscriptions.user_id -> users(id) ON DELETE CASCADE
 *   - calendar_tokens.user_id -> users(id) ON DELETE CASCADE
 *
 * Unique index (D12):
 *   - subscriptions(stripe_subscription_id)
 */

exports.up = (pgm) => {
  // D8: Single-column indexes
  pgm.createIndex('jobs', 'company_id', {
    name: 'idx_jobs_company_id',
    ifNotExists: true,
  });

  pgm.createIndex('jobs', 'status', {
    name: 'idx_jobs_status',
    ifNotExists: true,
  });

  pgm.createIndex('users', 'email', {
    name: 'idx_users_email',
    ifNotExists: true,
  });

  pgm.createIndex('users', 'company_id', {
    name: 'idx_users_company_id',
    ifNotExists: true,
  });

  // D23: Composite indexes
  pgm.createIndex('properties', ['user_id', 'address'], {
    name: 'idx_properties_user_address',
    ifNotExists: true,
  });

  pgm.createIndex('jobs', ['user_id', 'status'], {
    name: 'idx_jobs_user_status',
    ifNotExists: true,
  });

  pgm.createIndex('job_versions', ['job_id', 'user_id'], {
    name: 'idx_job_versions_job_user',
    ifNotExists: true,
  });

  // D9: FK constraints
  pgm.addConstraint('subscriptions', 'fk_subscriptions_user_id', {
    foreignKeys: {
      columns: 'user_id',
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    ifNotExists: true,
  });

  pgm.addConstraint('calendar_tokens', 'fk_calendar_tokens_user_id', {
    foreignKeys: {
      columns: 'user_id',
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    ifNotExists: true,
  });

  // D12: Unique index on stripe_subscription_id (allows NULLs — only non-null values must be unique)
  pgm.createIndex('subscriptions', 'stripe_subscription_id', {
    name: 'idx_subscriptions_stripe_sub_id_unique',
    unique: true,
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('subscriptions', [], { name: 'idx_subscriptions_stripe_sub_id_unique', ifExists: true });
  pgm.dropConstraint('calendar_tokens', 'fk_calendar_tokens_user_id', { ifExists: true });
  pgm.dropConstraint('subscriptions', 'fk_subscriptions_user_id', { ifExists: true });
  pgm.dropIndex('job_versions', [], { name: 'idx_job_versions_job_user', ifExists: true });
  pgm.dropIndex('jobs', [], { name: 'idx_jobs_user_status', ifExists: true });
  pgm.dropIndex('properties', [], { name: 'idx_properties_user_address', ifExists: true });
  pgm.dropIndex('users', [], { name: 'idx_users_company_id', ifExists: true });
  pgm.dropIndex('users', [], { name: 'idx_users_email', ifExists: true });
  pgm.dropIndex('jobs', [], { name: 'idx_jobs_status', ifExists: true });
  pgm.dropIndex('jobs', [], { name: 'idx_jobs_company_id', ifExists: true });
};
