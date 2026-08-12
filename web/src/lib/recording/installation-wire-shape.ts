/**
 * Plan E (feedback id 125) — normalise the job's `installation_details`
 * bucket into E2's frozen wire contract before it crosses `session_start`
 * / `job_state_update`.
 *
 * `job.installation_details` uses canonical snake_case field names
 * internally (matches the backend's field_schema.json — see
 * apply-extraction.ts's INSTALLATION_FIELDS route table). The frozen
 * client->server wire contract uses iOS's camelCase shape for BOTH
 * clients so the backend's `selectInstallationContainer` normaliser
 * (eicr-extraction-session.js) only has to understand one field-naming
 * convention inside the container, whichever of the three bucket-key
 * spellings it arrives under. Site keys (address/postcode/town/county)
 * are already spelled identically in both conventions; only the four
 * client_* keys need renaming — a raw snake_case `client_postcode` inside
 * the container would otherwise be silently ignored by the backend
 * normaliser (it only reads `clientPostcode`).
 */
export function buildInstallationWirePayload(
  installationDetails: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!installationDetails || typeof installationDetails !== 'object') return undefined;
  const src = installationDetails as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if ('client_address' in out) {
    out.clientAddress = out.client_address;
    delete out.client_address;
  }
  if ('client_postcode' in out) {
    out.clientPostcode = out.client_postcode;
    delete out.client_postcode;
  }
  if ('client_town' in out) {
    out.clientTown = out.client_town;
    delete out.client_town;
  }
  if ('client_county' in out) {
    out.clientCounty = out.client_county;
    delete out.client_county;
  }
  return out;
}

/**
 * Shallow-copy `job` with `installation_details` normalised to the wire
 * contract. Every other key (circuits, boards, supply_characteristics,
 * etc.) passes through unchanged — this is additive, not a full jobState
 * rebuild. Returns `job` unchanged (same reference) when there is no
 * installation bucket to normalise, so a job with no installation details
 * yet stays byte-identical on the wire.
 */
export function buildJobStateForWire<
  T extends { installation_details?: Record<string, unknown> | null },
>(job: T): T {
  const wireInstallation = buildInstallationWirePayload(job.installation_details);
  if (wireInstallation === undefined) return job;
  return { ...job, installation_details: wireInstallation };
}
