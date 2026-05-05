/**
 * Unit tests for the RCD-type lookup table — the deterministic
 * (manufacturer, model) → rcd_type / ways resolver that runs ahead of
 * the per-slot waveform-glyph VLM read.
 *
 * Two layers:
 *   1. Pure lookup (`lookupRcdType`) — load JSON, normalise keys, return
 *      a result object. No analysis mutation.
 *   2. Apply (`applyRcdTypeLookup`) — mutate `analysis.circuits[].rcd_type`
 *      per the confidence policy and return a summary.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  normaliseManufacturer,
  normaliseModel,
  loadLookupTable,
  lookupRcdType,
  applyRcdTypeLookup,
  PER_SLOT_OVERRIDE_THRESHOLD,
  _resetCacheForTests,
} from '../extraction/rcd-type-lookup.js';

// ---------------------------------------------------------------------------
// Test fixture: a temp lookup file we control fully so we don't depend on
// the production seed file's shape evolving.
// ---------------------------------------------------------------------------

const FIXTURE = {
  schema_version: 1,
  manufacturer_defaults: {
    elucian: { rcd_type: 'A', confidence: 'high', verified_by: 'production' },
    wylex: { rcd_type: 'A', confidence: 'medium', verified_by: 'literature' },
    contactum: { rcd_type: 'A', confidence: 'low', verified_by: 'literature' },
    hager: { rcd_type: null, confidence: 'low', note: 'series-dependent' },
    lewden: { rcd_type: 'XYZ', confidence: 'medium' }, // invalid type → sanitised away
    mystery: { rcd_type: 'A', confidence: 'NOPE' }, // invalid confidence → falls to 'low'
  },
  models: {
    'elucian/CU1SPD275': {
      rcd_type: 'A',
      ways: 15,
      confidence: 'high',
      verified_by: 'production',
    },
    'wylex/NHRS12SL': {
      rcd_type: 'A',
      ways: 12,
      confidence: 'high',
      verified_by: 'datasheet',
    },
  },
};

let tmpDir;
let lookupPath;

function writeFixture(fixture = FIXTURE) {
  fs.writeFileSync(lookupPath, JSON.stringify(fixture, null, 2), 'utf8');
  _resetCacheForTests();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcd-lookup-'));
  lookupPath = path.join(tmpDir, 'rcd-type-lookup.json');
  writeFixture();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetCacheForTests();
});

// ---------------------------------------------------------------------------
// Key normalisation
// ---------------------------------------------------------------------------

describe('normaliseManufacturer', () => {
  test.each([
    ['Elucian', 'elucian'],
    ['  Click Scolmore  ', 'click_scolmore'],
    ['BG Electrical', 'bg_electrical'],
    ['Schneider-Electric', 'schneider_electric'],
    ['MK / Sentry', 'mk_sentry'],
    ['eaton', 'eaton'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseManufacturer(input)).toBe(expected);
  });

  test.each([null, undefined, '', '   ', '@@@', '!!'])(
    'returns null for empty/garbage input %p',
    (input) => {
      expect(normaliseManufacturer(input)).toBeNull();
    }
  );
});

describe('normaliseModel', () => {
  test.each([
    ['CU1SPD275', 'CU1SPD275'],
    ['cu1spd275', 'CU1SPD275'],
    ['  CU 1 SPD 275  ', 'CU1SPD275'],
    ['NHRS-12SL', 'NHRS-12SL'],
    ['VML_906_SPD-B', 'VML_906_SPD-B'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseModel(input)).toBe(expected);
  });

  test.each([null, undefined, '', '   '])('returns null for %p', (input) => {
    expect(normaliseModel(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadLookupTable
// ---------------------------------------------------------------------------

describe('loadLookupTable', () => {
  test('reads and parses a valid file', () => {
    const t = loadLookupTable(lookupPath);
    expect(t.schema_version).toBe(1);
    expect(t.manufacturer_defaults.elucian.rcd_type).toBe('A');
    expect(t.models['elucian/CU1SPD275'].ways).toBe(15);
  });

  test('returns empty-but-valid table on missing file', () => {
    fs.rmSync(lookupPath);
    _resetCacheForTests();
    const t = loadLookupTable(lookupPath);
    expect(t).toEqual({
      schema_version: 1,
      manufacturer_defaults: {},
      models: {},
    });
  });

  test('returns empty table on malformed JSON (no throw)', () => {
    fs.writeFileSync(lookupPath, '{not valid json', 'utf8');
    _resetCacheForTests();
    const t = loadLookupTable(lookupPath);
    expect(t.manufacturer_defaults).toEqual({});
    expect(t.models).toEqual({});
  });

  test('reloads when file mtime changes', () => {
    const t1 = loadLookupTable(lookupPath);
    expect(t1.manufacturer_defaults.elucian.rcd_type).toBe('A');
    // Need to bump mtime explicitly because the rewrite within the same
    // millisecond may not change the stat. Sleep a tick + utime forces it.
    const future = new Date(Date.now() + 1000);
    fs.writeFileSync(
      lookupPath,
      JSON.stringify({ schema_version: 1, manufacturer_defaults: {}, models: {} }),
      'utf8'
    );
    fs.utimesSync(lookupPath, future, future);
    const t2 = loadLookupTable(lookupPath);
    expect(t2.manufacturer_defaults).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// lookupRcdType — pure
// ---------------------------------------------------------------------------

describe('lookupRcdType', () => {
  test('exact model match returns the model entry', () => {
    const r = lookupRcdType({ manufacturer: 'Elucian', model: 'CU1SPD275' }, lookupPath);
    expect(r).toMatchObject({
      rcd_type: 'A',
      ways: 15,
      confidence: 'high',
      source: 'model',
      matched_key: 'elucian/CU1SPD275',
      verified_by: 'production',
    });
  });

  test('case- and whitespace-insensitive model match', () => {
    const r = lookupRcdType({ manufacturer: '  ELUCIAN ', model: 'cu1spd275' }, lookupPath);
    expect(r.source).toBe('model');
    expect(r.rcd_type).toBe('A');
  });

  test('falls back to manufacturer default when model unknown', () => {
    const r = lookupRcdType({ manufacturer: 'Elucian', model: 'NEWMODEL999' }, lookupPath);
    expect(r).toMatchObject({
      source: 'manufacturer_default',
      matched_key: 'elucian',
      rcd_type: 'A',
      confidence: 'high',
    });
    expect(r.ways).toBeNull();
  });

  test('manufacturer with rcd_type=null returns the entry but no usable type', () => {
    const r = lookupRcdType({ manufacturer: 'Hager', model: 'UNKNOWN' }, lookupPath);
    expect(r.source).toBe('manufacturer_default');
    expect(r.rcd_type).toBeNull();
  });

  test('miss when manufacturer and model both unknown', () => {
    const r = lookupRcdType({ manufacturer: 'Unobtainium', model: 'X1' }, lookupPath);
    expect(r).toMatchObject({
      rcd_type: null,
      ways: null,
      confidence: null,
      source: 'miss',
      matched_key: null,
    });
  });

  test('null inputs miss cleanly', () => {
    expect(lookupRcdType({}, lookupPath).source).toBe('miss');
    expect(lookupRcdType({ manufacturer: null, model: null }, lookupPath).source).toBe('miss');
  });

  test('invalid rcd_type in entry is sanitised to null', () => {
    const r = lookupRcdType({ manufacturer: 'Lewden' }, lookupPath);
    expect(r.source).toBe('manufacturer_default');
    expect(r.rcd_type).toBeNull();
  });

  test('invalid confidence falls back to low', () => {
    const r = lookupRcdType({ manufacturer: 'Mystery' }, lookupPath);
    expect(r.confidence).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// applyRcdTypeLookup — mutation policy
// ---------------------------------------------------------------------------

function makeAnalysis(overrides = {}) {
  return {
    board_manufacturer: 'Elucian',
    board_model: 'CU1SPD275',
    geometric: { moduleCount: 15 },
    confidence: { overall: 0.92 },
    slots: [
      { slotIndex: 0, classification: 'rcbo', rcdWaveformType: 'AC', confidence: 0.88 },
      { slotIndex: 1, classification: 'rcbo', rcdWaveformType: 'AC', confidence: 0.91 },
      { slotIndex: 2, classification: 'rcbo', rcdWaveformType: 'A', confidence: 0.97 },
    ],
    circuits: [
      { circuit_number: 1, slot_index: 0, rcd_protected: true, rcd_type: 'AC' },
      { circuit_number: 2, slot_index: 1, rcd_protected: true, rcd_type: 'AC' },
      { circuit_number: 3, slot_index: 2, rcd_protected: true, rcd_type: 'A' },
      // Non-RCD circuit: must be left alone.
      { circuit_number: 4, slot_index: 3, rcd_protected: false, rcd_type: null },
      // SPD/main switch row: must be left alone.
      { circuit_number: null, slot_index: 4, rcd_protected: false, is_rcd_device: true },
    ],
    ...overrides,
  };
}

describe('applyRcdTypeLookup — high confidence', () => {
  test('overrides every RCD-protected circuit, leaves non-RCD alone', () => {
    const a = makeAnalysis(); // Elucian / CU1SPD275 → high
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.outcome).toBe('hit');
    expect(r.matched_key).toBe('elucian/CU1SPD275');
    // Two AC reads got overridden, one A read was already correct.
    expect(r.overridden).toBe(2);
    expect(r.applied).toBe(1);
    expect(r.kept).toBe(0);
    expect(a.circuits[0].rcd_type).toBe('A');
    expect(a.circuits[1].rcd_type).toBe('A');
    expect(a.circuits[2].rcd_type).toBe('A');
    expect(a.circuits[3].rcd_type).toBeNull(); // non-RCD untouched
    expect(a.circuits[4].is_rcd_device).toBe(true); // SPD untouched
    // Provenance fields attached on changed circuits.
    expect(a.circuits[0].rcd_type_source).toBe('model');
    expect(a.circuits[0].rcd_type_lookup_match).toBe('elucian/CU1SPD275');
    expect(a.circuits[0].rcd_type_lookup_confidence).toBe('high');
  });

  test('high override applies even when slot confidence is also high', () => {
    const a = makeAnalysis();
    a.circuits[0].rcd_type = 'AC';
    a.slots[0].confidence = 0.99; // would block a medium override
    applyRcdTypeLookup(a, { lookupPath });
    expect(a.circuits[0].rcd_type).toBe('A');
  });
});

describe('applyRcdTypeLookup — medium confidence', () => {
  test('overrides per-slot reads below the threshold', () => {
    // Wylex/UNKNOWN_MODEL → manufacturer_default medium A
    const a = makeAnalysis({
      board_manufacturer: 'Wylex',
      board_model: 'UNKNOWN_MODEL',
    });
    a.slots = [{ slotIndex: 0, classification: 'rcbo', rcdWaveformType: 'AC', confidence: 0.88 }];
    a.circuits = [{ circuit_number: 1, slot_index: 0, rcd_protected: true, rcd_type: 'AC' }];
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.outcome).toBe('default');
    expect(r.confidence).toBe('medium');
    expect(r.overridden).toBe(1);
    expect(a.circuits[0].rcd_type).toBe('A');
  });

  test('honours confident per-slot disagreement (>= threshold)', () => {
    const a = makeAnalysis({
      board_manufacturer: 'Wylex',
      board_model: 'UNKNOWN_MODEL',
    });
    a.slots = [
      {
        slotIndex: 0,
        classification: 'rcbo',
        rcdWaveformType: 'AC',
        confidence: PER_SLOT_OVERRIDE_THRESHOLD,
      },
    ];
    a.circuits = [{ circuit_number: 1, slot_index: 0, rcd_protected: true, rcd_type: 'AC' }];
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.kept).toBe(1);
    expect(r.overridden).toBe(0);
    expect(a.circuits[0].rcd_type).toBe('AC');
  });

  test('still applies when no previous read exists', () => {
    const a = makeAnalysis({
      board_manufacturer: 'Wylex',
      board_model: 'UNKNOWN_MODEL',
    });
    a.slots = [];
    a.circuits = [{ circuit_number: 1, slot_index: 0, rcd_protected: true, rcd_type: null }];
    applyRcdTypeLookup(a, { lookupPath });
    expect(a.circuits[0].rcd_type).toBe('A');
  });
});

describe('applyRcdTypeLookup — low confidence', () => {
  test('fills nulls only', () => {
    const a = makeAnalysis({
      board_manufacturer: 'Contactum',
      board_model: 'UNKNOWN',
    });
    a.slots = [];
    a.circuits = [
      { circuit_number: 1, slot_index: 0, rcd_protected: true, rcd_type: null },
      { circuit_number: 2, slot_index: 1, rcd_protected: true, rcd_type: 'AC' },
    ];
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.applied).toBe(1);
    expect(r.kept).toBe(1);
    expect(a.circuits[0].rcd_type).toBe('A');
    expect(a.circuits[1].rcd_type).toBe('AC');
  });
});

describe('applyRcdTypeLookup — miss / no_type outcomes', () => {
  test('miss is a no-op', () => {
    const a = makeAnalysis({
      board_manufacturer: 'Unknown Co',
      board_model: 'X1',
    });
    const beforeJson = JSON.stringify(a);
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.outcome).toBe('miss');
    expect(r.applied).toBe(0);
    expect(JSON.stringify(a)).toBe(beforeJson);
  });

  test('manufacturer entry with null rcd_type is no_type and no-op', () => {
    const a = makeAnalysis({ board_manufacturer: 'Hager', board_model: 'UNKNOWN' });
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.outcome).toBe('no_type');
    expect(r.applied).toBe(0);
  });
});

describe('applyRcdTypeLookup — ways cross-check', () => {
  test('warns when detected module count differs from datasheet ways', () => {
    const a = makeAnalysis();
    a.geometric.moduleCount = 14; // datasheet says 15
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.ways_warning).toMatch(/detected 14.*expects 15/);
  });

  test('no warning when counts match', () => {
    const a = makeAnalysis();
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.ways_warning).toBeNull();
  });
});

describe('applyRcdTypeLookup — robustness', () => {
  test('handles missing slots / circuits arrays', () => {
    const a = { board_manufacturer: 'Elucian', board_model: 'CU1SPD275' };
    const r = applyRcdTypeLookup(a, { lookupPath });
    expect(r.outcome).toBe('hit');
    expect(r.applied).toBe(0);
  });

  test('logs through the provided logger', () => {
    const calls = [];
    const logger = {
      info: (msg, fields) => calls.push({ msg, fields }),
    };
    applyRcdTypeLookup(makeAnalysis(), { logger, userId: 'u1', lookupPath });
    expect(calls.length).toBeGreaterThan(0);
    const applied = calls.find((c) => c.msg === 'RCD type lookup applied');
    expect(applied).toBeDefined();
    expect(applied.fields.userId).toBe('u1');
    expect(applied.fields.outcome).toBe('hit');
    expect(applied.fields.matchedKey).toBe('elucian/CU1SPD275');
  });
});
