/**
 * Phase 6 — change-password form.
 *
 * Covers:
 *   1. Submit button stays disabled until `current` is populated,
 *      `new` is ≥ 8 chars, `new` !== `current`, and `new` === `confirm`.
 *   2. On successful submit, `api.changePassword` is called with
 *      (current, new) and the success card replaces the form.
 *   3. On a 401 response (wrong current password), the error message
 *      from the backend is surfaced inline and the form remains
 *      editable so the inspector can correct it.
 *
 * Rendering strategy mirrors `pdf-tab.test.tsx` — inline createRoot +
 * module-boundary mocks — because ConfirmDialog, lucide-react, and
 * next/navigation each hit the root-vs-web React copy mismatch
 * documented in `vitest.config.ts`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  return {
    ArrowLeft: makeIcon('ArrowLeft'),
    CheckCircle2: makeIcon('CheckCircle2'),
    Eye: makeIcon('Eye'),
    EyeOff: makeIcon('EyeOff'),
    ShieldCheck: makeIcon('ShieldCheck'),
  };
});

const routerPush = vi.fn<(p: string) => void>();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerPush }),
}));

const changePasswordMock = vi.fn<(cur: string, next: string) => Promise<{ success: boolean }>>();
vi.mock('@/lib/api-client', () => ({
  api: {
    changePassword: (cur: string, next: string) => changePasswordMock(cur, next),
  },
}));

import ChangePasswordPage from '@/app/settings/change-password/page';
import { ApiError } from '@/lib/types';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ChangePasswordPage />);
  });
  return { container, root };
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement | null {
  const spans = Array.from(container.querySelectorAll('span'));
  const match = spans.find((s) => s.textContent?.trim() === label);
  const wrapper = match?.closest('.group');
  return (wrapper?.querySelector('input') as HTMLInputElement | null) ?? null;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    (Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(label)
    ) as HTMLButtonElement | undefined) ?? null
  );
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  changePasswordMock.mockReset();
  routerPush.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  if (harness) {
    act(() => {
      harness!.root.unmount();
    });
    harness.container.remove();
    harness = null;
  }
  vi.useRealTimers();
});

describe('Phase 6 · change-password form', () => {
  it('keeps submit disabled until every field is valid', async () => {
    harness = mount();
    const button = findButton(harness.container, 'Change password');
    expect(button?.disabled).toBe(true);

    const current = inputByLabel(harness.container, 'Current password')!;
    const next = inputByLabel(harness.container, 'New password')!;
    const confirm = inputByLabel(harness.container, 'Confirm new password')!;

    act(() => {
      setInput(current, 'old-pw');
      setInput(next, 'short');
      setInput(confirm, 'short');
    });
    expect(findButton(harness.container, 'Change password')?.disabled).toBe(true);

    act(() => {
      setInput(next, 'longenoughnow');
      setInput(confirm, 'mismatchlongenough');
    });
    expect(findButton(harness.container, 'Change password')?.disabled).toBe(true);

    act(() => {
      setInput(confirm, 'longenoughnow');
    });
    expect(findButton(harness.container, 'Change password')?.disabled).toBe(false);
  });

  it('submits with (current, new) and routes to /settings on success', async () => {
    changePasswordMock.mockResolvedValueOnce({ success: true });
    harness = mount();

    const current = inputByLabel(harness.container, 'Current password')!;
    const next = inputByLabel(harness.container, 'New password')!;
    const confirm = inputByLabel(harness.container, 'Confirm new password')!;

    act(() => {
      setInput(current, 'old-pw-123');
      setInput(next, 'newpass-strongenough');
      setInput(confirm, 'newpass-strongenough');
    });

    const submit = findButton(harness.container, 'Change password')!;
    await act(async () => {
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(changePasswordMock).toHaveBeenCalledWith('old-pw-123', 'newpass-strongenough');
    // Success card replaces the form.
    expect(harness.container.textContent).toContain('Password changed');

    // Auto-redirect fires after 2s.
    await act(async () => {
      vi.advanceTimersByTime(2100);
      await Promise.resolve();
    });
    expect(routerPush).toHaveBeenCalledWith('/settings');
  });

  it('surfaces a 401 "current password is incorrect" error inline and leaves the form editable', async () => {
    changePasswordMock.mockRejectedValueOnce(new ApiError(401, 'Current password is incorrect'));
    harness = mount();

    const current = inputByLabel(harness.container, 'Current password')!;
    const next = inputByLabel(harness.container, 'New password')!;
    const confirm = inputByLabel(harness.container, 'Confirm new password')!;
    act(() => {
      setInput(current, 'wrong');
      setInput(next, 'goodenoughpass');
      setInput(confirm, 'goodenoughpass');
    });

    const submit = findButton(harness.container, 'Change password')!;
    await act(async () => {
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.container.textContent).toContain('Current password is incorrect');
    // Form still present — no success redirect.
    expect(harness.container.textContent).not.toContain('Password changed');
    expect(inputByLabel(harness.container, 'Current password')).not.toBeNull();
  });
});
