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
 * That web LOSES the typing on a reload is a decision, not an oversight:
 * WAVE-CONTEXT.md § Decision 28a (TAKEN 2026-09-23, Derek). Web draft
 * persistence was already built in this repo and withdrawn — PLAN-B2's
 * `use-designation-draft.ts` grew a localStorage journal over review cycles
 * 1-8 and removed it in cycle 9, because its recovery path could not clear
 * what it recovered and a recovered draft could overwrite a NEWER value.
 * Rebuilding it would reintroduce a worse failure than the one it solves.
 *
 * So the assertions below pin exactly what Decision 28a says: web never
 * commits at an interruption. They do NOT claim that losing the typing is
 * ideal. Decision 28b later put iOS on the same rule — its local-only drafts
 * table was deleted — so the two clients are identical here, as recorded on
 * parity-ledger row `circuits/ocpd-bs-en-free-text-client`.
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

const { OcpdStandardField, OcpdStandardComboCell } =
  await import('@/components/job/ocpd-standard-field');
const { noteExternalOcpdWrite, purgeOcpdWriteEpochs } = await import('@/lib/ocpd-external-writes');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  purgeOcpdWriteEpochs();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(value: string, onCommit: (next: string) => void, circuitId?: string) {
  act(() => {
    root.render(React.createElement(OcpdStandardField, { value, onCommit, circuitId }));
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

  it('a SAME-VALUE external write still replaces the draft', () => {
    // Round 8's BLOCKER. `BS EN 60898` is committed, `3036` is typed but not
    // confirmed, and a correction re-applies `BS EN 60898`. The `value` prop
    // never changes, so watching it sees nothing — and the older typing would
    // commit over the standard the inspector was told had been applied.
    const onCommit = vi.fn();
    const input = mount('BS EN 60898', onCommit, 'circuit-1');
    typeInto(input, '3036');
    expect(input.value).toBe('3036');

    act(() => {
      noteExternalOcpdWrite('circuit-1');
    });

    expect(input.value).toBe('BS EN 60898');
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('an announcement for a DIFFERENT circuit leaves this draft alone', () => {
    const onCommit = vi.fn();
    const input = mount('BS EN 60898', onCommit, 'circuit-1');
    typeInto(input, '3036');

    act(() => {
      noteExternalOcpdWrite('circuit-2');
    });

    expect(input.value).toBe('3036');
  });

  it('clicking a suggestion after typing a prefix commits ONLY the suggestion', () => {
    // Round 9's IMPORTANT, and the only finding left that could put a wrong
    // value on a certificate. A pointer press moves focus before the click
    // handler runs, so the input's blur used to commit the half-typed text
    // first: type `60947`, click `BS EN 60947-4-1`, and `BS EN 60947` — a real
    // but DIFFERENT standard, canonical so it wears no marker — reached the job
    // on the way past.
    const onCommit = vi.fn();
    const input = mount('', onCommit, 'circuit-1');
    typeInto(input, '60947');

    const chip = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'BS EN 60947-2'
    );
    if (!chip) throw new Error('no suggestion chip rendered');

    // The real sequence, modelled as the browser does it: pointer down is what
    // moves focus, and a handler calling `preventDefault` on it is what stops
    // the move. So the blur only happens when the mousedown was NOT prevented
    // — firing it unconditionally would test nothing, since the fix works by
    // preventing it.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      chip.dispatchEvent(down);
    });
    if (!down.defaultPrevented) {
      act(() => {
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
    }
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(down.defaultPrevented).toBe(true);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('BS EN 60947-2');
    expect(onCommit).not.toHaveBeenCalledWith('BS EN 60947');
  });

  it('pressing the grid cell chevron after typing a prefix commits nothing', () => {
    // Round 10 BLOCKER: the chevron was the one control without the handler,
    // so opening the list committed `60947` as `BS EN 60947`.
    const onCommit = vi.fn();
    const onOpen = vi.fn();
    act(() => {
      root.render(
        React.createElement(OcpdStandardComboCell, {
          value: '',
          onCommit,
          circuitId: 'circuit-1',
          ariaLabel: 'OCPD BS EN',
          isOpen: false,
          onOpen,
          onClose: () => {},
        })
      );
    });
    const input = container.querySelector('input');
    if (!input) throw new Error('no input');
    typeInto(input, '60947');
    const chevron = container.querySelector('button[aria-haspopup="listbox"]');
    if (!chevron) throw new Error('no chevron');

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      chevron.dispatchEvent(down);
    });
    if (!down.defaultPrevented) {
      act(() => {
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
    }
    act(() => {
      chevron.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('EVERY button in both picker components keeps focus in the input on press', () => {
    // The card field is one surface; the combo cell is the other two (sticky
    // table and desktop schedule). Rendered with the list OPEN and the second
    // tier shown, so every control that exists is pressed. A button added
    // later without `keepFocusOnPress` fails here, not in the field.
    const pressAll = (buttons: HTMLButtonElement[]) =>
      buttons.map((b) => {
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        b.dispatchEvent(down);
        return {
          label: b.textContent || b.getAttribute('aria-label'),
          kept: down.defaultPrevented,
        };
      });

    act(() => {
      root.render(React.createElement(OcpdStandardField, { value: '', onCommit: () => {} }));
    });
    const tierToggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-expanded') === 'false'
    );
    act(() => {
      tierToggle?.click();
    });
    const card = pressAll(Array.from(container.querySelectorAll('button')));
    expect(card.length).toBeGreaterThan(8);
    expect(card.filter((r) => !r.kept)).toEqual([]);

    act(() => {
      root.render(
        React.createElement(OcpdStandardComboCell, {
          value: '',
          onCommit: () => {},
          ariaLabel: 'OCPD BS EN',
          isOpen: true,
          onOpen: () => {},
          onClose: () => {},
        })
      );
    });
    const listbox = document.body.querySelector('ul[role="listbox"]');
    if (!listbox) throw new Error('the open list did not render');
    // Reveal Tier 2 in the list too, or its options are never pressed (round
    // 11 NIT: the first version of this test skipped them).
    const listToggle = Array.from(listbox.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-expanded') === 'false'
    );
    if (!listToggle) throw new Error('the list has no tier toggle');
    const beforeTier2 = listbox.querySelectorAll('button').length;
    act(() => {
      listToggle.click();
    });
    expect(listbox.querySelectorAll('button').length).toBeGreaterThan(beforeTier2);
    const grid = pressAll([
      ...Array.from(container.querySelectorAll('button')),
      ...Array.from(listbox.querySelectorAll('button')),
    ]);
    expect(grid.length).toBeGreaterThan(8);
    expect(grid.filter((r) => !r.kept)).toEqual([]);
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
