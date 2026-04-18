import { describe, it, expect } from 'vitest';
import { middleware } from '@/middleware';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Wave 1 P0-4 + P0-5 middleware regression.
 *
 * P0-4 — `pathname.includes('.')` used to bypass auth for any URL with
 *         a dot (e.g. job ids like `job-2026.01.03`, or an employee
 *         name in `/settings/admin/users/user.name`). The fix replaced
 *         the includes-check with a file-extension allow-list.
 * P0-5 — `/settings/company/dashboard` was not admin-gated at middleware;
 *         only server-side API calls enforced RBAC, so an employee could
 *         land on the page and see employee PII until the first API call
 *         rendered a 403.
 *
 * Testing the middleware in isolation: we exercise the exported
 * `middleware()` function directly rather than spinning up a Next app.
 * `NextRequest` accepts a URL + request-init pair; we stamp a `token`
 * cookie by building the Request with a `cookie` header.
 */

function buildRequest(
  pathname: string,
  opts: {
    token?: string;
  } = {}
): NextRequest {
  const url = new URL(pathname, 'https://certomatic3000.co.uk');
  const headers = new Headers();
  if (opts.token) {
    headers.set('cookie', `token=${opts.token}`);
  }
  return new NextRequest(url, { headers });
}

/**
 * Build a syntactically-valid JWT with the given payload. Middleware
 * uses `atob` + JSON.parse on the middle segment, no signature check,
 * so an unsigned test token is sufficient.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${header}.${body}.sig`;
}

function expiresIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

describe('middleware — P0-4 dotted path auth bypass', () => {
  it('does NOT bypass auth for a dotted dynamic path (no file extension)', () => {
    // Pre-P0-4 this would have been `pathname.includes('.') → passthrough`.
    // Post-fix, `job-2026.01.03` doesn't match the static-asset regex, so
    // the middleware redirects to /login.
    const req = buildRequest('/job/job-2026.01.03/circuits');
    const res = middleware(req);
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('DOES bypass auth for genuine static assets', () => {
    const req = buildRequest('/icons/icon-512.png');
    const res = middleware(req);
    expect(res.status).toBe(200);
    // `NextResponse.next()` resolves to a 200 pass-through.
  });

  it('allows /api/* through without redirect', () => {
    const req = buildRequest('/api/auth/login');
    const res = middleware(req);
    expect(res.status).toBe(200);
  });
});

describe('middleware — P0-5 company-admin gate', () => {
  it('redirects an authenticated non-admin away from /settings/company/dashboard', () => {
    const token = makeJwt({
      exp: expiresIn(3600),
      role: 'user',
      company_role: 'employee',
    });
    const req = buildRequest('/settings/company/dashboard', { token });
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/settings');
    // Must NOT land back on /login — the user IS authenticated, just not authorised.
    expect(res.headers.get('location')).not.toContain('/login');
  });

  it('lets company-owner through to /settings/company/dashboard', () => {
    const token = makeJwt({
      exp: expiresIn(3600),
      role: 'user',
      company_role: 'owner',
    });
    const req = buildRequest('/settings/company/dashboard', { token });
    const res = middleware(req);
    expect(res.status).toBe(200);
  });

  it('lets system admin view any company surface', () => {
    const token = makeJwt({
      exp: expiresIn(3600),
      role: 'admin',
      // No company_role — system admin cross-tenant access.
    });
    const req = buildRequest('/settings/company/dashboard', { token });
    const res = middleware(req);
    expect(res.status).toBe(200);
  });

  it('redirects non-admin away from /settings/admin (system-admin gate)', () => {
    const token = makeJwt({
      exp: expiresIn(3600),
      role: 'user',
      company_role: 'admin', // company admin, not system admin
    });
    const req = buildRequest('/settings/admin/users', { token });
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/settings');
  });
});

describe('middleware — expired / missing token', () => {
  it('redirects to /login with ?redirect= when token is missing', () => {
    const req = buildRequest('/dashboard');
    const res = middleware(req);
    expect(res.status).toBe(307);
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).toContain('redirect=%2Fdashboard');
  });

  it('redirects when the token is expired', () => {
    const token = makeJwt({ exp: expiresIn(-60), role: 'user' });
    const req = buildRequest('/dashboard', { token });
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});
