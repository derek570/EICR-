/**
 * Desktop circuits schedule — full-width view at ≥1280 px.
 *
 * Asserts:
 *   1. Renders one row per circuit, with Ref + Designation in sticky cells.
 *   2. Cell-level dropdowns open on click and patch with the selected option.
 *   3. Header click opens the bulk-fill popover with a preset dropdown.
 *   4. Apply with `skipSpare=true` calls onBulkPatch with the chosen value.
 *   5. The "Skip spare circuits" checkbox toggles, and unchecking it
 *      flows through to onBulkPatch.
 *   6. Free-text columns (numeric) show a text input in the bulk-fill
 *      popover, not a select.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  const stub = (props: Record<string, unknown>) =>
    react.createElement('svg', { 'data-stub': 'lucide', ...props });
  return {
    Trash2: stub,
    ChevronDown: stub,
    default: stub,
  };
});

import { CircuitsScheduleDesktop } from '@/components/job/circuits-schedule-desktop';

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
  },
  {
    id: 'c2',
    circuit_ref: '2',
    circuit_designation: 'Sockets ring',
    ocpd_type: 'B',
    ocpd_rating_a: '32',
  },
  {
    id: 'c3',
    circuit_ref: '3',
    circuit_designation: 'Spare',
  },
];

describe('CircuitsScheduleDesktop', () => {
  it('renders one row per circuit with sticky Ref + Designation cells', () => {
    mounted = mount(
      <CircuitsScheduleDesktop
        circuits={CIRCUITS}
        onPatch={() => {}}
        onBulkPatch={() => {}}
        onRemove={() => {}}
      />
    );
    const rows = mounted.container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
    const stickyCells = mounted.container.querySelectorAll('tbody tr:first-child td');
    expect((stickyCells[0] as HTMLElement).className).toContain('sticky');
    expect((stickyCells[1] as HTMLElement).className).toContain('sticky');
  });

  it('opens a cell dropdown and patches the picked option', () => {
    const onPatch = vi.fn();
    mounted = mount(
      <CircuitsScheduleDesktop
        circuits={CIRCUITS}
        onPatch={onPatch}
        onBulkPatch={() => {}}
        onRemove={() => {}}
      />
    );
    const trigger = mounted.container.querySelector(
      'button[aria-label="Circuit 1 Type"]'
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.click();
    });
    const listbox = mounted.container.querySelector('ul[role="listbox"]');
    expect(listbox).not.toBeNull();
    const optionD = Array.from(listbox!.querySelectorAll('button[role="option"]')).find(
      (b) => (b as HTMLElement).textContent?.trim() === 'D'
    ) as HTMLButtonElement | undefined;
    expect(optionD).toBeDefined();
    act(() => {
      optionD!.click();
    });
    expect(onPatch).toHaveBeenCalledWith('c1', { ocpd_type: 'D' });
  });

  it('column-header click opens a bulk-fill popover with a preset select', () => {
    mounted = mount(
      <CircuitsScheduleDesktop
        circuits={CIRCUITS}
        onPatch={() => {}}
        onBulkPatch={() => {}}
        onRemove={() => {}}
      />
    );
    const header = Array.from(mounted.container.querySelectorAll('thead th button')).find((b) =>
      b.textContent?.includes('OCPD BS/EN')
    ) as HTMLButtonElement | undefined;
    expect(header).toBeDefined();
    act(() => {
      header!.click();
    });
    const dialog = mounted.container.querySelector('div[role="dialog"]');
    expect(dialog).not.toBeNull();
    const select = dialog!.querySelector('select') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.value).toBe('BS EN 60898');
  });

  it('applies bulk fill with skipSpare=true by default', () => {
    const onBulkPatch = vi.fn();
    mounted = mount(
      <CircuitsScheduleDesktop
        circuits={CIRCUITS}
        onPatch={() => {}}
        onBulkPatch={onBulkPatch}
        onRemove={() => {}}
      />
    );
    const header = Array.from(mounted.container.querySelectorAll('thead th button')).find((b) =>
      b.textContent?.includes('Type')
    ) as HTMLButtonElement | undefined;
    act(() => {
      header!.click();
    });
    const dialog = mounted.container.querySelector('div[role="dialog"]')!;
    const select = dialog.querySelector('select') as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      )!.set!;
      setter.call(select, 'C');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const apply = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === 'Apply'
    ) as HTMLButtonElement;
    act(() => {
      apply.click();
    });
    expect(onBulkPatch).toHaveBeenCalledWith('ocpd_type', 'C', { skipSpare: true });
  });

  it('uncheck "Skip spare circuits" flows through to onBulkPatch', () => {
    const onBulkPatch = vi.fn();
    mounted = mount(
      <CircuitsScheduleDesktop
        circuits={CIRCUITS}
        onPatch={() => {}}
        onBulkPatch={onBulkPatch}
        onRemove={() => {}}
      />
    );
    const header = Array.from(mounted.container.querySelectorAll('thead th button')).find((b) =>
      b.textContent?.includes('RCD Type')
    ) as HTMLButtonElement;
    act(() => {
      header.click();
    });
    const dialog = mounted.container.querySelector('div[role="dialog"]')!;
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    act(() => {
      checkbox.click();
    });
    expect(checkbox.checked).toBe(false);
    const apply = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === 'Apply'
    ) as HTMLButtonElement;
    act(() => {
      apply.click();
    });
    expect(onBulkPatch).toHaveBeenCalledWith('rcd_type', expect.any(String), { skipSpare: false });
  });

  it('free-text (numeric) column shows a text input in bulk-fill, not a select', () => {
    mounted = mount(
      <CircuitsScheduleDesktop
        circuits={CIRCUITS}
        onPatch={() => {}}
        onBulkPatch={() => {}}
        onRemove={() => {}}
      />
    );
    const header = Array.from(mounted.container.querySelectorAll('thead th button')).find((b) =>
      b.textContent?.includes('Live mm')
    ) as HTMLButtonElement | undefined;
    expect(header).toBeDefined();
    act(() => {
      header!.click();
    });
    const dialog = mounted.container.querySelector('div[role="dialog"]')!;
    expect(dialog.querySelector('select')).toBeNull();
    const input = dialog.querySelector('input[type="text"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.inputMode).toBe('decimal');
  });
});
