import type { PdfCompany, PdfInspectionOutcome, PdfInspectionSchedule } from './types';

/**
 * String/format helpers — verbatim ports of the private helpers at the
 * bottom of `EICRHTMLTemplate.swift` (lines 1999-2120 at port time).
 */

/** Port of `esc(_:)` — empty/undefined renders as a non-breaking space
 * so table cells keep their height, exactly as on iOS. */
export function esc(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '&nbsp;';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

/** Port of `escContinuity(_:)` — renders the discontinuous sentinel `∞`
 * bold + 15% larger so it doesn't read as `8` in dense tables. */
export function escContinuity(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '&nbsp;';
  if (trimmed === '∞') {
    return '<span style="font-weight:700;font-size:115%;">&#8734;</span>';
  }
  return esc(value);
}

/** Port of `assembleAddress(_:town:county:postcode:)`. */
export function assembleAddress(
  address: string | undefined,
  town: string | undefined,
  county: string | undefined,
  postcode: string | undefined
): string | undefined {
  const parts = [address, town, county, postcode]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** Port of `boolStr(_:)`. */
export function boolStr(value: boolean | undefined): string {
  if (value === undefined) return 'N/A';
  return value ? 'Yes' : 'No';
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Port of `formatDate(_:)` — Swift `"dd MMM yyyy"` (e.g. "02 Jul 2026").
 * English month symbols are hardcoded so output doesn't drift with the
 * browser locale (the certificate is an English-language BS 7671 form). */
export function formatDate(date: Date): string {
  return `${pad2(date.getDate())} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/** Swift `"dd/MM/yyyy"` used for the next-inspection due date. */
export function formatDateSlash(date: Date): string {
  return `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** Port of `testEquipmentCell(serial:cal:)`. */
export function testEquipmentCell(serial: string | undefined, cal: string | undefined): string {
  const s = serial ?? '';
  const c = cal ?? '';
  if (!s && !c) return '&nbsp;';
  const parts: string[] = [];
  if (s) parts.push(esc(s));
  if (c) parts.push(`Cal: ${esc(c)}`);
  return parts.join('<br>');
}

/** Port of `companyAddress(_:)` — on the shared wire the address is a
 * single pre-joined `company_address` string (iOS assembles its local
 * multi-line GRDB fields; web receives the already-flat form). */
export function companyAddress(company: PdfCompany | undefined): string {
  const joined = company?.address?.trim();
  return joined ? esc(joined) : '&nbsp;';
}

/** Port of `resolveInspectionOutcome(ref:schedule:)` — mirrors
 * InspectionScheduleViewModel.outcome(for:) so the PDF shows the same
 * ticks/codes the user sees in the app. */
export function resolveInspectionOutcome(
  ref: string,
  schedule: PdfInspectionSchedule | undefined
): PdfInspectionOutcome {
  const isTT = schedule?.isTTEarthing === true;
  const hasMicro = schedule?.hasMicrogeneration === true;
  const section7NA = schedule?.markSection7NA === true;

  // TT Earthing auto-control
  if (ref === '3.1') return isTT ? 'N/A' : 'tick';
  if (ref === '3.2') return isTT ? 'tick' : 'N/A';

  // Microgeneration auto-control
  const microgenerationItems = new Set(['2.0', '4.11', '4.21', '4.22']);
  if (microgenerationItems.has(ref)) {
    return hasMicro ? 'tick' : 'N/A';
  }

  // Section 7 auto-control
  if (ref.startsWith('7.') && section7NA) return 'N/A';

  // Explicit value or default to tick
  return schedule?.items[ref]?.outcome ?? 'tick';
}

/** Port of `outcomeBadge(_:)`. */
export function outcomeBadge(outcome: PdfInspectionOutcome | undefined): string {
  if (!outcome) return '&nbsp;';
  let badgeClass: string;
  let text: string;
  switch (outcome) {
    case 'tick':
      badgeClass = 'badge-tick';
      text = '\u{2713}';
      break;
    case 'C1':
      badgeClass = 'badge-c1';
      text = 'C1';
      break;
    case 'C2':
      badgeClass = 'badge-c2';
      text = 'C2';
      break;
    case 'C3':
      badgeClass = 'badge-c3';
      text = 'C3';
      break;
    case 'N/A':
      badgeClass = 'badge-na';
      text = 'N/A';
      break;
    case 'LIM':
      badgeClass = 'badge-lim';
      text = 'LIM';
      break;
    case 'NV':
      badgeClass = 'badge-nv';
      text = 'NV';
      break;
  }
  return `<span class="badge ${badgeClass}">${text}</span>`;
}

/** Port of the Swift `Array.chunked(size:)` extension. */
export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Port of `Circuit.afddButtonDisplay` — blank renders "N/A" so the
 * column is never visually empty where no AFDD is fitted. */
export function afddButtonDisplay(afddButtonConfirmed: string | undefined): string {
  const v = (afddButtonConfirmed ?? '').trim();
  return v === '' ? 'N/A' : v;
}

/** Port of `Circuit.hasUnscopedBoardId` — nil and '' both count as
 * unscoped (legacy single-board jobs re-saved post-multi-board). */
export function hasUnscopedBoardId(boardId: string | undefined): boolean {
  return (boardId ?? '') === '';
}

/** Port of `dataToBase64URI(_:mime:)` — browser-side (Blob → data URI). */
export async function blobToDataURI(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('PDF render: failed to encode image'));
    reader.readAsDataURL(blob);
  });
}
