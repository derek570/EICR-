/**
 * Runtime STT kill-switch — middleware/auth-path behaviour for `/runtime-config`
 * (parity WS4, round-6 NIT).
 *
 * Moving the route to the TOP-LEVEL `/runtime-config` path (NOT `/api/*`)
 * places it BEHIND the middleware JWT gate (an `/api/*` path would have been
 * early-returned). This is benign in practice — recording only runs when
 * authenticated — but must be pinned:
 *   - an AUTHENTICATED request reaches the route (NextResponse.next(), NOT a
 *     /login redirect), so the handler can serve JSON;
 *   - an UNAUTHENTICATED request is redirected to /login (HTML), and the
 *     client's `.json()` parse then fails → the fetch-failure branch resolves
 *     the fail-safe nova3 (covered in runtime-config.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

const TEST_SECRET = 'test-secret-for-runtime-config-vitest';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeSignedJwt(payload: Record<string, unknown>): string {
  const headerSeg = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const bodySeg = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', TEST_SECRET).update(`${headerSeg}.${bodySeg}`).digest();
  return `${headerSeg}.${bodySeg}.${base64url(sig)}`;
}
function req(pathname: string, token?: string): NextRequest {
  const url = new URL(pathname, 'https://certmate.uk');
  const headers = new Headers();
  if (token) headers.set('cookie', `token=${token}`);
  return new NextRequest(url, { headers });
}

describe('middleware — /runtime-config auth path', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });
  afterEach(() => {
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  it('an AUTHENTICATED request to /runtime-config passes through (not a /login redirect)', async () => {
    const token = makeSignedJwt({ role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 });
    const res = await middleware(req('/runtime-config', token));
    // NextResponse.next() → no redirect Location header, status 200.
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('an UNAUTHENTICATED request to /runtime-config is redirected to /login', async () => {
    const res = await middleware(req('/runtime-config'));
    const location = res.headers.get('location');
    expect(location).toContain('/login');
  });

  it('an EXPIRED-token request to /runtime-config is redirected to /login', async () => {
    const token = makeSignedJwt({ role: 'user', exp: Math.floor(Date.now() / 1000) - 10 });
    const res = await middleware(req('/runtime-config', token));
    expect(res.headers.get('location')).toContain('/login');
  });
});
