import type { User } from './types';

/**
 * Auth-token helpers. Token is stored in localStorage (for API calls) and
 * also mirrored into a cookie so the Next.js middleware can gate routes
 * before hitting the client.
 */

const TOKEN_KEY = 'cm_token';
const USER_KEY = 'cm_user';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setAuth(token: string, user: User): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  // Mirror into cookie so middleware can do a cheap expiry check.
  // SameSite=Lax + path=/ so it's sent on navigation within the app.
  document.cookie = `token=${token}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function clearAuth(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  document.cookie = 'token=; path=/; max-age=0; SameSite=Lax';
}
