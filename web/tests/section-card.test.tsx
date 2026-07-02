/**
 * SectionCard accent regression (Phase 1, re-locked for WS5 2026-07-02).
 *
 * Locks two contracts:
 *   1. The five legacy colour accents (blue/green/amber/magenta/red)
 *      stay class-styled — no inline background/borderColor — so they
 *      inherit the shared card chrome and nothing per-callsite.
 *   2. The seven iOS-parity category accents (client, electrical,
 *      board, test-results, schedule, notes, protection) paint the
 *      CMSectionCard recipe inline: L1 + blue-subtle tint background
 *      with an accent 20%→8% gradient border (padding-box/border-box
 *      trick), and a 3px accent→40% gradient conduit stripe (iOS
 *      `cmStatusConduit`, WS5 restyle of the old solid stripe).
 *
 * We assert on DOM-level attributes (style.borderColor, inline
 * background, the accent stripe span's background) rather than computed
 * styles — jsdom doesn't compute CSS variables so those would fail
 * spuriously. The inline style values carry the real guarantee.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SectionCard } from '@/components/ui/section-card';
import { SECTION_ACCENTS } from '@/lib/constants/section-accents';

/** jsdom normalises hex colours to rgb() in SOME serialised values (the
 *  single-gradient stripe) but preserves hex in others (the multi-layer
 *  section background) — accept either spelling of the accent colour. */
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

function expectContainsColour(haystack: string, hex: string): void {
  const found = haystack.includes(hex) || haystack.includes(hexToRgb(hex));
  expect(found, `expected style to contain ${hex} (or ${hexToRgb(hex)}): ${haystack}`).toBe(true);
}

function mount(element: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

beforeEach(() => {
  mounted = null;
});

afterEach(() => {
  if (mounted) {
    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;
  }
});

function getSection(container: HTMLElement): HTMLElement {
  const section = container.querySelector('section');
  if (!section) throw new Error('SectionCard did not render a <section>');
  return section as HTMLElement;
}

function getStripe(container: HTMLElement): HTMLElement {
  const stripe = container.querySelector('section > span[aria-hidden]');
  if (!stripe) throw new Error('SectionCard did not render the accent stripe');
  return stripe as HTMLElement;
}

describe('SectionCard', () => {
  it('default colour accent="blue" does not set inline background/borderColor', () => {
    mounted = mount(<SectionCard title="Legacy">body</SectionCard>);
    const section = getSection(mounted.container);
    expect(section.style.background).toBe('');
    expect(section.style.borderColor).toBe('');
  });

  it.each(['blue', 'green', 'amber', 'magenta', 'red'] as const)(
    'legacy colour accent="%s" keeps the surface byte-identical (no inline surfaceStyle)',
    (accent) => {
      mounted = mount(
        <SectionCard accent={accent} title="Legacy">
          body
        </SectionCard>
      );
      const section = getSection(mounted.container);
      expect(section.style.background).toBe('');
      expect(section.style.borderColor).toBe('');
    }
  );

  it.each(Object.keys(SECTION_ACCENTS))(
    'category accent="%s" applies the tokened inline background + border',
    (accent) => {
      const tokens = SECTION_ACCENTS[accent as keyof typeof SECTION_ACCENTS];
      mounted = mount(
        <SectionCard accent={accent as keyof typeof SECTION_ACCENTS} title={`Category ${accent}`}>
          body
        </SectionCard>
      );
      const section = getSection(mounted.container);
      // Assert on the raw style attribute — jsdom normalises some
      // colour syntaxes (hex -> rgb) when round-tripped through
      // `.style.*`, but the `style` attribute string preserves the
      // nested `color-mix(…)` expression because it's not a flat colour
      // value. That's the real contract we care about here.
      const styleAttr = section.getAttribute('style') ?? '';
      expect(styleAttr).toContain('color-mix');
      expectContainsColour(styleAttr, tokens.stripe);
      // Stripe span paints the iOS conduit gradient: full-strength
      // accent fading to 40% (WS5 restyle — was a flat colour).
      const stripe = getStripe(mounted.container);
      const stripeStyle = stripe.getAttribute('style') ?? '';
      expect(stripeStyle).toContain('linear-gradient');
      expectContainsColour(stripeStyle, tokens.stripe);
      expect(stripeStyle).toContain('40%');
    }
  );

  it('passes through caller-supplied style without stomping the accent surface', () => {
    // When both a category accent and a caller style are set, the caller
    // wins on overlapping keys (matches the documented behaviour of
    // `style` prop spreading) but a caller can still set e.g. margin
    // without losing the accent tint.
    mounted = mount(
      <SectionCard accent="client" title="x" style={{ marginTop: '40px' }}>
        body
      </SectionCard>
    );
    const section = getSection(mounted.container);
    expect(section.style.marginTop).toBe('40px');
    // Accent border survives the caller style merge.
    expect(section.getAttribute('style') ?? '').toContain('color-mix');
  });

  it('renders icon + title header when both supplied', () => {
    function Glyph(props: { className?: string }) {
      return <svg data-testid="glyph" {...props} />;
    }
    mounted = mount(
      <SectionCard accent="board" icon={Glyph} title="Board details" subtitle="Designation">
        child
      </SectionCard>
    );
    const glyph = mounted.container.querySelector('[data-testid="glyph"]');
    expect(glyph).not.toBeNull();
    expect(mounted.container.textContent).toContain('Board details');
    expect(mounted.container.textContent).toContain('Designation');
  });
});
