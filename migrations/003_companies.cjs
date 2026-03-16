/**
 * Add multi-tenant company layer for multi-user admin support.
 *
 * CertMate needs company-level grouping so that:
 * - A company admin can see ALL jobs across their company
 * - Employees can only see their own jobs
 * - Users are organized under companies (electrical contracting firms)
 *
 * The existing `company_name` TEXT field on users is just a display label.
 * This migration adds proper relational company support:
 * - `companies` table with settings/active state
 * - `company_id` FK on users and jobs for efficient company-level queries
 * - `company_role` on users for intra-company permission levels
 *
 * Approach: additive columns with defaults — no existing data is broken.
 * Existing users/jobs get NULL company_id until assigned to a company.
 */

exports.up = (pgm) => {
  // ── Companies table ──
  pgm.createTable(
    'companies',
    {
      id: { type: 'text', primaryKey: true },
      name: { type: 'text', notNull: true },
      is_active: { type: 'boolean', default: true, notNull: true },
      settings: { type: 'jsonb', default: pgm.func("'{}'::jsonb") },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
      updated_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  // ── Add company_id and company_role to users ──
  pgm.addColumn(
    'users',
    {
      company_id: {
        type: 'text',
        references: 'companies',
        onDelete: 'SET NULL',
      },
      company_role: {
        type: 'text',
        default: "'employee'",
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('users', 'company_id', {
    name: 'idx_users_company',
    ifNotExists: true,
  });

  // ── Add company_id to jobs ──
  // Denormalized from users for efficient company-level queries without JOIN
  pgm.addColumn(
    'jobs',
    {
      company_id: {
        type: 'text',
        references: 'companies',
        onDelete: 'SET NULL',
      },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('jobs', 'company_id', {
    name: 'idx_jobs_company',
    ifNotExists: true,
  });

  // Composite index for company-level job listing (ordered by date)
  // updated_at is timestamp; sufficient for sorting since it's always set
  pgm.createIndex('jobs', ['company_id', 'updated_at'], {
    name: 'idx_jobs_company_date',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('jobs', [], { name: 'idx_jobs_company_date', ifExists: true });
  pgm.dropIndex('jobs', [], { name: 'idx_jobs_company', ifExists: true });
  pgm.dropColumn('jobs', 'company_id', { ifExists: true });

  pgm.dropIndex('users', [], { name: 'idx_users_company', ifExists: true });
  pgm.dropColumn('users', ['company_id', 'company_role'], { ifExists: true });

  pgm.dropTable('companies', { ifExists: true });
};
