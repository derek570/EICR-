import { htmlHead } from './css';
import {
  afddButtonDisplay,
  assembleAddress,
  boolStr,
  chunked,
  companyAddress,
  esc,
  escContinuity,
  formatDate,
  formatDateSlash,
  hasUnscopedBoardId,
  outcomeBadge,
  resolveInspectionOutcome,
  testEquipmentCell,
} from './helpers';
import { eicScheduleItems, inspectionScheduleItems, type InspectionItem } from './inspection-items';
import type { PdfCompany, PdfInspector, PdfJob, PdfObservation } from './types';

/**
 * CertMate certificate HTML template — the WEB port of the iOS canon
 * `CertMateUnified/Sources/PDF/EICRHTMLTemplate.swift` (2131 lines,
 * ported 2026-07-02 for parity WS9, ledger row `pdf/pdf-fidelity`).
 *
 * ── Renderer choice (WS9 Step 0 spike, 2026-07-02) ────────────────────
 * The template emits the SAME fixed-size page-div HTML as iOS and is
 * rendered by `../render/` — a hidden-iframe + SVG foreignObject page
 * capture assembled into a PDF Blob with pdf-lib. Chosen over
 * html2canvas (cannot render the writing-mode:vertical-lr circuit
 * headers), and over vector re-authoring in @react-pdf/renderer/pdfmake
 * (cannot consume HTML — would break the 1:1 correspondence with the
 * iOS template that this file exists to preserve). Trade-off: pages are
 * 3× rasters (crisp at print size) rather than iOS's selectable vector
 * text. Full rationale in `../render/capture.ts`.
 *
 * ── PARITY RULE (WS1 governance) ──────────────────────────────────────
 * ANY change to `EICRHTMLTemplate.swift` REQUIRES a companion change
 * here (and vice versa) — the ledger row `pdf/pdf-fidelity` records
 * this. Function names, section order, page composition, and even the
 * iOS estimate quirks (e.g. `totalPages` assuming 3 inspection pages
 * while the real chunking yields 4) are ported VERBATIM so the two
 * outputs stay page-for-page identical. Fix quirks on iOS first, then
 * mirror.
 */

/** Port of `JobDetail.nextInspectionDate` (Job.swift:108-114). */
function nextInspectionDate(job: PdfJob): Date | undefined {
  const stored = job.installationDetails?.nextInspectionDueDate;
  if (stored) return stored;
  const years = job.installationDetails?.nextInspectionYears;
  if (years === undefined) return undefined;
  const base = job.installationDetails?.dateOfInspection ?? job.createdAt;
  const d = new Date(base.getTime());
  d.setFullYear(d.getFullYear() + years);
  return d;
}

export interface BuiltCertificateHtml {
  portrait: string;
  landscape: string | null;
}

/**
 * Port of `EICRHTMLTemplate.build(from:company:inspector:authorisedBy:
 * designer:constructor:)` — returns (portraitHTML, landscapeHTML) for
 * separate rendering at different page sizes.
 */
export function buildCertificateHtml(
  job: PdfJob,
  company: PdfCompany | undefined,
  inspector: PdfInspector | undefined,
  authorisedBy: PdfInspector | undefined = undefined,
  designer: PdfInspector | undefined = undefined,
  constructor: PdfInspector | undefined = undefined
): BuiltCertificateHtml {
  const isEICR = job.certificateType === 'EICR' || job.certificateType === undefined;
  const certTitle = isEICR
    ? 'ELECTRICAL INSTALLATION CONDITION REPORT'
    : 'ELECTRICAL INSTALLATION CERTIFICATE';
  const certPrefix = isEICR ? 'EICR' : 'EIC';
  const certNumber = `${certPrefix}-${job.id.slice(0, 8).toUpperCase()}`;

  // Compute observation counts (EICR only)
  const c1Count = isEICR ? job.observations.filter((o) => o.code === 'C1').length : 0;
  const c2Count = isEICR ? job.observations.filter((o) => o.code === 'C2').length : 0;
  const c3Count = isEICR ? job.observations.filter((o) => o.code === 'C3').length : 0;
  const fiCount = isEICR ? job.observations.filter((o) => o.code === 'FI').length : 0;
  const isUnsatisfactory = c1Count > 0 || c2Count > 0;

  const logoDataURI = company?.logoDataURI;
  const signatureDataURI = inspector?.signatureDataURI;

  // Total pages estimate for footer — VERBATIM iOS estimate, including
  // its quirks (EICR assumes 3 inspection pages; actual chunking gives 4).
  const inspectionPages = isEICR ? 3 : 1; // EIC has 1 inspection schedule page (14 items)
  const circuitPages = job.boards.length === 0 ? 0 : job.boards.length;
  const portraitPageCount = isEICR ? 3 : 2; // EICR: p1+p2(obs)+p3, EIC: p1(details)+p2(supply)
  const eicExtraPages = 0;
  const totalPages = portraitPageCount + eicExtraPages + inspectionPages + circuitPages + 1; // + guidance

  // Portrait pages
  let portrait = htmlHead();

  // Page 1: Title, Client, Installation, Extent, Summary, Recommendations
  portrait += buildPage1({
    job,
    company,
    certTitle,
    certNumber,
    logoDataURI,
    isUnsatisfactory,
    totalPages,
    inspector,
    authorisedBy,
    designer,
    constructor,
    signatureDataURI,
  });

  // EICR: Page 2 = Observations, Page 3 = General Condition, Declaration, Supply
  // EIC: Page 2 = Declaration, Supply (no observations, no general condition)
  if (isEICR) {
    portrait += buildPage2(job, certNumber, c1Count, c2Count, c3Count, fiCount, totalPages);
  }

  // EICR: Page 3 = General Condition, Declaration, Supply, Particulars
  // EIC: Declaration + Supply merged into page 1 (handled in buildPage1)
  if (isEICR) {
    portrait += buildPage3(
      job,
      company,
      inspector,
      authorisedBy,
      designer,
      constructor,
      certNumber,
      logoDataURI,
      signatureDataURI,
      totalPages
    );
  }

  // EIC-specific sections (Extent & Type, Design & Construction)
  if (!isEICR) {
    portrait += buildEICSections(
      job,
      company,
      inspector,
      designer,
      constructor,
      certNumber,
      logoDataURI,
      totalPages
    );
  }

  // Inspection Schedule pages
  if (isEICR) {
    portrait += buildInspectionSchedulePages(
      job,
      inspector,
      certNumber,
      signatureDataURI,
      totalPages
    );
  } else {
    portrait += buildEICInspectionSchedulePage(
      job,
      inspector,
      certNumber,
      signatureDataURI,
      totalPages
    );
  }

  // Guidance page
  portrait += buildGuidancePage(certNumber, totalPages);

  portrait += '</body></html>';

  // Landscape pages (circuit schedules)
  let landscape: string | null = null;
  if (job.boards.length > 0) {
    let lhtml = htmlHead();
    lhtml += buildCircuitSchedulePages(job, inspector, certNumber, signatureDataURI, totalPages);
    lhtml += '</body></html>';
    landscape = lhtml;
  }

  return { portrait, landscape };
}

// MARK: - Page Header & Footer helpers

function pageHeader(logoDataURI: string | undefined, certNumber: string): string {
  const logoHTML = logoDataURI
    ? `<img src="${logoDataURI}" style="max-height:40pt;max-width:120pt;">`
    : '';

  return `
        <div style="text-align:right;font-size:7pt;margin-bottom:1pt;">
            ${logoHTML === '' ? '' : `<div style="float:left;">${logoHTML}</div>`}
            <span style="font-weight:bold;">${esc(certNumber)}</span>
        </div>
        <div style="clear:both;"></div>
        `;
}

function pageFooter(certNumber: string, pageNum: number, totalPages: number): string {
  return `
        <div class="footer">
            <span>Report produced by CertMate based on the model form from BS7671:2018+A3:2024 (18th Edition).</span>
            <span>Page ${pageNum} of ${totalPages}</span>
        </div>
        `;
}

// MARK: - Page 1: Client, Installation, Extent, Summary, Recommendations

function buildPage1(args: {
  job: PdfJob;
  company: PdfCompany | undefined;
  certTitle: string;
  certNumber: string;
  logoDataURI: string | undefined;
  isUnsatisfactory: boolean;
  totalPages: number;
  inspector: PdfInspector | undefined;
  authorisedBy: PdfInspector | undefined;
  designer: PdfInspector | undefined;
  constructor: PdfInspector | undefined;
  signatureDataURI: string | undefined;
}): string {
  // NOTE: `args.company` is accepted but not destructured — the iOS
  // buildPage1 has the same signature and same non-use (contractor
  // details render on page 3 / the EIC sections); kept for 1:1
  // call-shape parity.
  const {
    job,
    certTitle,
    certNumber,
    logoDataURI,
    isUnsatisfactory,
    totalPages,
    inspector,
    authorisedBy,
    designer,
    constructor,
    signatureDataURI,
  } = args;

  const isEICR = job.certificateType === 'EICR' || job.certificateType === undefined;
  const inst = job.installationDetails;
  const dateStr = formatDate(inst?.dateOfInspection ?? job.createdAt);
  const nextYears = inst?.nextInspectionYears !== undefined ? String(inst.nextInspectionYears) : '';
  const nextDate = nextInspectionDate(job);
  const nextDateStr = nextDate ? formatDateSlash(nextDate) : '';

  // Logo
  const logoHTML = logoDataURI
    ? `<img src="${logoDataURI}" style="max-height:45pt;max-width:140pt;">`
    : '';

  const assessmentText = isUnsatisfactory ? 'UNSATISFACTORY' : 'SATISFACTORY';

  let html = `
        <div class="page">

        <!-- Header with logo and title -->
        <div style="display:flex;align-items:flex-start;margin-bottom:2pt;">
            <div style="flex:0 0 auto;margin-right:8pt;">${logoHTML}</div>
            <div style="flex:1;">
                <div style="font-size:13pt;font-weight:bold;line-height:1.1;">${esc(certTitle)}</div>
                <div style="font-size:6.5pt;color:#333;">Requirements for electrical installations (BS7671:2018+A3:2024 18th edition)</div>
                <div style="font-size:6.5pt;color:#333;">Certificate number: ${esc(certNumber)}</div>
            </div>
        </div>

        <!-- DETAILS OF CLIENT -->
        <div class="red-bar">DETAILS OF CLIENT OR PERSON ORDERING ${isEICR ? 'REPORT' : 'THE WORK'}</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:55pt;">Client:</td>
                <td class="value" colspan="3">${esc(inst?.clientName)}</td>
            </tr>
            <tr>
                <td class="label">Address:</td>
                <td class="value" colspan="3">${esc(assembleAddress(inst?.clientAddress, inst?.clientTown, inst?.clientCounty, inst?.clientPostcode))}</td>
            </tr>
            <tr>
                <td class="label">Phone:</td>
                <td class="value">${esc(inst?.clientPhone)}</td>
                <td class="label" style="width:45pt;">Email:</td>
                <td class="value">${esc(inst?.clientEmail)}</td>
            </tr>
        </table>
        `;

  // EICR: Reason for Report section
  if (isEICR) {
    html += `

            <!-- REASON FOR REPORT -->
            <div class="red-bar">REASON FOR PRODUCING THIS REPORT</div>
            <table class="form-table">
                <tr>
                    <td class="label" style="width:55pt;">Reason:</td>
                    <td class="value-wide">${esc(inst?.reasonForReport)}</td>
                    <td class="label" style="width:110pt;">Date inspection carried out:</td>
                    <td class="value" style="width:80pt;">${esc(dateStr)}</td>
                </tr>
            </table>
            `;
  } else {
    // EIC: Date of certificate
    html += `

            <table class="form-table" style="margin-top:2pt;">
                <tr>
                    <td class="label" style="width:130pt;">Date of installation work:</td>
                    <td class="value">${esc(dateStr)}</td>
                </tr>
            </table>
            `;
  }

  // DETAILS OF INSTALLATION
  html += `

        <!-- DETAILS OF INSTALLATION -->
        <div class="red-bar">DETAILS OF THE INSTALLATION</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:130pt;">Occupier name:</td>
                <td class="value" colspan="3">${esc(inst?.occupierName)}</td>
            </tr>
            <tr>
                <td class="label">Installation address:</td>
                <td class="value" colspan="3">${esc(assembleAddress(inst?.address, inst?.town, inst?.county, inst?.postcode))}</td>
            </tr>
            <tr>
                <td class="label">Description of premises:</td>
                <td class="value" colspan="3">${esc(inst?.premisesDescription)}</td>
            </tr>
        `;

  // EICR-only installation detail rows
  if (isEICR) {
    html += `
            <tr>
                <td class="label">Installation records available:</td>
                <td class="value">${boolStr(inst?.installationRecordsAvailable)}</td>
                <td class="label" style="width:130pt;"></td>
                <td class="value"></td>
            </tr>
            <tr>
                <td class="label">Date of previous inspection:</td>
                <td class="value">${esc(inst?.dateOfPreviousInspection)}</td>
                <td class="label">Previous certificate number:</td>
                <td class="value">${esc(inst?.previousCertificateNumber)}</td>
            </tr>
            <tr>
                <td class="label">Evidence of additions/alterations:</td>
                <td class="value">${boolStr(inst?.evidenceOfAdditionsAlterations)}</td>
                <td class="label"></td>
                <td class="value"></td>
            </tr>
            <tr>
                <td class="label">Estimated age of installation:</td>
                <td class="value">${esc(inst?.estimatedAgeOfInstallation)}<span style="color:#666;"> years</span></td>
                <td class="label"></td>
                <td class="value"></td>
            </tr>
            `;
  }

  html += '</table>';

  // EICR: Extent and Limitations, Summary, Recommendations
  if (isEICR) {
    html += `

            <!-- EXTENT AND LIMITATIONS -->
            <div class="red-bar">EXTENT AND LIMITATIONS OF INSPECTION AND TESTING</div>
            <table class="form-table">
                <tr>
                    <td class="label" colspan="4" style="font-weight:bold;">Extent of the electrical installation covered by this report:</td>
                </tr>
                <tr>
                    <td class="value-wide" colspan="4" style="min-height:22pt;">${esc(inst?.extent)}</td>
                </tr>
                <tr>
                    <td class="label" colspan="4" style="font-weight:bold;">Agreed limitations including the reasons:</td>
                </tr>
                <tr>
                    <td class="value-wide" colspan="4" style="min-height:22pt;">${esc(inst?.agreedLimitations)}</td>
                </tr>
                <tr>
                    <td class="label" style="width:70pt;">Agreed with:</td>
                    <td class="value">${esc(inst?.agreedWith)}</td>
                    <td class="label" colspan="2"></td>
                </tr>
                <tr>
                    <td class="label" colspan="4" style="font-weight:bold;">Operational limitations including the reasons:</td>
                </tr>
                <tr>
                    <td class="value-wide" colspan="4" style="min-height:22pt;">${esc(inst?.operationalLimitations)}</td>
                </tr>
            </table>
            <div style="font-size:5.5pt;color:#333;margin-top:1pt;line-height:1.2;">
                The inspection and testing in this report and accompanying schedules have been carried out in accordance with BS7671:2018+A3:2024 (18th Edition)
                It should be noted that cables concealed within trunking and conduits, under floors, in roof spaces, and generally within the fabric of the building
                or underground, have not been inspected unless specifically agreed between the client and inspector prior to the inspection.
                An inspection should be made within an accessible roof space housing other electrical equipment.
            </div>

            <!-- SUMMARY -->
            <div class="red-bar">SUMMARY OF THE CONDITION OF THE INSTALLATION</div>
            <div class="summary-box">
                <div class="summary-label">
                    Overall assessment of the installation in<br>terms of it's suitability for continued use*
                </div>
                <div class="summary-result">${esc(assessmentText)}</div>
                <div class="summary-note">
                    *An unsatisfactory assessment indicates that<br>
                    dangerous (Code C1) and/or potentially dangerous<br>
                    (Code C2) conditions have been identified.
                </div>
            </div>

            <!-- RECOMMENDATIONS -->
            <div class="red-bar">RECOMMENDATIONS</div>
            <div style="font-size:6pt;line-height:1.3;padding:3pt;border:0.75pt solid #CCC;border-top:none;">
                <p>Where the overall assessment of the suitability of the installation for continued use above is stated as UNSATISFACTORY, I / we recommend that
                any observations classified as 'Danger present' (code C1) or 'Potentially dangerous' (code C2) are acted upon as a matter of urgency. Investigation
                without delay is recommended for observations identified as 'Further investigation required' (code FI). Observations classified as 'Improvement
                recommended' (code C3) should be given due consideration.</p>

                <p style="margin-top:4pt;"><b>Subject to the necessary remedial action being taken, I/we recommend that the installation is further inspected and tested by:</b></p>
                <div style="background:#FFFFFF;border:0.75pt solid #CCC;padding:3pt;margin-top:2pt;min-height:14pt;">
                    ${nextYears === '' ? '' : `${esc(nextYears)} years from date of this report`}
                    ${nextDateStr === '' ? '' : `<br><b>Next inspection due by: ${esc(nextDateStr)}</b>`}
                </div>

                <p style="margin-top:2pt;font-size:5.5pt;color:#333;">Note: The proposed date for the next inspection should take into consideration the frequency and quality of maintenance that the installation can
                reasonably be expected to receive during its intended life. The period should be agreed between relevant parties.</p>
            </div>
            `;
  } else {
    // EIC: Description and Extent of Installation
    const newInstChecked =
      job.extentAndType?.installationType?.toLowerCase().includes('new') === true ? '\u{2713}' : '';
    const additionChecked =
      job.extentAndType?.installationType?.toLowerCase().includes('addition') === true
        ? '\u{2713}'
        : '';
    const alterationChecked =
      job.extentAndType?.installationType?.toLowerCase().includes('alteration') === true
        ? '\u{2713}'
        : '';

    html += `

            <div class="red-bar">DESCRIPTION AND EXTENT OF THE INSTALLATION</div>
            <table class="form-table">
                <tr>
                    <td class="label" style="width:120pt;">Description of installation:</td>
                    <td class="value" colspan="3">${esc(inst?.premisesDescription)}</td>
                </tr>
                <tr>
                    <td class="label" style="vertical-align:top;">Extent of installation covered by this Certificate:</td>
                    <td class="value" colspan="3" style="min-height:90pt;white-space:pre-wrap;vertical-align:top;font-size:5.5pt;line-height:1.25;">${esc(job.extentAndType?.extent)}</td>
                </tr>
                <tr>
                    <td class="label" style="width:120pt;"></td>
                    <td style="background:#F0F0F0;width:100pt;"><span class="checkbox">${newInstChecked}</span> New installation</td>
                    <td style="background:#F0F0F0;width:140pt;"><span class="checkbox">${additionChecked}</span> Addition to an existing installation</td>
                    <td style="background:#F0F0F0;"><span class="checkbox">${alterationChecked}</span> Alteration to an existing installation</td>
                </tr>
            </table>
            `;

    // EIC: Design departures
    html += `

            <div class="red-bar">DESIGN AND CONSTRUCTION</div>
            <table class="form-table">
                <tr>
                    <td class="label" style="width:140pt;">Departures from BS 7671:</td>
                    <td class="value" colspan="3">${esc(job.designConstruction?.departuresFromBs7671)}</td>
                </tr>
                <tr>
                    <td class="label">Departure details:</td>
                    <td class="value" colspan="3">${esc(job.designConstruction?.departureDetails)}</td>
                </tr>
                <tr>
                    <td class="label">Comments:</td>
                    <td class="value" colspan="3">${esc(job.extentAndType?.comments)}</td>
                </tr>
            </table>
            `;

    // EIC: Signatures (Design, Construction, Inspection & Testing)
    const sigHTML = signatureDataURI ? `<img class="sig-img" src="${signatureDataURI}">` : '';
    const authSigHTML = authorisedBy?.signatureDataURI
      ? `<img class="sig-img" src="${authorisedBy.signatureDataURI}">`
      : '';

    html += signatureSection({
      isEICR: false,
      inspector,
      authorisedBy,
      designer,
      constructor,
      sigHTML,
      authSigHTML,
      dateStr,
    });

    // EIC: Next inspection recommendation
    html += `

            <div class="red-bar">NEXT INSPECTION</div>
            <table class="form-table">
                <tr>
                    <td class="label" style="width:200pt;">I/we recommend that this installation is further inspected and tested after an interval of no more than:</td>
                    <td class="value" style="text-align:center;font-weight:bold;">${nextYears === '' ? '&nbsp;' : `${esc(nextYears)} years`}</td>
                </tr>
                <tr>
                    <td class="label" style="width:200pt;">Next inspection due by:</td>
                    <td class="value" style="text-align:center;font-weight:bold;">${nextDateStr === '' ? '&nbsp;' : esc(nextDateStr)}</td>
                </tr>
            </table>
            `;
  }

  html += pageFooter(certNumber, 1, totalPages);
  html += '</div>';
  return html;
}

// MARK: - Page 2: Observations

function buildPage2(
  job: PdfJob,
  certNumber: string,
  c1Count: number,
  c2Count: number,
  c3Count: number,
  fiCount: number,
  totalPages: number
): string {
  let rows = '';

  if (job.observations.length > 0) {
    job.observations.forEach((obs: PdfObservation, i: number) => {
      const bgStyle = i % 2 === 0 ? '' : ' style="background:#FFFEF5;"';
      let badgeClass: string;
      switch (obs.code) {
        case 'C1':
          badgeClass = 'badge-c1';
          break;
        case 'C2':
          badgeClass = 'badge-c2';
          break;
        case 'C3':
          badgeClass = 'badge-c3';
          break;
        case 'FI':
          badgeClass = 'badge-fi';
          break;
      }
      const obsText = [obs.observationText, obs.regulation ? `Reg: ${obs.regulation}` : undefined]
        .filter((p): p is string => p !== undefined)
        .join(' — ');
      rows += `
                <tr${bgStyle}>
                    <td style="text-align:center;width:25pt;">${i + 1}</td>
                    <td style="width:60pt;">${esc(obs.itemLocation)}</td>
                    <td>${esc(obsText)}</td>
                    <td style="text-align:center;width:45pt;"><span class="badge ${badgeClass}">${obs.code}</span></td>
                </tr>
                `;
    });
  }

  return `
        <div class="page">

        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2pt;">
            <div class="page-title">OBSERVATIONS AND RECOMMENDATIONS</div>
            <div style="font-size:7pt;font-weight:bold;">${esc(certNumber)}</div>
        </div>
        <div style="font-size:6pt;color:#333;margin-bottom:4pt;">
            One of the following codes, as appropriate, has been allocated to each of the observations made above to indicate to
            responsible for the installation the degree of urgency for remedial action.
        </div>

        <!-- Code summary cards -->
        <div style="display:flex;gap:6pt;margin-bottom:4pt;">
            <div class="code-card">
                <span class="badge badge-c1">C1</span>
                <span class="count">${c1Count} items</span><br>
                <span class="desc">Danger present, risk of injury<br>(Immediate remedial action required)</span>
            </div>
            <div class="code-card">
                <span class="badge badge-c2">C2</span>
                <span class="count">${c2Count} items</span><br>
                <span class="desc">Potentially dangerous (Urgent remedial<br>action required)</span>
            </div>
            <div class="code-card">
                <span class="badge badge-c3">C3</span>
                <span class="count">${c3Count} items</span><br>
                <span class="desc">Improvement recommended<br>(Non-urgent remedial action)</span>
            </div>
            <div class="code-card">
                <span class="badge badge-fi">FI</span>
                <span class="count">${fiCount} items</span><br>
                <span class="desc">Further investigation required without<br>delay</span>
            </div>
        </div>

        <!-- Observation table -->
        <table class="obs-table">
            <thead>
                <tr>
                    <th style="width:25pt;">No.</th>
                    <th style="width:60pt;">Location</th>
                    <th>Observation</th>
                    <th style="width:45pt;">Code</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>

        ${pageFooter(certNumber, 2, totalPages)}
        </div>
        `;
}

// MARK: - Page 3: General Condition, Declaration, Supply, Particulars

function buildPage3(
  job: PdfJob,
  company: PdfCompany | undefined,
  inspector: PdfInspector | undefined,
  authorisedBy: PdfInspector | undefined,
  designer: PdfInspector | undefined,
  constructor: PdfInspector | undefined,
  certNumber: string,
  logoDataURI: string | undefined,
  signatureDataURI: string | undefined,
  totalPages: number
): string {
  const supply = job.supplyCharacteristics;
  const dateStr = formatDate(job.installationDetails?.dateOfInspection ?? job.createdAt);

  // Signature HTML for inspector
  const sigHTML = signatureDataURI ? `<img class="sig-img" src="${signatureDataURI}">` : '';

  // Signature HTML for authorised-by
  const authSigHTML = authorisedBy?.signatureDataURI
    ? `<img class="sig-img" src="${authorisedBy.signatureDataURI}">`
    : '';

  // Means of earthing checkboxes
  const earthDistChecked = supply?.meansEarthingDistributor === true ? '\u{2713}' : '';
  const earthElecChecked = supply?.meansEarthingElectrode === true ? '\u{2713}' : '';

  // Earth electrode details
  const earthElecType = supply?.earthElectrodeType ?? 'N/A';
  const earthElecResistance = supply?.earthElectrodeResistance ?? 'N/A';
  const earthElecLocation = supply?.earthElectrodeLocation ?? 'N/A';

  // Company address
  const compAddr = companyAddress(company);

  const isEICR = job.certificateType === 'EICR' || job.certificateType === undefined;
  const pageNum = isEICR ? 3 : 2;

  let page3 = `
        <div class="page">
        ${pageHeader(logoDataURI, certNumber)}
        `;

  // General Condition — EICR only
  if (isEICR) {
    page3 += `

            <!-- GENERAL CONDITION -->
            <div class="red-bar">GENERAL CONDITION OF THE INSTALLATION</div>
            <table class="form-table">
                <tr><td class="label" colspan="4">General Condition of the Installation:</td></tr>
                <tr><td class="value-wide" colspan="4" style="min-height:24pt;">${esc(job.installationDetails?.generalConditionOfInstallation)}</td></tr>
            </table>
            `;
  }

  // Declaration
  const declarationText = isEICR
    ? 'I/We, being the person(s) responsible for the inspection and testing of the electrical installation (as indicated by my/our signatures below), particulars of which are described above, having exercised reasonable skill and care when carrying out the inspection and testing, hereby declare that the information in this report, including the observations and the attached schedules, provides an accurate assessment of the condition of the electrical installation taking into account the stated extent and limitations in this report.'
    : 'I/We, being the person(s) responsible for the design, construction, inspection and testing of the electrical installation (as indicated by my/our signatures below), particulars of which are described above, having exercised reasonable skill and care when carrying out the design, construction, inspection and testing, hereby declare that the work for which I/we have been responsible is to the best of my/our knowledge and belief in accordance with BS 7671:2018+A3:2024 (18th Edition), except for the departures, if any, detailed in this report.';

  page3 += `

        <!-- DECLARATION -->
        <div class="red-bar" style="margin-top:4pt;">DECLARATION</div>
        <table class="form-table">
            <tr><td class="value" colspan="4" style="font-size:6pt;line-height:1.2;padding:3pt;">
                ${declarationText}
            </td></tr>
        </table>

        <!-- Contractor details -->
        <table class="form-table" style="margin-top:4pt;">
            <tr>
                <td class="label" style="width:70pt;">Trading title:</td>
                <td class="value">${esc(company?.companyName)}</td>
                <td class="label" style="width:90pt;">Enrolment number:</td>
                <td class="value">${esc(company?.enrolmentNumber)}</td>
            </tr>
            <tr>
                <td class="label">Address:</td>
                <td class="value" colspan="3">${compAddr}</td>
            </tr>
            <tr>
                <td class="label">Website:</td>
                <td class="value">${esc(company?.website)}</td>
                <td class="label">Phone:</td>
                <td class="value">${esc(company?.phoneNumber)}</td>
            </tr>
        </table>

        ${signatureSection({ isEICR, inspector, authorisedBy, designer, constructor, sigHTML, authSigHTML, dateStr })}

        <!-- SUPPLY CHARACTERISTICS -->
        <div class="red-bar" style="margin-top:4pt;">SUPPLY CHARACTERISTICS AND EARTHING ARRANGEMENTS</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:100pt;">Earthing arrangement:</td>
                <td class="value">${esc(supply?.earthingArrangement)}</td>
                <td class="label" style="width:135pt;">Number and type of live conductors:</td>
                <td class="value">AC - ${esc(supply?.liveConductors)}</td>
            </tr>
        </table>

        <div style="font-weight:bold;font-size:6.5pt;margin-top:2pt;margin-bottom:1pt;">Nature of Supply Parameters</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:85pt;">Nominal voltage (U):</td>
                <td class="value">${esc(supply?.nominalVoltageU)}<span style="color:#666;"> V</span></td>
                <td class="label" style="width:25pt;">Uo:</td>
                <td class="value">${esc(supply?.nominalVoltageUo)}<span style="color:#666;"> V</span></td>
                <td class="label" style="width:85pt;">Nominal frequency:</td>
                <td class="value">${esc(supply?.nominalFrequency)}<span style="color:#666;"> Hz</span></td>
                <td class="label" style="width:95pt;">Supply polarity confirmed:</td>
                <td class="value">${boolStr(supply?.supplyPolarityConfirmed)}</td>
            </tr>
            <tr>
                <td class="label">Prospective fault current:</td>
                <td class="value">${esc(supply?.prospectiveFaultCurrent)}<span style="color:#666;"> kA</span></td>
                <td class="label" colspan="2">Earth loop impedance (Ze):</td>
                <td class="value">${esc(supply?.earthLoopImpedanceZe)}<span style="color:#666;"> ohm</span></td>
                <td class="label">Number of supplies:</td>
                <td class="value" colspan="2">${esc(supply?.numberOfSupplies)}</td>
            </tr>
        </table>

        <div style="font-weight:bold;font-size:6.5pt;margin-top:2pt;margin-bottom:1pt;">Supply Protective Device (Main Fuse)</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:50pt;">BS (EN):</td>
                <td class="value">${esc(supply?.spdBsEn)}</td>
                <td class="label" style="width:40pt;">Type:</td>
                <td class="value">${esc(supply?.spdTypeSupply)}</td>
                <td class="label" style="width:100pt;">Short circuit capacity:</td>
                <td class="value">${esc(supply?.spdShortCircuit)}<span style="color:#666;"> kA</span></td>
                <td class="label" style="width:75pt;">Rated current:</td>
                <td class="value">${esc(supply?.spdRatedCurrent)}<span style="color:#666;"> A</span></td>
            </tr>
        </table>

        <!-- Surge Protection Device (surge-protection-box 2026-06-17). Item
             4.19 schedule row stays static — NOT auto-filled from this block. -->
        <div style="font-weight:bold;font-size:6.5pt;margin-top:2pt;margin-bottom:1pt;">Surge Protection Device</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:50pt;">Fitted:</td>
                <td class="value">${esc(supply?.surgeSpdPresent)}</td>
                <td class="label" style="width:40pt;">Type:</td>
                <td class="value">${esc(supply?.surgeSpdType)}</td>
                <td class="label" style="width:100pt;">BS (EN):</td>
                <td class="value">${esc(supply?.surgeSpdBsEn)}</td>
                <td class="label" style="width:75pt;">Status indicator:</td>
                <td class="value">${esc(supply?.surgeStatusIndicator)}</td>
            </tr>
        </table>

        <!-- PARTICULARS OF INSTALLATION -->
        <div class="red-bar" style="margin-top:4pt;">PARTICULARS OF INSTALLATION REFERRED TO IN THE REPORT</div>

        <!-- Means of Earthing + Earth Electrode -->
        <table class="form-table">
            <tr>
                <td class="label" style="width:100pt;" rowspan="2">Means of earthing</td>
                <td style="width:110pt;background:#F0F0F0;">
                    <span class="checkbox">${earthDistChecked}</span> Distributor's facility
                </td>
                <td class="label" colspan="4">Details of installation earth electrode (where applicable)</td>
                <td class="label" colspan="2"></td>
            </tr>
            <tr>
                <td style="background:#F0F0F0;">
                    <span class="checkbox">${earthElecChecked}</span> Earth electrode
                </td>
                <td class="label" style="width:35pt;">Type:</td>
                <td class="value">${esc(earthElecType)}</td>
                <td class="label" style="width:80pt;">Resistance to earth:</td>
                <td class="value">${esc(earthElecResistance)}<span style="color:#666;"> ohm</span></td>
                <td class="label" style="width:55pt;">Location:</td>
                <td class="value">${esc(earthElecLocation)}</td>
            </tr>
        </table>

        <!-- Main Switch -->
        <div style="font-weight:bold;font-size:6.5pt;margin-top:2pt;margin-bottom:1pt;">Main switch / switch fuse / circuit breaker / RCD</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:60pt;">Type BS(EN):</td>
                <td class="value">${esc(supply?.mainSwitchBsEn)}</td>
                <td class="label" style="width:75pt;">Number of poles:</td>
                <td class="value">${esc(supply?.mainSwitchPoles)}</td>
                <td class="label" style="width:70pt;">Location:</td>
                <td class="value">${esc(supply?.mainSwitchLocation)}</td>
            </tr>
            <tr>
                <td class="label">Voltage rating:</td>
                <td class="value">${esc(supply?.mainSwitchVoltage)}<span style="color:#666;"> V</span></td>
                <td class="label">Rated current:</td>
                <td class="value">${esc(supply?.mainSwitchCurrent)}<span style="color:#666;"> A</span></td>
                <td class="label"></td><td class="value"></td>
            </tr>
            <tr>
                <td class="label">Fuse device setting:</td>
                <td class="value">${esc(supply?.mainSwitchFuseSetting)}<span style="color:#666;"> A</span></td>
                <td class="label">Conductor material:</td>
                <td class="value">${esc(supply?.mainSwitchConductorMaterial)}</td>
                <td class="label">Conductor CSA:</td>
                <td class="value">${esc(supply?.mainSwitchConductorCsa)}<span style="color:#666;"> mm\u{00B2}</span></td>
            </tr>
            <tr>
                <td class="label" style="font-size:6.5pt;">If RCD main switch:<br>RCD operating current:</td>
                <td class="value">${esc(supply?.rcdOperatingCurrent)}<span style="color:#666;"> mA</span></td>
                <td class="label">RCD time delay:</td>
                <td class="value">${esc(supply?.rcdTimeDelay)}<span style="color:#666;"> ms</span></td>
                <td class="label" style="font-size:6.5pt;">RCD operating time:</td>
                <td class="value">${esc(supply?.rcdOperatingTime)}<span style="color:#666;"> ms</span></td>
            </tr>
        </table>

        <!-- Earthing & Bonding Conductors -->
        <table class="form-table" style="margin-top:3pt;">
            <tr>
                <td class="label" style="width:110pt;font-weight:bold;">Earthing conductor</td>
                <td class="label" style="width:85pt;">Conductor material:</td>
                <td class="value">${esc(supply?.earthingConductorMaterial)}</td>
                <td class="label" style="width:75pt;">Conductor CSA:</td>
                <td class="value">${esc(supply?.earthingConductorCsa)}<span style="color:#666;"> mm\u{00B2}</span></td>
                <td class="label" style="width:60pt;">Continuity:</td>
                <td class="value">${esc(supply?.earthingConductorContinuity)}</td>
            </tr>
            <tr>
                <td class="label" style="font-weight:bold;">Main protective bonding</td>
                <td class="label">Conductor material:</td>
                <td class="value">${esc(supply?.mainBondingMaterial)}</td>
                <td class="label">Conductor CSA:</td>
                <td class="value">${esc(supply?.mainBondingCsa)}<span style="color:#666;"> mm\u{00B2}</span></td>
                <td class="label">Continuity:</td>
                <td class="value">${esc(supply?.mainBondingContinuity)}</td>
            </tr>
        </table>

        <!-- Bonding -->
        <div style="font-weight:bold;font-size:6.5pt;margin-top:2pt;margin-bottom:1pt;">Bonding of extraneous conductive parts</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:45pt;">Water:</td>
                <td class="value">${esc(supply?.bondingWater)}</td>
                <td class="label" style="width:35pt;">Gas:</td>
                <td class="value">${esc(supply?.bondingGas)}</td>
                <td class="label" style="width:30pt;">Oil:</td>
                <td class="value">${esc(supply?.bondingOil)}</td>
                <td class="label" style="width:35pt;">Steel:</td>
                <td class="value">${esc(supply?.bondingStructuralSteel)}</td>
                <td class="label" style="width:55pt;">Lightning:</td>
                <td class="value">${esc(supply?.bondingLightning)}</td>
            </tr>
            <tr>
                <td class="label">Other:</td>
                <td class="value" colspan="9">${supply?.bondingOtherNa === true ? 'N/A' : esc(supply?.bondingOther)}</td>
            </tr>
        </table>

        ${pageFooter(certNumber, pageNum, totalPages)}
        </div>
        `;
  return page3;
}

// MARK: - Signature Section

function signatureSection(args: {
  isEICR: boolean;
  inspector: PdfInspector | undefined;
  authorisedBy: PdfInspector | undefined;
  designer: PdfInspector | undefined;
  constructor: PdfInspector | undefined;
  sigHTML: string;
  authSigHTML: string;
  dateStr: string;
}): string {
  const { isEICR, inspector, authorisedBy, designer, constructor, sigHTML, authSigHTML, dateStr } =
    args;

  if (isEICR) {
    // EICR: Inspected & Tested by + Report Authorised by
    return `
            <!-- SIGNATURES -->
            <table class="form-table" style="margin-top:4pt;">
                <tr>
                    <td class="label" style="width:140pt;">Inspected and Tested by:</td>
                    <td class="value">${esc(inspector?.fullName)}</td>
                    <td class="label" style="width:60pt;">Position:</td>
                    <td class="value">${esc(inspector?.position)}</td>
                </tr>
                <tr>
                    <td class="label">Signature:</td>
                    <td class="value" style="height:22pt;">${sigHTML}</td>
                    <td class="label">Date:</td>
                    <td class="value">${dateStr}</td>
                </tr>
            </table>
            <table class="form-table" style="margin-top:4pt;">
                <tr>
                    <td class="label" style="width:140pt;">Report authorised by:</td>
                    <td class="value">${esc(authorisedBy?.fullName ?? inspector?.fullName)}</td>
                    <td class="label" style="width:60pt;">Position:</td>
                    <td class="value">${esc(authorisedBy?.position ?? inspector?.position)}</td>
                </tr>
                <tr>
                    <td class="label">Signature:</td>
                    <td class="value" style="height:22pt;">${authSigHTML === '' ? sigHTML : authSigHTML}</td>
                    <td class="label">Date:</td>
                    <td class="value">${dateStr}</td>
                </tr>
            </table>
            `;
  }

  // EIC: Three signature roles — Design, Construction, Inspection & Testing
  const designerSigHTML = designer?.signatureDataURI
    ? `<img class="sig-img" src="${designer.signatureDataURI}">`
    : '';
  const constructorSigHTML = constructor?.signatureDataURI
    ? `<img class="sig-img" src="${constructor.signatureDataURI}">`
    : '';

  return `
            <!-- EIC SIGNATURES -->
            <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">For the DESIGN of the electrical installation</div>
            <table class="form-table">
                <tr>
                    <td class="label" style="width:50pt;">Name:</td>
                    <td class="value">${esc(designer?.fullName)}</td>
                    <td class="label" style="width:60pt;">Position:</td>
                    <td class="value">${esc(designer?.position)}</td>
                </tr>
                <tr>
                    <td class="label">Signature:</td>
                    <td class="value" style="height:20pt;">${designerSigHTML}</td>
                    <td class="label">Date:</td>
                    <td class="value">${dateStr}</td>
                </tr>
            </table>

            <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">For the CONSTRUCTION of the electrical installation</div>
            <table class="form-table">
                <tr>
                    <td class="label" style="width:50pt;">Name:</td>
                    <td class="value">${esc(constructor?.fullName)}</td>
                    <td class="label" style="width:60pt;">Position:</td>
                    <td class="value">${esc(constructor?.position)}</td>
                </tr>
                <tr>
                    <td class="label">Signature:</td>
                    <td class="value" style="height:20pt;">${constructorSigHTML}</td>
                    <td class="label">Date:</td>
                    <td class="value">${dateStr}</td>
                </tr>
            </table>

            <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">For the INSPECTION & TESTING of the electrical installation</div>
            <table class="form-table">
                <tr>
                    <td class="label" style="width:50pt;">Name:</td>
                    <td class="value">${esc(inspector?.fullName)}</td>
                    <td class="label" style="width:60pt;">Position:</td>
                    <td class="value">${esc(inspector?.position)}</td>
                </tr>
                <tr>
                    <td class="label">Signature:</td>
                    <td class="value" style="height:20pt;">${sigHTML}</td>
                    <td class="label">Date:</td>
                    <td class="value">${dateStr}</td>
                </tr>
            </table>
            `;
}

// MARK: - EIC Specific Sections

function buildEICSections(
  job: PdfJob,
  company: PdfCompany | undefined,
  inspector: PdfInspector | undefined,
  designer: PdfInspector | undefined,
  constructor: PdfInspector | undefined,
  certNumber: string,
  logoDataURI: string | undefined,
  totalPages: number
): string {
  const supply = job.supplyCharacteristics;
  const compAddr = companyAddress(company);

  // Means of earthing checkboxes
  const earthDistChecked = supply?.meansEarthingDistributor === true ? '\u{2713}' : '';
  const earthElecChecked = supply?.meansEarthingElectrode === true ? '\u{2713}' : '';
  const earthElecType = supply?.earthElectrodeType ?? 'N/A';
  const earthElecResistance = supply?.earthElectrodeResistance ?? 'N/A';
  const earthElecLocation = supply?.earthElectrodeLocation ?? 'N/A';

  return `
        <div class="page">
        ${pageHeader(logoDataURI, certNumber)}

        <!-- PARTICULARS OF SIGNATORIES -->
        <div class="red-bar">PARTICULARS OF SIGNATORIES TO THE ELECTRICAL INSTALLATION CERTIFICATE</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:70pt;">Trading title:</td>
                <td class="value">${esc(company?.companyName)}</td>
                <td class="label" style="width:90pt;">Enrolment number:</td>
                <td class="value">${esc(company?.enrolmentNumber)}</td>
            </tr>
            <tr>
                <td class="label">Address:</td>
                <td class="value" colspan="3">${compAddr}</td>
            </tr>
            <tr>
                <td class="label">Website:</td>
                <td class="value">${esc(company?.website)}</td>
                <td class="label">Phone:</td>
                <td class="value">${esc(company?.phoneNumber)}</td>
            </tr>
        </table>
        <table class="form-table" style="margin-top:2pt;">
            <tr>
                <td class="label" style="width:80pt;font-weight:bold;">Designer</td>
                <td class="label" style="width:40pt;">Name:</td>
                <td class="value">${esc(designer?.fullName)}</td>
                <td class="label" style="width:55pt;">Company:</td>
                <td class="value">${esc(company?.companyName)}</td>
            </tr>
            <tr>
                <td class="label" style="font-weight:bold;">Constructor</td>
                <td class="label">Name:</td>
                <td class="value">${esc(constructor?.fullName)}</td>
                <td class="label">Company:</td>
                <td class="value">${esc(company?.companyName)}</td>
            </tr>
            <tr>
                <td class="label" style="font-weight:bold;">Inspector</td>
                <td class="label">Name:</td>
                <td class="value">${esc(inspector?.fullName)}</td>
                <td class="label">Company:</td>
                <td class="value">${esc(company?.companyName)}</td>
            </tr>
        </table>

        <!-- SUPPLY CHARACTERISTICS -->
        <div class="red-bar" style="margin-top:4pt;">SUPPLY CHARACTERISTICS AND EARTHING ARRANGEMENTS</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:100pt;">Earthing arrangement:</td>
                <td class="value">${esc(supply?.earthingArrangement)}</td>
                <td class="label" style="width:135pt;">Number and type of live conductors:</td>
                <td class="value">AC - ${esc(supply?.liveConductors)}</td>
            </tr>
        </table>

        <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">Nature of Supply Parameters</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:85pt;">Nominal voltage (U):</td>
                <td class="value">${esc(supply?.nominalVoltageU)}<span style="color:#666;"> V</span></td>
                <td class="label" style="width:25pt;">Uo:</td>
                <td class="value">${esc(supply?.nominalVoltageUo)}<span style="color:#666;"> V</span></td>
                <td class="label" style="width:85pt;">Nominal frequency:</td>
                <td class="value">${esc(supply?.nominalFrequency)}<span style="color:#666;"> Hz</span></td>
                <td class="label" style="width:95pt;">Supply polarity confirmed:</td>
                <td class="value">${boolStr(supply?.supplyPolarityConfirmed)}</td>
            </tr>
            <tr>
                <td class="label">Prospective fault current:</td>
                <td class="value">${esc(supply?.prospectiveFaultCurrent)}<span style="color:#666;"> kA</span></td>
                <td class="label" colspan="2">Earth loop impedance (Ze):</td>
                <td class="value">${esc(supply?.earthLoopImpedanceZe)}<span style="color:#666;"> ohm</span></td>
                <td class="label">Number of supplies:</td>
                <td class="value" colspan="2">${esc(supply?.numberOfSupplies)}</td>
            </tr>
        </table>

        <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">Supply Protective Device (Main Fuse)</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:50pt;">BS (EN):</td>
                <td class="value">${esc(supply?.spdBsEn)}</td>
                <td class="label" style="width:40pt;">Type:</td>
                <td class="value">${esc(supply?.spdTypeSupply)}</td>
                <td class="label" style="width:100pt;">Short circuit capacity:</td>
                <td class="value">${esc(supply?.spdShortCircuit)}<span style="color:#666;"> kA</span></td>
                <td class="label" style="width:75pt;">Rated current:</td>
                <td class="value">${esc(supply?.spdRatedCurrent)}<span style="color:#666;"> A</span></td>
            </tr>
        </table>

        <!-- Surge Protection Device (surge-protection-box 2026-06-17). -->
        <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">Surge Protection Device</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:50pt;">Fitted:</td>
                <td class="value">${esc(supply?.surgeSpdPresent)}</td>
                <td class="label" style="width:40pt;">Type:</td>
                <td class="value">${esc(supply?.surgeSpdType)}</td>
                <td class="label" style="width:100pt;">BS (EN):</td>
                <td class="value">${esc(supply?.surgeSpdBsEn)}</td>
                <td class="label" style="width:75pt;">Status indicator:</td>
                <td class="value">${esc(supply?.surgeStatusIndicator)}</td>
            </tr>
        </table>

        <!-- PARTICULARS OF INSTALLATION -->
        <div class="red-bar" style="margin-top:4pt;">PARTICULARS OF INSTALLATION REFERRED TO IN THE CERTIFICATE</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:100pt;" rowspan="2">Means of earthing</td>
                <td style="width:110pt;background:#F0F0F0;">
                    <span class="checkbox">${earthDistChecked}</span> Distributor's facility
                </td>
                <td class="label" colspan="4">Details of installation earth electrode (where applicable)</td>
                <td class="label" colspan="2"></td>
            </tr>
            <tr>
                <td style="background:#F0F0F0;">
                    <span class="checkbox">${earthElecChecked}</span> Earth electrode
                </td>
                <td class="label" style="width:35pt;">Type:</td>
                <td class="value">${esc(earthElecType)}</td>
                <td class="label" style="width:80pt;">Resistance to earth:</td>
                <td class="value">${esc(earthElecResistance)}<span style="color:#666;"> ohm</span></td>
                <td class="label" style="width:55pt;">Location:</td>
                <td class="value">${esc(earthElecLocation)}</td>
            </tr>
        </table>

        <!-- Main Switch -->
        <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">Main switch / switch fuse / circuit breaker / RCD</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:60pt;">Type BS(EN):</td>
                <td class="value">${esc(supply?.mainSwitchBsEn)}</td>
                <td class="label" style="width:75pt;">Number of poles:</td>
                <td class="value">${esc(supply?.mainSwitchPoles)}</td>
                <td class="label" style="width:70pt;">Location:</td>
                <td class="value">${esc(supply?.mainSwitchLocation)}</td>
            </tr>
            <tr>
                <td class="label">Voltage rating:</td>
                <td class="value">${esc(supply?.mainSwitchVoltage)}<span style="color:#666;"> V</span></td>
                <td class="label">Rated current:</td>
                <td class="value">${esc(supply?.mainSwitchCurrent)}<span style="color:#666;"> A</span></td>
                <td class="label"></td><td class="value"></td>
            </tr>
            <tr>
                <td class="label">Fuse device setting:</td>
                <td class="value">${esc(supply?.mainSwitchFuseSetting)}<span style="color:#666;"> A</span></td>
                <td class="label">Conductor material:</td>
                <td class="value">${esc(supply?.mainSwitchConductorMaterial)}</td>
                <td class="label">Conductor CSA:</td>
                <td class="value">${esc(supply?.mainSwitchConductorCsa)}<span style="color:#666;"> mm\u{00B2}</span></td>
            </tr>
            <tr>
                <td class="label" style="font-size:6pt;">If RCD main switch:<br>RCD operating current:</td>
                <td class="value">${esc(supply?.rcdOperatingCurrent)}<span style="color:#666;"> mA</span></td>
                <td class="label">RCD time delay:</td>
                <td class="value">${esc(supply?.rcdTimeDelay)}<span style="color:#666;"> ms</span></td>
                <td class="label" style="font-size:6pt;">RCD operating time:</td>
                <td class="value">${esc(supply?.rcdOperatingTime)}<span style="color:#666;"> ms</span></td>
            </tr>
        </table>

        <!-- Earthing & Bonding Conductors -->
        <table class="form-table" style="margin-top:2pt;">
            <tr>
                <td class="label" style="width:110pt;font-weight:bold;">Earthing conductor</td>
                <td class="label" style="width:85pt;">Conductor material:</td>
                <td class="value">${esc(supply?.earthingConductorMaterial)}</td>
                <td class="label" style="width:75pt;">Conductor CSA:</td>
                <td class="value">${esc(supply?.earthingConductorCsa)}<span style="color:#666;"> mm\u{00B2}</span></td>
                <td class="label" style="width:60pt;">Continuity:</td>
                <td class="value">${esc(supply?.earthingConductorContinuity)}</td>
            </tr>
            <tr>
                <td class="label" style="font-weight:bold;">Main protective bonding</td>
                <td class="label">Conductor material:</td>
                <td class="value">${esc(supply?.mainBondingMaterial)}</td>
                <td class="label">Conductor CSA:</td>
                <td class="value">${esc(supply?.mainBondingCsa)}<span style="color:#666;"> mm\u{00B2}</span></td>
                <td class="label">Continuity:</td>
                <td class="value">${esc(supply?.mainBondingContinuity)}</td>
            </tr>
        </table>

        <!-- Bonding -->
        <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">Bonding of extraneous conductive parts</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:45pt;">Water:</td>
                <td class="value">${esc(supply?.bondingWater)}</td>
                <td class="label" style="width:35pt;">Gas:</td>
                <td class="value">${esc(supply?.bondingGas)}</td>
                <td class="label" style="width:30pt;">Oil:</td>
                <td class="value">${esc(supply?.bondingOil)}</td>
                <td class="label" style="width:35pt;">Steel:</td>
                <td class="value">${esc(supply?.bondingStructuralSteel)}</td>
                <td class="label" style="width:55pt;">Lightning:</td>
                <td class="value">${esc(supply?.bondingLightning)}</td>
            </tr>
            <tr>
                <td class="label">Other:</td>
                <td class="value" colspan="9">${supply?.bondingOtherNa === true ? 'N/A' : esc(supply?.bondingOther)}</td>
            </tr>
        </table>

        ${pageFooter(certNumber, 2, totalPages)}
        </div>
        `;
}

// MARK: - EIC Inspection Schedule

function buildEICInspectionSchedulePage(
  job: PdfJob,
  inspector: PdfInspector | undefined,
  certNumber: string,
  signatureDataURI: string | undefined,
  totalPages: number
): string {
  const sigHTML = signatureDataURI ? `<img class="sig-img" src="${signatureDataURI}">` : '';

  let html = `
        <div class="page">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2pt;">
            <div class="page-title">SCHEDULE OF INSPECTIONS</div>
            <div style="font-size:7pt;font-weight:bold;">${esc(certNumber)}</div>
        </div>

        <div class="legend-bar">
            <div class="legend-item"><span class="badge badge-tick" style="font-size:6pt;min-width:14pt;">\u{2713}</span> Acceptable</div>
            <div class="legend-item"><span class="badge badge-na" style="font-size:6pt;min-width:14pt;">N/A</span> Not applicable</div>
            <div class="legend-item"><span class="badge badge-lim" style="font-size:6pt;min-width:14pt;">LIM</span> Limitation</div>
        </div>

        <table class="inspection-table">
        <thead>
            <tr style="background:#CC0000;color:white;">
                <th style="width:40pt;padding:2pt 4pt;font-size:7pt;font-weight:bold;text-align:left;border:0.75pt solid #CC0000;">Item</th>
                <th style="padding:2pt 4pt;font-size:7pt;font-weight:bold;text-align:center;border:0.75pt solid #CC0000;">Description</th>
                <th style="width:50pt;padding:2pt 4pt;font-size:7pt;font-weight:bold;text-align:center;border:0.75pt solid #CC0000;">Outcome</th>
            </tr>
        </thead>
        <tbody>
        `;

  for (const item of eicScheduleItems) {
    const outcome = job.inspectionSchedule?.items[item.ref]?.outcome ?? 'tick';
    const badgeHTML = outcomeBadge(outcome);
    html += `
            <tr>
                <td class="item-ref">${esc(item.ref)}</td>
                <td>${esc(item.description)}</td>
                <td class="item-outcome">${badgeHTML}</td>
            </tr>
            `;
  }

  html += `
        </tbody>
        </table>

        <div style="font-weight:bold;font-size:7pt;margin-top:4pt;margin-bottom:1pt;">Inspected and tested by</div>
        <table class="form-table">
            <tr>
                <td class="label" style="width:40pt;">Name:</td>
                <td class="value">${esc(inspector?.fullName)}</td>
                <td class="label" style="width:50pt;">Position:</td>
                <td class="value">${esc(inspector?.position)}</td>
                <td class="label" style="width:55pt;">Signature:</td>
                <td class="value">${sigHTML}</td>
                <td class="label" style="width:30pt;">Date:</td>
                <td class="value">${formatDate(job.installationDetails?.dateOfInspection ?? job.createdAt)}</td>
            </tr>
        </table>

        ${pageFooter(certNumber, 4, totalPages)}
        </div>
        `;

  return html;
}

// MARK: - Inspection Schedule

function buildInspectionSchedulePages(
  job: PdfJob,
  inspector: PdfInspector | undefined,
  certNumber: string,
  signatureDataURI: string | undefined,
  totalPages: number
): string {
  const items = inspectionScheduleItems();
  const chunks = chunked(items, 28);
  let html = '';
  const startPage = 4;

  chunks.forEach((chunk: InspectionItem[], chunkIdx: number) => {
    const isFirst = chunkIdx === 0;
    const isLast = chunkIdx === chunks.length - 1;

    html += '<div class="page">';

    // Page title
    html += `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2pt;">
                <div class="page-title">INSPECTION SCHEDULE</div>
                <div style="font-size:7pt;font-weight:bold;">${esc(certNumber)}</div>
            </div>
            `;

    // Legend on first page
    if (isFirst) {
      html += `
                <div class="legend-bar">
                    <div class="legend-item"><span class="badge badge-tick" style="font-size:6pt;min-width:14pt;">\u{2713}</span> Acceptable condition</div>
                    <div class="legend-item"><span class="badge badge-c1" style="font-size:6pt;min-width:14pt;">C1</span> <span class="badge badge-c2" style="font-size:6pt;min-width:14pt;">C2</span> Unacceptable condition</div>
                    <div class="legend-item"><span class="badge badge-c3" style="font-size:6pt;min-width:14pt;">C3</span> Improvement recommended</div>
                    <div class="legend-item"><span class="badge badge-fi" style="font-size:6pt;min-width:14pt;">FI</span> Further investigation</div>
                    <div class="legend-item"><span class="badge badge-nv" style="font-size:6pt;min-width:14pt;">NV</span> Not verified</div>
                    <div class="legend-item"><span class="badge badge-lim" style="font-size:6pt;min-width:14pt;">LIM</span> Limitation</div>
                    <div class="legend-item"><span class="badge badge-na" style="font-size:6pt;min-width:14pt;">NA</span> Not applicable</div>
                </div>
                `;
    }

    // Table header
    html += `
            <table class="inspection-table">
            <thead>
                <tr style="background:#CC0000;color:white;">
                    <th style="width:40pt;padding:2pt 4pt;font-size:7pt;font-weight:bold;text-align:left;border:0.75pt solid #CC0000;">Item no</th>
                    <th style="padding:2pt 4pt;font-size:7pt;font-weight:bold;text-align:center;border:0.75pt solid #CC0000;">Description</th>
                    <th style="width:50pt;padding:2pt 4pt;font-size:7pt;font-weight:bold;text-align:center;border:0.75pt solid #CC0000;">Outcome</th>
                </tr>
            </thead>
            <tbody>
            `;

    for (const item of chunk) {
      if (item.isHeader) {
        html += `<tr><td class="section-header" colspan="3">${esc(item.ref)}</td></tr>`;
      } else {
        const outcome = resolveInspectionOutcome(item.ref, job.inspectionSchedule);
        const badgeHTML = outcomeBadge(outcome);
        html += `
                    <tr>
                        <td class="item-ref">${esc(item.ref)}</td>
                        <td>${esc(item.description)}</td>
                        <td class="item-outcome">${badgeHTML}</td>
                    </tr>
                    `;
      }
    }

    html += '</tbody></table>';

    // Inspected by section on last page
    if (isLast) {
      const sigHTML = signatureDataURI ? `<img class="sig-img" src="${signatureDataURI}">` : '';
      html += `
                <div style="font-weight:bold;font-size:7pt;margin-top:4pt;margin-bottom:1pt;">Inspected by</div>
                <table class="form-table">
                    <tr>
                        <td class="label" style="width:40pt;">Name:</td>
                        <td class="value">${esc(inspector?.fullName)}</td>
                        <td class="label" style="width:50pt;">Position:</td>
                        <td class="value">${esc(inspector?.position)}</td>
                        <td class="label" style="width:55pt;">Signature:</td>
                        <td class="value">${sigHTML}</td>
                        <td class="label" style="width:30pt;">Date:</td>
                        <td class="value">${formatDate(job.installationDetails?.dateOfInspection ?? job.createdAt)}</td>
                    </tr>
                </table>
                `;
    }

    html += pageFooter(certNumber, startPage + chunkIdx, totalPages);
    html += '</div>';
  });

  return html;
}

// MARK: - Circuit Schedule (Landscape)

function buildCircuitSchedulePages(
  job: PdfJob,
  inspector: PdfInspector | undefined,
  certNumber: string,
  signatureDataURI: string | undefined,
  totalPages: number
): string {
  let html = '';
  // Circuit schedule pages come after portrait pages (before guidance).
  // Portrait pages = 3 (p1+p2+p3) + inspection schedule pages.
  const isEICR = job.certificateType === 'EICR' || job.certificateType === undefined;
  const inspectionItems = isEICR ? inspectionScheduleItems() : [];
  const inspectionPages = isEICR ? chunked(inspectionItems, 28).length : 0;
  const circuitStartPage = 3 + inspectionPages + 1; // +1 because guidance is last portrait page

  let boardPageIndex = 0;

  for (const board of job.boards) {
    const boardCircuits = job.circuits.filter((c) => c.boardId === board.id);
    // Orphans = circuits with no scoping boardId. Covers both nil and ""
    // (the latter shows up on legacy single-board jobs re-saved
    // post-multi-board); see Circuit.hasUnscopedBoardId.
    const orphanCircuits =
      board.id === job.boards[0]?.id
        ? job.circuits.filter((c) => hasUnscopedBoardId(c.boardId))
        : [];
    const allCircuits = [
      ...boardCircuits,
      ...orphanCircuits.filter((c) => !boardCircuits.some((bc) => bc.id === c.id)),
    ];

    if (allCircuits.length === 0 && job.boards.length > 1) continue;

    const boardName = board.designation ?? board.name ?? 'DB-1';

    html += `
            <div class="page-landscape">

            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4pt;">
                <div style="font-size:12pt;font-weight:bold;">Distribution Board - ${esc(boardName)}</div>
                <div style="font-size:7pt;font-weight:bold;">${esc(certNumber)}</div>
            </div>

            <!-- Board Details -->
            <div class="red-bar-small">${esc(boardName)} - Board Details</div>
            <table class="board-detail-table">
                <tr>
                    <td class="label" style="width:50pt;">Location:</td>
                    <td class="value">${esc(board.location)}</td>
                    <td class="label" style="width:65pt;">Manufacturer:</td>
                    <td class="value">${esc(board.manufacturer)}</td>
                    <td class="label" style="width:65pt;">Supplied from:</td>
                    <td class="value">${esc(board.suppliedFrom)}</td>
                    <td class="label" style="width:80pt;">Polarity confirmed:</td>
                    <td class="value">${esc(board.polarityConfirmed)}</td>
                    <td class="label" style="width:45pt;">Phases:</td>
                    <td class="value">${esc(board.phases)}</td>
                    <td class="label" style="width:85pt;">Phases confirmed:</td>
                    <td class="value">${esc(board.phasesConfirmed)}</td>
                </tr>
                <tr>
                    <td class="label">Ze at DB:</td>
                    <td class="value">${esc(board.zeAtDb)}<span style="color:#666;font-size:5pt;"> ohm</span></td>
                    <td class="label">IPF at DB:</td>
                    <td class="value">${esc(board.ipfAtDb)}<span style="color:#666;font-size:5pt;"> kA</span></td>
                    <td class="label">RCD trip time:</td>
                    <td class="value">${esc(board.rcdTripTime)}<span style="color:#666;font-size:5pt;"> ms</span></td>
                    <td class="label">Main Switch BS (EN):</td>
                    <td class="value">${esc(board.mainSwitchBsEn)}</td>
                    <td class="label">Voltage rating:</td>
                    <td class="value">${esc(board.voltageRating)}<span style="color:#666;font-size:5pt;"> V</span></td>
                    <td class="label">Rated current:</td>
                    <td class="value">${esc(board.ratedCurrent)}<span style="color:#666;font-size:5pt;"> A</span></td>
                </tr>
                <tr>
                    <td class="label" colspan="2" style="font-size:6pt;">SPD Details Type:</td>
                    <td class="value">${esc(board.spdType)}</td>
                    <td class="label">Status:</td>
                    <td class="value">${esc(board.spdStatus)}</td>
                    <td class="label" colspan="2">Overcurrent Device BS (EN):</td>
                    <td class="value">${esc(board.overcurrentBsEn)}</td>
                    <td class="label">Voltage:</td>
                    <td class="value">${esc(board.overcurrentVoltage)}<span style="color:#666;font-size:5pt;"> V</span></td>
                    <td class="label">Current:</td>
                    <td class="value">${esc(board.overcurrentCurrent)}<span style="color:#666;font-size:5pt;"> A</span></td>
                </tr>
                <tr>
                    <td class="label" colspan="2"></td>
                    <td class="label" colspan="2"></td>
                    <td class="label" colspan="2"></td>
                    <td class="label">IPF rating:</td>
                    <td class="value">${esc(board.ipfRating)}<span style="color:#666;font-size:5pt;"> kA</span></td>
                    <td class="label">RCD rating:</td>
                    <td class="value">${esc(board.rcdRatingMa)}<span style="color:#666;font-size:5pt;"> mA</span></td>
                    <td class="label" colspan="2"></td>
                </tr>
            </table>
            `;

    // Sub-main / sub-distribution: render the upstream cable section.
    // Phase 3 of the multi-board sprint
    // (.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PLAN.md).
    // Length is intentionally not rendered (Phase 1 dropped the field).
    if (board.boardType === 'sub_distribution' || board.boardType === 'sub_main') {
      const parent = job.boards.find((b) => b.id === board.parentBoardId);
      const parentDesignation = parent?.designation ?? parent?.name;
      html += `
                <div class="red-bar-small" style="margin-top:3pt;">${esc(boardName)} - Distribution Circuit (Sub-Main)</div>
                <table class="board-detail-table">
                    <tr>
                        <td class="label" style="width:50pt;">Fed from:</td>
                        <td class="value">${esc(parentDesignation)}</td>
                        <td class="label" style="width:65pt;">Feed circuit:</td>
                        <td class="value">${esc(board.feedCircuitRef)}</td>
                        <td class="label" style="width:65pt;">Cable material:</td>
                        <td class="value">${esc(board.subMainCableMaterial)}</td>
                        <td class="label" style="width:80pt;">Live conductor CSA:</td>
                        <td class="value">${esc(board.subMainCableCsa)}<span style="color:#666;font-size:5pt;"> mm²</span></td>
                        <td class="label" style="width:65pt;">CPC CSA:</td>
                        <td class="value">${esc(board.subMainCpcCsa)}<span style="color:#666;font-size:5pt;"> mm²</span></td>
                    </tr>
                </table>
                `;
    }

    html += `

            <!-- Notes -->
            <table class="board-detail-table" style="margin-top:2pt;">
                <tr>
                    <td class="label" style="width:40pt;">Notes:</td>
                    <td class="value">${esc(board.notes)}</td>
                </tr>
            </table>

            <!-- Circuit table -->
            <table class="circuit-table" style="margin-top:3px;">
            <colgroup>
                <col style="width:22px"><!-- Cct ref -->
                <col style="width:63px"><!-- Circuit designation (reduced 30%) -->
                <col style="width:22px"><!-- No. of points -->
                <col style="width:24px"><!-- Wiring type -->
                <col style="width:21px"><!-- Ref method -->
                <col style="width:25px"><!-- Live mm² -->
                <col style="width:25px"><!-- CPC mm² -->
                <col style="width:24px"><!-- Max t(s) -->
                <col style="width:34px"><!-- OCPD BS(EN) -->
                <col style="width:21px"><!-- OCPD Type -->
                <col style="width:24px"><!-- OCPD Rating -->
                <col style="width:21px"><!-- OCPD kA -->
                <col style="width:28px"><!-- Max Zs -->
                <col style="width:34px"><!-- RCD BS(EN) -->
                <col style="width:21px"><!-- RCD Type -->
                <col style="width:24px"><!-- RCD mA -->
                <col style="width:21px"><!-- RCD A -->
                <col style="width:26px"><!-- Ring r1 -->
                <col style="width:26px"><!-- Ring rn -->
                <col style="width:26px"><!-- Ring r2 -->
                <col style="width:29px"><!-- R1+R2 -->
                <col style="width:24px"><!-- R2 -->
                <col style="width:21px"><!-- Test V -->
                <col style="width:26px"><!-- L-L MΩ -->
                <col style="width:26px"><!-- L-E MΩ -->
                <col style="width:21px"><!-- Polarity -->
                <col style="width:28px"><!-- Meas Zs -->
                <col style="width:24px"><!-- RCD ms -->
                <col style="width:22px"><!-- RCD btn -->
                <col style="width:22px"><!-- AFDD btn -->
            </colgroup>
            <thead>
                <tr>
                    <td class="group-header" colspan="2"></td>
                    <td class="group-header" colspan="6">CONDUCTORS</td>
                    <td class="group-header" colspan="5">OVERCURRENT DEVICES</td>
                    <td class="group-header" colspan="4">RCD</td>
                    <td class="group-header" colspan="3">RING FINAL CIRCUITS</td>
                    <td class="group-header" colspan="2">R1+R2 OR R2</td>
                    <td class="group-header" colspan="3">INSULATION RESISTANCE</td>
                    <td class="group-header" colspan="2"></td>
                    <td class="group-header" colspan="2">RCD</td>
                    <td class="group-header" colspan="1">AFDD</td>
                </tr>
                <tr>
                    <th>Circuit<br>reference</th>
                    <th style="writing-mode:horizontal-tb;">Circuit designation</th>
                    <th>Number of<br>points served</th>
                    <th>Type of<br>wiring</th>
                    <th>Reference<br>method</th>
                    <th>Live<br>(mm\u{00B2})</th>
                    <th>CPC<br>(mm\u{00B2})</th>
                    <th>Max disconnect<br>time (s)</th>
                    <th>BS(EN)</th>
                    <th>Type</th>
                    <th>Rating<br>(A)</th>
                    <th>Breaking<br>capacity (kA)</th>
                    <th>Maximum<br>Zs (ohm)</th>
                    <th>BS(EN)</th>
                    <th>Type</th>
                    <th>Operating<br>current (mA)</th>
                    <th>Rating<br>(A)</th>
                    <th>r1<br>(ohm)</th>
                    <th>rn<br>(ohm)</th>
                    <th>r2<br>(ohm)</th>
                    <th>R1+R2<br>(ohm)</th>
                    <th>R2<br>(ohm)</th>
                    <th>Test<br>Voltage (V)</th>
                    <th>Live-Live<br>(Mohm)</th>
                    <th>Live-Earth<br>(Mohm)</th>
                    <th>Polarity<br>confirmed</th>
                    <th>Measured<br>Zs (ohm)</th>
                    <th>RCD time<br>(ms)</th>
                    <th>RCD button<br>confirmed</th>
                    <th>AFDD button<br>confirmed</th>
                </tr>
            </thead>
            <tbody>
            `;

    if (allCircuits.length === 0) {
      html +=
        '<tr><td colspan="30" style="text-align:center;padding:8pt;color:#666;">No circuits recorded.</td></tr>';
    } else {
      for (const circuit of allCircuits) {
        html += '<tr>';
        html += `<td>${esc(circuit.circuitRef)}</td>`;
        html += `<td style="text-align:left;">${esc(circuit.circuitDesignation)}</td>`;
        html += `<td>${esc(circuit.numberOfPoints)}</td>`;
        html += `<td>${esc(circuit.wiringType)}</td>`;
        html += `<td>${esc(circuit.refMethod)}</td>`;
        html += `<td>${esc(circuit.liveCsaMm2)}</td>`;
        html += `<td>${esc(circuit.cpcCsaMm2)}</td>`;
        html += `<td>${esc(circuit.maxDisconnectTimeS)}</td>`;
        html += `<td>${esc(circuit.ocpdBsEn)}</td>`;
        html += `<td>${esc(circuit.ocpdType)}</td>`;
        html += `<td>${esc(circuit.ocpdRatingA)}</td>`;
        html += `<td>${esc(circuit.ocpdBreakingCapacityKa)}</td>`;
        html += `<td>${esc(circuit.ocpdMaxZsOhm)}</td>`;
        html += `<td>${esc(circuit.rcdBsEn)}</td>`;
        html += `<td>${esc(circuit.rcdType)}</td>`;
        html += `<td>${esc(circuit.rcdOperatingCurrentMa)}</td>`;
        html += `<td>${esc(circuit.rcdRatingA)}</td>`;
        html += `<td>${escContinuity(circuit.ringR1Ohm)}</td>`;
        html += `<td>${escContinuity(circuit.ringRnOhm)}</td>`;
        html += `<td>${escContinuity(circuit.ringR2Ohm)}</td>`;
        html += `<td>${escContinuity(circuit.r1R2Ohm)}</td>`;
        html += `<td>${escContinuity(circuit.r2Ohm)}</td>`;
        html += `<td>${esc(circuit.irTestVoltageV)}</td>`;
        html += `<td>${esc(circuit.irLiveLiveMohm)}</td>`;
        html += `<td>${esc(circuit.irLiveEarthMohm)}</td>`;
        html += `<td>${esc(circuit.polarityConfirmed)}</td>`;
        html += `<td>${esc(circuit.measuredZsOhm)}</td>`;
        html += `<td>${esc(circuit.rcdTimeMs)}</td>`;
        html += `<td>${esc(circuit.rcdButtonConfirmed)}</td>`;
        html += `<td>${esc(afddButtonDisplay(circuit.afddButtonConfirmed))}</td>`;
        html += '</tr>';
      }
    }

    html += '</tbody></table>';

    // Testing information
    const sigHTML = signatureDataURI ? `<img class="sig-img" src="${signatureDataURI}">` : '';

    html += `
            <div class="red-bar-small" style="margin-top:3pt;">${esc(boardName)} - Testing information</div>
            <table class="board-detail-table" style="margin-top:0;">
                <tr>
                    <td class="label" style="width:50pt;font-weight:bold;">Tested by</td>
                    <td class="label" style="width:35pt;">Name:</td>
                    <td class="value">${esc(inspector?.fullName)}</td>
                    <td class="label" style="width:45pt;">Position:</td>
                    <td class="value">${esc(inspector?.position)}</td>
                    <td class="label" style="width:60pt;">Date tested:</td>
                    <td class="value">${formatDate(job.installationDetails?.dateOfInspection ?? job.createdAt)}</td>
                    <td class="label" style="width:55pt;">Signature:</td>
                    <td class="value">${sigHTML}</td>
                </tr>
            </table>

            <div style="font-weight:bold;font-size:6pt;margin-top:2pt;margin-bottom:1pt;">Test Equipment Details</div>
            <table class="board-detail-table">
                <tr>
                    <td class="label" style="width:30pt;">MFT:</td>
                    <td class="value">${testEquipmentCell(inspector?.mftSerialNumber, inspector?.mftCalibrationDate)}</td>
                    <td class="label" style="width:60pt;">Continuity:</td>
                    <td class="value">${testEquipmentCell(inspector?.continuitySerialNumber, inspector?.continuityCalibrationDate)}</td>
                    <td class="label" style="width:95pt;">Insulation resistance:</td>
                    <td class="value">${testEquipmentCell(inspector?.insulationSerialNumber, inspector?.insulationCalibrationDate)}</td>
                    <td class="label" style="width:120pt;">Earth fault loop impedance:</td>
                    <td class="value">${testEquipmentCell(inspector?.earthFaultSerialNumber, inspector?.earthFaultCalibrationDate)}</td>
                    <td class="label" style="width:30pt;">RCD:</td>
                    <td class="value">${testEquipmentCell(inspector?.rcdSerialNumber, inspector?.rcdCalibrationDate)}</td>
                </tr>
            </table>
            `;

    html += pageFooter(certNumber, circuitStartPage + boardPageIndex, totalPages);
    html += '</div>';

    boardPageIndex += 1;
  }

  return html;
}

// MARK: - Guidance Page

function buildGuidancePage(certNumber: string, totalPages: number): string {
  return `
        <div class="page">
        <div style="text-align:right;font-size:7pt;font-weight:bold;margin-bottom:4pt;">${esc(certNumber)}</div>

        <div class="red-bar">CONDITION REPORT GUIDANCE FOR RECIPIENTS</div>

        <div style="font-size:5.5pt;line-height:1.3;margin-top:3pt;">
            <p>1. The purpose of this Report is to confirm, as far as reasonably practicable, whether or not the electrical installation is in a satisfactory condition for continued service
            (see SUMMARY OF THE CONDITION OF THE INSTALLATION). The Report should identify any damage, deterioration, defects, and / or conditions which may give rise
            to danger (see OBSERVATIONS AND RECOMMENDATIONS).</p>

            <p style="margin-top:3pt;">2. This Report is only valid if accompanied by the Inspection Schedule(s) and the Schedule(s) of Circuit Details and Test Results.</p>

            <p style="margin-top:3pt;">3. The person ordering the Report should have received this Report without watermarks and the inspector / company should have retained a duplicate.</p>

            <p style="margin-top:3pt;">4. This Report should be retained in a safe place and be made available to any person inspecting or undertaking work on the electrical installation in the future. If the
            property is vacated, this Report will provide the new owner / occupier with details of the condition of the electrical installation at the time the Report was issued.</p>

            <p style="margin-top:3pt;">5. The EXTENT AND LIMITATIONS section should identify fully the extent of the installation covered by this Report and any limitations on the inspection and testing. The
            inspector should have agreed these aspects with the person ordering the Report and with other interested parties (licensing authority, insurance company, mortgage
            provider and the like) before the inspection was carried out.</p>

            <p style="margin-top:3pt;">6. Some operational limitations such as inability to gain access to parts of the installation or an item of equipment may have been encountered during the inspection. The
            inspector should have noted these in the EXTENT AND LIMITATIONS section.</p>

            <p style="margin-top:3pt;">7. For items classified in the OBSERVATIONS AND RECOMMENDATIONS section as C1 ("Danger present"), the safety of those using the installation is at risk, and it is
            recommended that a skilled person or persons competent in electrical installation work undertakes the necessary remedial work immediately.</p>

            <p style="margin-top:3pt;">8. For items classified in the OBSERVATIONS AND RECOMMENDATIONS section as C2 ("Potentially dangerous"), the safety of those using the installation may be at
            risk, and it is recommended that a skilled person or persons competent in electrical installation work undertakes the necessary remedial work as a matter of urgency.</p>

            <p style="margin-top:3pt;">9. Where it has been stated in the OBSERVATIONS AND RECOMMENDATIONS section that an observation requires further investigation (Code FI) the inspection has
            revealed an apparent deficiency which may result in a Code C1 or C2, and could not, due to the extent or limitations of the inspection, be fully identified. Such
            observations should be investigated without delay. A further examination of the installation will be necessary, to determine the nature and extent of the apparent
            deficiency, (see SUMMARY OF THE CONDITION OF THE INSTALLATION).</p>

            <p style="margin-top:3pt;">10. For safety reasons, the electrical installation should be re-inspected at appropriate intervals by a skilled person or persons, competent in such work. The
            recommended date by which the next inspection is due can be found in the DECLARATION section of the Report.</p>

            <p style="margin-top:3pt;">11. INTAKE EQUIPMENT (VISUAL INSPECTION ONLY) EXPLANATION OF CLASSIFICATION CODE X An outcome against an item in this section, other than access
            to live parts, should NOT be used to determine the overall outcome. NOTE 1: Where inadequacies in the intake equipment are encountered, which may result in a
            dangerous or potentially dangerous situation, the person ordering the work and / or duty holder must be informed. It is strongly recommended that the person ordering
            the work informs the appropriate authority. NOTE 2: For this section only, where inadequacies are found, an X should be put against the appropriate item and a comment
            made in the Observations and Recommendations section.</p>

            <p style="margin-top:3pt;">12. Where the installation includes a Residual Current Device (RCD) it should be tested 6 monthly by pressing the button marked 'T' or 'Test'. The device should switch
            off the supply and should then be switched on to restore the supply. If the device does not switch off the supply when the button is pressed, seek expert advice. For safety
            reasons it is important that this instruction is followed.</p>

            <p style="margin-top:3pt;">13. Where the installation includes an Arc Fault Detection Device (AFDD) having a manual test facility it should be tested 6 monthly by pressing the test button. Where an
            AFDD has both a test button and automatic test function, manufacturer's instructions shall be followed with respect to test button operation.</p>

            <p style="margin-top:3pt;">14. Where the installation includes a Surge Protective Device (SPD) the status indicator should be checked to confirm it is in operational condition in accordance with
            manufacturer's information. If the indication shows that the device is not operational, seek expert advice. For safety reasons it is important this safety instruction is
            followed.</p>

            <p style="margin-top:3pt;">15. Where the installation includes alternative or additional sources of supply warning notices should be found at the origin or meter position or, if remote from the origin,
            at the consumer unit or distribution board and at all points of isolation of all sources of supply.</p>
        </div>

        <div style="margin-top:4pt;">
            <div style="font-weight:bold;font-size:7pt;margin-bottom:2pt;">WIRING TYPES REFERENCE</div>
            <div style="font-size:6pt;line-height:1.4;padding-left:6pt;">
                A: PVC/PVC cables<br>
                B: PVC cables in metallic conduit<br>
                C: PVC cables in non-metallic conduit core<br>
                D: PVC cables in metallic trunking<br>
                E: PVC cables in non-metallic trunking<br>
                F: PVC/SWA cables<br>
                G: XLPE/SWA cables<br>
                H: Mineral insulated cables<br>
                O: Other cable types not listed here
            </div>
        </div>

        ${pageFooter(certNumber, totalPages, totalPages)}
        </div>
        `;
}
