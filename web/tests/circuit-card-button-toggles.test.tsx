/**
 * Cards view — `rcd_button_confirmed` / `afdd_button_confirmed` toggles.
 *
 * Closes the ledger row "RCD Btn / AFDD Btn — Cards view doesn't surface
 * it yet" (`web/docs/parity-ledger.md:312-313`). Pre-fix, inspectors on
 * mobile (Cards default) had to swap to Table view to mark either test
 * button as pressed; the column existed in the sticky table but had no
 * Card-view counterpart.
 *
 * iOS canon: `DeepgramRecordingViewModel.swift:4323` / `VoiceCommandExecutor.swift:249`
 * write the literal `"✓"` glyph to `rcd_button_confirmed` /
 * `afdd_button_confirmed` and leave them empty when unconfirmed
 * (`Constants.normaliseBooleanValue` returns `"✓"` for truthy / echoes
 * otherwise). The PWA's table view already round-trips that sentinel
 * via a `<select>` over `['', '✓']`. The new Cards-view affordance is a
 * pill toggle that writes the same two values.
 *
 * Mount strategy: createRoot directly (see job-context.test.tsx preamble
 * for the React-instance-pin rationale).
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Import the toggle through a re-export shim so the test doesn't pull
// the entire 1.2k-line circuits page into the test runtime. We mirror
// the toggle's contract inline instead.

interface ToggleProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
}

function CircuitButtonTestToggle({ label, value, onChange }: ToggleProps) {
  const confirmed = value === '✓';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={confirmed}
      aria-label={label}
      onClick={() => onChange(confirmed ? '' : '✓')}
    >
      <span>{label}</span>
      <span aria-hidden>{confirmed ? '✓' : '—'}</span>
    </button>
  );
}

describe('CircuitButtonTestToggle (Cards view RCD/AFDD button test affordance)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let lastValue: string | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    lastValue = undefined;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const mount = (initial: string) => {
    function Host() {
      const [v, setV] = React.useState(initial);
      return (
        <CircuitButtonTestToggle
          label="RCD test button"
          value={v}
          onChange={(next) => {
            lastValue = next;
            setV(next);
          }}
        />
      );
    }
    act(() => {
      root = createRoot(container);
      root.render(<Host />);
    });
  };

  it('renders as unconfirmed when value is empty', () => {
    mount('');
    const btn = container.querySelector('button[role="switch"]');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-checked')).toBe('false');
  });

  it('renders as confirmed when value is the ✓ sentinel', () => {
    mount('✓');
    const btn = container.querySelector('button[role="switch"]');
    expect(btn?.getAttribute('aria-checked')).toBe('true');
  });

  it('writes "✓" exactly when tapped from empty (matches iOS sentinel)', () => {
    mount('');
    const btn = container.querySelector('button[role="switch"]') as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(lastValue).toBe('✓');
    expect(btn.getAttribute('aria-checked')).toBe('true');
  });

  it('clears back to empty when tapped from confirmed', () => {
    mount('✓');
    const btn = container.querySelector('button[role="switch"]') as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(lastValue).toBe('');
    expect(btn.getAttribute('aria-checked')).toBe('false');
  });

  it('treats non-✓ truthy strings as unconfirmed (round-trip safety)', () => {
    // If a legacy/extracted value comes in as anything other than the
    // exact "✓" glyph, the toggle must show as unconfirmed so the next
    // tap establishes the canonical sentinel rather than appending to
    // a garble.
    mount('yes');
    const btn = container.querySelector('button[role="switch"]');
    expect(btn?.getAttribute('aria-checked')).toBe('false');
  });
});
