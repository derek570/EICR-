import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route guard.
 *
 * Public paths (login, legal, offline, static assets, API proxy calls)
 * pass through. Everything else requires an unexpired JWT cookie; missing
 * or expired token → redirect to /login with ?redirect=<attempted path>.
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
  company_role?: 'owner' | 'admin' | 'employee';
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload;
  } catch {
    return null;
  }
}

function isTokenExpired(payload: JwtPayload): boolean {
  if (!payload.exp) return false;
  return Date.now() >= payload.exp * 1000;
}

export function middleware(req: NextRequest) {
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
  const payload = token ? decodeJwt(token) : null;
  if (!token || !payload || isTokenExpired(payload)) {
    const url = new URL('/login', req.url);
    if (pathname !== '/') url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  // System-admin surfaces. `role === 'admin'` is signed into the JWT
  // by the backend (`src/auth.js`), so a tampered localStorage user
  // object can't promote anyone — the cookie-held token is authoritative.
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
