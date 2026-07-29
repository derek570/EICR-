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
    Check: makeIcon('Check'),
    ChevronDown: makeIcon('ChevronDown'),
    ChevronRight: makeIcon('ChevronRight'),
    ExternalLink: makeIcon('ExternalLink'),
    Image: makeIcon('Image'),
    Plus: makeIcon('Plus'),
    RefreshCw: makeIcon('RefreshCw'),
    Save: makeIcon('Save'),
    ScanSearch: makeIcon('ScanSearch'),
    Trash2: makeIcon('Trash2'),
  };
});

const replaceMock = vi.fn();
const routerSingleton = { replace: replaceMock, push: vi.fn() };
const searchParamsSingleton = {
  get: (key: string) => (key === 'sample' ? 'sample-1' : null),
  toString: () => 'sample=sample-1',
};

vi.mock('next/navigation', () => ({
  useRouter: () => routerSingleton,
  useSearchParams: () => searchParamsSingleton,
}));

const currentUserSingleton = {
  user: {
    id: 'admin-1',
    email: 'admin@certmate.uk',
    name: 'Admin',
    role: 'admin' as const,
  },
  loading: false,
  refresh: vi.fn(),
};

vi.mock('@/lib/use-current-user', () => ({
  useCurrentUser: () => currentUserSingleton,
}));

const { listMock, detailMock, saveMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  detailMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  api: {
    adminListCcuReviewSamples: (...args: unknown[]) => listMock(...args),
    adminGetCcuReviewSample: (...args: unknown[]) => detailMock(...args),
    adminSaveCcuGroundTruth: (...args: unknown[]) => saveMock(...args),
  },
}));

import CcuReviewPage from '@/app/settings/admin/ccu-review/page';

const sample = {
  sampleId: 'sample-1',
  extractionId: '1785232800000-abc123',
  sessionId: 'session-1',
  createdAt: '2026-07-29T10:00:00.000Z',
  reviewed: false,
};

function queueResponse() {
  return {
    items: [sample],
    total: 1,
    reviewed: 0,
    unreviewed: 1,
    limit: 200,
    offset: 0,
  };
}

function detailResponse() {
  return {
    sample,
    imageUrl: 'https://signed.example/original.jpg',
    extracted: {
      board_manufacturer: 'Hager',
      board_model: 'VML',
      board_technology: 'modern',
      main_switch_rating: '100',
      main_switch_bs_en: '60947-3',
      spd_present: true,
      spd_type: 'Type 2',
      circuits: [
        {
          circuit_number: 1,
          label: 'Sockets',
          ocpd_type: 'B',
          ocpd_rating_a: '32',
          ocpd_bs_en: '60898-1',
          ocpd_breaking_capacity_ka: '6',
          rcd_protected: true,
          rcd_type: 'A',
          rcd_rating_ma: '30',
          rcd_bs_en: '61009-1',
        },
      ],
      questionsForInspector: [],
    },
    extractionMeta: { model: 'gpt-5.5', timestamp: null, totalElapsedMs: 900 },
    groundTruth: null,
    reviewMeta: null,
    sessionConfirmedLayout: null,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

let harness: { container: HTMLDivElement; root: Root } | null = null;

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(queueResponse());
  detailMock.mockReset().mockResolvedValue(detailResponse());
  saveMock.mockReset().mockResolvedValue({
    success: true,
    sampleId: 'sample-1',
    reviewedAt: '2026-07-29T11:00:00.000Z',
    revision: 1,
  });
  replaceMock.mockReset();
});

afterEach(() => {
  if (harness) {
    act(() => harness!.root.unmount());
    harness.container.remove();
    harness = null;
  }
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<CcuReviewPage />));
  harness = { container, root };
}

describe('CCU ground-truth review page', () => {
  it('shows the original photo alongside CertMate-shaped extracted circuit fields', async () => {
    mount();
    await flush();

    const text = harness!.container.textContent ?? '';
    expect(text).toContain('CCU Ground Truth');
    expect(text).toContain('Original photograph');
    expect(text).toContain('Circuit 1');
    expect(text).toContain('Sockets');
    expect(text).toContain('OCPD BS EN');

    const image = harness!.container.querySelector<HTMLImageElement>(
      'img[alt*="1785232800000-abc123"]'
    );
    expect(image?.src).toBe('https://signed.example/original.jpg');

    const designationLabel = Array.from(harness!.container.querySelectorAll('label')).find(
      (label) => label.textContent === 'Designation'
    );
    const designationInput = designationLabel?.parentElement?.querySelector('input');
    expect(designationInput?.value).toBe('Sockets');
    expect(detailMock).toHaveBeenCalledWith('sample-1');
  });

  it('saves an edited designation as the reviewed ground truth', async () => {
    mount();
    await flush();

    const designationLabel = Array.from(harness!.container.querySelectorAll('label')).find(
      (label) => label.textContent === 'Designation'
    );
    const designationInput = designationLabel?.parentElement?.querySelector('input');
    expect(designationInput).toBeTruthy();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(designationInput, 'Kitchen ring');
      designationInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = Array.from(harness!.container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Save correct board') && !button.disabled
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.click();
      await flush();
    });

    expect(saveMock).toHaveBeenCalledWith(
      'sample-1',
      expect.objectContaining({
        board: expect.objectContaining({ board_manufacturer: 'Hager' }),
        circuits: [
          expect.objectContaining({
            circuit_ref: '1',
            circuit_designation: 'Kitchen ring',
            ocpd_rating_a: '32',
          }),
        ],
      })
    );
  });
});
