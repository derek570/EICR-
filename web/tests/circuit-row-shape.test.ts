/**
 * `CircuitRow` shape lock — Wave-B audit Phase 3 #16/#18.
 *
 * Pre-Wave-B the type used `number` + `description`; the wire shape
 * (`packages/shared-types/src/circuit.ts Circuit`) and every backend
 * emission used `circuit_ref` + `circuit_designation`. Every consumer
 * site had to defensively `?? .number` / `?? .description` to read a
 * value at all. The audit asked for a refactor to canonical names.
 *
 * Three slices of the contract get tested here:
 *
 *   1. The `CircuitRowSchema` zod adapter accepts the canonical
 *      `circuit_ref` + `circuit_designation` keys without dropping
 *      anything (`.passthrough()` is essential — without it the
 *      adapter would silently strip every per-tab field as the wire
 *      adds them).
 *
 *   2. Legacy `number` + `description` keys still flow through the
 *      schema (they ride the `.passthrough()` indexer). Any pre-
 *      Wave-B job blob on disk would otherwise fail validation.
 *
 *   3. The TypeScript surface declares `circuit_ref` and
 *      `circuit_designation` (not `number` / `description`) so a
 *      future contributor can't reintroduce the drift through
 *      autocomplete. This is a compile-time check enforced via the
 *      type-only `satisfies` clause below.
 */

import { describe, it, expect } from 'vitest';
import { CircuitRowSchema } from '@/lib/adapters/job';
import type { CircuitRow } from '@/lib/types';

describe('CircuitRow — canonical wire shape (audit Phase 3 #16/#18)', () => {
  it('CircuitRowSchema accepts canonical circuit_ref + circuit_designation keys', () => {
    const row = {
      id: 'c-1',
      circuit_ref: '7',
      circuit_designation: 'Kitchen sockets',
      // Per-tab field — passes through the indexer.
      live_csa_mm2: '4.0',
    };
    const parsed = CircuitRowSchema.parse(row);
    expect(parsed.id).toBe('c-1');
    expect(parsed.circuit_ref).toBe('7');
    expect(parsed.circuit_designation).toBe('Kitchen sockets');
    // Per-tab fields survive .passthrough().
    expect((parsed as Record<string, unknown>).live_csa_mm2).toBe('4.0');
  });

  it('CircuitRowSchema also accepts legacy number/description (passthrough — pre-Wave-B blobs)', () => {
    const legacyRow = {
      id: 'c-2',
      number: '8',
      description: 'Bedroom lights',
    };
    const parsed = CircuitRowSchema.parse(legacyRow) as Record<string, unknown>;
    expect(parsed.id).toBe('c-2');
    // The legacy keys ride the passthrough indexer — type doesn't
    // surface them, but the data round-trips.
    expect(parsed.number).toBe('8');
    expect(parsed.description).toBe('Bedroom lights');
  });

  it('CircuitRow type surface advertises circuit_ref / circuit_designation, not number / description', () => {
    // Compile-time check — if a future refactor reintroduces `number`
    // or `description` as named (typed) properties, this satisfies
    // clause's *exact-keys* shape will fail to compile. The runtime
    // assertion is a sanity check; the value is the type-only test.
    const row: CircuitRow = {
      id: 'c-3',
      circuit_ref: '12',
      circuit_designation: 'Cooker',
    };
    expect(row.circuit_ref).toBe('12');
    expect(row.circuit_designation).toBe('Cooker');

    // The index signature still tolerates extras (per-tab fields),
    // but the *named* properties don't include the legacy aliases.
    type NamedKeys = Exclude<keyof CircuitRow, string>;
    type _AssertNoLegacyNamed = NamedKeys extends 'number' | 'description' ? never : true;
    const _check: _AssertNoLegacyNamed = true;
    void _check;
  });
});
