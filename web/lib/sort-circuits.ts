/**
 * sort-circuits.ts — Port of iOS Circuit.sortByCircuitRef()
 *
 * Sorts circuits by reference number, handling alphanumeric sub-refs:
 *   "1a" → (1, "a"), "10" → (10, ""), "DB1" → (nil, "DB1")
 * Numeric parts sort as integers (2 < 10, not lexicographic).
 * Sub-refs with same leading number sort alphabetically ("1a" < "1b").
 */

import type { Circuit } from './types';

/**
 * Split a circuit ref into leading integer + remainder.
 * e.g. "1a" → [1, "a"], "10" → [10, ""], "DB1" → [null, "DB1"]
 */
function leadingIntAndRemainder(ref: string): [number | null, string] {
  const match = ref.match(/^(\d+)(.*)/);
  if (match) {
    return [parseInt(match[1], 10), match[2].toLowerCase()];
  }
  return [null, ref.toLowerCase()];
}

/**
 * Sort circuits by their circuit_ref, handling sub-refs correctly.
 * Returns a new sorted array (never mutates the original).
 */
export function sortCircuitsByRef(circuits: Circuit[]): Circuit[] {
  return [...circuits].sort((a, b) => {
    const [aNum, aRem] = leadingIntAndRemainder(a.circuit_ref || '');
    const [bNum, bRem] = leadingIntAndRemainder(b.circuit_ref || '');

    // Both have numeric prefix — sort numerically
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum - bNum;
      // Same number — sort by remainder alphabetically
      return aRem.localeCompare(bRem);
    }

    // One has numeric prefix, the other doesn't — numeric first
    if (aNum !== null) return -1;
    if (bNum !== null) return 1;

    // Neither has numeric prefix — alphabetical
    return aRem.localeCompare(bRem);
  });
}
