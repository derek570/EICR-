/**
 * WS7 — haptic call-site wiring (2026-07-03).
 *
 * The generic `haptic()` helper is already covered by
 * `phase-9-haptic.test.ts`. This file locks the two NEW WS7 call sites
 * (parity with iOS `UIImpactFeedbackGenerator`) so the
 * `crosscutting/uiimpactfeedbackgenerator` ledger row cannot flip
 * without evidence the wiring exists:
 *
 *   1. Job tab-rail tap → `haptic('light')` — behavioural: render
 *      `JobTabNav`, click a tab, assert `navigator.vibrate(10)` fired
 *      (iOS JobDetailView.swift:190 fires `.light` on every tab tap).
 *   2. Gate-pass dispatch → `haptic('heavy')` immediately after
 *      `playSentForProcessingChime()` — the RecordingProvider is not
 *      unit-mountable (see transcript-gate-wiring.test.ts), so this is
 *      a source-adjacency assertion on the real `recording-context.tsx`
 *      (iOS DeepgramRecordingViewModel.playChime()).
 *   3. `playConfirmationChime()` stays SOUND-ONLY — behavioural: call
 *      the real tone fn with a mocked `navigator.vibrate` and assert it
 *      is never invoked (iOS AlertManager.playConfirmationChime() is
 *      sound-only — no Taptic).
 *
 * Mount strategy mirrors `job-staff-tab.test.tsx` — inline `createRoot`
 * rather than RTL to dodge the React dual-copy hazard documented in
 * `vitest.config.ts`; module boundaries (lucide-react, next/link,
 * next/navigation, job-context) are stubbed so the render stays
 * unit-sized. `navigator.vibrate` is installed as a real spy so the
 * production `haptic()` helper runs unmocked end-to-end.
 */

import * as React from 'react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom lacks these; JobTabNav's indicator effect uses both.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
});

vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  // Explicit named exports (vitest enforces static named-export presence
  // on mocked ESM modules) — the full icon set used by job-tab-nav.tsx.
  return {
    AlertTriangle: makeIcon('AlertTriangle'),
    Boxes: makeIcon('Boxes'),
    ClipboardCheck: makeIcon('ClipboardCheck'),
    DraftingCompass: makeIcon('DraftingCompass'),
    FileText: makeIcon('FileText'),
    LayoutDashboard: makeIcon('LayoutDashboard'),
    List: makeIcon('List'),
    Ruler: makeIcon('Ruler'),
    Settings2: makeIcon('Settings2'),
    UserCheck: makeIcon('UserCheck'),
    Zap: makeIcon('Zap'),
  };
});

// next/link → plain anchor so a click stays in-DOM (no router navigation).
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({
    children,
    href,
    onClick,
    ...rest
  }: React.PropsWithChildren<{ href: string; onClick?: () => void }>) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

let pathnameStub = '/job/job_1';
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameStub,
}));

let certificateTypeStub: 'EICR' | 'EIC' = 'EICR';
vi.mock('@/lib/job-context', () => ({
  useJobContext: () => ({ certificateType: certificateTypeStub }),
}));

import { JobTabNav } from '@/components/job/job-tab-nav';
import { playConfirmationChime } from '@/lib/recording/tones';

const realNavigator = globalThis.navigator;

function installVibrate(): ReturnType<typeof vi.fn> {
  const vibrate = vi.fn(() => true);
  Object.defineProperty(globalThis, 'navigator', {
    value: { vibrate },
    configurable: true,
    writable: true,
  });
  return vibrate;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: realNavigator,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
});

describe('WS7 haptic call sites', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    pathnameStub = '/job/job_1';
    certificateTypeStub = 'EICR';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('job tab-rail tap fires haptic("light") → vibrate(10)', () => {
    const vibrate = installVibrate();
    act(() => {
      root.render(<JobTabNav jobId="job_1" />);
    });
    // Overview is the active tab (pathname === base); tap Circuits.
    const links = Array.from(container.querySelectorAll('a'));
    const circuits = links.find((a) => a.textContent?.includes('Circuits'));
    expect(circuits).toBeTruthy();
    act(() => {
      circuits!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('every tab tap fires a light haptic (not just the active one)', () => {
    const vibrate = installVibrate();
    act(() => {
      root.render(<JobTabNav jobId="job_1" />);
    });
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBeGreaterThan(3);
    // Tap three distinct tabs — each is one light pulse.
    for (const label of ['Supply', 'Board', 'Circuits']) {
      const link = links.find((a) => a.textContent?.includes(label));
      act(() => {
        link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    }
    expect(vibrate).toHaveBeenCalledTimes(3);
    expect(vibrate.mock.calls.every(([p]) => p === 10)).toBe(true);
  });

  it('playConfirmationChime() stays sound-only — never vibrates', () => {
    const vibrate = installVibrate();
    playConfirmationChime();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('recording-context gate-pass wires haptic("heavy") next to playSentForProcessingChime()', () => {
    // The RecordingProvider is not unit-mountable (transcript-gate-wiring.test.ts),
    // so pin the gate-pass adjacency at the source level: the heavy haptic
    // must fire immediately after the "sent for processing" chime.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../src/lib/recording-context.tsx'), 'utf8');
    // Same import style as the file's ./image-resize sibling import.
    expect(src).toContain("import { haptic } from './haptic'");
    // Adjacency: chime then heavy haptic, with only whitespace between.
    // Since B1 (pwa-replay-harness Wave 2) both effects are injectable —
    // the harness seams wrap them; production defaults are unchanged — so
    // the pinned shape is the seam-wrapped pair.
    expect(src).toMatch(
      /\(getRecordingTestServices\(\)\?\.chime \?\? playSentForProcessingChime\)\(\);\s*\n\s*\(getRecordingTestServices\(\)\?\.haptic \?\? haptic\)\('heavy'\);/
    );
  });

  it('recording-context does NOT haptic on the confirmation chime paths', () => {
    // playConfirmationChime is sound-only on iOS; ensure no haptic() was
    // bolted onto those call sites in recording-context.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../src/lib/recording-context.tsx'), 'utf8');
    // No `haptic(` appears on the same line as, or immediately after, a
    // playConfirmationChime() call.
    expect(src).not.toMatch(/playConfirmationChime\(\);\s*\n?\s*haptic\(/);
  });
});
