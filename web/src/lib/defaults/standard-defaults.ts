/**
 * Standard (zero-preset) certificate defaults — literal port of iOS
 * `CertificateDefaultsService.applyStandardDefaults`
 * (CertificateDefaultsService.swift:430-480).
 *
 * iOS applies these on EVERY job creation when the inspector has no
 * named presets (`JobListViewModel.autoApplyDefaults`,
 * JobListViewModel.swift:200-234) — the values that are true for
 * effectively every UK domestic installation (230 V single-phase,
 * copper conductors, 5-year retest) so a fresh certificate never
 * starts fully blank.
 *
 * Only-fill-empty like `applyPresetToJob`: a string fills when
 * null/undefined/'' (iOS `isNilOrEmpty`), a boolean fills only when
 * null/undefined (iOS `== nil` — note `means_earthing_electrode`
 * defaults to an EXPLICIT false, mirroring iOS). Wire keys match the
 * iOS Codable CodingKeys one-for-one (SupplyCharacteristics.swift /
 * InstallationDetails.swift / InspectionSchedule.swift).
 */

import type { JobDetail } from '../types';

function isEmptyString(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/** iOS canon field lists. Exported for tests so the port's coverage is
 *  pinned against the Swift source, not re-derived. */
export const STANDARD_SUPPLY_STRING_DEFAULTS: Record<string, string> = {
  number_of_supplies: '1',
  nominal_voltage_u: '230',
  nominal_voltage_uo: '230',
  nominal_frequency: '50',
  main_switch_voltage: '230',
  main_switch_conductor_material: 'Copper',
  rcd_operating_current: 'N/A',
  rcd_time_delay: 'N/A',
  rcd_operating_time: 'N/A',
  earthing_conductor_material: 'Copper',
  main_bonding_material: 'Copper',
};

export const STANDARD_SUPPLY_BOOLEAN_DEFAULTS: Record<string, boolean> = {
  means_earthing_distributor: true,
  means_earthing_electrode: false,
  bonding_other_na: true,
};

/**
 * Returns a `Partial<JobDetail>` patch (same contract as
 * `applyPresetToJob`) — empty object when nothing needed filling.
 */
export function applyStandardDefaultsToJob(job: JobDetail): Partial<JobDetail> {
  const patch: Partial<JobDetail> = {};

  // Installation.
  const install = { ...((job.installation_details ?? {}) as Record<string, unknown>) };
  let installChanged = false;
  if (isEmptyString(install.premises_description)) {
    install.premises_description = 'Residential';
    installChanged = true;
  }
  if (install.installation_records_available == null) {
    install.installation_records_available = true;
    installChanged = true;
  }
  if (install.evidence_of_additions_alterations == null) {
    install.evidence_of_additions_alterations = true;
    installChanged = true;
  }
  if (install.next_inspection_years == null) {
    install.next_inspection_years = 5;
    installChanged = true;
  }
  if (installChanged) patch.installation_details = install;

  // Supply (incl. main switch, RCD N/A stamps, earthing + bonding).
  const supply = { ...((job.supply_characteristics ?? {}) as Record<string, unknown>) };
  let supplyChanged = false;
  for (const [key, value] of Object.entries(STANDARD_SUPPLY_STRING_DEFAULTS)) {
    if (isEmptyString(supply[key])) {
      supply[key] = value;
      supplyChanged = true;
    }
  }
  for (const [key, value] of Object.entries(STANDARD_SUPPLY_BOOLEAN_DEFAULTS)) {
    if (supply[key] == null) {
      supply[key] = value;
      supplyChanged = true;
    }
  }
  if (supplyChanged) patch.supply_characteristics = supply;

  // Board — first board's phases only (iOS: boards[0].phases = "1").
  const boards = (job.boards ?? []) as Array<Record<string, unknown>>;
  if (boards.length > 0 && isEmptyString(boards[0].phases)) {
    patch.boards = [{ ...boards[0], phases: '1' }, ...boards.slice(1)];
  }

  // Inspection schedule — Section 7 N/A marker.
  const schedule = (job.inspection_schedule ?? {}) as Record<string, unknown>;
  if (schedule.mark_section7_na == null) {
    patch.inspection_schedule = { ...schedule, mark_section7_na: true };
  }

  return patch;
}
