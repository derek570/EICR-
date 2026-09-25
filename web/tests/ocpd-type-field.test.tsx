/**
 * PLAN-C2 (feedback-2026-09-17 wave, Decision 6) — the web OCPD-type control:
 * free text with suggestions, canonicalise on commit, refuse (never truncate)
 * past 24 characters, the BS 1361 display alias that is never written back, and
 * the advisory marker. Mount strategy mirrors `ocpd-standard-field.test.tsx`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('lucide-react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  const stub = (props: Record<string, unknown>) =>
    react.createElement('svg', { 'data-stub': 'lucide', ...props });
  return { ChevronDown: stub, default: stub };
});

const { OcpdTypeField, OcpdTypeComboCell } = await import('@/components/job/ocpd-type-field');
const { OCPD_TYPE_SUGGESTIONS } = await import('@certmate/shared-utils');

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

const input = () => container.querySelector('input') as HTMLInputElement;

function type(value: string) {
  const el = input();
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
      el,
      value
    );
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function blur() {
  act(() => {
    input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

const marker = () => container.querySelector('[data-testid="ocpd-type-marker"]');

describe('OcpdTypeField — commit contract', () => {
  it('offers every suggestion and commits a pick', () => {
    const onCommit = vi.fn();
    mount(<OcpdTypeField value="" standard="BS EN 60898" onCommit={onCommit} />);
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual([...OCPD_TYPE_SUGGESTIONS]);
    const k = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'K')!;
    act(() => k.click());
    expect(onCommit).toHaveBeenCalledWith('K');
  });

  it('canonicalises on commit, never per keystroke, and stores an unknown value as typed', () => {
    const onCommit = vi.fn();
    mount(<OcpdTypeField value="" standard="BS 3871" onCommit={onCommit} />);
    type('type two');
    expect(onCommit).not.toHaveBeenCalled();
    blur();
    expect(onCommit).toHaveBeenLastCalledWith('2');
    type('Superfast-20');
    blur();
    expect(onCommit).toHaveBeenLastCalledWith('Superfast-20');
  });

  it('refuses a 25th character without truncating what is there', () => {
    mount(<OcpdTypeField value="" standard="" onCommit={() => {}} />);
    type('x'.repeat(24));
    expect(input().value).toHaveLength(24);
    type('x'.repeat(25));
    expect(input().value).toHaveLength(24);
  });

  it('shows the BS 1361 alias and never writes it back on a plain blur', () => {
    const onCommit = vi.fn();
    mount(<OcpdTypeField value="2" standard="BS 1361" onCommit={onCommit} />);
    expect(input().value).toBe('II');
    blur();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows the advisory marker for an incompatible or unknown pair, and none for a good one', () => {
    mount(<OcpdTypeField value="gG" standard="BS EN 60898" onCommit={() => {}} />);
    expect(marker()?.getAttribute('title')).toBe('may not be right for BS EN 60898');
    act(() => root.render(<OcpdTypeField value="Q" standard="BS EN 60898" onCommit={() => {}} />));
    expect(marker()?.getAttribute('title')).toBe('not a type I know');
    act(() => root.render(<OcpdTypeField value="B" standard="BS EN 60898" onCommit={() => {}} />));
    expect(marker()).toBeNull();
  });
});

describe('OcpdTypeComboCell — the grid form', () => {
  it('commits a typed value on blur and carries the marker', () => {
    const onCommit = vi.fn();
    mount(
      <OcpdTypeComboCell
        value="2"
        standard="BS EN 60898"
        onCommit={onCommit}
        ariaLabel="Circuit 1 Type"
        isOpen={false}
        onOpen={() => {}}
        onClose={() => {}}
      />
    );
    expect(marker()?.getAttribute('title')).toBe('may not be right for BS EN 60898');
    type('c');
    blur();
    expect(onCommit).toHaveBeenCalledWith('C');
  });
});
