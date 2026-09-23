/**
 * PLAN-CC (feedback-2026-09-17 wave) — the OCPD-standard picker contract.
 *
 * Plan acceptance 4, on the web side. The three surfaces share one control and
 * one commit hook, so the rules are asserted once here and the sticky table and
 * desktop schedule inherit them by construction rather than by a copied
 * assertion.
 *
 * Mount strategy mirrors `job-row-swipe-delete.test.tsx` — inline `createRoot`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// lucide-react resolves through the monorepo root and brings a SECOND React
// copy with it, so its icons' `useContext` runs against the wrong instance and
// throws at render. Same stub the sticky-table suite uses.
vi.mock('lucide-react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  const stub = (props: Record<string, unknown>) =>
    react.createElement('svg', { 'data-stub': 'lucide', ...props });
  return { ChevronDown: stub, default: stub };
});

const { OcpdStandardField } = await import('@/components/job/ocpd-standard-field');
const { OCPD_BS_TIER1, OCPD_BS_TIER2, OCPD_BS_INPUT_CAP } =
  await import('@/lib/recording/ocpd-bs-suggestions.generated');

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(ui);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function input(): HTMLInputElement {
  return container.querySelector('input') as HTMLInputElement;
}

function chipLabels(): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
}

function type(value: string) {
  const el = input();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function blur() {
  // React delegates through `focusout`, not the non-bubbling `blur`.
  act(() => {
    input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('OcpdStandardField — suggestion tiers', () => {
  it('shows Tier 1 up front and Tier 2 only behind the disclosure', () => {
    mount(<OcpdStandardField value="" onCommit={() => {}} />);
    const before = chipLabels();
    for (const t1 of OCPD_BS_TIER1) expect(before).toContain(t1);
    for (const t2 of OCPD_BS_TIER2) expect(before).not.toContain(t2);
    expect(before).toContain('More standards');

    act(() => {
      (
        Array.from(container.querySelectorAll('button')).find(
          (b) => b.textContent === 'More standards'
        ) as HTMLButtonElement
      ).click();
    });

    const after = chipLabels();
    for (const t2 of OCPD_BS_TIER2) expect(after).toContain(t2);
    expect(after).toContain('Fewer standards');
  });

  it('offers NEITHER tier for the accepted-but-never-suggested standards', () => {
    // These are RCD standards. Dictating or typing one is accepted; putting
    // them on an OCPD picker would invite the wrong device on the certificate.
    mount(<OcpdStandardField value="" onCommit={() => {}} />);
    act(() => {
      (
        Array.from(container.querySelectorAll('button')).find(
          (b) => b.textContent === 'More standards'
        ) as HTMLButtonElement
      ).click();
    });
    for (const never of ['BS EN 61008', 'BS 4293', 'BS 7288']) {
      expect(chipLabels()).not.toContain(never);
    }
  });

  it('picking a chip commits that standard', () => {
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="" onCommit={onCommit} />);
    act(() => {
      (
        Array.from(container.querySelectorAll('button')).find(
          (b) => b.textContent === 'BS 3036'
        ) as HTMLButtonElement
      ).click();
    });
    expect(onCommit).toHaveBeenCalledWith('BS 3036');
  });
});

describe('OcpdStandardField — the commit contract', () => {
  it('accepts free text outside both tiers and stores it as typed', () => {
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="" onCommit={onCommit} />);
    type('BS 9999');
    blur();
    expect(onCommit).toHaveBeenCalledWith('BS 9999');
  });

  it('canonicalises a known form on commit, not per keystroke', () => {
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="" onCommit={onCommit} />);
    type('60898-1');
    // Nothing committed yet: canonicalising while typing would rewrite the
    // value under the cursor after five characters.
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe('60898-1');
    blur();
    expect(onCommit).toHaveBeenCalledWith('BS EN 60898');
  });

  it('stores an unreadable value exactly as typed — a human typed it deliberately', () => {
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="" onCommit={onCommit} />);
    type('88');
    blur();
    // `88` is a canonicalisation MISS (it cannot say which BS 88 part), but a
    // picker is a manual boundary with nobody to re-ask.
    expect(onCommit).toHaveBeenCalledWith('88');
  });

  it('refuses a PASTE that exceeds the cap, rather than truncating it', () => {
    // The native `maxLength` attribute this control used to carry truncated a
    // paste BEFORE React's onChange saw it, so a pasted 25-character standard
    // arrived already 24 characters long, passed the check and committed — the
    // control silently storing a different standard from the one pasted, which
    // is the exact outcome refuse-don't-truncate exists to prevent. jsdom's
    // property setter ignores `maxLength`, so the old test passed either way;
    // the assertion that discriminates is the absence of the attribute.
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="BS 3036" onCommit={onCommit} />);
    expect(input().hasAttribute('maxlength')).toBe(false);
    type('B'.repeat(OCPD_BS_INPUT_CAP + 1));
    expect(input().value).toBe('BS 3036');
    blur();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('refuses a 25th character WITHOUT changing the value already there', () => {
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="" onCommit={onCommit} />);
    const atCap = 'B'.repeat(OCPD_BS_INPUT_CAP);
    type(atCap);
    expect(input().value).toBe(atCap);
    type(atCap + 'X');
    // Refused, not truncated: truncating would silently store a different
    // standard from the one the inspector typed.
    expect(input().value).toBe(atCap);
    expect(input().value).toHaveLength(OCPD_BS_INPUT_CAP);
  });

  it('commits nothing when the value did not change', () => {
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="BS EN 60898" onCommit={onCommit} />);
    blur();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('clearing the field commits an empty string rather than a canonical miss', () => {
    const onCommit = vi.fn();
    mount(<OcpdStandardField value="BS EN 60898" onCommit={onCommit} />);
    type('');
    blur();
    expect(onCommit).toHaveBeenCalledWith('');
  });
});

describe('OcpdStandardComboCell — the grid form', () => {
  it('renders its suggestion list OUTSIDE the cell, so a scroll container cannot clip it', async () => {
    // The sticky table's wrapper is `overflow-x-auto`, which clips
    // absolutely-positioned descendants on BOTH axes: the tiers were in the
    // DOM and unreachable, so one of the three web surfaces effectively had no
    // suggestions. A portal escapes any container. This fails on the pre-fix
    // markup, where the list was an `absolute` child of the cell.
    const { OcpdStandardComboCell } = await import('@/components/job/ocpd-standard-field');
    mount(
      <div style={{ overflowX: 'auto' }}>
        <OcpdStandardComboCell
          value=""
          onCommit={() => {}}
          ariaLabel="Circuit 1 OCPD BS/EN"
          isOpen
          onOpen={() => {}}
          onClose={() => {}}
        />
      </div>
    );
    const list = document.querySelector('ul[role="listbox"]') as HTMLElement | null;
    expect(list).not.toBeNull();
    expect(container.contains(list)).toBe(false);
    expect(document.body.contains(list)).toBe(true);
    expect(list!.style.position).toBe('fixed');
    // Tier 1 is reachable from it, and Tier 2 is behind the disclosure.
    const labels = Array.from(list!.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toContain('BS EN 60898');
    expect(labels).toContain('More standards');
    // No manual removal: React owns the portal node and the afterEach unmount
    // takes it with the tree. Removing it here raced that teardown.
  });

  it("keeps a press on the list INSIDE the host's click-outside boundary", async () => {
    // The portal sits outside the grid's container, so a host mousedown
    // handler saw a press on a suggestion as an outside click and closed the
    // list before the button's click fired: the desktop schedule's tiers
    // looked selectable and never selected.
    const { OcpdStandardComboCell } = await import('@/components/job/ocpd-standard-field');
    const outside = vi.fn();
    document.addEventListener('mousedown', outside);
    mount(
      <OcpdStandardComboCell
        value=""
        onCommit={() => {}}
        ariaLabel="Circuit 1 OCPD BS/EN"
        isOpen
        onOpen={() => {}}
        onClose={() => {}}
      />
    );
    const list = document.querySelector('ul[role="listbox"]') as HTMLElement;
    const option = Array.from(list.querySelectorAll('button')).find(
      (b) => b.textContent === 'BS EN 60898'
    ) as HTMLButtonElement;
    act(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener('mousedown', outside);
  });

  it('flips the list ABOVE the cell when there is no room below it', async () => {
    // A fixed list does not extend the page's scroll area, so one placed below
    // a row near the bottom of the viewport falls off it and its options
    // cannot be reached at all.
    const { OcpdStandardComboCell } = await import('@/components/job/ocpd-standard-field');
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    const near = { left: 10, top: 560, bottom: 590, width: 140 };
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(near as DOMRect);
    mount(
      <OcpdStandardComboCell
        value=""
        onCommit={() => {}}
        ariaLabel="Circuit 1 OCPD BS/EN"
        isOpen
        onOpen={() => {}}
        onClose={() => {}}
      />
    );
    const list = document.querySelector('ul[role="listbox"]') as HTMLElement;
    // 600 - 590 - 4 = 6px below, 556px above — so it must render above the
    // cell's top rather than below its bottom.
    expect(parseFloat(list.style.top)).toBeLessThan(near.top);
    expect(parseFloat(list.style.maxHeight)).toBeGreaterThan(0);
    spy.mockRestore();
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true });
  });

  it('never places the list off the top of a SHORT viewport', async () => {
    // Forcing the preferred minimum height put the top at a negative
    // coordinate, and a fixed list cannot be scrolled back into view — the
    // options were unreachable in exactly the case the flip exists to rescue.
    const { OcpdStandardComboCell } = await import('@/components/job/ocpd-standard-field');
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 180, configurable: true });
    const cramped = { left: 10, top: 90, bottom: 130, width: 140 };
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(cramped as DOMRect);
    mount(
      <OcpdStandardComboCell
        value=""
        onCommit={() => {}}
        ariaLabel="Circuit 1 OCPD BS/EN"
        isOpen
        onOpen={() => {}}
        onClose={() => {}}
      />
    );
    const list = document.querySelector('ul[role="listbox"]') as HTMLElement;
    const top = parseFloat(list.style.top);
    const maxHeight = parseFloat(list.style.maxHeight);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight);
    spy.mockRestore();
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true });
  });
});
