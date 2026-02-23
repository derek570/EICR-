import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Middleware is skipped for static export (Capacitor) builds.
// Auth is handled client-side in those cases.

// Routes that require authentication
const protectedRoutes = ["/dashboard", "/upload", "/job", "/clients"];

// Routes that should redirect to dashboard if already authenticated
const authRoutes = ["/login"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check for token in cookies (set by client after login)
  // Note: For better security, use httpOnly cookies set by the server
  // This is a client-side token check for simplicity
  const token = request.cookies.get("token")?.value;

  // Protected routes - redirect to login if not authenticated
  if (protectedRoutes.some((route) => pathname.startsWith(route))) {
    if (!token) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("from", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Auth routes - redirect to dashboard if already authenticated
  if (authRoutes.some((route) => pathname.startsWith(route))) {
    if (token) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/upload/:path*", "/job/:path*", "/clients/:path*", "/login"],
};
