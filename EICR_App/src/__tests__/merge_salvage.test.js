/**
 * Tests for merge_salvage module.
 */

import { mergeSalvageIntoRows } from '../merge_salvage.js';

describe('mergeSalvageIntoRows', () => {
  describe('basic functionality', () => {
    test('should return merged rows and empty unresolved for empty salvage', () => {
      const rows = [{ circuit_ref: '1', description: 'Lighting' }];
      const salvage = { values: [] };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged).toEqual(rows);
      expect(result.unresolved).toEqual([]);
    });

    test('should handle null salvage', () => {
      const rows = [{ circuit_ref: '1' }];

      const result = mergeSalvageIntoRows(rows, null);

      expect(result.merged).toEqual(rows);
      expect(result.unresolved).toEqual([]);
    });

    test('should handle undefined salvage', () => {
      const rows = [{ circuit_ref: '1' }];

      const result = mergeSalvageIntoRows(rows, undefined);

      expect(result.merged).toEqual(rows);
      expect(result.unresolved).toEqual([]);
    });

    test('should not mutate original rows', () => {
      const rows = [{ circuit_ref: '1', r1_r2: '' }];
      const salvage = { values: [{ circuit_ref: '1', test: 'r1_r2', value: '0.5' }] };
      const originalRows = JSON.parse(JSON.stringify(rows));

      mergeSalvageIntoRows(rows, salvage);

      expect(rows).toEqual(originalRows);
    });
  });

  describe('r1_r2 test merging', () => {
    test('should merge r1_r2 value into empty cell', () => {
      const rows = [{ circuit_ref: '1', r1_r2: '' }];
      const salvage = {
        values: [{ circuit_ref: '1', test: 'r1_r2', value: '0.35' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.35');
      expect(result.unresolved).toEqual([]);
    });

    test('should add unit if provided', () => {
      const rows = [{ circuit_ref: '1', r1_r2: '' }];
      const salvage = {
        values: [{ circuit_ref: '1', test: 'r1_r2', value: '0.35', unit: 'Ω' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.35 Ω');
    });

    test('should not overwrite existing r1_r2 value', () => {
      const rows = [{ circuit_ref: '1', r1_r2: '0.25' }];
      const salvage = {
        values: [{ circuit_ref: '1', test: 'r1_r2', value: '0.35' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.25');
      expect(result.unresolved.length).toBe(1);
      expect(result.unresolved[0].reason).toContain('already filled');
    });
  });

  describe('zs test merging', () => {
    test('should merge zs value into empty cell', () => {
      const rows = [{ circuit_ref: '2', zs: '' }];
      const salvage = {
        values: [{ circuit_ref: '2', test: 'zs', value: '0.50' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].zs).toBe('0.50');
    });
  });

  describe('ir test merging', () => {
    test('should merge ir value into ir_500v_mohm column', () => {
      const rows = [{ circuit_ref: '3', ir_500v_mohm: '' }];
      const salvage = {
        values: [{ circuit_ref: '3', test: 'ir', value: '>200' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].ir_500v_mohm).toBe('>200');
    });
  });

  describe('rcd_trip_time test merging', () => {
    test('should merge rcd_trip_time into rcd_trip_times_ms column', () => {
      const rows = [{ circuit_ref: '4', rcd_trip_times_ms: '' }];
      const salvage = {
        values: [{ circuit_ref: '4', test: 'rcd_trip_time', value: '18', unit: 'ms' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].rcd_trip_times_ms).toBe('18 ms');
    });
  });

  describe('circuit matching', () => {
    test('should match circuit_ref with string comparison', () => {
      const rows = [{ circuit_ref: '1' }, { circuit_ref: '2' }];
      const salvage = {
        values: [{ circuit_ref: '2', test: 'r1_r2', value: '0.40' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBeUndefined();
      expect(result.merged[1].r1_r2).toBe('0.40');
    });

    test('should handle numeric circuit_ref in salvage', () => {
      const rows = [{ circuit_ref: '1' }];
      const salvage = {
        values: [{ circuit_ref: 1, test: 'r1_r2', value: '0.30' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.30');
    });

    test('should trim whitespace when matching', () => {
      const rows = [{ circuit_ref: '  1  ' }];
      const salvage = {
        values: [{ circuit_ref: '1', test: 'r1_r2', value: '0.30' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.30');
    });

    test('should add to unresolved when circuit not found', () => {
      const rows = [{ circuit_ref: '1' }];
      const salvage = {
        values: [{ circuit_ref: '99', test: 'r1_r2', value: '0.30' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.unresolved.length).toBe(1);
      expect(result.unresolved[0].reason).toContain('Circuit not found');
    });
  });

  describe('validation and error handling', () => {
    test('should add to unresolved when circuit_ref is missing', () => {
      const rows = [{ circuit_ref: '1' }];
      const salvage = {
        values: [{ test: 'r1_r2', value: '0.30' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.unresolved.length).toBe(1);
      expect(result.unresolved[0].reason).toContain('Missing');
    });

    test('should add to unresolved when test is missing', () => {
      const rows = [{ circuit_ref: '1' }];
      const salvage = {
        values: [{ circuit_ref: '1', value: '0.30' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.unresolved.length).toBe(1);
      expect(result.unresolved[0].reason).toContain('Missing');
    });

    test('should add to unresolved when value is missing', () => {
      const rows = [{ circuit_ref: '1' }];
      const salvage = {
        values: [{ circuit_ref: '1', test: 'r1_r2' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.unresolved.length).toBe(1);
      expect(result.unresolved[0].reason).toContain('Missing');
    });

    test('should add to unresolved for unknown test type', () => {
      const rows = [{ circuit_ref: '1' }];
      const salvage = {
        values: [{ circuit_ref: '1', test: 'unknown_test', value: '123' }]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.unresolved.length).toBe(1);
      expect(result.unresolved[0].reason).toContain('Unknown test');
    });
  });

  describe('multiple values', () => {
    test('should merge multiple values for different circuits', () => {
      const rows = [
        { circuit_ref: '1', r1_r2: '' },
        { circuit_ref: '2', r1_r2: '' },
        { circuit_ref: '3', r1_r2: '' }
      ];
      const salvage = {
        values: [
          { circuit_ref: '1', test: 'r1_r2', value: '0.30' },
          { circuit_ref: '2', test: 'r1_r2', value: '0.35' },
          { circuit_ref: '3', test: 'r1_r2', value: '0.40' }
        ]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.30');
      expect(result.merged[1].r1_r2).toBe('0.35');
      expect(result.merged[2].r1_r2).toBe('0.40');
      expect(result.unresolved).toEqual([]);
    });

    test('should merge multiple test types for same circuit', () => {
      const rows = [
        { circuit_ref: '1', r1_r2: '', zs: '', ir_500v_mohm: '' }
      ];
      const salvage = {
        values: [
          { circuit_ref: '1', test: 'r1_r2', value: '0.30' },
          { circuit_ref: '1', test: 'zs', value: '0.50' },
          { circuit_ref: '1', test: 'ir', value: '>200' }
        ]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.30');
      expect(result.merged[0].zs).toBe('0.50');
      expect(result.merged[0].ir_500v_mohm).toBe('>200');
    });

    test('should handle mix of successful and failed merges', () => {
      const rows = [
        { circuit_ref: '1', r1_r2: '0.25' },  // Already has value
        { circuit_ref: '2', r1_r2: '' }
      ];
      const salvage = {
        values: [
          { circuit_ref: '1', test: 'r1_r2', value: '0.30' },  // Should fail
          { circuit_ref: '2', test: 'r1_r2', value: '0.35' },  // Should succeed
          { circuit_ref: '99', test: 'r1_r2', value: '0.40' }  // Should fail
        ]
      };

      const result = mergeSalvageIntoRows(rows, salvage);

      expect(result.merged[0].r1_r2).toBe('0.25');  // Unchanged
      expect(result.merged[1].r1_r2).toBe('0.35');  // Merged
      expect(result.unresolved.length).toBe(2);
    });
  });
});
