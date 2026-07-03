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
      // WS7 — the acceptance signature (iOS UserDefaults key).
      signature: 'termsAcceptanceSignature',
    });
  });

  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANS';

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
      // localStorage.getItem is a writable own property in jsdom; the
      // assignment type-checks cleanly without a directive.
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
    it('writes the four iOS-parity keys and returns true, with the signature FIRST', () => {
      // Capture write ORDER — the signature must persist before the
      // accepted/version flags so a later throw can never leave
      // termsAccepted=true without a signature on file.
      const order: string[] = [];
      const realSet = window.localStorage.setItem.bind(window.localStorage);
      window.localStorage.setItem = (k: string, v: string) => {
        order.push(k);
        realSet(k, v);
      };
      try {
        const ok = recordTermsAcceptance({
          signatureDataUrl: SIG,
          now: new Date('2026-04-25T12:34:56.000Z'),
        });
        expect(ok).toBe(true);
        expect(order[0]).toBe(TERMS_STORAGE_KEYS.signature);
        expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.signature)).toBe(SIG);
        expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.accepted)).toBe('true');
        expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.version)).toBe(TERMS_VERSION);
        expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.date)).toBe(
          '2026-04-25T12:34:56.000Z'
        );
      } finally {
        window.localStorage.setItem = realSet;
      }
    });

    it('flips hasAcceptedCurrentTerms() to true', () => {
      expect(hasAcceptedCurrentTerms()).toBe(false);
      expect(recordTermsAcceptance({ signatureDataUrl: SIG })).toBe(true);
      expect(hasAcceptedCurrentTerms()).toBe(true);
    });

    it('uses the supplied Date when given (deterministic test seam)', () => {
      const fixed = new Date('2026-01-01T00:00:00.000Z');
      recordTermsAcceptance({ signatureDataUrl: SIG, now: fixed });
      expect(window.localStorage.getItem(TERMS_STORAGE_KEYS.date)).toBe(fixed.toISOString());
    });

    it('on a setItem throw: leaves NO terms keys and returns false (all-or-nothing)', () => {
      // Pre-seed a stale value to prove the rollback clears everything,
      // not just the keys this call wrote.
      window.localStorage.setItem(TERMS_STORAGE_KEYS.accepted, 'stale');
      const realSet = window.localStorage.setItem.bind(window.localStorage);
      // Throw on the FIRST write (the signature) — the largest, likeliest
      // thrower — so accepted/version/date never get written.
      window.localStorage.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      try {
        const ok = recordTermsAcceptance({ signatureDataUrl: SIG });
        expect(ok).toBe(false);
      } finally {
        window.localStorage.setItem = realSet;
      }
      // Every terms key removed — no soft-bypass residue.
      for (const key of Object.values(TERMS_STORAGE_KEYS)) {
        expect(window.localStorage.getItem(key)).toBeNull();
      }
      expect(hasAcceptedCurrentTerms()).toBe(false);
    });

    it('does not throw even if setItem AND removeItem both throw', () => {
      const realSet = window.localStorage.setItem.bind(window.localStorage);
      const realRemove = window.localStorage.removeItem.bind(window.localStorage);
      window.localStorage.setItem = () => {
        throw new Error('QuotaExceededError');
      };
      window.localStorage.removeItem = () => {
        throw new Error('SecurityError');
      };
      try {
        expect(recordTermsAcceptance({ signatureDataUrl: SIG })).toBe(false);
      } finally {
        window.localStorage.setItem = realSet;
        window.localStorage.removeItem = realRemove;
      }
    });
  });
});
