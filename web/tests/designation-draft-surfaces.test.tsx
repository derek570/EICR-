/**
 * PLAN-B2 (B2-2, web manual edits) — surface-level draft-buffer
 * behaviour on the two table surfaces.
 *
 * Contract: designation typing NEVER reaches the model (no onPatch per
 * keystroke — no mid-typing rewrite, and the debounced save can never
 * catch a half-typed raw value); blur commits ONCE through
 * onCommitDesignation; the desktop surface then runs its defaults
 * pipeline against the committed canonical shape.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same lucide stub as circuits-schedule-desktop.test.tsx — the real
// icons pull the monorepo-root-hoisted React CJS bundle and trip the
// 19.2.3/19.2.4 invalid-hook-call mismatch.
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
import { CircuitsStickyTable } from '@/components/job/circuits-sticky-table';
import { flushDesignationDrafts } from '@/lib/designation-drafts';

const CIRCUITS = [{ id: 'c1', circuit_ref: '1', circuit_designation: 'Cooker' }];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function designationInput(): HTMLInputElement {
  const el = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="Circuit 1 designation"]'
  );
  if (!el) throw new Error('designation input not found');
  return el;
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe.each([
  {
    name: 'desktop schedule',
    render: (
      onPatch: (id: string, p: Record<string, string>) => void,
      onCommit: (id: string, raw: string) => string
    ) => (
      <CircuitsScheduleDesktop
        circuits={CIRCUITS}
        onPatch={onPatch}
        onBulkPatch={() => {}}
        onRemove={() => {}}
        onCommitDesignation={onCommit}
      />
    ),
  },
  {
    name: 'sticky table',
    render: (
      onPatch: (id: string, p: Record<string, string>) => void,
      onCommit: (id: string, raw: string) => string
    ) => (
      <CircuitsStickyTable
        circuits={CIRCUITS}
        onPatch={onPatch}
        onRemove={() => {}}
        onCommitDesignation={onCommit}
      />
    ),
  },
])('$name — designation draft buffer', ({ render }) => {
  it('typing never patches the model; blur commits exactly once with the raw draft', () => {
    const onPatch = vi.fn();
    const onCommit = vi.fn((_id: string, raw: string) => raw);
    mount(render(onPatch, onCommit));
    const input = designationInput();
    act(() => {
      setNativeValue(input, 'Upstairs lighting circ');
    });
    act(() => {
      setNativeValue(input, 'Upstairs lighting circuit');
    });
    // No model patch mid-typing for the designation field.
    const designationPatches = onPatch.mock.calls.filter(
      (c) => typeof c[1] === 'object' && 'circuit_designation' in (c[1] as object)
    );
    expect(designationPatches).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
    // The draft renders live.
    expect(input.value).toBe('Upstairs lighting circuit');
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('c1', 'Upstairs lighting circuit');
  });

  it('a registry flush (flushSave/pagehide path) commits an open draft', () => {
    const onPatch = vi.fn();
    const onCommit = vi.fn((_id: string, raw: string) => raw);
    mount(render(onPatch, onCommit));
    act(() => {
      setNativeValue(designationInput(), 'Garage supply circuit');
    });
    act(() => {
      flushDesignationDrafts();
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('c1', 'Garage supply circuit');
    // Blur after the flush must NOT double-commit.
    act(() => {
      designationInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
