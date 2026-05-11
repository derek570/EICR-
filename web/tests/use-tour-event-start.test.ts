/**
 * `useTour` — `cm:start-tour` imperative event channel.
 *
 * iOS canon: a single TourManager observable is reachable from both the
 * dashboard view and the JobDetail toolbar menu, so any "Start Tour"
 * affordance can call `tourManager.startTour(phase:)` directly. The PWA's
 * useTour deliberately does NOT live in a React context — each consumer
 * gets its own controller (the existing comment in use-tour.ts:35
 * explains why). To still allow a sibling component (e.g. JobHeader's
 * 3-dot menu) to kick off a tour rendered by a different sibling
 * (JobTourMount), useTour subscribes to the `cm:start-tour` DOM event
 * and calls `start()` when the event's `stateKey` detail matches the
 * hook's `stateKey`. Pre-fix the JobHeader wiped `cm-tour-job` from
 * localStorage and called `window.location.reload()` — clunky + a full
 * page reload mid-session.
 *
 * Mount strategy: createRoot directly (same as job-context.test.tsx) —
 * see that file's preamble for the React-instance-pin rationale. Using
 * RTL's `renderHook` trips the dual-React mismatch.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { useTour, type TourController } from '@/hooks/use-tour';

interface Harness {
  unmount: () => void;
  ctxRef: React.MutableRefObject<TourController | null>;
}

function mountHook(stateKey: 'job' | 'dashboard'): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctxRef: Harness['ctxRef'] = { current: null };
  let root: Root | null = null;

  const Probe: React.FC = () => {
    const controller = useTour({ stateKey });
    React.useLayoutEffect(() => {
      ctxRef.current = controller;
    });
    return null;
  };

  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Probe));
  });

  return {
    unmount: () => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
    ctxRef,
  };
}

describe('useTour — cm:start-tour event channel', () => {
  let harness: Harness;

  beforeEach(() => {
    // Clear job-tour seen flag so the controller starts in its default
    // state for each test.
    window.localStorage.removeItem('cm-tour-job');
    window.localStorage.removeItem('cm-tour-dashboard');
  });

  afterEach(() => {
    harness?.unmount();
  });

  it('start fires when stateKey matches', () => {
    harness = mountHook('job');
    expect(harness.ctxRef.current?.active).toBe(false);

    act(() => {
      window.dispatchEvent(new CustomEvent('cm:start-tour', { detail: { stateKey: 'job' } }));
    });

    expect(harness.ctxRef.current?.active).toBe(true);
    expect(harness.ctxRef.current?.stepIndex).toBe(0);
  });

  it('ignores events for a different stateKey', () => {
    harness = mountHook('job');

    act(() => {
      window.dispatchEvent(new CustomEvent('cm:start-tour', { detail: { stateKey: 'dashboard' } }));
    });

    expect(harness.ctxRef.current?.active).toBe(false);
  });

  it('ignores events with no detail', () => {
    harness = mountHook('job');

    act(() => {
      window.dispatchEvent(new CustomEvent('cm:start-tour'));
    });

    expect(harness.ctxRef.current?.active).toBe(false);
  });

  it('re-fires start even after a previous stop', () => {
    harness = mountHook('job');

    act(() => {
      harness.ctxRef.current?.stop();
    });
    expect(harness.ctxRef.current?.active).toBe(false);

    act(() => {
      window.dispatchEvent(new CustomEvent('cm:start-tour', { detail: { stateKey: 'job' } }));
    });
    expect(harness.ctxRef.current?.active).toBe(true);
  });

  it('does not throw after unmount (listener cleaned up)', () => {
    harness = mountHook('job');
    harness.unmount();
    // Reassign harness so the afterEach noop is safe.
    harness = { unmount: () => {}, ctxRef: { current: null } };

    expect(() => {
      window.dispatchEvent(new CustomEvent('cm:start-tour', { detail: { stateKey: 'job' } }));
    }).not.toThrow();
  });
});
