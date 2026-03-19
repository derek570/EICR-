/**
 * Add performance indexes for job listing queries.
 *
 * The main list endpoint queries `WHERE user_id = $1 ORDER BY updated_at DESC`
 * but had no index on user_id — causing sequential scans on every request.
 *
 * Adds:
 * - idx_jobs_user_id: speeds up the WHERE user_id = $1 filter
 * - idx_jobs_user_updated: composite index for the ORDER BY + LIMIT pattern
 */

exports.up = (pgm) => {
  pgm.createIndex('jobs', 'user_id', {
    name: 'idx_jobs_user_id',
    ifNotExists: true,
  });

  pgm.createIndex('jobs', ['user_id', { name: 'updated_at', sort: 'DESC' }], {
    name: 'idx_jobs_user_updated',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('jobs', [], { name: 'idx_jobs_user_updated', ifExists: true });
  pgm.dropIndex('jobs', [], { name: 'idx_jobs_user_id', ifExists: true });
};
