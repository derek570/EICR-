/**
 * Phase 5 — sticky-columns circuits table.
 *
 * Asserts:
 *   1. Renders one row per circuit with the Ref + Designation cells
 *      placed in the sticky left column (via `position: sticky; left: 0`).
 *   2. Scrollable column cells dispatch patches on edit.
 *   3. Select fields (ocpd_type, polarity_confirmed, etc.) surface the
 *      correct options from the iOS schema.
 *   4. The per-row delete button calls onRemove with the circuit id.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock lucide-react to a minimal SVG — lucide 1.x resolves React via
// the workspace-root copy under vitest, which trips the "Invalid hook
// call" guard that `vitest.config.ts` documents. The sticky-table only
// uses lucide icons as decoration, so a stand-in <svg> is fine.
// `vi.mock` calls are hoisted above the `import` below; the factory
// is invoked lazily so it can safely reference `React` (pulled from
// the vite-resolved copy) after hoisting.
vi.mock('lucide-react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  const stub = (props: Record<string, unknown>) =>
    react.createElement('svg', { 'data-stub': 'lucide', ...props });
  // Explicitly export every icon the sticky-table uses so `import
  // { Trash2 } from 'lucide-react'` resolves to our stub rather than
  // picking up the real icon through the module resolver's fall-through.
  return {
    Trash2: stub,
    LayoutGrid: stub,
    Table2: stub,
    default: stub,
  };
});

import { CircuitsStickyTable } from '@/components/job/circuits-sticky-table';

function mount(element: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

beforeEach(() => {
  mounted = null;
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

const CIRCUITS = [
  {
    id: 'c1',
    circuit_ref: '1',
    circuit_designation: 'Upstairs lighting',
    ocpd_type: 'B',
    ocpd_rating_a: '6',
    measured_zs_ohm: '0.48',
  },
  {
    id: 'c2',
    circuit_ref: '2',
    circuit_designation: 'Sockets ring',
    ocpd_type: 'B',
    ocpd_rating_a: '32',
    polarity_confirmed: 'pass',
  },
];

describe('CircuitsStickyTable', () => {
  it('renders one row per circuit', () => {
    mounted = mount(
      <CircuitsStickyTable circuits={CIRCUITS} onPatch={() => {}} onRemove={() => {}} />
    );
    const rows = mounted.container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    const firstDesignation = mounted.container.querySelector(
      'input[aria-label="Circuit 1 designation"]'
    ) as HTMLInputElement | null;
    expect(firstDesignation).not.toBeNull();
    expect(firstDesignation!.value).toBe('Upstairs lighting');
  });

  it('sticks the Ref + Designation columns to the left', () => {
    mounted = mount(
      <CircuitsStickyTable circuits={CIRCUITS} onPatch={() => {}} onRemove={() => {}} />
    );
    const firstCells = mounted.container.querySelectorAll('tbody tr td');
    const styles = Array.from(firstCells)
      .slice(0, 2)
      .map((cell) => (cell as HTMLElement).className);
    expect(styles[0]).toContain('sticky');
    expect(styles[1]).toContain('sticky');
  });

  it('dispatches patches when a non-sticky cell is edited', () => {
    const onPatch = vi.fn();
    mounted = mount(
      <CircuitsStickyTable circuits={CIRCUITS} onPatch={onPatch} onRemove={() => {}} />
    );
    const zsInput = mounted.container.querySelector(
      'input[aria-label="Circuit 1 Meas Zs"]'
    ) as HTMLInputElement | null;
    expect(zsInput).not.toBeNull();
    act(() => {
      // React tracks inputs via the value property descriptor; setting
      // `.value` directly bypasses the tracker and `onChange` never
      // fires. Go through the prototype setter as the login-redirect
      // integration test documents.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(zsInput, '1.23');
      zsInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onPatch).toHaveBeenCalledWith('c1', { measured_zs_ohm: '1.23' });
  });

  it('renders select fields with card-aligned options so values round-trip between Cards and Table views', () => {
    mounted = mount(
      <CircuitsStickyTable circuits={CIRCUITS} onPatch={() => {}} onRemove={() => {}} />
    );
    const ocpdSelect = mounted.container.querySelector(
      'select[aria-label="Circuit 1 Type"]'
    ) as HTMLSelectElement | null;
    expect(ocpdSelect).not.toBeNull();
    const ocpdValues = Array.from(ocpdSelect!.options).map((o) => o.value);
    // Table OCPD options MUST match the card's OCPD_TYPES — any extra
    // value written here would appear as "unselected" when the user
    // toggles back to the card view and would be silently overwritten.
    expect(ocpdValues).toEqual(['', 'B', 'C', 'D']);

    const polaritySelect = mounted.container.querySelector(
      'select[aria-label="Circuit 1 Pol"]'
    ) as HTMLSelectElement | null;
    const polarityValues = Array.from(polaritySelect!.options).map((o) => o.value);
    expect(polarityValues).toEqual(['', 'pass', 'fail', 'na']);

    const rcdSelect = mounted.container.querySelector(
      'select[aria-label="Circuit 1 RCD Type"]'
    ) as HTMLSelectElement | null;
    const rcdValues = Array.from(rcdSelect!.options).map((o) => o.value);
    expect(rcdValues).toEqual(['', 'AC', 'A', 'B', 'F']);
  });

  it('calls onRemove when the per-row trash icon is clicked', () => {
    const onRemove = vi.fn();
    mounted = mount(
      <CircuitsStickyTable circuits={CIRCUITS} onPatch={() => {}} onRemove={onRemove} />
    );
    const removeBtn = mounted.container.querySelector(
      'button[aria-label="Remove circuit 2"]'
    ) as HTMLButtonElement | null;
    expect(removeBtn).not.toBeNull();
    act(() => {
      removeBtn!.click();
    });
    expect(onRemove).toHaveBeenCalledWith('c2');
  });
});
