/**
 * WS7 — circuit keyboard accessory, per-surface wiring.
 *
 * Layer 2: proves the accessory is correctly wired into each of the three
 * circuit entry surfaces (plan requirement: card, sticky-table AND desktop
 * schedule). The sticky table and desktop schedule are mounted for real;
 * the card view lives inside the heavy `CircuitsPage` (job-context/router/
 * many hooks), so its collapsed-mount + auto-expand focus latch is covered
 * by a Tier-1 mirror of the page-level card wiring (same convention as
 * `transcript-gate-wiring.test.ts` mirrors `recording-context`). The deep
 * nav/visibility logic itself is unit-tested in
 * `circuit-keyboard-accessory.test.tsx`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// lucide-react resolves React via the workspace-root copy under vitest,
// tripping the dual-copy "Invalid hook call" guard (vitest.config.ts). The
// surfaces only use lucide icons as decoration, so stub them (mirrors
// phase-5-circuits-table.test.tsx).
vi.mock('lucide-react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  const stub = (props: Record<string, unknown>) =>
    react.createElement('svg', { 'data-stub': 'lucide', ...props });
  return { Trash2: stub, ChevronDown: stub, default: stub };
});

import { CircuitsStickyTable } from '@/components/job/circuits-sticky-table';
import { CircuitsScheduleDesktop } from '@/components/job/circuits-schedule-desktop';
import {
  useCircuitAccessoryController,
  CIRCUIT_TOKEN_LIM,
  CIRCUIT_TOKEN_NA,
} from '@/components/job/circuit-keyboard-accessory';
import { orderCircuitFocusFields } from '@/components/job/circuit-focus-fields';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// A keyboard is "shown" for the whole file so the accessory renders.
function installKeyboard() {
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: {
      height: 500,
      offsetTop: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

let container: HTMLDivElement;
let root: Root;
function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

function inputByAria(sub: string): HTMLInputElement {
  const inputs = Array.from(container.querySelectorAll('input'));
  const el = inputs.find((i) => (i.getAttribute('aria-label') ?? '').includes(sub));
  if (!el) throw new Error(`no input matching aria-label ~ "${sub}"`);
  return el as HTMLInputElement;
}
const bar = () => container.querySelector('[data-testid="circuit-keyboard-accessory"]');
const tbtn = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

// ── Real surface suites (sticky + desktop) ─────────────────────────────
// Matches the surfaces' `CircuitLike` ({ id: string; [k]: unknown }).
type TestCircuit = { id: string } & Record<string, string>;
interface SurfaceCfg {
  name: string;
  render: (
    circuits: TestCircuit[],
    onPatch: (id: string, patch: Record<string, string>) => void
  ) => React.ReactElement;
  // aria-label substrings for the cells we drive
  tokenCellAria: string; // measured_zs — token-eligible
  refCellAria: string; // circuit_ref — token-INeligible
  webExtraAria: string; // a web-extra keyboard field (ocpd_rating_a)
  tokenField: string; // field key expected in the patch
}

const circuits: TestCircuit[] = [
  { id: 'c1', circuit_ref: '1', circuit_designation: 'Lights' },
  { id: 'c2', circuit_ref: '2', circuit_designation: 'Sockets' },
];

const SURFACES: SurfaceCfg[] = [
  {
    name: 'sticky table',
    render: (cs, onPatch) => (
      <CircuitsStickyTable circuits={cs} onPatch={onPatch} onRemove={() => {}} />
    ),
    tokenCellAria: 'Circuit 1 Meas Zs',
    refCellAria: 'Circuit 1 reference',
    webExtraAria: 'Circuit 1 Rating A',
    tokenField: 'measured_zs_ohm',
  },
  {
    name: 'desktop schedule',
    render: (cs, onPatch) => (
      <CircuitsScheduleDesktop
        circuits={cs}
        onPatch={onPatch}
        onBulkPatch={() => {}}
        onRemove={() => {}}
      />
    ),
    tokenCellAria: 'Circuit 1 Meas Zs',
    refCellAria: 'Circuit 1 reference',
    // desktop's ocpd_rating_a column label is 'A' → "Circuit 1 A"
    webExtraAria: 'Circuit 1 A',
    tokenField: 'measured_zs_ohm',
  },
];

for (const cfg of SURFACES) {
  describe(`accessory wiring — ${cfg.name}`, () => {
    it('focusing a token cell shows the bar; LIM and N/A write the token via onPatch', () => {
      installKeyboard();
      const onPatch = vi.fn();
      mount(cfg.render(circuits, onPatch));
      act(() => inputByAria(cfg.tokenCellAria).focus());
      expect(bar()).not.toBeNull();
      expect(tbtn('accessory-lim')).not.toBeNull();
      act(() => tbtn('accessory-lim')!.click());
      expect(onPatch).toHaveBeenCalledWith('c1', { [cfg.tokenField]: CIRCUIT_TOKEN_LIM });
      act(() => tbtn('accessory-na')!.click());
      expect(onPatch).toHaveBeenCalledWith('c1', { [cfg.tokenField]: CIRCUIT_TOKEN_NA });
    });

    it('hides LIM/N/A on circuit_ref (token-ineligible) but still shows prev/next', () => {
      installKeyboard();
      mount(cfg.render(circuits, vi.fn()));
      act(() => inputByAria(cfg.refCellAria).focus());
      expect(bar()).not.toBeNull();
      expect(tbtn('accessory-lim')).toBeNull();
      expect(tbtn('accessory-na')).toBeNull();
      expect(tbtn('accessory-next')).not.toBeNull();
    });

    it('web-extra keyboard field gets prev/next/Done but NOT LIM/N/A', () => {
      installKeyboard();
      mount(cfg.render(circuits, vi.fn()));
      act(() => inputByAria(cfg.webExtraAria).focus());
      expect(bar()).not.toBeNull();
      expect(tbtn('accessory-lim')).toBeNull();
      expect(tbtn('accessory-na')).toBeNull();
      expect(tbtn('accessory-prev')).not.toBeNull();
      expect(tbtn('accessory-next')).not.toBeNull();
      expect(tbtn('accessory-done')).not.toBeNull();
    });

    it('prev from the first cell of the second circuit wraps back into the first circuit', () => {
      installKeyboard();
      mount(cfg.render(circuits, vi.fn()));
      act(() => inputByAria('Circuit 2 reference').focus());
      act(() => tbtn('accessory-prev')!.click());
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('aria-label') ?? '').toContain('Circuit 1');
    });

    it('Done blurs the input and hides the bar', () => {
      installKeyboard();
      mount(cfg.render(circuits, vi.fn()));
      act(() => inputByAria(cfg.tokenCellAria).focus());
      expect(bar()).not.toBeNull();
      act(() => tbtn('accessory-done')!.click());
      expect(bar()).toBeNull();
    });

    it('token/nav buttons preventDefault on mousedown (blur-survival)', () => {
      installKeyboard();
      mount(cfg.render(circuits, vi.fn()));
      act(() => inputByAria(cfg.tokenCellAria).focus());
      const next = tbtn('accessory-next')!;
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      act(() => next.dispatchEvent(ev));
      expect(ev.defaultPrevented).toBe(true);
    });
  });
}

// ── Card view — Tier-1 mirror of the page-level card wiring ────────────
// Reproduces CircuitsPage's card controller: collapsed cards mount NO
// inputs, focusField expands the target card and focuses the field once it
// mounts (pending-focus latch in registerCardRef). Keep in lockstep with
// web/src/app/job/[id]/circuits/page.tsx.
const CARD_FIELDS = orderCircuitFocusFields(['circuit_ref', 'number_of_points', 'measured_zs_ohm']);

// Applied tokens captured out-of-band (avoids mutating the component
// during render). Reset per test.
let cardMirrorPatches: Array<[string, Record<string, string>]> = [];

function CardMirror() {
  const ids = ['c1', 'c2'];
  const [expandedId, setExpandedId] = React.useState<string | null>('c1');
  const inputRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());
  const pending = React.useRef<{ circuitId: string; fieldKey: string } | null>(null);
  const key = (c: string, f: string) => `${c}::${f}`;

  const registerRef = React.useCallback((c: string, f: string, el: HTMLInputElement | null) => {
    const k = key(c, f);
    if (el) {
      inputRefs.current.set(k, el);
      const p = pending.current;
      if (p && p.circuitId === c && p.fieldKey === f) {
        pending.current = null;
        el.focus();
      }
    } else inputRefs.current.delete(k);
  }, []);
  const focusField = React.useCallback((c: string, f: string) => {
    const el = inputRefs.current.get(key(c, f));
    if (el) {
      el.focus();
      return;
    }
    pending.current = { circuitId: c, fieldKey: f };
    setExpandedId(c);
  }, []);
  const controller = useCircuitAccessoryController({
    circuitIds: ids,
    fieldOrder: CARD_FIELDS,
    applyToken: (c, f, t) => cardMirrorPatches.push([c, { [f]: t }]),
    focusField,
  });

  return (
    <div>
      {ids.map((c) => (
        <div key={c} data-card={c} data-expanded={expandedId === c}>
          {expandedId === c
            ? CARD_FIELDS.map((f) => (
                <input
                  key={f}
                  aria-label={`Circuit ${c} ${f}`}
                  data-cell={`${c}::${f}`}
                  ref={(el) => registerRef(c, f, el)}
                  {...controller.inputHandlers(c, f)}
                />
              ))
            : null}
        </div>
      ))}
      {controller.accessory}
    </div>
  );
}

describe('accessory wiring — card view (auto-expand latch mirror)', () => {
  it('Next from the last field of an expanded card auto-expands the next card and focuses its first field', () => {
    installKeyboard();
    mount(<CardMirror />);
    // Only c1 inputs are mounted (c2 collapsed).
    expect(container.querySelector('[data-cell="c2::circuit_ref"]')).toBeNull();
    // Focus the LAST focusable field of c1.
    const last = CARD_FIELDS[CARD_FIELDS.length - 1];
    act(() => inputByAria(`Circuit c1 ${last}`).focus());
    expect(bar()).not.toBeNull();
    // Next → wraps to c2's first field, which requires c2 to auto-expand.
    act(() => tbtn('accessory-next')!.click());
    const c2 = container.querySelector('[data-card="c2"]');
    expect(c2?.getAttribute('data-expanded')).toBe('true');
    expect(document.activeElement).toBe(container.querySelector('[data-cell="c2::circuit_ref"]'));
  });

  it('LIM writes the token on a token cell; ref cell shows no tokens', () => {
    installKeyboard();
    cardMirrorPatches = [];
    mount(<CardMirror />);
    act(() => inputByAria('Circuit c1 measured_zs_ohm').focus());
    expect(tbtn('accessory-lim')).not.toBeNull();
    act(() => tbtn('accessory-lim')!.click());
    expect(cardMirrorPatches).toContainEqual(['c1', { measured_zs_ohm: CIRCUIT_TOKEN_LIM }]);
    // ref cell → no tokens
    act(() => inputByAria('Circuit c1 circuit_ref').focus());
    expect(tbtn('accessory-lim')).toBeNull();
  });
});
