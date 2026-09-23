/**
 * PLAN-CC recovery (WAVE-CONTEXT.md § Decision 28, TAKEN 2026-09-23, Derek) —
 * the WEB half of the interrupted-draft contract.
 *
 * Decision 28 rule 1: an OCPD standard the inspector is still typing must
 * never become the certificate value until a REAL commit — focus loss, Enter,
 * or a suggestion tap. iOS needed new machinery for this, because `saveNow()`
 * at backgrounding flushed the draft through the canonicaliser and turned
 * `60947` into `BS EN 60947`: a real but DIFFERENT device standard which, being
 * canonical, wears no compatibility marker and would print looking correct.
 *
 * Web needs none, and these tests are why. `onCommit` is reachable only from
 * `commit`, and `commit` is reachable only from blur, Enter and a suggestion
 * tap — there is no backgrounding flush, no unmount commit and no
 * `beforeunload` handler. That is a structural property worth pinning rather
 * than re-deriving, because the next person to add an autosave to this control
 * is the one who would break it.
 *
 * The honest divergence is recorded on parity-ledger row
 * `circuits/ocpd-bs-en-free-text-client`: iOS RESTORES an interrupted draft
 * when the job reopens (persisted to a local-only table); web's draft is React
 * state and does not survive a page reload. Nothing wrong reaches a certificate
 * either way — web loses the typing where iOS keeps it.
 *
 * Mount strategy mirrors `ocpd-standard-field.test.tsx` — inline `createRoot`.
 * `@testing-library/react` resolves through the monorepo root and brings a
 * SECOND React copy, which makes every hook call throw.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('lucide-react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  const stub = (props: Record<string, unknown>) =>
    react.createElement('svg', { 'data-stub': 'lucide', ...props });
  return { ChevronDown: stub, default: stub };
});

const { OcpdStandardField } = await import('@/components/job/ocpd-standard-field');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(value: string, onCommit: (next: string) => void) {
  act(() => {
    root.render(React.createElement(OcpdStandardField, { value, onCommit }));
  });
  const input = container.querySelector('input');
  if (!input) throw new Error('the control rendered no input');
  return input;
}

/** Type one character, the way the control receives it from the DOM. */
function typeInto(input: HTMLInputElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, next);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PLAN-CC Decision 28 — web never commits an interrupted draft', () => {
  it('types the whole of 60947-4-1 without committing once', () => {
    const onCommit = vi.fn();
    const input = mount('', onCommit);

    for (let n = 1; n <= '60947-4-1'.length; n++) {
      typeInto(input, '60947-4-1'.slice(0, n));
    }

    // Not once. On iOS this is exactly where the debounced save fired and the
    // `60947` prefix reached the certificate.
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('60947-4-1');
  });

  it('commits the canonical value only at blur, and only once', () => {
    const onCommit = vi.fn();
    const input = mount('', onCommit);
    typeInto(input, '60947-4-1');

    act(() => {
      // React delegates onBlur from the bubbling `focusout`, not `blur`;
      // dispatching `blur` here passes silently and proves nothing.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('BS EN 60947-4-1');
  });

  it('unmounting mid-typing commits NOTHING — the prefix is lost, never stored', () => {
    const onCommit = vi.fn();
    const input = mount('', onCommit);
    typeInto(input, '60947');

    act(() => root.unmount());
    root = createRoot(container); // so afterEach's unmount stays valid

    // `60947` canonicalises to `BS EN 60947`, a real but different standard
    // carrying no marker. Losing the prefix is the correct outcome; storing it
    // is the defect Decision 28 exists to prevent.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('an external write mid-typing replaces the draft — the correction wins', () => {
    const onCommit = vi.fn();
    const input = mount('', onCommit);
    typeInto(input, '3036');

    // A dictated correction lands underneath, as Decision 28 rule 2 requires.
    act(() => {
      root.render(React.createElement(OcpdStandardField, { value: 'BS EN 60898', onCommit }));
    });

    expect(input.value).toBe('BS EN 60898');

    // And a later blur cannot resurrect the typed value over it.
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
