import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { middleware } from '@/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';

/**
 * Middleware regression surface. Each describe block corresponds to a
 * specific wave-level fix so the tests document their own history.
 *
 * Wave 1 P0-4 — `pathname.includes('.')` used to bypass auth for any
 *         URL with a dot (e.g. job ids like `job-2026.01.03`, or an
 *         employee name in `/settings/admin/users/user.name`). The fix
 *         replaced the includes-check with a file-extension allow-list.
 * Wave 1 P0-5 — `/settings/company/dashboard` was not admin-gated at
 *         middleware; only server-side API calls enforced RBAC, so an
 *         employee could land on the page and see employee PII until
 *         the first API call rendered a 403.
 * Wave 4 D4 — middleware now HMAC-verifies the JWT before trusting the
 *         claim set. A tampered cookie with a forged `role` or
 *         `company_role` claim is rejected here as if the token were
 *         missing entirely, so admin-surface gating cannot be bypassed
 *         by hand-crafting a JWT in the browser console.
 *
 * Testing the middleware in isolation: we exercise the exported
 * `middleware()` function directly rather than spinning up a Next app.
 * `NextRequest` accepts a URL + request-init pair; we stamp a `token`
 * cookie by building the Request with a `cookie` header.
 */

const TEST_SECRET = 'test-secret-for-middleware-vitest-only';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

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

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build a **signed** HS256 JWT with the given payload. This is the
 * real contract the backend emits, so middleware signature-verify
 * accepts it. Most tests use this path.
 */
function makeSignedJwt(payload: Record<string, unknown>, secret: string = TEST_SECRET): string {
  const headerSeg = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const bodySeg = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${headerSeg}.${bodySeg}`).digest();
  const sigSeg = base64url(sig);
  return `${headerSeg}.${bodySeg}.${sigSeg}`;
}

function expiresIn(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

describe('middleware — P0-4 dotted path auth bypass', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  it('does NOT bypass auth for a dotted dynamic path (no file extension)', async () => {
    // Pre-P0-4 this would have been `pathname.includes('.') → passthrough`.
    // Post-fix, `job-2026.01.03` doesn't match the static-asset regex, so
    // the middleware redirects to /login.
    const req = buildRequest('/job/job-2026.01.03/circuits');
    const res = await middleware(req);
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('does NOT bypass auth for a dotted admin-path (Wave 4 regression guard)', async () => {
    // Wave 4 — a hostile user could pre-P0-4 craft `/settings/admin/users/user.name`
    // and skip BOTH auth and admin gating because the old regex treated the
    // dot as a static-asset marker. With no token, we must still redirect
    // to /login rather than fall through.
    const req = buildRequest('/settings/admin/users/user.name');
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('DOES bypass auth for genuine static assets', async () => {
    const req = buildRequest('/icons/icon-512.png');
    const res = await middleware(req);
    expect(res.status).toBe(200);
    // `NextResponse.next()` resolves to a 200 pass-through.
  });

  it('allows /api/* through without redirect', async () => {
    const req = buildRequest('/api/auth/login');
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });
});

describe('middleware — P0-5 company-admin gate', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  it('redirects an authenticated non-admin away from /settings/company/dashboard', async () => {
    const token = makeSignedJwt({
      exp: expiresIn(3600),
      role: 'user',
      company_role: 'employee',
    });
    const req = buildRequest('/settings/company/dashboard', { token });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/settings');
    // Must NOT land back on /login — the user IS authenticated, just not authorised.
    expect(res.headers.get('location')).not.toContain('/login');
  });

  it('lets company-owner through to /settings/company/dashboard', async () => {
    const token = makeSignedJwt({
      exp: expiresIn(3600),
      role: 'user',
      company_role: 'owner',
    });
    const req = buildRequest('/settings/company/dashboard', { token });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it('lets system admin view any company surface', async () => {
    const token = makeSignedJwt({
      exp: expiresIn(3600),
      role: 'admin',
      // No company_role — system admin cross-tenant access.
    });
    const req = buildRequest('/settings/company/dashboard', { token });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it('redirects non-admin away from /settings/admin (system-admin gate)', async () => {
    const token = makeSignedJwt({
      exp: expiresIn(3600),
      role: 'user',
      company_role: 'admin', // company admin, not system admin
    });
    const req = buildRequest('/settings/admin/users', { token });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/settings');
  });

  it('redirects a company-admin away from /settings/admin (Wave 4 D4 escalation guard)', async () => {
    // Company-admins ≠ system-admins. A `company_role: 'admin'` claim
    // must not unlock the system-admin surface — that's a privilege
    // escalation vector when the two role axes get conflated.
    const token = makeSignedJwt({
      exp: expiresIn(3600),
      role: 'user',
      company_role: 'admin',
    });
    const req = buildRequest('/settings/admin/users/some-id', { token });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/settings');
    expect(res.headers.get('location')).not.toContain('/login');
  });
});

describe('middleware — Wave 4 D4 signature verification', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  it('rejects a JWT forged with a wrong signature (even with admin claims)', async () => {
    // Attacker hand-crafts a token claiming system-admin privileges
    // and signs it with a bogus secret. Middleware must HMAC-verify
    // against the server's JWT_SECRET and reject before any admin-
    // surface gate considers the claim.
    const forged = makeSignedJwt(
      {
        exp: expiresIn(3600),
        role: 'admin',
        company_role: 'owner',
      },
      'not-the-real-secret'
    );
    const req = buildRequest('/settings/admin/users', { token: forged });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    // Invalid signature → treated as if there's no token at all → /login.
    expect(res.headers.get('location')).toContain('/login');
  });

  it('rejects a JWT forged with company_admin company_role but wrong signature', async () => {
    const forged = makeSignedJwt(
      {
        exp: expiresIn(3600),
        role: 'user',
        company_role: 'admin',
      },
      'attacker-chosen-secret'
    );
    const req = buildRequest('/settings/company/dashboard', { token: forged });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('rejects a JWT with alg:none header even if structurally valid', async () => {
    // Classic "alg: none" attack — attacker strips the signature and
    // sets the header alg to `none`. Our verifier explicitly rejects
    // anything that isn't HS256.
    const headerSeg = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const bodySeg = base64url(
      JSON.stringify({ exp: expiresIn(3600), role: 'admin', company_role: 'owner' })
    );
    const token = `${headerSeg}.${bodySeg}.`;
    const req = buildRequest('/settings/admin/users', { token });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('accepts a correctly-signed JWT', async () => {
    const token = makeSignedJwt({
      exp: expiresIn(3600),
      role: 'admin',
      company_role: 'owner',
    });
    const req = buildRequest('/settings/admin/users', { token });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });
});

describe('middleware — expired / missing token', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  it('redirects to /login with ?redirect= when token is missing', async () => {
    const req = buildRequest('/dashboard');
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).toContain('redirect=%2Fdashboard');
  });

  it('redirects when the token is expired', async () => {
    const token = makeSignedJwt({ exp: expiresIn(-60), role: 'user' });
    const req = buildRequest('/dashboard', { token });
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});
