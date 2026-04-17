import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route guard.
 *
 * Public paths (login, legal, offline, static assets, API proxy calls)
 * pass through. Everything else requires an unexpired JWT cookie; missing
 * or expired token → redirect to /login with ?redirect=<attempted path>.
 */

const PUBLIC_PREFIXES = ['/login', '/legal', '/offline'];

interface JwtPayload {
  exp?: number;
  role?: 'admin' | 'user';
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
    pathname.includes('.')
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

  // Admin-only surfaces. Belt-and-braces — the settings pages also check
  // role client-side via useCurrentUser, but a middleware check avoids
  // any flash-of-admin-chrome for non-admins and catches tampered
  // localStorage. The `role` claim is signed into the JWT by the backend.
  if (pathname.startsWith('/settings/admin') && payload.role !== 'admin') {
    return NextResponse.redirect(new URL('/settings', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
