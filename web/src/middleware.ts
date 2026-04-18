import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route guard.
 *
 * Public paths (login, legal, offline, static assets, API proxy calls)
 * pass through. Everything else requires an unexpired JWT cookie; missing
 * or expired token → redirect to /login with ?redirect=<attempted path>.
 *
 * Wave 4 D4 — the JWT is HMAC-verified with the JWT_SECRET env var
 * before any claim is trusted for authorisation. Pre-D4 the middleware
 * base64-decoded the payload and trusted it verbatim, which meant a
 * hand-crafted token with a forged `role: 'admin'` claim would pass
 * every admin-surface gate (the server still refused on write, but the
 * UI would render admin chrome and leak PII). Verifying the HMAC here
 * means the claim set is only as trustworthy as the shared secret.
 */

const PUBLIC_PREFIXES = ['/login', '/legal', '/offline'];

/**
 * Static-asset allow-list. The old implementation used
 * `pathname.includes('.')` which accidentally bypassed auth AND admin
 * gating for ANY dynamic URL that happened to contain a dot (e.g. a
 * job id like `job-2026.01.03` or `/settings/admin/users/user.name`).
 * Whitelist the file extensions we actually serve instead.
 */
const STATIC_ASSET_EXT =
  /\.(?:ico|png|jpg|jpeg|gif|svg|webp|avif|css|js|mjs|map|txt|xml|json|webmanifest|woff|woff2|ttf|otf|eot|mp3|mp4|webm|pdf)$/i;

/**
 * Admin-only surface matchers. Anything under these roots requires
 * the JWT to carry `role === 'admin'` or (for company surfaces)
 * a `company_role` of owner/admin. Server routes re-verify, but
 * matching here avoids flash-of-admin-chrome for unauthorised users.
 */
const SYS_ADMIN_PREFIX = '/settings/admin';
const COMPANY_ADMIN_PREFIX = '/settings/company';

interface JwtPayload {
  exp?: number;
  role?: 'admin' | 'user';
  company_id?: string | null;
  company_role?: 'owner' | 'admin' | 'employee';
}

function base64UrlToUint8(base64Url: string): Uint8Array<ArrayBuffer> {
  const pad = base64Url.length % 4 === 0 ? '' : '='.repeat(4 - (base64Url.length % 4));
  const base64 = (base64Url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  // Back the array with a concrete `ArrayBuffer` (not the default
  // `ArrayBufferLike`) so the bytes satisfy `crypto.subtle.verify`'s
  // `BufferSource` parameter type under strict tsc.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToString(base64Url: string): string {
  const bytes = base64UrlToUint8(base64Url);
  return new TextDecoder().decode(bytes);
}

/**
 * HMAC-SHA256 verify the three-segment JWT against `secret`.
 *
 * The middleware runs on the Edge / Node runtime where `crypto.subtle`
 * is always available. We use Web Crypto directly (rather than adding
 * `jose` as a dep) because it's one short function, avoids a runtime
 * surface we'd have to audit, and keeps the middleware bundle tiny.
 *
 * Returns the decoded payload on success; `null` on any failure
 * (tampered signature, malformed segments, wrong algorithm). Only HS256
 * is accepted — a future move to RS256 would touch this function and
 * the backend mint path together. `alg: none` and the absence of the
 * header's `alg` field both count as tampered and fall through to null.
 */
async function verifyAndDecodeJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const [headerSeg, payloadSeg, signatureSeg] = token.split('.');
    if (!headerSeg || !payloadSeg || !signatureSeg) return null;

    const header = JSON.parse(base64UrlToString(headerSeg)) as { alg?: string };
    if (header.alg !== 'HS256') return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const signature = base64UrlToUint8(signatureSeg);
    const signedData = encoder.encode(`${headerSeg}.${payloadSeg}`);
    const ok = await crypto.subtle.verify('HMAC', key, signature, signedData);
    if (!ok) return null;

    return JSON.parse(base64UrlToString(payloadSeg)) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Claim-only decoder — kept for the fallback path where `JWT_SECRET`
 * is not exposed to the middleware runtime (e.g. certain local-dev
 * configurations). The claims returned here are NOT trustworthy and
 * MUST NOT be used for authorisation when a secret is available. The
 * verify path above is the one that gates admin surfaces in production.
 */
function unsafeDecodeJwt(token: string): JwtPayload | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(base64UrlToString(payload)) as JwtPayload;
  } catch {
    return null;
  }
}

function isTokenExpired(payload: JwtPayload): boolean {
  if (!payload.exp) return false;
  return Date.now() >= payload.exp * 1000;
}

/**
 * Resolve the JWT-verifying secret.
 *
 * `NEXT_RUNTIME`-agnostic. In production the secret is injected via the
 * ECS task definition's `JWT_SECRET` env var (same value as the backend
 * auth module consumes). In local dev the variable may be absent; in
 * that case we log once and skip signature verification — the cookie
 * is still checked for expiry + presence, admin surfaces still gate on
 * the claim set, and the server re-authorises every write. A missing
 * secret is a known-degraded mode, not a silent failure.
 */
let warnedMissingSecret = false;
function getJwtSecret(): string | null {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn(
        '[middleware] JWT_SECRET not set — running in claim-only mode. Admin-surface gating still enforced on decoded claims, but forged tokens cannot be rejected here. Server routes remain authoritative.'
      );
    }
    return null;
  }
  return secret;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public paths & static files pass through.
  if (
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    STATIC_ASSET_EXT.test(pathname)
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get('token')?.value;
  const secret = getJwtSecret();
  const payload = token
    ? secret
      ? await verifyAndDecodeJwt(token, secret)
      : unsafeDecodeJwt(token)
    : null;
  if (!token || !payload || isTokenExpired(payload)) {
    const url = new URL('/login', req.url);
    if (pathname !== '/') url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  // System-admin surfaces. `role === 'admin'` is signed into the JWT
  // by the backend (`src/auth.js`), and verified by `verifyAndDecodeJwt`
  // above when JWT_SECRET is configured — so a tampered cookie cannot
  // forge a claim that reaches here. Anyone below the bar is bounced
  // to the settings hub (not /login — they ARE authenticated).
  if (pathname.startsWith(SYS_ADMIN_PREFIX) && payload.role !== 'admin') {
    return NextResponse.redirect(new URL('/settings', req.url));
  }

  // Company-admin surfaces — `/settings/company` AND its subroutes
  // (notably `/settings/company/dashboard`, which paints employee PII
  // before the server-side `requireAdmin` on its API calls kicks in).
  // Allow `company_role` of owner/admin; a system admin can view any
  // company too. Anyone else is bounced to the settings hub.
  if (pathname.startsWith(COMPANY_ADMIN_PREFIX)) {
    const isSysAdmin = payload.role === 'admin';
    const isCompanyAdmin = payload.company_role === 'owner' || payload.company_role === 'admin';
    if (!isSysAdmin && !isCompanyAdmin) {
      return NextResponse.redirect(new URL('/settings', req.url));
    }
  }

  // PWA guardrail. Next's App Router bakes server-action hashes into the
  // client bundle; a page served from the browser's HTTP cache after a
  // deploy will call handlers that no longer exist server-side and throw
  // "Failed to find Server Action". Forcing no-store on HTML responses
  // means the browser always revalidates, so the client bundle can never
  // outlive its matching server routes. Static assets (anything with a
  // `.`) and `/_next/*` are early-returned above, so this header only
  // reaches HTML. The SW decides its own caching independently.
  const res = NextResponse.next();
  res.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
