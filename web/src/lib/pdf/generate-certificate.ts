import { api } from '@/lib/api-client';
import type { InspectorProfile, JobDetail } from '@/lib/types';
import { buildCertificateHtml } from './template/eicr-html-template';
import { companyFromSettings, decodePdfJob, inspectorFromProfile } from './template/decode';
import { blobToDataURI } from './template/helpers';
import type { PdfInspector, PdfJob } from './template/types';

/**
 * Client-side certificate generation — the web mirror of iOS
 * `PDFGenerator.generate(from:)` (PDFGenerator.swift:9-68):
 *
 *   1. Normalize the job so the PDF always shows a next-inspection date
 *      (nil-init installation details, default 5 years, derive the due
 *      date from dateOfInspection ?? createdAt) — lines 14-25 verbatim.
 *   2. Fetch company details + the inspector / authoriser / designer /
 *      constructor records (lines 27-55; web fetches the shared
 *      CompanySettings blob + InspectorProfile array over the API where
 *      iOS reads its local GRDB rows) and inline logo/signature images
 *      as data: URIs.
 *   3. Build portrait+landscape HTML (EICRHTMLTemplate.build port).
 *   4. Render to one merged PDF Blob (HTMLPDFRenderer.render port).
 *
 * The renderer is dynamic-imported by the caller (pdf/page.tsx) so
 * pdf-lib and the capture machinery stay out of the main bundle.
 */

/** Port of PDFGenerator.swift:14-25 — work on a clone, never mutate the
 * caller's job. Exported for direct unit-testing of the defaults. */
export function normalizePdfJob(job: PdfJob): PdfJob {
  const normalized: PdfJob = {
    ...job,
    installationDetails: job.installationDetails ? { ...job.installationDetails } : {},
  };
  const inst = normalized.installationDetails!;
  if (inst.nextInspectionYears === undefined) {
    inst.nextInspectionYears = 5;
  }
  if (inst.nextInspectionDueDate === undefined) {
    const years = inst.nextInspectionYears ?? 5;
    const baseDate = inst.dateOfInspection ?? normalized.createdAt;
    const due = new Date(baseDate.getTime());
    due.setFullYear(due.getFullYear() + years);
    inst.nextInspectionDueDate = due;
  }
  return normalized;
}

async function fetchSignatureURI(
  userId: string,
  profile: InspectorProfile | undefined
): Promise<string | undefined> {
  if (!profile?.signature_file) return undefined;
  try {
    const blob = await api.fetchSignatureBlob(userId, profile.signature_file);
    return await blobToDataURI(blob);
  } catch {
    // Best-effort, like iOS's `try?` fetches — a missing signature
    // renders an empty signature cell, never fails the certificate.
    return undefined;
  }
}

async function resolveInspector(
  userId: string,
  profiles: InspectorProfile[],
  id: string | undefined
): Promise<PdfInspector | undefined> {
  if (!id) return undefined;
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return undefined;
  return inspectorFromProfile(profile, await fetchSignatureURI(userId, profile));
}

/**
 * Generate the certificate PDF Blob for a job. `detail` is the same
 * wire payload the tabs edit (GET /api/job/:userId/:jobId shape).
 */
export async function generateCertificatePdf(userId: string, detail: JobDetail): Promise<Blob> {
  const job = normalizePdfJob(decodePdfJob(detail));

  // Fetch company details and inspectors — mirrors PDFGenerator.swift:
  // 27-55, `try?` semantics preserved (any individual fetch failure
  // renders that section blank rather than failing the PDF).
  const [companySettings, profiles] = await Promise.all([
    api.companySettings(userId).catch(() => undefined),
    api.inspectorProfiles(userId).catch(() => [] as InspectorProfile[]),
  ]);

  let logoDataURI: string | undefined;
  if (companySettings?.logo_file) {
    try {
      logoDataURI = await blobToDataURI(await api.fetchLogoBlob(userId, companySettings.logo_file));
    } catch {
      logoDataURI = undefined;
    }
  }
  const company = companyFromSettings(companySettings, logoDataURI);

  const [inspector, authorisedBy, designer, constructor] = await Promise.all([
    resolveInspector(userId, profiles, job.inspectorId),
    resolveInspector(userId, profiles, job.authorisedById),
    resolveInspector(userId, profiles, job.designerId),
    resolveInspector(userId, profiles, job.constructorId),
  ]);

  // Build HTML templates (portrait + landscape separately)
  const { portrait, landscape } = buildCertificateHtml(
    job,
    company,
    inspector,
    authorisedBy,
    designer,
    constructor
  );

  // Render to PDF via the foreignObject capture pipeline, merging
  // portrait and landscape (HTMLPDFRenderer.render mirror).
  const { renderCertificatePdf } = await import('./render');
  return renderCertificatePdf(portrait, landscape);
}
