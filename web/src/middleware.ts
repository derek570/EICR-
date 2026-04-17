import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route guard.
 *
 * Public paths (login, legal, offline, static assets, API proxy calls)
 * pass through. Everything else requires an unexpired JWT cookie; missing
 * or expired token → redirect to /login with ?redirect=<attempted path>.
 */

const PUBLIC_PREFIXES = ['/login', '/legal', '/offline'];

function isTokenExpired(token: string): boolean {
  try {
    const [, payload] = token.split('.');
    if (!payload) return true;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    if (!json.exp) return false;
    return Date.now() >= json.exp * 1000;
  } catch {
    return true;
  }
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
  if (!token || isTokenExpired(token)) {
    const url = new URL('/login', req.url);
    if (pathname !== '/') url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
