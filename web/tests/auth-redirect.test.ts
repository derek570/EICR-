import { describe, it, expect } from 'vitest';
import { sanitiseRedirect } from '@/lib/auth-redirect';

/**
 * Wave 1 P0-16 regression: login `?redirect=` open-redirect.
 *
 * The sanitiser must only accept absolute-path, same-origin redirects.
 * Every rejection case below corresponds to a phishing vector the pre-
 * P0-16 login page would have honoured — keeping these as explicit
 * assertions makes it obvious when a future "just strip the domain"
 * refactor accidentally reintroduces the hole.
 */
describe('sanitiseRedirect (P0-16)', () => {
  it('returns /dashboard for null / missing redirect', () => {
    expect(sanitiseRedirect(null)).toBe('/dashboard');
    expect(sanitiseRedirect('')).toBe('/dashboard');
  });

  it('accepts a simple absolute path', () => {
    expect(sanitiseRedirect('/dashboard')).toBe('/dashboard');
    expect(sanitiseRedirect('/job/123/circuits')).toBe('/job/123/circuits');
  });

  it('rejects protocol-relative redirects (//evil.com)', () => {
    // Browsers interpret `//evil.com` as `https://evil.com` relative to
    // the current page protocol — this is the most common variant of
    // the open-redirect. Must come back as /dashboard.
    expect(sanitiseRedirect('//evil.com')).toBe('/dashboard');
    expect(sanitiseRedirect('//evil.com/attack')).toBe('/dashboard');
  });

  it('rejects backslash variants (browsers collapse \\ to /)', () => {
    expect(sanitiseRedirect('/\\evil.com')).toBe('/dashboard');
    expect(sanitiseRedirect('\\/evil.com')).toBe('/dashboard');
  });

  it('rejects absolute URLs', () => {
    expect(sanitiseRedirect('https://evil.com')).toBe('/dashboard');
    expect(sanitiseRedirect('http://evil.com/?a=b')).toBe('/dashboard');
  });

  it('rejects scheme-less or non-path inputs', () => {
    expect(sanitiseRedirect('javascript:alert(1)')).toBe('/dashboard');
    expect(sanitiseRedirect('dashboard')).toBe('/dashboard');
    expect(sanitiseRedirect('?next=/x')).toBe('/dashboard');
  });
});
