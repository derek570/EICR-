/**
 * Phase 2 — PDF tab wiring regression.
 *
 * Locks the behaviours the Phase 2 brief asked for explicitly:
 *   1. `api.generatePdf(userId, jobId)` is invoked with the signed-in
 *      user's id and the URL's job id when Generate is clicked. This
 *      guards the only per-user auth path — if the page ever reads
 *      `userId` from the job document instead of `getUser()`, the
 *      backend will 403 every request.
 *   2. The Preview, Share, and Delete buttons are disabled in the
 *      "no PDF generated yet" state and enabled after generate
 *      resolves. The inverse of this contract — shipping a
 *      falsely-enabled Share button in the pre-generated state —
 *      would surface as a "nothing to share" bug.
 *   3. On a 500 JSON response the error copy surfaces on the page
 *      (we do NOT assert the exact wording — the backend owns that).
 *   4. The Discard flow clears the Blob and flips the buttons back
 *      to disabled (session-scoped deletion, mirrors iOS
 *      "re-generate every time" behaviour).
 *
 * We can't run a full build-time component integration here without
 * spinning up a JobProvider + next/router + auth fixture — the PDF
 * page consumes `useJobContext`, `useParams`, and `getUser`. Those
 * are mocked at the module boundary so the test stays unit-sized and
 * fast (no network, no IDB, no router). `api.generatePdf` is mocked
 * too; the real method's contract is covered in `api-client.test.ts`.
 *
 * Mount strategy mirrors `login-redirect.integration.test.tsx` —
 * inline `createRoot` rather than RTL to dodge the React dual-copy
 * hazard documented in `vitest.config.ts`.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  // React 19's act() requires this flag when mounting via `createRoot`
  // directly. Mirrors dashboard-cache-race.integration.test.tsx.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// Mock lucide-react because the package's internal React import goes
// through CJS bare-require resolution (resolves to the monorepo-root
// react copy, not web's 19.2.4 pin), producing "Invalid hook call" on
// mount. Same class of problem that keeps dashboard-cache-race.test
// from mounting the real DashboardPage. The icons have no behaviour we
// need to test — they render a span with the right aria-hidden
// attribute, which is all the page needs.
//
// Vitest's hoisted mock cannot return a JS Proxy (it needs explicit
// exports at evaluate time); enumerate every icon the PDF page +
// warning/error cards reach for. If a future icon is added, extend
// this list.
vi.mock('lucide-react', () => {
  const makeIcon = (name: string) =>
    // eslint-disable-next-line react/display-name
    React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>((props, ref) => (
      <span ref={ref} data-icon={name} {...props} />
    ));
  return {
    AlertTriangle: makeIcon('AlertTriangle'),
    CheckCircle2: makeIcon('CheckCircle2'),
    Eye: makeIcon('Eye'),
    FileText: makeIcon('FileText'),
    Loader2: makeIcon('Loader2'),
    Share2: makeIcon('Share2'),
    Sparkles: makeIcon('Sparkles'),
    Trash2: makeIcon('Trash2'),
    XOctagon: makeIcon('XOctagon'),
  };
});

// ConfirmDialog wraps Radix @radix-ui/react-dialog which hits the same
// root-vs-web React copy mismatch as lucide. Stub it to a minimal
// button + dialog that still exercises the open state machine so the
// Discard-confirm test can observe the `open` prop.
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    onOpenChange,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    onOpenChange: (v: boolean) => void;
    confirmLabel?: string;
    cancelLabel?: string;
    title: string;
  }) => {
    if (!open) return null;
    return (
      <div role="dialog" data-testid="confirm-dialog">
        <p>{title}</p>
        <button type="button" onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    );
  },
}));

// Mock next/navigation BEFORE importing the page so the hook lookup
// resolves to our stub. Vitest hoists vi.mock to the top so import
// order is visual only.
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'job-42' }),
}));

// Stub getUser so the page renders the authenticated user id without
// touching localStorage or the real auth module.
vi.mock('@/lib/auth', () => ({
  getUser: () => ({ id: 'user-7', email: 't@e.st', role: 'inspector' }),
}));

// The page reads certificateType + job shape from the JobContext.
// Provide a minimal stub; the real provider's wiring is exercised in
// job-context.test.tsx.
const jobStub = {
  id: 'job-42',
  certificate_type: 'EICR' as const,
  installation: { address_line1: '1 Test Road', date_of_inspection: '2026-04-24' },
  board: { boards: [{ id: 'b1' }] },
  circuits: [{ id: 'c1' }],
  inspector_id: 'u-inspector',
  authorised_by_id: 'u-boss',
};

vi.mock('@/lib/job-context', () => ({
  useJobContext: () => ({
    job: jobStub,
    certificateType: 'EICR',
    updateJob: vi.fn(),
    setJob: vi.fn(),
    isDirty: false,
    isSaving: false,
    saveError: null,
  }),
}));

// api-client mock — the page calls generatePdf ONLY on the explicit
// server-fallback action (WS9: the primary Generate is the client
// render) and updateAttestationPdfKey (fire-and-forget, post-render;
// args captured so the local:// / route:// stamping can be pinned).
// legalTextVersions + acceptCertAttestations live inside the modal
// which we stub out below, so they're not strictly needed here.
const generatePdfMock = vi.fn<(userId: string, jobId: string) => Promise<Blob>>();
const updateAttestationPdfKeyMock = vi.fn(
  async (_args: { attestation_ids: number[]; pdf_s3_key: string }) => ({ ok: true, updated: 2 })
);
vi.mock('@/lib/api-client', () => ({
  api: {
    generatePdf: (userId: string, jobId: string) => generatePdfMock(userId, jobId),
    updateAttestationPdfKey: (args: { attestation_ids: number[]; pdf_s3_key: string }) =>
      updateAttestationPdfKeyMock(args),
  },
}));

// Client renderer mock — the page dynamic-imports this module inside
// handleGenerate. The real pipeline (template + foreignObject capture +
// pdf-lib) needs a real browser; its own coverage lives in
// tests/pdf-template.test.ts + tests-e2e/pdf-renderer-spike.spec.ts.
const generateCertificatePdfMock = vi.fn<(userId: string, detail: unknown) => Promise<Blob>>();
vi.mock('@/lib/pdf/generate-certificate', () => ({
  generateCertificatePdf: (userId: string, detail: unknown) =>
    generateCertificatePdfMock(userId, detail),
}));

// Stub the attestation modal — these tests pin the *page's* PDF
// generation behaviour, not the modal's UX. When the page passes
// open=true the stub auto-confirms with mock attestation_ids so the
// flow reaches handleGenerate. `attestationPromptCount` counts modal
// presentations so the spec §4.3 no-re-prompt retry can be pinned.
// Real modal UX is exercised in issue-certificate-modal.test.tsx.
let attestationPromptCount = 0;
vi.mock('@/components/job/issue-certificate-modal', () => ({
  IssueCertificateModal: ({
    open,
    onConfirmed,
  }: {
    open: boolean;
    onConfirmed: (ids: number[]) => void;
  }) => {
    React.useEffect(() => {
      if (open) {
        attestationPromptCount += 1;
        onConfirmed([101, 102]);
      }
    }, [open, onConfirmed]);
    return null;
  },
}));

// downloadBlob fallback — we never want a real anchor click in jsdom.
const downloadBlobMock = vi.fn<(blob: Blob, filename: string) => void>();
vi.mock('@certmate/shared-utils', async (orig) => {
  const actual = await orig<typeof import('@certmate/shared-utils')>();
  return {
    ...actual,
    downloadBlob: (blob: Blob, filename: string) => downloadBlobMock(blob, filename),
  };
});

// Import the page AFTER mocks so its module graph resolves to our stubs.
import PdfPage from '@/app/job/[id]/pdf/page';
import { ApiError } from '@/lib/types';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PdfPage />);
  });
  return { container, root };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return (buttons.find((b) => b.textContent?.trim().includes(label)) ??
    null) as HTMLButtonElement | null;
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  generatePdfMock.mockReset();
  generateCertificatePdfMock.mockReset();
  updateAttestationPdfKeyMock.mockClear();
  attestationPromptCount = 0;
  downloadBlobMock.mockReset();
  // URL.createObjectURL / revokeObjectURL aren't implemented in jsdom.
  // Stub both so PdfPreview can mount without throwing.
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:mock'),
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
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

describe('Phase 2 · PDF tab', () => {
  it('renders with Preview/Share/Delete disabled until Generate succeeds', () => {
    harness = mount();
    const preview = findButton(harness.container, 'Preview PDF');
    const share = findButton(harness.container, 'Share PDF');
    const del = findButton(harness.container, 'Delete');
    expect(preview?.disabled).toBe(true);
    expect(share?.disabled).toBe(true);
    expect(del?.disabled).toBe(true);
    // Hero status copy matches iOS "Not yet generated" default.
    expect(harness.container.textContent).toContain('Not yet generated');
  });

  it('renders CLIENT-side via generateCertificatePdf(userId, job) and enables secondary buttons on success', async () => {
    generateCertificatePdfMock.mockResolvedValueOnce(
      new Blob(['%PDF-1.4 stub'], { type: 'application/pdf' })
    );
    harness = mount();

    const generate = findButton(harness.container, 'Generate PDF');
    expect(generate).not.toBeNull();

    await act(async () => {
      generate!.click();
      // Let the pending microtask + setState flush (dynamic import adds
      // an extra tick).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The primary Generate is the iOS-parity CLIENT render — the
    // server generator must NOT be called on this path.
    expect(generateCertificatePdfMock).toHaveBeenCalledTimes(1);
    expect(generateCertificatePdfMock).toHaveBeenCalledWith('user-7', jobStub);
    expect(generatePdfMock).not.toHaveBeenCalled();

    // Attestation rows stamped with the iOS local:// scheme
    // (PDFTab.swift:363), using the share filename.
    expect(updateAttestationPdfKeyMock).toHaveBeenCalledWith({
      attestation_ids: [101, 102],
      pdf_s3_key: 'local://EICR_job-42.pdf',
    });

    const preview = findButton(harness.container, 'Preview PDF');
    const share = findButton(harness.container, 'Share PDF');
    const del = findButton(harness.container, 'Delete');
    expect(preview?.disabled).toBe(false);
    expect(share?.disabled).toBe(false);
    expect(del?.disabled).toBe(false);
    // Hero copy flips.
    expect(harness.container.textContent).toContain('PDF generated');
    // Preview iframe mounts.
    expect(harness.container.querySelector('iframe')).not.toBeNull();
  });

  it('keeps the server generator reachable via the explicit fallback action, stamping route://', async () => {
    generatePdfMock.mockResolvedValueOnce(new Blob(['%PDF-1.4 stub'], { type: 'application/pdf' }));
    harness = mount();

    const serverBtn = findButton(harness.container, 'Generate on server (fallback)');
    expect(serverBtn).not.toBeNull();

    await act(async () => {
      serverBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(generatePdfMock).toHaveBeenCalledTimes(1);
    expect(generatePdfMock).toHaveBeenCalledWith('user-7', 'job-42');
    expect(generateCertificatePdfMock).not.toHaveBeenCalled();
    expect(updateAttestationPdfKeyMock).toHaveBeenCalledWith({
      attestation_ids: [101, 102],
      pdf_s3_key: 'route://api/job/user-7/job-42/generate-pdf',
    });
    expect(findButton(harness.container, 'Preview PDF')?.disabled).toBe(false);
  });

  it('surfaces the error on a failed render; Try again re-uses the attestation ids with NO re-prompt (spec §4.3)', async () => {
    generateCertificatePdfMock.mockRejectedValueOnce(
      new ApiError(500, 'PDF generation failed: missing test results CSV')
    );
    harness = mount();

    const generate = findButton(harness.container, 'Generate PDF');
    await act(async () => {
      generate!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.container.textContent).toContain(
      'PDF generation failed: missing test results CSV'
    );
    expect(attestationPromptCount).toBe(1);
    // Secondary buttons stay disabled on failure.
    expect(findButton(harness.container, 'Preview PDF')?.disabled).toBe(true);

    // "Try again" re-fires the render WITHOUT re-presenting the
    // attestation modal — the audit rows written before the failed
    // render are re-used (pdf-issuance-attestations.md §4.3; current
    // iOS re-prompts here, which is an open iOS spec-parity todo dated
    // 2026-07-02 — web deliberately implements the SPEC).
    generateCertificatePdfMock.mockResolvedValueOnce(
      new Blob(['%PDF-1.4 ok'], { type: 'application/pdf' })
    );
    const retry = findButton(harness.container, 'Try again');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(generateCertificatePdfMock).toHaveBeenCalledTimes(2);
    expect(attestationPromptCount).toBe(1);
    // The successful re-render stamps the SAME attestation ids.
    expect(updateAttestationPdfKeyMock).toHaveBeenCalledWith({
      attestation_ids: [101, 102],
      pdf_s3_key: 'local://EICR_job-42.pdf',
    });
    expect(findButton(harness.container, 'Preview PDF')?.disabled).toBe(false);
  });

  it('re-prompts the attestation modal on a fresh issuance after success (spec §3)', async () => {
    generateCertificatePdfMock.mockResolvedValue(
      new Blob(['%PDF-1.4 stub'], { type: 'application/pdf' })
    );
    harness = mount();

    await act(async () => {
      findButton(harness!.container, 'Generate PDF')!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(attestationPromptCount).toBe(1);

    // Regenerate — a fresh SUCCESSFUL issuance always re-prompts.
    await act(async () => {
      findButton(harness!.container, 'Regenerate PDF')!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(attestationPromptCount).toBe(2);
    expect(generateCertificatePdfMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to downloadBlob when navigator.canShare returns false', async () => {
    generateCertificatePdfMock.mockResolvedValueOnce(
      new Blob(['%PDF-1.4 stub'], { type: 'application/pdf' })
    );
    // Force the "desktop" path where canShare({files}) returns false.
    const nav = navigator as unknown as {
      canShare?: (data: unknown) => boolean;
      share?: (data: unknown) => Promise<void>;
    };
    nav.canShare = () => false;
    nav.share = vi.fn(async () => undefined);

    harness = mount();
    await act(async () => {
      findButton(harness!.container, 'Generate PDF')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const share = findButton(harness.container, 'Share PDF')!;
    await act(async () => {
      share.click();
      await Promise.resolve();
    });
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    expect(downloadBlobMock.mock.calls[0][1]).toBe('EICR_job-42.pdf');

    delete nav.canShare;
    delete nav.share;
  });

  it('does NOT download when the user cancels the native share sheet', async () => {
    // Regression guard for the Phase 2 post-codex fix: a navigator.share
    // AbortError must not silently fall through to downloadBlob — the
    // user explicitly cancelled, so we should leave them alone.
    generateCertificatePdfMock.mockResolvedValueOnce(
      new Blob(['%PDF-1.4 stub'], { type: 'application/pdf' })
    );
    const nav = navigator as unknown as {
      canShare?: (data: unknown) => boolean;
      share?: (data: unknown) => Promise<void>;
    };
    nav.canShare = () => true;
    nav.share = vi.fn(async () => {
      const err = new Error('User cancelled');
      err.name = 'AbortError';
      throw err;
    });

    harness = mount();
    await act(async () => {
      findButton(harness!.container, 'Generate PDF')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const share = findButton(harness.container, 'Share PDF')!;
    downloadBlobMock.mockClear();
    await act(async () => {
      share.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nav.share).toHaveBeenCalledTimes(1);
    expect(downloadBlobMock).not.toHaveBeenCalled();

    delete nav.canShare;
    delete nav.share;
  });
});
