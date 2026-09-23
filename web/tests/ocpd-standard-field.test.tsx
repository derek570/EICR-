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
