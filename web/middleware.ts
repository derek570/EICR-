import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const publicPaths = ['/login', '/mic', '/legal', '/offline'];

function isTokenExpired(token: string): boolean {
  try {
    // JWT structure: header.payload.signature — decode payload (base64url)
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return false; // No expiry claim = assume valid
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true; // Malformed token = treat as expired
  }
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow landing page (exact root path)
  if (pathname === '/') {
    return NextResponse.next();
  }

  // Allow public paths
  if (publicPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static files and API routes
  if (pathname.startsWith('/_next') || pathname.startsWith('/api') || pathname.includes('.')) {
    return NextResponse.next();
  }

  // Check for auth token in cookies and validate it
  const token = request.cookies.get('token')?.value;

  if (!token || isTokenExpired(token)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
