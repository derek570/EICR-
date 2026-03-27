import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Middleware is skipped for static export (Capacitor) builds.
// Auth is handled client-side in those cases.

// Routes that require authentication
const protectedRoutes = ['/dashboard', '/upload', '/job'];

// Routes that should redirect to dashboard if already authenticated
const authRoutes = ['/login'];

/**
 * Decode JWT payload and check if the token has expired.
 * Does NOT verify the signature -- that is the backend's job.
 */
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    // base64url -> base64 -> decode
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(payload));
    if (!decoded.exp) return false; // No exp claim means non-expiring token
    // exp is in seconds; compare to current time with 30s buffer
    return decoded.exp * 1000 < Date.now() + 30_000;
  } catch {
    return true; // Malformed token = treat as expired
  }
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const token = request.cookies.get('token')?.value;
  const hasValidToken = !!token && !isTokenExpired(token);

  // Protected routes - redirect to login if not authenticated or token expired
  if (protectedRoutes.some((route) => pathname.startsWith(route))) {
    if (!hasValidToken) {
      // Clear the expired cookie
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('from', pathname);
      const response = NextResponse.redirect(loginUrl);
      if (token && !hasValidToken) {
        response.cookies.delete('token');
      }
      return response;
    }
  }

  // Auth routes - redirect to dashboard if already authenticated
  if (authRoutes.some((route) => pathname.startsWith(route))) {
    if (hasValidToken) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/upload/:path*', '/job/:path*', '/login'],
};
