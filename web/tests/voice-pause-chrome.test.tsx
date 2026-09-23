/**
 * PLAN-D Acceptance 12 — paused presentation (web half).
 *
 * The recording chrome did not know about a voice pause: its single
 * Pause/Resume control keyed on `state === 'sleeping'` only. During a
 * hands-free voice pause the Pause affordance is replaced by a Resume-only
 * presentation whose tap calls the SAME origin-aware `resume()` the spoken
 * phrase reaches; from the button pause the chrome says the phrase is
 * unavailable and only the tap works.
 *
 * `useRecording` is stubbed so the render is deterministic; the provider
 * side (the tap resuming through the voice-pause exit) is pinned in
 * `harness/pland-voice-pause.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// lucide-react resolves the root React copy (two React instances); stub every
// icon with a plain element, the pattern phase-3-alerts-page.test.tsx uses.
vi.mock('lucide-react', () => {
  const cache = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === '__esModule') return true;
        if (!cache.has(name)) {
          const Icon = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
            (props, ref) => <span ref={ref} data-icon={name} {...props} />
          );
          Icon.displayName = name;
          cache.set(name, Icon);
        }
        return cache.get(name);
      },
      has: () => true,
    }
  );
});

// Radix dialogs also resolve the root React copy; none is open in these
// renders, so closed-state stubs keep the tree honest.
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock('@/components/defaults/apply-defaults-sheet', () => ({ ApplyDefaultsSheet: () => null }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: 'job_1' }),
}));

const recording = {
  state: 'active' as 'active' | 'sleeping',
  voicePaused: false,
  pause: vi.fn(),
  resume: vi.fn(),
};

vi.mock('@/lib/recording-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recording-context')>();
  return {
    ...actual,
    useRecording: () => ({
      state: recording.state,
      voicePaused: recording.voicePaused,
      micLevel: 0,
      elapsedSec: 0,
      costUsd: 0,
      errorMessage: null,
      processingCount: 0,
      pendingReadings: 0,
      stop: vi.fn(),
      pause: recording.pause,
      resume: recording.resume,
      captureObservationPhoto: vi.fn(),
    }),
  };
});

vi.mock('@/lib/job-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/job-context')>();
  return {
    ...actual,
    useJobContext: () => ({
      job: { id: 'job_1', circuits: [] },
      updateJob: vi.fn(),
      flushDraftsAndGetSnapshot: vi.fn(),
    }),
  };
});

import { RecordingChrome } from '@/components/recording/recording-chrome';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('PLAN-D Acceptance 12 — voice-pause presentation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    recording.pause.mockClear();
    recording.resume.mockClear();
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(state: 'active' | 'sleeping', voicePaused: boolean) {
    recording.state = state;
    recording.voicePaused = voicePaused;
    await act(async () => {
      root.render(<RecordingChrome />);
    });
  }
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('recording: Pause is offered, no hint', async () => {
    await render('active', false);
    expect(button('Pause')).not.toBeNull();
    expect(button('Resume')).toBeNull();
    expect(container.querySelector('[data-testid="voice-pause-hint"]')).toBeNull();
    expect(container.querySelector('[data-testid="button-pause-hint"]')).toBeNull();
  });

  it('voice pause: Resume-only, the phrase is offered, and the tap calls resume()', async () => {
    await render('active', true);
    expect(button('Pause')).toBeNull();
    const resume = button('Resume');
    expect(resume).not.toBeNull();
    expect(container.textContent).toContain('Voice paused');
    expect(container.querySelector('[data-testid="voice-pause-hint"]')?.textContent).toContain(
      'CertMate, carry on'
    );
    await act(async () => {
      resume!.click();
    });
    expect(recording.resume).toHaveBeenCalledTimes(1);
    expect(recording.pause).not.toHaveBeenCalled();
  });

  it('button pause: states that the resume phrase is unavailable and only the tap works', async () => {
    await render('sleeping', false);
    expect(button('Resume')).not.toBeNull();
    const hint = container.querySelector('[data-testid="button-pause-hint"]');
    expect(hint?.textContent).toMatch(/voice resume is unavailable/i);
    expect(container.querySelector('[data-testid="voice-pause-hint"]')).toBeNull();
  });
});
