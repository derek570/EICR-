/**
 * WS7 — circuit keyboard accessory controller + nav + visibility.
 *
 * Layer 1 of the accessory coverage: the pure prev/next resolver, the
 * shared field constants, and the controller's visualViewport-driven
 * visibility + token-eligibility + Done/blur behaviour, exercised through
 * a tiny synthetic harness (the three real surfaces are covered in
 * `circuit-keyboard-accessory-surfaces.test.tsx`).
 *
 * Inline `createRoot` mount (react dual-copy hazard, per vitest.config.ts).
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeNavTarget,
  useCircuitAccessoryController,
  CIRCUIT_TOKEN_LIM,
  CIRCUIT_TOKEN_NA,
} from '@/components/job/circuit-keyboard-accessory';
import {
  IOS_CIRCUIT_FOCUSABLE_FIELDS,
  CIRCUIT_ACCESSORY_TOKEN_FIELDS,
  CIRCUIT_FOCUS_ORDER,
  WEB_EXTRA_CIRCUIT_KEYBOARD_FIELDS,
  orderCircuitFocusFields,
  isCircuitTokenField,
} from '@/components/job/circuit-focus-fields';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// ── visualViewport mock ────────────────────────────────────────────────
interface VVListeners {
  resize: Array<() => void>;
  scroll: Array<() => void>;
}
function installVisualViewport(height: number, offsetTop = 0) {
  const listeners: VVListeners = { resize: [], scroll: [] };
  const vv = {
    height,
    offsetTop,
    addEventListener: (type: 'resize' | 'scroll', cb: () => void) => {
      listeners[type].push(cb);
    },
    removeEventListener: (type: 'resize' | 'scroll', cb: () => void) => {
      listeners[type] = listeners[type].filter((f) => f !== cb) as never;
    },
    _set(next: { height?: number; offsetTop?: number }) {
      if (next.height != null) vv.height = next.height;
      if (next.offsetTop != null) vv.offsetTop = next.offsetTop;
      listeners.resize.forEach((f) => f());
    },
  };
  Object.defineProperty(window, 'visualViewport', {
    value: vv,
    configurable: true,
    writable: true,
  });
  return vv;
}
function clearVisualViewport() {
  Object.defineProperty(window, 'visualViewport', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

const originalInnerHeight = window.innerHeight;
function setInnerHeight(h: number) {
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true });
}

afterEach(() => {
  clearVisualViewport();
  setInnerHeight(originalInnerHeight);
  vi.restoreAllMocks();
});

// ── Synthetic harness ──────────────────────────────────────────────────
function Harness({
  circuitIds,
  fieldOrder,
  onToken,
}: {
  circuitIds: string[];
  fieldOrder: string[];
  onToken: (circuitId: string, fieldKey: string, token: string) => void;
}) {
  const refs = React.useRef<Record<string, HTMLInputElement | null>>({});
  const controller = useCircuitAccessoryController({
    circuitIds,
    fieldOrder,
    applyToken: onToken,
    focusField: (cid, fk) => refs.current[`${cid}::${fk}`]?.focus(),
  });
  return (
    <>
      {circuitIds.flatMap((cid) =>
        fieldOrder.map((fk) => (
          <input
            key={`${cid}::${fk}`}
            data-cell={`${cid}::${fk}`}
            ref={(el) => {
              refs.current[`${cid}::${fk}`] = el;
            }}
            {...controller.inputHandlers(cid, fk)}
          />
        ))
      )}
      {controller.accessory}
    </>
  );
}

let container: HTMLDivElement;
let root: Root;
function mountHarness(props: React.ComponentProps<typeof Harness>) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Harness {...props} />);
  });
}
function cell(sel: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[data-cell="${sel}"]`);
  if (!el) throw new Error(`no cell ${sel}`);
  return el;
}
function accessory(): HTMLElement | null {
  return container.querySelector('[data-testid="circuit-keyboard-accessory"]');
}
function btn(testid: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
}
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});

describe('circuit-focus-fields constants', () => {
  it('IOS focusable order is the exact 13-field iOS list', () => {
    expect(IOS_CIRCUIT_FOCUSABLE_FIELDS).toEqual([
      'circuit_ref',
      'circuit_designation',
      'number_of_points',
      'ocpd_max_zs_ohm',
      'ring_r1_ohm',
      'ring_rn_ohm',
      'ring_r2_ohm',
      'r1_r2_ohm',
      'r2_ohm',
      'ir_live_live_mohm',
      'ir_live_earth_mohm',
      'measured_zs_ohm',
      'rcd_time_ms',
    ]);
  });

  it('token fields = focusable minus ref/designation', () => {
    expect(CIRCUIT_ACCESSORY_TOKEN_FIELDS).not.toContain('circuit_ref');
    expect(CIRCUIT_ACCESSORY_TOKEN_FIELDS).not.toContain('circuit_designation');
    expect(CIRCUIT_ACCESSORY_TOKEN_FIELDS).toContain('measured_zs_ohm');
    expect(CIRCUIT_ACCESSORY_TOKEN_FIELDS).toHaveLength(11);
    expect(isCircuitTokenField('circuit_ref')).toBe(false);
    expect(isCircuitTokenField('measured_zs_ohm')).toBe(true);
    // web-extra fields never take tokens
    expect(isCircuitTokenField('ocpd_rating_a')).toBe(false);
  });

  it('canonical order leads with the 13 iOS fields then the web-extras', () => {
    expect(CIRCUIT_FOCUS_ORDER.slice(0, 13)).toEqual([...IOS_CIRCUIT_FOCUSABLE_FIELDS]);
    for (const f of WEB_EXTRA_CIRCUIT_KEYBOARD_FIELDS) {
      expect(CIRCUIT_FOCUS_ORDER).toContain(f);
    }
  });

  it('orderCircuitFocusFields sorts a surface subset by canonical order, not input order', () => {
    // Give it deliberately shuffled + a web-extra; the iOS spine must lead.
    const ordered = orderCircuitFocusFields([
      'measured_zs_ohm',
      'ocpd_rating_a',
      'number_of_points',
      'circuit_ref',
    ]);
    expect(ordered).toEqual([
      'circuit_ref',
      'number_of_points',
      'measured_zs_ohm',
      'ocpd_rating_a', // web-extra trails the iOS spine
    ]);
  });
});

describe('computeNavTarget', () => {
  const circuits = ['c1', 'c2'];
  const fields = ['circuit_ref', 'number_of_points', 'measured_zs_ohm'];

  it('moves to the next field within a circuit', () => {
    expect(
      computeNavTarget(circuits, fields, { circuitId: 'c1', fieldKey: 'circuit_ref' }, 1)
    ).toEqual({ circuitId: 'c1', fieldKey: 'number_of_points' });
  });

  it('wraps to the first field of the next circuit at the field-list edge', () => {
    expect(
      computeNavTarget(circuits, fields, { circuitId: 'c1', fieldKey: 'measured_zs_ohm' }, 1)
    ).toEqual({ circuitId: 'c2', fieldKey: 'circuit_ref' });
  });

  it('wraps backwards to the last field of the previous circuit', () => {
    expect(
      computeNavTarget(circuits, fields, { circuitId: 'c2', fieldKey: 'circuit_ref' }, -1)
    ).toEqual({ circuitId: 'c1', fieldKey: 'measured_zs_ohm' });
  });

  it('returns null at the very first cell (prev disabled)', () => {
    expect(
      computeNavTarget(circuits, fields, { circuitId: 'c1', fieldKey: 'circuit_ref' }, -1)
    ).toBeNull();
  });

  it('returns null at the very last cell (next disabled)', () => {
    expect(
      computeNavTarget(circuits, fields, { circuitId: 'c2', fieldKey: 'measured_zs_ohm' }, 1)
    ).toBeNull();
  });

  it('returns null for an unknown current cell or empty grid', () => {
    expect(computeNavTarget(circuits, fields, null, 1)).toBeNull();
    expect(
      computeNavTarget([], fields, { circuitId: 'c1', fieldKey: 'circuit_ref' }, 1)
    ).toBeNull();
    expect(
      computeNavTarget(circuits, fields, { circuitId: 'zzz', fieldKey: 'circuit_ref' }, 1)
    ).toBeNull();
  });
});

describe('controller visibility (visualViewport)', () => {
  const fields = ['circuit_ref', 'measured_zs_ohm'];

  it('focused input + NO viewport shrink → toolbar hidden', () => {
    setInnerHeight(800);
    installVisualViewport(800); // inset = 0
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::measured_zs_ohm').focus());
    expect(accessory()).toBeNull();
  });

  it('focused input + mocked keyboard shrink → toolbar shown at the keyboard inset', () => {
    setInnerHeight(800);
    installVisualViewport(500); // inset = 300
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::measured_zs_ohm').focus());
    const bar = accessory();
    expect(bar).not.toBeNull();
    expect((bar as HTMLElement).style.bottom).toBe('300px');
  });

  it('toolbar bottom offset tracks a keyboard-height change', () => {
    setInnerHeight(800);
    const vv = installVisualViewport(500); // inset 300
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::measured_zs_ohm').focus());
    expect((accessory() as HTMLElement).style.bottom).toBe('300px');
    // Keyboard shrinks (taller vv) → smaller inset → bar drops.
    act(() => vv._set({ height: 650 })); // inset 150
    expect((accessory() as HTMLElement).style.bottom).toBe('150px');
    // Keyboard dismissed entirely → inset 0 → hidden.
    act(() => vv._set({ height: 800 }));
    expect(accessory()).toBeNull();
  });
});

describe('controller token eligibility + actions', () => {
  const fields = ['circuit_ref', 'circuit_designation', 'measured_zs_ohm', 'ocpd_rating_a'];
  beforeEach(() => {
    setInnerHeight(800);
    installVisualViewport(500);
  });

  it('shows LIM/N/A for a token field and writes the tokens via applyToken', () => {
    const onToken = vi.fn();
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken });
    act(() => cell('c1::measured_zs_ohm').focus());
    expect(btn('accessory-lim')).not.toBeNull();
    expect(btn('accessory-na')).not.toBeNull();
    act(() => btn('accessory-lim')!.click());
    expect(onToken).toHaveBeenCalledWith('c1', 'measured_zs_ohm', CIRCUIT_TOKEN_LIM);
    act(() => btn('accessory-na')!.click());
    expect(onToken).toHaveBeenCalledWith('c1', 'measured_zs_ohm', CIRCUIT_TOKEN_NA);
  });

  it('hides LIM/N/A on circuit_ref and circuit_designation', () => {
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::circuit_ref').focus());
    expect(accessory()).not.toBeNull();
    expect(btn('accessory-lim')).toBeNull();
    expect(btn('accessory-na')).toBeNull();
    // prev/next still present
    expect(btn('accessory-next')).not.toBeNull();
    act(() => cell('c1::circuit_designation').focus());
    expect(btn('accessory-lim')).toBeNull();
  });

  it('web-extra field (ocpd_rating_a) gets prev/next/Done but NOT LIM/N/A', () => {
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::ocpd_rating_a').focus());
    expect(accessory()).not.toBeNull();
    expect(btn('accessory-lim')).toBeNull();
    expect(btn('accessory-na')).toBeNull();
    expect(btn('accessory-prev')).not.toBeNull();
    expect(btn('accessory-next')).not.toBeNull();
    expect(btn('accessory-done')).not.toBeNull();
  });

  it('prev/next move focus across the grid and Done blurs + hides', () => {
    mountHarness({ circuitIds: ['c1', 'c2'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::measured_zs_ohm').focus());
    // next → ocpd_rating_a (same circuit)
    act(() => btn('accessory-next')!.click());
    expect(document.activeElement).toBe(cell('c1::ocpd_rating_a'));
    // next again → wraps to first field of c2
    act(() => btn('accessory-next')!.click());
    expect(document.activeElement).toBe(cell('c2::circuit_ref'));
    // Done clears focus + hides bar
    act(() => btn('accessory-done')!.click());
    expect(accessory()).toBeNull();
  });

  it('prev is disabled at the very first cell', () => {
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::circuit_ref').focus());
    expect(btn('accessory-prev')!.disabled).toBe(true);
    expect(btn('accessory-next')!.disabled).toBe(false);
  });

  it('token/nav buttons preventDefault on pointerdown so the input keeps focus (blur-survival)', () => {
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::measured_zs_ohm').focus());
    const lim = btn('accessory-lim')!;
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => lim.dispatchEvent(ev));
    // Handler called preventDefault → the focused input would not blur.
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('controller fallback (no visualViewport, coarse pointer)', () => {
  const fields = ['circuit_ref', 'measured_zs_ohm'];
  it('renders on a coarse-pointer touch context via safe-area fallback', () => {
    clearVisualViewport();
    // matchMedia → coarse pointer true.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q.includes('coarse'),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }),
    });
    mountHarness({ circuitIds: ['c1'], fieldOrder: fields, onToken: vi.fn() });
    act(() => cell('c1::measured_zs_ohm').focus());
    const bar = accessory();
    // Renders on the coarse-pointer fallback path. (The env(safe-area-…)
    // bottom value is dropped by jsdom's CSSOM, so we assert presence +
    // the absence of a numeric px inset rather than the exact string.)
    expect(bar).not.toBeNull();
    expect((bar as HTMLElement).style.bottom).not.toMatch(/\d+px/);
  });
});
