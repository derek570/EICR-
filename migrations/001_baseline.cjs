/**
 * Baseline migration capturing all existing schema.
 * Uses IF NOT EXISTS throughout so it is safe to run on existing databases.
 *
 * Replaces the following ensure* functions from db.js:
 * - ensureTokenVersionColumn
 * - ensureJobsUpdatedAt
 * - ensurePushSubscriptionsTable
 * - ensureJobVersionsTable
 * - ensureCRMTables
 * - ensureSubscriptionsTable
 * - ensureCalendarTokensTable
 */

exports.up = (pgm) => {
  // Users table assumed to exist as the foundational table (created during initial setup)

  // Token version column (from ensureTokenVersionColumn)
  pgm.addColumn(
    'users',
    {
      token_version: { type: 'integer', default: 0, notNull: true },
    },
    { ifNotExists: true }
  );

  // CX-27: CHECK constraint — token_version must be non-negative
  pgm.addConstraint('users', 'users_token_version_check', {
    check: 'token_version >= 0',
  });

  // Jobs updated_at column (from ensureJobsUpdatedAt)
  pgm.addColumn(
    'jobs',
    {
      updated_at: { type: 'timestamp', notNull: true, default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  // Push subscriptions table (from ensurePushSubscriptionsTable)
  pgm.createTable(
    'push_subscriptions',
    {
      id: 'id', // serial primary key
      user_id: {
        type: 'varchar(255)',
        notNull: true,
        references: 'users',
        onDelete: 'CASCADE',
      },
      endpoint: { type: 'text', notNull: true },
      p256dh: { type: 'text', notNull: true },
      auth: { type: 'text', notNull: true },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createConstraint('push_subscriptions', 'push_subscriptions_user_endpoint_unique', {
    unique: ['user_id', 'endpoint'],
    ifNotExists: true,
  });

  // Job versions table (from ensureJobVersionsTable)
  pgm.createTable(
    'job_versions',
    {
      id: { type: 'text', primaryKey: true },
      job_id: { type: 'text', notNull: true },
      user_id: { type: 'text', notNull: true },
      version_number: { type: 'integer', notNull: true },
      changes_summary: { type: 'text' },
      data_snapshot: { type: 'jsonb' },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createConstraint('job_versions', 'job_versions_job_version_unique', {
    unique: ['job_id', 'version_number'],
    ifNotExists: true,
  });

  // CX-27: CHECK constraint — version_number must be positive
  pgm.addConstraint('job_versions', 'job_versions_version_number_check', {
    check: 'version_number > 0',
  });

  pgm.createIndex('job_versions', 'job_id', {
    name: 'idx_job_versions_job',
    ifNotExists: true,
  });

  // CRM tables (from ensureCRMTables)
  pgm.createTable(
    'clients',
    {
      id: { type: 'text', primaryKey: true },
      user_id: { type: 'text', notNull: true },
      name: { type: 'text', notNull: true },
      email: { type: 'text' },
      phone: { type: 'text' },
      company: { type: 'text' },
      notes: { type: 'text' },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('clients', 'user_id', {
    name: 'idx_clients_user',
    ifNotExists: true,
  });

  // CX-29: UNIQUE on (id, user_id) to support composite FK from properties
  pgm.createConstraint('clients', 'clients_id_user_unique', {
    unique: ['id', 'user_id'],
    ifNotExists: true,
  });

  pgm.createTable(
    'properties',
    {
      id: { type: 'text', primaryKey: true },
      client_id: { type: 'text' },
      user_id: { type: 'text', notNull: true },
      address: { type: 'text', notNull: true },
      postcode: { type: 'text' },
      property_type: { type: 'text' },
      notes: { type: 'text' },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('properties', 'user_id', {
    name: 'idx_properties_user',
    ifNotExists: true,
  });

  pgm.createIndex('properties', 'client_id', {
    name: 'idx_properties_client',
    ifNotExists: true,
  });

  // CX-28: UNIQUE on (user_id, address) to prevent duplicate properties per user
  pgm.createConstraint('properties', 'properties_user_address_unique', {
    unique: ['user_id', 'address'],
    ifNotExists: true,
  });

  // CX-29: Composite FK — ensures properties can only link to clients owned by same user
  pgm.addConstraint('properties', 'properties_client_user_fk', {
    foreignKeys: {
      columns: ['client_id', 'user_id'],
      references: 'clients(id, user_id)',
      match: 'SIMPLE',
    },
  });

  // Subscriptions table (from ensureSubscriptionsTable)
  // Note: matches actual db.js schema -- user_id is TEXT NOT NULL UNIQUE (no FK to users),
  // status defaults to 'inactive', includes stripe_price_id column
  pgm.createTable(
    'subscriptions',
    {
      id: 'id', // serial primary key
      user_id: { type: 'text', notNull: true, unique: true },
      stripe_customer_id: { type: 'text' },
      stripe_subscription_id: { type: 'text' },
      stripe_price_id: { type: 'text' },
      plan: { type: 'text', default: 'free' },
      status: { type: 'text', default: 'inactive' },
      current_period_start: { type: 'timestamp' },
      current_period_end: { type: 'timestamp' },
      cancel_at_period_end: { type: 'boolean', default: false },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('subscriptions', 'user_id', {
    name: 'idx_subscriptions_user',
    ifNotExists: true,
  });

  pgm.createIndex('subscriptions', 'stripe_customer_id', {
    name: 'idx_subscriptions_stripe_customer',
    ifNotExists: true,
  });

  // Calendar tokens table (from ensureCalendarTokensTable)
  // Note: matches actual db.js schema -- access_token/refresh_token/expiry_date are nullable,
  // includes token_type and scope columns, user_id has no FK to users
  pgm.createTable(
    'calendar_tokens',
    {
      id: 'id', // serial primary key
      user_id: { type: 'text', notNull: true, unique: true },
      access_token: { type: 'text' },
      refresh_token: { type: 'text' },
      expiry_date: { type: 'bigint' },
      token_type: { type: 'text' },
      scope: { type: 'text' },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('calendar_tokens', 'user_id', {
    name: 'idx_calendar_tokens_user',
    ifNotExists: true,
  });
};

// Baseline migration -- no rollback
exports.down = false;
