/**
 * Unit tests for `promoteLabelMatchedMainSwitch` — the post-Stage-4 fix
 * that catches the case where Stage 3 mis-classifies a main-switch slot
 * as RCBO/MCB but Stage 4 reads "Main Switch" off the device face.
 *
 * Without this promotion, the slot survives `slotsToCircuits` and
 * appears as circuit #1 with label "Main Switch" — production
 * extraction `1777975403777-zvdpli` (Elucian CU1SPD275, 2026-05-05).
 *
 * Module setup mirrors `ccu-route-merger.test.js` — same mocks for
 * storage / queue / DB so the route module imports cleanly without
 * pulling in any production side-effects.
 */
import { jest } from '@jest/globals';
import { describe, test, expect, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn().mockResolvedValue(true),
  uploadFile: jest.fn().mockResolvedValue(true),
  uploadBytes: jest.fn().mockResolvedValue(true),
  uploadText: jest.fn().mockResolvedValue(true),
  downloadBytes: jest.fn().mockResolvedValue(null),
  downloadText: jest.fn().mockResolvedValue(''),
  isUsingS3: jest.fn().mockReturnValue(false),
  getSignedUrl: jest.fn().mockResolvedValue('https://example.com/signed'),
  getJsonObject: jest.fn().mockResolvedValue(null),
  listObjects: jest.fn().mockResolvedValue([]),
}));

jest.unstable_mockModule('../queue.js', () => ({
  getConnection: jest.fn().mockReturnValue({
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
  }),
  isRedisAvailable: jest.fn().mockReturnValue(false),
  enqueueJob: jest.fn().mockResolvedValue(undefined),
  startWorker: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../db.js', () => ({
  getDb: jest.fn().mockReturnValue({
    prepare: jest.fn().mockReturnValue({
      get: jest.fn(),
      all: jest.fn().mockReturnValue([]),
      run: jest.fn(),
    }),
  }),
}));

let promoteLabelMatchedMainSwitch;

beforeAll(async () => {
  const mod = await import('../routes/extraction.js');
  promoteLabelMatchedMainSwitch = mod.promoteLabelMatchedMainSwitch;
});

describe('promoteLabelMatchedMainSwitch — labels that should promote', () => {
  test.each([
    'Main Switch',
    'main switch',
    '  Main Switch  ',
    'MAIN SWITCH',
    'Main switch',
    'Mains Switch',
    'Main Isolator',
    'Isolator',
    'Switch Disconnector',
    'Main Isol.',
    'Main Isol',
  ])('promotes RCBO slot with label %p', (label) => {
    const slots = [{ slotIndex: 0, classification: 'rcbo', label, labelConfidence: 0.9 }];
    const promoted = promoteLabelMatchedMainSwitch(slots);
    expect(promoted).toBe(1);
    expect(slots[0].classification).toBe('main_switch');
    expect(slots[0]._originalClassification).toBe('rcbo');
    expect(slots[0]._promotedToMainSwitchByLabel).toBe(true);
  });

  test('promotes mcb / rcd / unknown classifications too', () => {
    const slots = [
      { slotIndex: 0, classification: 'mcb', label: 'Main Switch' },
      { slotIndex: 1, classification: 'rcd', label: 'Main Switch' },
      { slotIndex: 2, classification: 'unknown', label: 'Main Switch' },
    ];
    expect(promoteLabelMatchedMainSwitch(slots)).toBe(3);
    expect(slots[0].classification).toBe('main_switch');
    expect(slots[1].classification).toBe('main_switch');
    expect(slots[2].classification).toBe('main_switch');
  });

  test('promotes from labelRaw when label is null', () => {
    const slots = [
      {
        slotIndex: 0,
        classification: 'rcbo',
        label: null,
        labelRaw: 'Main Switch',
      },
    ];
    expect(promoteLabelMatchedMainSwitch(slots)).toBe(1);
    expect(slots[0].classification).toBe('main_switch');
  });
});

describe('promoteLabelMatchedMainSwitch — labels that should NOT promote', () => {
  test.each([
    'Hot Tub Switch',
    'Garage Switch',
    'Kitchen Sockets',
    'Outside Lights',
    null,
    undefined,
    '',
    '   ',
    'Switched Spur',
    'Boiler Switch',
    'Pump Isolation',
    // The lookalike "Mains" alone isn't a main-switch identifier.
    'Mains',
    // 'Main' alone isn't enough either.
    'Main',
  ])('does NOT promote slot with label %p', (label) => {
    const slots = [{ slotIndex: 0, classification: 'rcbo', label, labelConfidence: 0.9 }];
    const promoted = promoteLabelMatchedMainSwitch(slots);
    expect(promoted).toBe(0);
    expect(slots[0].classification).toBe('rcbo');
    expect(slots[0]._promotedToMainSwitchByLabel).toBeUndefined();
  });
});

describe('promoteLabelMatchedMainSwitch — non-circuit classifications skipped', () => {
  test.each(['main_switch', 'spd', 'blank', 'empty'])(
    'leaves %s slot alone even when label says Main Switch',
    (cls) => {
      const slots = [{ slotIndex: 0, classification: cls, label: 'Main Switch' }];
      expect(promoteLabelMatchedMainSwitch(slots)).toBe(0);
      expect(slots[0].classification).toBe(cls);
      expect(slots[0]._promotedToMainSwitchByLabel).toBeUndefined();
    }
  );

  test('idempotent on re-invocation', () => {
    const slots = [{ slotIndex: 0, classification: 'rcbo', label: 'Main Switch' }];
    expect(promoteLabelMatchedMainSwitch(slots)).toBe(1);
    expect(promoteLabelMatchedMainSwitch(slots)).toBe(0);
    expect(slots[0].classification).toBe('main_switch');
  });
});

describe('promoteLabelMatchedMainSwitch — production-shape slot list', () => {
  // Mirrors the failing 2026-05-05 extraction (1777975403777-zvdpli):
  // Elucian CU1SPD275, 15 slots — slot 0 SPD, slots 1-13 should be RCBOs,
  // slot 14 main switch. Stage 3 misclassified slot 13 as RCBO. Stage 4
  // read "Main Switch" off slot 13's face (the device half of the 2-pole
  // main switch). Without promotion, slot 13 surfaces as circuit #1.
  test('demotes the misclassified main-switch half', () => {
    const slots = [
      { slotIndex: 0, classification: 'spd', label: null },
      { slotIndex: 1, classification: 'rcbo', label: 'Ovens' },
      { slotIndex: 2, classification: 'rcbo', label: 'Hob' },
      { slotIndex: 3, classification: 'rcbo', label: 'Utility Sockets' },
      { slotIndex: 4, classification: 'rcbo', label: 'Master Bed Sockets' },
      { slotIndex: 5, classification: 'rcbo', label: 'Garage Sockets' },
      { slotIndex: 6, classification: 'rcbo', label: 'Kitchen Sockets' },
      { slotIndex: 7, classification: 'rcbo', label: 'RHS Bed Sockets' },
      { slotIndex: 8, classification: 'rcbo', label: 'Left Bed Sockets' },
      { slotIndex: 9, classification: 'rcbo', label: 'Bathroom Underfloor Heating' },
      { slotIndex: 10, classification: 'rcbo', label: 'Rear Bed Sockets' },
      { slotIndex: 11, classification: 'rcbo', label: 'Lounge Tv Socket' },
      { slotIndex: 12, classification: 'rcbo', label: 'Loft Socket' },
      { slotIndex: 13, classification: 'rcbo', label: 'Main Switch' }, // misclassified
      { slotIndex: 14, classification: 'main_switch', label: 'Main Switch' },
    ];
    const promoted = promoteLabelMatchedMainSwitch(slots);
    expect(promoted).toBe(1);
    expect(slots[13].classification).toBe('main_switch');
    expect(slots[13]._originalClassification).toBe('rcbo');
    // Real RCBOs untouched
    expect(slots[1].classification).toBe('rcbo');
    expect(slots[12].classification).toBe('rcbo');
    // Already-correctly-classified main switch untouched
    expect(slots[14].classification).toBe('main_switch');
    expect(slots[14]._originalClassification).toBeUndefined();
  });
});

describe('promoteLabelMatchedMainSwitch — robustness', () => {
  test('handles non-array input', () => {
    expect(promoteLabelMatchedMainSwitch(null)).toBeUndefined();
    expect(promoteLabelMatchedMainSwitch(undefined)).toBeUndefined();
  });

  test('handles empty array', () => {
    expect(promoteLabelMatchedMainSwitch([])).toBe(0);
  });

  test('handles slots with missing label fields gracefully', () => {
    const slots = [
      { slotIndex: 0, classification: 'rcbo' }, // no label, no labelRaw
      { slotIndex: 1, classification: 'rcbo', label: undefined },
      { slotIndex: 2, classification: 'rcbo', label: 123 }, // non-string
    ];
    expect(promoteLabelMatchedMainSwitch(slots)).toBe(0);
  });

  test('logs through provided logger', () => {
    const calls = [];
    const logger = { info: (msg, fields) => calls.push({ msg, fields }) };
    promoteLabelMatchedMainSwitch(
      [{ slotIndex: 5, classification: 'rcbo', label: 'Main Switch' }],
      { logger, userId: 'test-user' }
    );
    expect(calls.length).toBe(1);
    expect(calls[0].msg).toBe('Stage 3 main_switch promoted from label');
    expect(calls[0].fields).toMatchObject({
      userId: 'test-user',
      slotIndex: 5,
      previousClassification: 'rcbo',
      label: 'Main Switch',
    });
  });
});
