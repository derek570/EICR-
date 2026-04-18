/**
 * Login `?redirect=` sanitiser (Wave 1 P0-16).
 *
 * Accepts only same-origin, absolute-path redirects. Rejects protocol-
 * relative (`//evil.com/...`), absolute URLs (`https://evil.com`),
 * backslash-encoded variants, and anything that does not begin with a
 * single `/`. This closes the open-redirect that otherwise let a
 * phishing link of the form `/login?redirect=https://evil.com` bounce
 * an authenticated user off-site the moment they signed in.
 *
 * Extracted from `src/app/login/page.tsx` in Wave 2 so the behaviour
 * can be unit-tested without mounting the React page. The login page
 * re-imports it rather than re-declaring — a single source of truth
 * keeps the sanitiser and its tests from drifting apart.
 */
export function sanitiseRedirect(raw: string | null): string {
  if (!raw) return '/dashboard';
  // Must start with a single `/` and the second char must not be
  // another `/` or `\` (which browsers collapse to scheme-relative).
  if (raw.length > 1 && raw[0] === '/' && raw[1] !== '/' && raw[1] !== '\\') {
    return raw;
  }
  return '/dashboard';
}
