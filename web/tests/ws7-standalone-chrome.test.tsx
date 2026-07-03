/**
 * WS7 — installed-mode ("standalone") chrome + splash continuity.
 *
 * jsdom can't emulate `display-mode: standalone`, `env(safe-area-inset-*)`,
 * `overscroll-behavior`, or `-webkit-tap-highlight-color` (no layout / no
 * PWA display mode), so the chrome suppressions are pinned at the SOURCE
 * level: the CSS rules must exist in `globals.css` and the safe-area class
 * must be applied to the AppShell header. The branded splash is a pure
 * component and is rendered for real. Device behaviour (actual overscroll /
 * tap-highlight / notch clearance on an iPhone in A2HS mode) is verified in
 * the two-phase device smoke — this suite is the regression lock that the
 * wiring is present.
 */

import * as React from 'react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { BrandedSplash } from '@/components/brand/branded-splash';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(resolve(here, '../src', rel), 'utf8');

let container: HTMLDivElement;
let root: Root;
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});

describe('BrandedSplash', () => {
  it('renders the CertMate wordmark and a status role', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<BrandedSplash />));
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-label')).toContain('CertMate');
    expect(container.textContent).toContain('CertMate');
    // The bolt.shield glyph is present.
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('globals.css standalone chrome rules', () => {
  const css = readSrc('app/globals.css');

  it('blocks overscroll chaining on html and body', () => {
    expect(css).toMatch(/html\s*\{[^}]*overscroll-behavior:\s*none/);
    expect(css).toContain('overscroll-behavior-y: none');
  });

  it('removes the tap-highlight flash', () => {
    expect(css).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
  });

  it('suppresses text-selection on chrome but keeps inputs selectable', () => {
    // chrome selector block sets user-select: none
    expect(css).toMatch(/\[role='toolbar'\][\s\S]*?user-select:\s*none/);
    // inputs/textareas explicitly re-enabled
    expect(css).toMatch(/input,[\s\S]*?textarea,[\s\S]*?user-select:\s*text/);
  });

  it('defines safe-area padding helpers', () => {
    expect(css).toMatch(/\.pt-safe\s*\{\s*padding-top:\s*env\(safe-area-inset-top/);
    expect(css).toMatch(/\.pb-safe\s*\{\s*padding-bottom:\s*env\(safe-area-inset-bottom/);
  });
});

describe('AppShell header safe-area', () => {
  it('applies the safe-area top padding class so the header clears the notch', () => {
    const shell = readSrc('components/layout/app-shell.tsx');
    // header carries pt-safe (and pl/pr for landscape notches)
    expect(shell).toMatch(/pt-safe/);
    // and grows rather than fixing height (so the inset is additive)
    expect(shell).toMatch(/min-h-14/);
  });
});
