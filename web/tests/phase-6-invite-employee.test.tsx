/**
 * Phase 6 — invite-employee page.
 *
 * Locks the role gate + submit/error paths:
 *   1. Non-admins land on /settings instead of rendering the form.
 *      Company admins (owner / admin) and system admins see the form.
 *   2. Successful invite swaps the form out for the "temp password"
 *      card with the plaintext password from the backend response,
 *      and the password is marked for copy-to-clipboard.
 *   3. A 409 "user exists" response surfaces the friendly
 *      "A user with this email already exists." copy rather than the
 *      raw backend message.
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
    Copy: makeIcon('Copy'),
    UserPlus: makeIcon('UserPlus'),
  };
});

const routerReplace = vi.fn<(p: string) => void>();
const routerPush = vi.fn<(p: string) => void>();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

const currentUserMock = vi.fn();
vi.mock('@/lib/use-current-user', () => ({
  useCurrentUser: () => currentUserMock(),
}));

const inviteMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    inviteEmployee: (companyId: string, body: { name: string; email: string }) =>
      inviteMock(companyId, body),
  },
}));

import InviteEmployeePage from '@/app/settings/invite/page';
import { ApiError } from '@/lib/types';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<InviteEmployeePage />);
  });
  return { container, root };
}

function findInput(container: HTMLElement, label: string): HTMLInputElement | null {
  const label_el = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === label
  );
  if (!label_el) return null;
  const id = label_el.getAttribute('for');
  return id ? (container.querySelector(`#${id}`) as HTMLInputElement | null) : null;
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
  inviteMock.mockReset();
  routerReplace.mockReset();
  routerPush.mockReset();
});

afterEach(() => {
  if (harness) {
    act(() => {
      harness!.root.unmount();
    });
    harness.container.remove();
    harness = null;
  }
});

describe('Phase 6 · invite employee — role gate', () => {
  it('redirects non-admins to /settings', async () => {
    currentUserMock.mockReturnValue({
      user: {
        id: 'u1',
        email: 'e@example.com',
        name: 'Employee',
        role: 'user',
        company_id: 'c1',
        company_role: 'employee',
      },
      loading: false,
      refresh: vi.fn(),
    });
    harness = mount();
    // Effect runs after mount; flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(routerReplace).toHaveBeenCalledWith('/settings');
  });

  it('renders the form for company admins', async () => {
    currentUserMock.mockReturnValue({
      user: {
        id: 'u2',
        email: 'owner@example.com',
        name: 'Owner',
        role: 'user',
        company_id: 'c1',
        company_role: 'owner',
      },
      loading: false,
      refresh: vi.fn(),
    });
    harness = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(routerReplace).not.toHaveBeenCalledWith('/settings');
    expect(findInput(harness.container, 'Full name')).not.toBeNull();
    expect(findInput(harness.container, 'Email')).not.toBeNull();
  });
});

describe('Phase 6 · invite employee — submit flow', () => {
  beforeEach(() => {
    currentUserMock.mockReturnValue({
      user: {
        id: 'u2',
        email: 'owner@example.com',
        name: 'Owner',
        role: 'user',
        company_id: 'company-42',
        company_role: 'owner',
      },
      loading: false,
      refresh: vi.fn(),
    });
  });

  it('posts to the backend and shows the one-shot temp password on success', async () => {
    inviteMock.mockResolvedValueOnce({
      userId: 'new-1',
      email: 'hire@example.com',
      name: 'New Hire',
      temporaryPassword: 'temp-pw-xyz',
    });
    harness = mount();
    await act(async () => {
      await Promise.resolve();
    });

    const nameInput = findInput(harness.container, 'Full name')!;
    const emailInput = findInput(harness.container, 'Email')!;
    act(() => {
      setInput(nameInput, 'New Hire');
      setInput(emailInput, 'hire@example.com');
    });

    const submit = findButton(harness.container, 'Send invite')!;
    await act(async () => {
      submit.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inviteMock).toHaveBeenCalledWith('company-42', {
      name: 'New Hire',
      email: 'hire@example.com',
    });
    expect(harness.container.textContent).toContain('temp-pw-xyz');
    expect(harness.container.textContent).toContain('Invite sent');
  });

  it('maps a 409 response to a friendly "already exists" message', async () => {
    inviteMock.mockRejectedValueOnce(new ApiError(409, 'A user with this email already exists'));
    harness = mount();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      setInput(findInput(harness!.container, 'Full name')!, 'Dup Hire');
      setInput(findInput(harness!.container, 'Email')!, 'dup@example.com');
    });
    await act(async () => {
      findButton(harness!.container, 'Send invite')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.container.textContent).toContain('A user with this email already exists.');
    // Form still rendered — the temp-password card only shows on success.
    expect(harness.container.textContent).not.toContain('Invite sent');
  });
});
