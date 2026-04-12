/**
 * Add security-related columns to users table and create audit_log table.
 *
 * The application's auth and db modules reference these columns/tables:
 * - users.last_login          (updateLastLogin)
 * - users.failed_login_attempts (updateLoginAttempts, isAccountLocked)
 * - users.locked_until        (updateLoginAttempts, isAccountLocked)
 * - audit_log                 (logAction)
 *
 * Uses IF NOT EXISTS throughout so it is safe to run on existing databases.
 */

exports.up = (pgm) => {
  // Add security columns to users table
  pgm.addColumn(
    'users',
    {
      last_login: { type: 'timestamp' },
    },
    { ifNotExists: true }
  );

  pgm.addColumn(
    'users',
    {
      failed_login_attempts: { type: 'integer', default: 0 },
    },
    { ifNotExists: true }
  );

  pgm.addColumn(
    'users',
    {
      locked_until: { type: 'timestamp' },
    },
    { ifNotExists: true }
  );

  // Audit log table (used by logAction in db.js)
  pgm.createTable(
    'audit_log',
    {
      id: { type: 'text', primaryKey: true },
      user_id: { type: 'text', notNull: true },
      action: { type: 'text', notNull: true },
      details: { type: 'text' },
      ip_address: { type: 'text' },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  pgm.createIndex('audit_log', 'user_id', {
    name: 'idx_audit_log_user',
    ifNotExists: true,
  });

  pgm.createIndex('audit_log', 'created_at', {
    name: 'idx_audit_log_created_at',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropTable('audit_log', { ifExists: true });
  pgm.dropColumn('users', 'locked_until', { ifExists: true });
  pgm.dropColumn('users', 'failed_login_attempts', { ifExists: true });
  pgm.dropColumn('users', 'last_login', { ifExists: true });
};
