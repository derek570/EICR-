/**
 * PLAN-F structural guard for the long free-text fields (feedback ids 135, 137).
 *
 * Derek, dictating an extent clause: *"the Text box is very difficult to use as
 * it does not grow with the text and you have to slide along."* The iOS half is
 * `CMFloatingTextEditor`; this is the web half — `MultilineField`'s opt-in
 * `autoGrow` variant.
 *
 * What is assertable HERE and what is not. The suite runs under jsdom
 * (`web/vitest.config.ts`), which implements no CSS layout: `scrollHeight`,
 * `clientHeight` and `offsetHeight` do not reflect rendering, so "renders at
 * the grown height" is unwritable in this runner. That assertion lives in
 * `tests-e2e/long-text-fields.spec.ts`, which drives a real browser. What this
 * file pins is the structure the fix depends on:
 *
 *   1. the grown variant renders a textarea with no fixed `rows` and no
 *      `resize-none`, with the 3/12-line bounds actually applied;
 *   2. the four owned call sites pass `autoGrow`;
 *   3. the five Installation callers do NOT — they are dated parity
 *      divergences, not part of this plan's evidence.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { MultilineField } from '../src/components/ui/multiline-field';

const repoWeb = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoWeb, p), 'utf8');

describe('MultilineField autoGrow variant', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(node: React.ReactElement) {
    act(() => root.render(node));
    const el = host.querySelector('textarea');
    if (!el) throw new Error('no textarea rendered');
    return el;
  }

  it('renders a textarea with no fixed rows and no resize-none', () => {
    const el = render(
      <MultilineField label="Extent" value="whole installation" onChange={() => {}} autoGrow />
    );
    // `rows` is what pins a textarea to a fixed height regardless of content —
    // the exact shape Derek complained about. React omits the attribute when
    // the prop is not passed; the DOM property then reports the UA default.
    expect(el.hasAttribute('rows')).toBe(false);
    expect(el.className).not.toContain('resize-none');
    expect(el.className).toContain('resize-y');
    // Growth has to stop somewhere, and past that it has to scroll rather
    // than clip.
    expect(el.className).toContain('overflow-y-auto');
  });

  it('bounds growth at 3 and 12 lines', () => {
    const el = render(<MultilineField label="Extent" value="" onChange={() => {}} autoGrow />);
    expect(el.style.lineHeight).toBe('24px');
    expect(el.style.minHeight).toBe('72px'); // 3 lines
    expect(el.style.maxHeight).toBe('288px'); // 12 lines
  });

  it('clears the imperative height when the variant is turned off', () => {
    // The textarea is reused across a variant flip, so a stale inline height
    // would outlive the variant that set it.
    const el = render(<MultilineField label="Extent" value="x" onChange={() => {}} autoGrow />);
    el.style.height = '192px';
    act(() =>
      root.render(<MultilineField label="Extent" value="x" onChange={() => {}} rows={4} />)
    );
    const after = host.querySelector('textarea')!;
    expect(after.style.height).toBe('');
  });

  it('leaves the fixed variant exactly as it was', () => {
    const el = render(
      <MultilineField label="Reason for report" value="x" onChange={() => {}} rows={3} />
    );
    expect(el.getAttribute('rows')).toBe('3');
    expect(el.className).toContain('resize-none');
    expect(el.style.maxHeight).toBe('');
  });

  it('still renders the character counter when asked', () => {
    act(() =>
      root.render(
        <MultilineField label="Extent" value="12345" onChange={() => {}} autoGrow showCount />
      )
    );
    expect(host.textContent).toContain('5 characters');
  });
});

describe('PLAN-F call-site scope', () => {
  it('the four long free-text fields use the grown variant', () => {
    const extent = read('src/app/job/[id]/extent/page.tsx');
    const design = read('src/app/job/[id]/design/page.tsx');
    // Two per page, and no fixed `rows` left behind on either.
    expect(extent.match(/autoGrow/g)?.length).toBe(2);
    expect(design.match(/autoGrow/g)?.length).toBe(2);
    expect(extent).not.toMatch(/rows=\{/);
    expect(design).not.toMatch(/rows=\{/);
  });

  it('the five Installation callers are unchanged', () => {
    const installation = read('src/app/job/[id]/installation/page.tsx');
    // Dated parity divergences (`installation/installationtab-155/-166/-177/
    // -180/-184`), owner Derek: their iOS counterparts DO grow, but choosing
    // each field's line bounds needs evidence this plan does not have.
    expect(installation).not.toContain('autoGrow');
    expect(installation.match(/rows=\{\d\}/g)?.length).toBe(5);
  });
});
