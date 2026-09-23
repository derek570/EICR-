/**
 * PLAN-CC round 8 — external-write epochs for the OCPD-standard control.
 *
 * Decision 28 rule 2: a correction the inspector heard confirmed, and any
 * import, WIN over an open draft. `useOcpdStandardDraft` detected that by
 * watching its `value` prop, which fails for the case round 8 found — a
 * correction that RE-APPLIES the standard already committed. The prop never
 * changes, so the draft survives and a later blur commits the older typing
 * over the value the inspector was told had been applied.
 *
 * Value equality cannot carry "an apply happened"; only the apply can. So each
 * write path announces itself here, per circuit, and the control resets on the
 * epoch rather than on the text.
 *
 * Module-level rather than React context, matching `designation-drafts.ts`:
 * the announcing code is the apply layer, none of which sits under a provider,
 * and there is one active job screen at a time.
 *
 * COMPLETENESS IS CHECKED, NOT PROMISED. `ocpd-external-writes.test.ts`
 * enumerates every place in `web/src` that assigns `ocpd_bs_en` and fails if
 * one has no announcement — because "remember to call this" is exactly the
 * instruction that was forgotten twice on the iOS side of this plan.
 */

import type { VoiceCommandOutcome } from '@certmate/shared-utils';

type Listener = () => void;

const epochs = new Map<string, number>();
const listeners = new Set<Listener>();

/**
 * Announce that an external writer has applied `ocpd_bs_en` to this circuit —
 * a voice correction, a server apply, a CCU or document import, a regex admit.
 * Call it whether or not the value CHANGED: that is the whole point.
 */
export function noteExternalOcpdWrite(circuitId: string | null | undefined): void {
  if (!circuitId) return;
  epochs.set(circuitId, (epochs.get(circuitId) ?? 0) + 1);
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One bad subscriber must not stop the others being told.
    }
  }
}

export function subscribeToOcpdWrites(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ocpdWriteEpoch(circuitId: string | null | undefined): number {
  return circuitId ? (epochs.get(circuitId) ?? 0) : 0;
}

/**
 * Sign-out reset, mirroring `purgeDesignationDraftState`. A stale epoch is
 * harmless alone, but leaving one inspector's counters for the next login is
 * cheap to prevent and awkward to reason about later.
 */
export function purgeOcpdWriteEpochs(): void {
  epochs.clear();
}

/** Test seam. */
export function _ocpdWriteEpochCount(): number {
  return epochs.size;
}

/** PLAN-CC (Decision 28 rule 2, Decision 32) — announce an OCPD-standard
 *  write for every circuit the command ACTUALLY wrote, so the editing control
 *  drops an open draft there. Read from the writer's own `appliedResults`, not
 *  from the command's target: a bulk `apply_field` carries its target in
 *  `scope`, may skip spares, and may run past the last circuit, and a rejected
 *  value (a bare `88`, indistinguishable from BS 88-1/-2/-3/-6) writes nothing
 *  and has nothing to win with. A correction re-applying the stored value is
 *  still in `appliedResults`, which is why this is by operation and not by
 *  comparing values. Matched by circuit REF, which identifies exactly one
 *  circuit: `stage6-dispatchers-circuit.js` rejects a duplicate `circuit_ref`,
 *  so numbers are unique even though NAMES may repeat. */
export function noteOcpdWritesFromVoiceOutcome(
  outcome: Pick<VoiceCommandOutcome, 'patch' | 'appliedResults'>,
  job: unknown
): void {
  if (!outcome.patch) return;
  const refs = new Set(
    (outcome.appliedResults ?? [])
      .filter((r) => r.field === 'ocpd_bs_en')
      .map((r) => String(r.circuit))
  );
  if (refs.size === 0) return;
  const circuits = (job as { circuits?: Array<Record<string, unknown>> } | null)?.circuits;
  if (!Array.isArray(circuits)) return;
  for (const row of circuits) {
    const rowRef = row.circuit_ref ?? row.number;
    if (rowRef != null && refs.has(String(rowRef))) {
      noteExternalOcpdWrite(row.id == null ? null : String(row.id));
    }
  }
}
