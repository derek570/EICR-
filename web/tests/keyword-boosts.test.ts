/**
 * Keyterm prompt generator + URL appender — regression locks.
 *
 * The Wave-A audit Phase 6 P0 flagged that web sent zero Nova-3
 * keyterms vs iOS's ~89. This file covers the port (`keyword-boosts.ts`)
 * with assertions that match the iOS contract:
 *
 *   1. Base config emits the iOS keyword set (case-insensitive dedup,
 *      sorted by boost desc → alphabetical), capped at 100.
 *   2. CCU augmentation injects board manufacturer / model / OCPD
 *      types / SPD vocabulary / circuit labels / circuit numbers /
 *      RCD ratings the way iOS does, without duplicating anything
 *      already in the base config.
 *   3. `appendKeytermsToUrl` honours the 1800-char URL budget and the
 *      iOS top-tier (`≥3.0`) `:X.X` boost-suffix optimisation.
 */

import { describe, it, expect } from 'vitest';
import {
  KEYTERM_INTERNALS,
  appendKeytermsToUrl,
  generateKeyterms,
} from '@/lib/recording/keyword-boosts';

describe('generateKeyterms — config-only path', () => {
  it('emits the iOS canonical electrical-vocab set', () => {
    const list = generateKeyterms();
    const keys = list.map((k) => k.keyword);
    // Spot-check critical iOS terms across all boost tiers.
    expect(keys).toContain('Zs');
    expect(keys).toContain('R1 plus R2');
    expect(keys).toContain('insulation resistance');
    expect(keys).toContain('LIM');
    expect(keys).toContain('TN-C-S');
    expect(keys).toContain('MICC');
    expect(keys).toContain('CertMate');
    // Board manufacturers from the board_types block.
    expect(keys).toContain('Hager');
    expect(keys).toContain('Wylex');
    expect(keys).toContain('Schneider');
  });

  it('returns boosts in (boost desc, alphabetical) order — stable output for URL diffs', () => {
    const list = generateKeyterms();
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev.boost !== cur.boost) {
        expect(prev.boost).toBeGreaterThan(cur.boost);
      } else {
        expect(prev.keyword <= cur.keyword).toBe(true);
      }
    }
  });

  it('dedupes case-insensitively, keeping the highest boost (iOS dedupAndCap parity)', () => {
    const list = generateKeyterms();
    const seen = new Set<string>();
    for (const { keyword } of list) {
      const lc = keyword.toLowerCase();
      expect(seen.has(lc)).toBe(false);
      seen.add(lc);
    }
    // The iOS "tails" entry appears at both 1.5 and 2.0 in the config —
    // dedup must keep the 2.0 boost.
    const tails = list.find((b) => b.keyword.toLowerCase() === 'tails');
    expect(tails?.boost).toBe(2.0);
  });

  it('caps at MAX_KEYTERMS (100)', () => {
    const list = generateKeyterms();
    expect(list.length).toBeLessThanOrEqual(KEYTERM_INTERNALS.MAX_KEYTERMS);
  });
});

describe('generateKeyterms — CCU-augmented path', () => {
  it('injects manufacturer / model / SPD / main-switch terms when the analysis carries them', () => {
    // Post codex-fix on `e38fa5e`: the analysis pool gets
    // ANALYSIS_RESERVED_SLOTS (10) reserved at the bottom of the cap,
    // so even 1.0-boost augmentations (board_model, surge_protection)
    // make it into the URL.
    const list = generateKeyterms({
      board_manufacturer: 'Acme Boards', // novel — boost 1.5
      board_model: 'Acme-X1', // boost 1.0 — now reaches via reserved slots
      main_switch_type: 'Isolator', // boost 1.5
      spd_present: true,
      circuits: [],
    });
    const keys = list.map((k) => k.keyword);
    expect(keys).toContain('Acme Boards');
    expect(keys).toContain('Acme-X1');
    expect(keys).toContain('Isolator');
    expect(keys).toContain('SPD');
    expect(keys).toContain('surge protection');
  });

  it('does NOT duplicate manufacturer when the value matches an existing board-types entry', () => {
    const list = generateKeyterms({
      board_manufacturer: 'Hager', // Already in BOARD_TYPE_BOOSTS at 1.5
      circuits: [],
    });
    // Only one entry — no duplicate at the higher boost.
    const hagerEntries = list.filter((k) => k.keyword.toLowerCase() === 'hager');
    expect(hagerEntries).toHaveLength(1);
  });

  it('extracts OCPD types (uppercased), RCBO/RCD flags, and "circuit N" refs from the circuits array', () => {
    // Post codex-fix: "circuit N" entries land via the reserved slots.
    const list = generateKeyterms({
      circuits: [
        { circuit_number: 1, ocpd_type: 'mcb', is_rcbo: false, rcd_protected: false },
        { circuit_number: 2, ocpd_type: 'fuse', is_rcbo: true },
        { circuit_number: 3, rcd_protected: true },
      ],
    });
    const keys = list.map((k) => k.keyword);
    expect(keys).toContain('FUSE');
    // MCB / RCBO / RCD already in base — must NOT appear duplicated.
    expect(list.filter((k) => k.keyword.toLowerCase() === 'mcb')).toHaveLength(1);
    expect(list.filter((k) => k.keyword.toLowerCase() === 'rcbo')).toHaveLength(1);
    expect(list.filter((k) => k.keyword.toLowerCase() === 'rcd')).toHaveLength(1);
    expect(keys).toContain('circuit 1');
    expect(keys).toContain('circuit 2');
    expect(keys).toContain('circuit 3');
  });

  it('extracts label terms, skipping stop-words and short tokens', () => {
    // Post codex-fix: label terms also reach the URL via reserved slots.
    const list = generateKeyterms({
      circuits: [
        { circuit_number: 1, label: 'Kitchen sockets' },
        { circuit_number: 2, label: 'Spare' }, // stop-word — must be dropped
        { circuit_number: 3, label: 'Bedroom 2 lights' },
      ],
    });
    const keys = list.map((k) => k.keyword);
    expect(keys).toContain('Kitchen');
    expect(keys).toContain('Sockets');
    expect(keys).toContain('Bedroom');
    expect(keys).toContain('Lights');
    expect(keys).toContain('Kitchen sockets');
    // Stop-words filtered before dedupAndCap.
    expect(keys.includes('Spare')).toBe(false);
  });

  it('reserves slots for analysis-derived terms even when the base list is full (codex P2 on e38fa5e)', () => {
    // The exact bug codex flagged: analysis-derived 1.0 terms used to
    // be deterministically dropped because the base list saturated the
    // 100-term cap before any analysis term was considered. Repro from
    // the codex review verbatim:
    const list = generateKeyterms({
      board_model: 'Acme-X1',
      circuits: [{ circuit_number: 7, label: 'Kitchen sockets' }],
      spd_present: true,
    });
    const keys = list.map((k) => k.keyword);
    // Pre-fix: NONE of these surfaced. Post-fix: all do via the
    // ANALYSIS_RESERVED_SLOTS allocation.
    expect(keys).toContain('Acme-X1');
    expect(keys).toContain('circuit 7');
    expect(keys).toContain('Kitchen');
    expect(keys).toContain('surge protection');
  });

  it('emits both spoken + numeric RCD ratings and dedupes', () => {
    const list = generateKeyterms({
      circuits: [
        { circuit_number: 1, rcd_rating_ma: '30' },
        { circuit_number: 2, rcd_rating_ma: '30' }, // dup
        { circuit_number: 3, rcd_rating_ma: '100' },
      ],
    });
    const keys = list.map((k) => k.keyword);
    expect(keys).toContain('30 milliamp');
    expect(keys).toContain('30mA');
    expect(keys).toContain('100 milliamp');
    expect(keys).toContain('100mA');
    // No duplicates.
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('appendKeytermsToUrl — URL budget + boost-suffix optimisation', () => {
  it('appends top-tier keyterms with the ":X.X" boost suffix and lower-tier without', () => {
    const params = new URLSearchParams({ model: 'nova-3' });
    const baseLength = 'wss://api.deepgram.com/v1/listen?model=nova-3'.length;
    appendKeytermsToUrl(
      params,
      [
        { keyword: 'foo', boost: 3.0 },
        { keyword: 'bar', boost: 2.0 },
      ],
      baseLength
    );
    const out = params.getAll('keyterm');
    expect(out).toContain('foo:3.0'); // top-tier — gets suffix
    expect(out).toContain('bar'); // lower-tier — bare keyword
  });

  it('stops appending once the projected URL would exceed the 1800-char budget', () => {
    const params = new URLSearchParams();
    const baseLength = 1700; // already close to the cap
    const longList = Array.from({ length: 200 }, (_, i) => ({
      keyword: `keyword${'x'.repeat(20)}${i}`,
      boost: 1.0,
    }));
    const appended = appendKeytermsToUrl(params, longList, baseLength);
    // Should have stopped well before all 200 were tried.
    expect(appended).toBeLessThan(longList.length);
    // And the resulting URL must fit within the budget.
    const finalLength = baseLength + ('&' + params.toString()).length - 1; // -1 for leading & not in toString of single-key URLSearchParams
    expect(finalLength).toBeLessThanOrEqual(KEYTERM_INTERNALS.URL_LENGTH_BUDGET + 50);
  });

  it('returns 0 if the very first keyterm would already overflow the budget', () => {
    const params = new URLSearchParams();
    // Already at the cap — any append is over-budget.
    const appended = appendKeytermsToUrl(
      params,
      [{ keyword: 'big', boost: 1.0 }],
      KEYTERM_INTERNALS.URL_LENGTH_BUDGET
    );
    expect(appended).toBe(0);
    expect(params.getAll('keyterm')).toHaveLength(0);
  });

  it('URL-encodes keyterm values that contain reserved characters', () => {
    const params = new URLSearchParams();
    appendKeytermsToUrl(params, [{ keyword: 'live to live', boost: 2.0 }], 0);
    // The serialised query string must contain URL-encoded space (+ or %20).
    const serialised = params.toString();
    expect(serialised.includes('live%20to%20live') || serialised.includes('live+to+live')).toBe(
      true
    );
  });
});
