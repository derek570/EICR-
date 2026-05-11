/**
 * Convert users.is_active from INTEGER to BOOLEAN.
 *
 * The users table predates the migration framework (see migration 001
 * comment: "Users table assumed to exist as the foundational table") and
 * was inherited from the CertMate SQLite era with `is_active INTEGER`. The
 * sibling companies.is_active column (added later in 003_companies.cjs) was
 * created as proper BOOLEAN, so this is a single-column drift on `users`.
 *
 * The drift surfaced 2026-05-11 when `POST /api/admin/users` started
 * 500-ing in production with:
 *   column "is_active" is of type integer but expression is of type boolean
 *
 * The backend had been masking it on the read side by casting on every
 * SELECT (`u.is_active::boolean as is_active`, three call sites), but the
 * INSERT in createUser writes a literal `true` straight into the integer
 * column. Four broken write paths in total:
 *   - POST /api/admin/users           (admin create user)
 *   - POST /api/companies/:id/invite  (createUser → same INSERT)
 *   - PUT  /api/admin/users/:userId   (is_active toggle from admin)
 *   - DELETE /api/auth/account        (self-delete soft-deactivate)
 *
 * Three of them were silent — nobody exercised those paths since the
 * wire shape settled — but every TestFlight invite-employee flow and the
 * new Task 18 account-deletion flow are blocked too.
 *
 * Migration uses `is_active <> 0` for the USING clause, matching the
 * read-side `::boolean` cast's semantics exactly (any non-zero integer
 * becomes true, zero becomes false). DEFAULT flips from `1` to `true`,
 * NOT NULL preserved.
 *
 * After this migration applies, the existing `::boolean` casts at
 * db.js:181, 207, 1284 become no-ops; they get dropped in the
 * accompanying code commit. The same-commit ordering means the migration
 * MUST be applied to production before the code change deploys —
 * otherwise the un-cast SELECTs will return raw integers and the web
 * frontend's `is_active === false` strict-equality checks will misclassify
 * active users as active and inactive users as inactive (because integer
 * 0 is not strict-equal to boolean false).
 *
 * The table is tiny (single-digit row count for this single-user system),
 * so the ACCESS EXCLUSIVE lock from ALTER COLUMN is sub-millisecond. Run
 * via `npm run migrate:up` with DATABASE_URL set to the production
 * Secrets Manager value.
 */

exports.up = (pgm) => {
  pgm.alterColumn('users', 'is_active', {
    type: 'boolean',
    using: '(is_active <> 0)',
    default: true,
    notNull: true,
  });
};

exports.down = (pgm) => {
  pgm.alterColumn('users', 'is_active', {
    type: 'integer',
    using: 'CASE WHEN is_active THEN 1 ELSE 0 END',
    default: 1,
    notNull: true,
  });
};
