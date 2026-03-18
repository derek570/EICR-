/**
 * Add role column to users table for admin/user distinction.
 *
 * CertMate is on TestFlight but has no way to create users — there's no
 * registration endpoint or admin panel. This migration adds the role column
 * needed for admin-only access control, and promotes the app owner to admin
 * so he can manage users via the new admin panel.
 *
 * All existing users default to 'user' role. Only 'admin' and 'user' values
 * are used — kept simple for a small inspector team.
 */

exports.up = (pgm) => {
  // Add role column — defaults to 'user' so all existing accounts remain regular users
  pgm.addColumn(
    'users',
    {
      role: { type: 'text', default: "'user'", notNull: true },
    },
    { ifNotExists: true }
  );

  // Promote the app owner to admin
  pgm.sql(`UPDATE users SET role = 'admin' WHERE email = 'derek@beckleyelectrical.co.uk'`);
};

exports.down = (pgm) => {
  pgm.dropColumn('users', 'role', { ifExists: true });
};
