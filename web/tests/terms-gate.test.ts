/**
 * Unit-level tests for the dependency-free gate helpers in
 * `web/src/app/terms/legal-texts-gate.ts`.
 *
 * These functions are imported by both the `/terms` page (to record
 * acceptance) and the `AppShell` (to decide whether to redirect to the
 * gate). Locking them down here means a future refactor of either
 * caller can't silently change the gate's contract.
 *
 * iOS parity: the storage keys match `TermsAcceptanceView.swift`'s
 * `UserDefaults` writes — `termsAccepted=true`,
 * `termsAcceptedVersion="1.0"`, `termsAcceptedDate=ISO8601` — so a job
 * future-synced from iOS into web localStorage (or vice versa) flips
 * this gate without bespoke migration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TERMS_STORAGE_KEYS,
  TERMS_VERSION,
  hasAcceptedCurrentTerms,
  recordTermsAcceptance,
} from '@/app/terms/legal-texts-gate';

describe('T&Cs gate helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it('TERMS_VERSION matches iOS TermsAcceptanceView.currentVersion ("1.0")', () => {
    // If iOS bumps to 1.1, this constant must move in lockstep so an
    // accepted-on-iOS user is re-prompted on web (and vice versa).
    expect(TERMS_VERSION).toBe('1.0');
  });

  it('storage keys are the iOS UserDefaults keys', () => {
    expect(TERMS_STORAGE_KEYS).toEqual({
      accepted: 'termsAccepted',
      version: 'termsAcceptedVersion',
      date: 'termsAcceptedDate',
    });
  });

  describe('hasAcceptedCurrentTerms', () => {
    it('returns false on a fresh device (no flags set)', () => {
      expect(hasAcceptedCurrentTerms()).toBe(false);
    });

    it('returns false when termsAccepted is missing but version is set', () => {
      window.localStorage.setItem(TERMS_STORAGE_KEYS.version, TERMS_VERSION);
      expect(hasAcceptedCurrentTerms()).toBe(false);
    });

    it('returns false when termsAccepted is the literal string "false"', () => {
      window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'false');
      window.localStorage.setItem(TERMS_STORAGE_KEYS.version, TERMS_VERSION);
      expect(hasAcceptedCurrentTerms()).toBe(false);
    });

    it('returns false when version is stale (re-acceptance forced)', () => {
      window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'true');
      window.localStorage.setItem(TERMS_STORAGE_KEYS.version, '0.9');
      expect(hasAcceptedCurrentTerms()).toBe(false);
    });

    it('returns true only when both flags are set with the current version', () => {
      window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'true');
      window.localStorage.setItem(TERMS_STORAGE_KEYS.version, TERMS_VERSION);
      expect(hasAcceptedCurrentTerms()).toBe(true);
    });

    it('returns false when localStorage.getItem throws (privacy mode)', () => {
      const realGet = window.localStorage.getItem;
      // @ts-expect-error overriding for the test
      window.localStorage.getItem = () => {
        throw new Error('SecurityError: localStorage disabled');
      };
      try {
        expect(hasAcceptedCurrentTerms()).toBe(false);
      } finally {
        window.localStorage.getItem = realGet;
      }
    });
  });

  describe('recordTermsAcceptance', () => {
    it('writes the three iOS-parity keys atomically', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-25T12:34:56.000Z'));
      recordTermsAcceptance();
      expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.accepted)).toBe('true');
      expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.version)).toBe(TERMS_VERSION);
      expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.date)).toBe('2026-04-25T12:34:56.000Z');
    });

    it('flips hasAcceptedCurrentTerms() to true', () => {
      expect(hasAcceptedCurrentTerms()).toBe(false);
      recordTermsAcceptance();
      expect(hasAcceptedCurrentTerms()).toBe(true);
    });

    it('uses the supplied Date when given (deterministic test seam)', () => {
      const fixed = new Date('2026-01-01T00:00:00.000Z');
      recordTermsAcceptance(fixed);
      expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.date)).toBe(fixed.toISOString());
    });

    it('silently no-ops if localStorage.setItem throws', () => {
      const realSet = window.localStorage.setItem;
      // @ts-expect-error overriding for the test
      window.localStorage.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      try {
        // The intent is "doesn't throw"; absence of an exception is
        // the assertion. We don't care about post-conditions here
        // because the page's own redirect runs regardless — the gate
        // will simply re-prompt next mount, which is the documented
        // graceful-degrade path.
        expect(() => recordTermsAcceptance()).not.toThrow();
      } finally {
        window.localStorage.setItem = realSet;
      }
    });
  });
});
