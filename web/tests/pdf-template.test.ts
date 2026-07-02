/**
 * WS9 — certificate template + data-graph tests.
 *
 * Pins the plan-mandated behaviours of the iOS template port
 * (`src/lib/pdf/template/` + `generate-certificate.ts` normalization):
 *
 *   1. Company logo + role signatures render as data: URIs for BOTH
 *      certificate types (EICR: inspector + authoriser; EIC: designer +
 *      constructor + inspector) — the PDFGenerator.swift:27-55 data
 *      graph, exercised as pure template input.
 *   2. A job with NO installation_details still renders a populated
 *      next-inspection recommendation matching the iOS defaults
 *      (PDFGenerator.swift:14-25 — 5 years from createdAt).
 *   3. Page composition matches the iOS pipeline (page-div counts the
 *      capture renderer will turn into PDF pages, incl. the legacy
 *      board_info→single-board fallback and the 28-item inspection
 *      chunking).
 *   4. Wire-decoder leniencies documented in decode.ts (numeric-string
 *      coercion; ''-as-unset) — the strict Swift equivalent REJECTS the
 *      whole job on these, which is the iOS bug found on the WS9 EICR
 *      fixture (execution log, 2026-07-02).
 *
 * These are pure string/data tests — no browser. The raster/geometry
 * side is covered by tests/pdf-assemble.test.ts (Node) and
 * tests-e2e/pdf-renderer-spike.spec.ts (real browsers).
 */

import { describe, expect, it } from 'vitest';
import { buildCertificateHtml } from '@/lib/pdf/template/eicr-html-template';
import {
  companyFromSettings,
  decodeInstallationDetails,
  decodePdfJob,
  inspectorFromProfile,
} from '@/lib/pdf/template/decode';
import { normalizePdfJob } from '@/lib/pdf/generate-certificate';
import { escContinuity, formatDateSlash } from '@/lib/pdf/template/helpers';
import type { JobDetail } from '@/lib/types';
import type { PdfJob } from '@/lib/pdf/template/types';

const LOGO_URI = 'data:image/png;base64,LOGOBYTES==';
const SIG_INSPECTOR = 'data:image/png;base64,SIGINSPECTOR==';
const SIG_AUTHORISER = 'data:image/png;base64,SIGAUTHORISER==';
const SIG_DESIGNER = 'data:image/png;base64,SIGDESIGNER==';
const SIG_CONSTRUCTOR = 'data:image/png;base64,SIGCONSTRUCTOR==';

function pageCount(html: string, cls: 'page' | 'page-landscape'): number {
  return html.split(`class="${cls}"`).length - 1;
}

const company = companyFromSettings(
  {
    company_name: 'Beckley Electrical Ltd',
    company_address: '1 Volt Way, Reading, RG1 2AB',
    company_phone: '0118 111 2222',
    company_website: 'beckleyelectrical.co.uk',
    company_registration: 'NICEIC-12345',
    logo_file: 'settings/u1/logo/logo.png',
  },
  LOGO_URI
);

const inspector = inspectorFromProfile(
  {
    id: 'insp-1',
    name: 'Derek Beckley',
    position: 'Approved Electrician',
    signature_file: 'settings/u1/signatures/insp1.png',
    mft_serial_number: 'MFT-1741',
    mft_calibration_date: '2026-01-10',
  },
  SIG_INSPECTOR
);

const authorisedBy = inspectorFromProfile(
  { id: 'auth-1', name: 'Q. Supervisor', position: 'Qualified Supervisor' },
  SIG_AUTHORISER
);

const designer = inspectorFromProfile(
  { id: 'des-1', name: 'D. Signer', position: 'Design Engineer' },
  SIG_DESIGNER
);

const constructorProfile = inspectorFromProfile(
  { id: 'con-1', name: 'C. Structor', position: 'Installer' },
  SIG_CONSTRUCTOR
);

function baseJob(overrides: Partial<PdfJob> = {}): PdfJob {
  return {
    id: 'job_1234567890',
    createdAt: new Date(2026, 6, 2), // 02 Jul 2026 local
    certificateType: 'EICR',
    installationDetails: {
      clientName: 'Test Client Ltd',
      address: '1 Test Fixture Lane',
      town: 'Reading',
      postcode: 'RG1 1AA',
      dateOfInspection: new Date(2026, 6, 1),
      nextInspectionYears: 5,
      nextInspectionDueDate: new Date(2031, 6, 1),
    },
    boards: [{ id: 'b1', designation: 'DB-1', location: 'Hallway' }],
    circuits: [
      { id: 'c1', boardId: 'b1', circuitRef: '1', circuitDesignation: 'Sockets', r1R2Ohm: '∞' },
    ],
    observations: [],
    ...overrides,
  };
}

describe('WS9 · certificate template — logo + signatures (data graph)', () => {
  it('EICR renders company logo, inspector + authoriser signatures, equipment serials', () => {
    const { portrait, landscape } = buildCertificateHtml(
      baseJob(),
      company,
      inspector,
      authorisedBy
    );
    const all = portrait + (landscape ?? '');

    expect(portrait).toContain(LOGO_URI);
    expect(portrait).toContain(SIG_INSPECTOR);
    expect(portrait).toContain(SIG_AUTHORISER);
    expect(all).toContain('Derek Beckley');
    expect(all).toContain('Q. Supervisor');
    expect(portrait).toContain('Beckley Electrical Ltd');
    expect(portrait).toContain('NICEIC-12345');
    expect(portrait).toContain('1 Volt Way, Reading, RG1 2AB');
    // Equipment cell on the landscape circuit page (Tested by block).
    expect(landscape).toContain('MFT-1741');
    expect(landscape).toContain('Cal: 2026-01-10');
    // Landscape signature cell uses the inspector signature.
    expect(landscape).toContain(SIG_INSPECTOR);
  });

  it('EICR with no authoriser falls back to the inspector for the authorised-by row (iOS ?? fallback)', () => {
    const { portrait } = buildCertificateHtml(baseJob(), company, inspector, undefined);
    // Inspector signature appears in BOTH signature tables.
    const occurrences = portrait.split(SIG_INSPECTOR).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('EIC renders all three role signatures (design / construction / inspection)', () => {
    const { portrait } = buildCertificateHtml(
      baseJob({ certificateType: 'EIC' }),
      company,
      inspector,
      undefined,
      designer,
      constructorProfile
    );
    expect(portrait).toContain(SIG_DESIGNER);
    expect(portrait).toContain(SIG_CONSTRUCTOR);
    expect(portrait).toContain(SIG_INSPECTOR);
    expect(portrait).toContain('D. Signer');
    expect(portrait).toContain('C. Structor');
    expect(portrait).toContain(LOGO_URI);
    expect(portrait).toContain('ELECTRICAL INSTALLATION CERTIFICATE');
  });
});

describe('WS9 · PDFGenerator normalization (blank installation_details)', () => {
  it('a job with NO installation_details renders next-inspection 5 years from createdAt (iOS defaults)', () => {
    const job = normalizePdfJob(baseJob({ installationDetails: undefined }));

    expect(job.installationDetails?.nextInspectionYears).toBe(5);
    const expectedDue = new Date(2031, 6, 2); // createdAt + 5y
    expect(job.installationDetails?.nextInspectionDueDate?.getTime()).toBe(expectedDue.getTime());

    const { portrait } = buildCertificateHtml(job, undefined, undefined);
    expect(portrait).toContain('5 years from date of this report');
    expect(portrait).toContain(`Next inspection due by: ${formatDateSlash(expectedDue)}`);
  });

  it('does not overwrite explicit next-inspection values', () => {
    const job = normalizePdfJob(baseJob());
    expect(job.installationDetails?.nextInspectionYears).toBe(5);
    expect(job.installationDetails?.nextInspectionDueDate?.getTime()).toBe(
      new Date(2031, 6, 1).getTime()
    );
  });
});

describe('WS9 · page composition (what the capture renderer turns into PDF pages)', () => {
  it('EICR: 8 portrait pages (p1 + obs + p3 + 4 inspection chunks + guidance) and 1 landscape per board', () => {
    const { portrait, landscape } = buildCertificateHtml(baseJob(), company, inspector);
    expect(pageCount(portrait, 'page')).toBe(8);
    expect(pageCount(landscape ?? '', 'page-landscape')).toBe(1);
  });

  it('EIC: 4 portrait pages (p1 + EIC sections + schedule + guidance) and 1 landscape per board', () => {
    const { portrait, landscape } = buildCertificateHtml(
      baseJob({ certificateType: 'EIC' }),
      company,
      inspector
    );
    expect(pageCount(portrait, 'page')).toBe(4);
    expect(pageCount(landscape ?? '', 'page-landscape')).toBe(1);
  });

  it('no boards → no landscape document', () => {
    const { landscape } = buildCertificateHtml(baseJob({ boards: [] }), company, inspector);
    expect(landscape).toBeNull();
  });

  it('legacy flat board_info decodes into one board (Job.swift:154 fallback) so the circuit page renders', () => {
    const detail = {
      id: 'job_legacy',
      created_at: '2026-07-02T08:00:00.000Z',
      certificate_type: 'EICR',
      board_info: { location: 'Garage', manufacturer: 'Wylex' },
      circuits: [{ id: 'c9', circuit_ref: '1', circuit_designation: 'Lights' }],
    } as unknown as JobDetail;
    const job = decodePdfJob(detail);
    expect(job.boards).toHaveLength(1);
    const { landscape } = buildCertificateHtml(job, undefined, undefined);
    expect(landscape).not.toBeNull();
    // Unscoped circuits attach to the first board (hasUnscopedBoardId).
    expect(landscape).toContain('Lights');
  });

  it('renders the ∞ continuity sentinel bold instead of as a bare glyph', () => {
    const { landscape } = buildCertificateHtml(baseJob(), company, inspector);
    expect(landscape).toContain('&#8734;');
    expect(escContinuity('∞')).toContain('font-weight:700');
  });
});

describe('WS9 · wire-decoder leniencies (documented divergence from strict Swift decode)', () => {
  it("coerces numeric-string next_inspection_years and treats '' as unset", () => {
    expect(decodeInstallationDetails({ next_inspection_years: '5' })?.nextInspectionYears).toBe(5);
    expect(
      decodeInstallationDetails({ next_inspection_years: '' })?.nextInspectionYears
    ).toBeUndefined();
    expect(decodeInstallationDetails({ next_inspection_years: 3 })?.nextInspectionYears).toBe(3);
  });

  it('reads only iOS-canon keys — non-canon fixture keys render blank exactly as they do on iOS', () => {
    const inst = decodeInstallationDetails({
      premises_type: 'Domestic', // non-canon (canon: premises_description)
      estimated_age: '25', // non-canon (canon: estimated_age_of_installation)
    });
    expect(inst?.premisesDescription).toBeUndefined();
    expect(inst?.estimatedAgeOfInstallation).toBeUndefined();
  });
});
