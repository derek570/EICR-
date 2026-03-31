'use client';

import { useEffect, useRef, useState, memo } from 'react';
import type {
  JobDetail,
  Circuit,
  Observation,
  BoardInfo,
  SupplyCharacteristics,
  InstallationDetails,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LiveFillViewProps {
  job: JobDetail | null;
  isRecording: boolean;
}

// ---------------------------------------------------------------------------
// TypingText — animates characters in during recording, static otherwise
// ---------------------------------------------------------------------------

function TypingText({
  text,
  isRecording,
}: {
  text: string | undefined | null;
  isRecording: boolean;
}) {
  const [displayed, setDisplayed] = useState('');
  const prevTextRef = useRef<string>('');

  useEffect(() => {
    if (!text) {
      setDisplayed('');
      prevTextRef.current = '';
      return;
    }

    if (!isRecording) {
      setDisplayed(text);
      prevTextRef.current = text;
      return;
    }

    // Only animate the new characters (from where previous text ended)
    const startFrom = prevTextRef.current.length;
    if (text === prevTextRef.current) {
      // No change
      return;
    }

    // If text changed entirely (not just appended), show it immediately
    if (!text.startsWith(prevTextRef.current)) {
      setDisplayed(text);
      prevTextRef.current = text;
      return;
    }

    // Animate new characters
    let idx = startFrom;
    setDisplayed(text.slice(0, idx));

    const timer = setInterval(() => {
      idx++;
      if (idx > text.length) {
        clearInterval(timer);
        prevTextRef.current = text;
        return;
      }
      setDisplayed(text.slice(0, idx));
    }, 30);

    return () => {
      clearInterval(timer);
      prevTextRef.current = text;
    };
  }, [text, isRecording]);

  if (!text) {
    return <span className="text-zinc-600">&mdash;</span>;
  }

  return <>{displayed || <span className="text-zinc-600">&mdash;</span>}</>;
}

// ---------------------------------------------------------------------------
// FieldRow — label + value pair
// ---------------------------------------------------------------------------

function FieldRow({
  label,
  value,
  isRecording,
}: {
  label: string;
  value: string | undefined | null;
  isRecording: boolean;
}) {
  return (
    <div className="flex gap-2 min-h-[20px]">
      <span className="text-xs text-zinc-500 w-24 shrink-0 text-right">{label}:</span>
      <span className="text-sm text-zinc-200 min-w-0">
        <TypingText text={value} isRecording={isRecording} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionCard — wraps each section
// ---------------------------------------------------------------------------

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <h3 className="text-xs uppercase text-zinc-500 tracking-wider font-semibold mb-2">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ObservationBadge
// ---------------------------------------------------------------------------

const codeBadgeColors: Record<string, string> = {
  C1: 'bg-red-600/20 text-red-400 border-red-600/40',
  C2: 'bg-amber-600/20 text-amber-400 border-amber-600/40',
  C3: 'bg-blue-600/20 text-blue-400 border-blue-600/40',
  FI: 'bg-green-600/20 text-green-400 border-green-600/40',
};

function ObservationBadge({ code }: { code: string }) {
  const cls = codeBadgeColors[code] || 'bg-zinc-700/20 text-zinc-400 border-zinc-600/40';
  return (
    <span
      className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold border ${cls}`}
    >
      {code}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function InstallationSection({
  install,
  isRecording,
}: {
  install: InstallationDetails | undefined;
  isRecording: boolean;
}) {
  return (
    <SectionCard title="Installation">
      <FieldRow label="Client" value={install?.client_name} isRecording={isRecording} />
      <FieldRow label="Address" value={install?.address} isRecording={isRecording} />
      <FieldRow label="Postcode" value={install?.postcode} isRecording={isRecording} />
      <FieldRow label="Premises" value={install?.premises_description} isRecording={isRecording} />
      <FieldRow
        label="Next Insp."
        value={
          install?.next_inspection_years ? `${install.next_inspection_years} years` : undefined
        }
        isRecording={isRecording}
      />
    </SectionCard>
  );
}

function SupplySection({
  supply,
  isRecording,
}: {
  supply: SupplyCharacteristics | undefined;
  isRecording: boolean;
}) {
  return (
    <SectionCard title="Supply">
      <FieldRow label="Earthing" value={supply?.earthing_arrangement} isRecording={isRecording} />
      <FieldRow label="Conductors" value={supply?.live_conductors} isRecording={isRecording} />
      <FieldRow label="Voltage" value={supply?.nominal_voltage_u} isRecording={isRecording} />
      <FieldRow label="Frequency" value={supply?.nominal_frequency} isRecording={isRecording} />
      <FieldRow label="PFC" value={supply?.prospective_fault_current} isRecording={isRecording} />
      <FieldRow label="Ze" value={supply?.earth_loop_impedance_ze} isRecording={isRecording} />
    </SectionCard>
  );
}

function MainSwitchSection({
  supply,
  isRecording,
}: {
  supply: SupplyCharacteristics | undefined;
  isRecording: boolean;
}) {
  return (
    <SectionCard title="Main Switch">
      <FieldRow label="BS/EN" value={supply?.main_switch_bs_en} isRecording={isRecording} />
      <FieldRow label="Current" value={supply?.main_switch_current} isRecording={isRecording} />
      <FieldRow label="Poles" value={supply?.main_switch_poles} isRecording={isRecording} />
      <FieldRow label="Voltage" value={supply?.main_switch_voltage} isRecording={isRecording} />
    </SectionCard>
  );
}

function BoardSection({
  board,
  isRecording,
}: {
  board: BoardInfo | undefined;
  isRecording: boolean;
}) {
  return (
    <SectionCard title="Board">
      <FieldRow label="Manufacturer" value={board?.manufacturer} isRecording={isRecording} />
      <FieldRow label="Location" value={board?.location} isRecording={isRecording} />
      <FieldRow label="Phases" value={board?.phases} isRecording={isRecording} />
    </SectionCard>
  );
}

function SPDSection({
  supply,
  isRecording,
}: {
  supply: SupplyCharacteristics | undefined;
  isRecording: boolean;
}) {
  return (
    <SectionCard title="SPD">
      <FieldRow label="BS/EN" value={supply?.spd_bs_en} isRecording={isRecording} />
      <FieldRow label="Type" value={supply?.spd_type_supply} isRecording={isRecording} />
      <FieldRow label="Rated I" value={supply?.spd_rated_current} isRecording={isRecording} />
    </SectionCard>
  );
}

function EarthingSection({
  supply,
  isRecording,
}: {
  supply: SupplyCharacteristics | undefined;
  isRecording: boolean;
}) {
  return (
    <SectionCard title="Earthing">
      <FieldRow
        label="Distributor"
        value={
          supply?.means_earthing_distributor != null
            ? supply.means_earthing_distributor
              ? 'Yes'
              : 'No'
            : undefined
        }
        isRecording={isRecording}
      />
      <FieldRow
        label="Electrode"
        value={
          supply?.means_earthing_electrode != null
            ? supply.means_earthing_electrode
              ? 'Yes'
              : 'No'
            : undefined
        }
        isRecording={isRecording}
      />
      <FieldRow
        label="Earth Mat."
        value={supply?.earthing_conductor_material}
        isRecording={isRecording}
      />
      <FieldRow
        label="Earth CSA"
        value={
          supply?.earthing_conductor_csa ? `${supply.earthing_conductor_csa}mm\u00B2` : undefined
        }
        isRecording={isRecording}
      />
      <FieldRow
        label="Bond Mat."
        value={supply?.bonding_conductor_material}
        isRecording={isRecording}
      />
      <FieldRow
        label="Bond CSA"
        value={
          supply?.bonding_conductor_csa ? `${supply.bonding_conductor_csa}mm\u00B2` : undefined
        }
        isRecording={isRecording}
      />
    </SectionCard>
  );
}

function CircuitsSummarySection({
  circuits,
  isRecording,
}: {
  circuits: Circuit[];
  isRecording: boolean;
}) {
  return (
    <SectionCard title={`Circuits (${circuits.length})`}>
      {circuits.length === 0 ? (
        <span className="text-xs text-zinc-600">No circuits</span>
      ) : (
        <>
          {/* Header */}
          <div className="flex gap-1 text-[10px] uppercase text-zinc-500 font-semibold tracking-wider pb-1 border-b border-zinc-800">
            <span className="w-8">Ref</span>
            <span className="flex-1 min-w-0">Designation</span>
            <span className="w-12 text-center">OCPD</span>
            <span className="w-10 text-right">Rating</span>
          </div>
          {/* Rows */}
          {circuits.map((c, i) => {
            const ocpd = [c.ocpd_type, c.ocpd_rating_a ? `${c.ocpd_rating_a}A` : null]
              .filter(Boolean)
              .join(' ');
            return (
              <div key={`circuit-${i}`} className="flex gap-1 text-xs py-0.5">
                <span className="w-8 text-zinc-400 font-mono">
                  {c.circuit_ref || <span className="text-zinc-600">&mdash;</span>}
                </span>
                <span className="flex-1 min-w-0 text-zinc-200 truncate">
                  <TypingText text={c.circuit_designation} isRecording={isRecording} />
                </span>
                <span className="w-12 text-center text-zinc-400 truncate">
                  {c.ocpd_type || <span className="text-zinc-600">&mdash;</span>}
                </span>
                <span className="w-10 text-right text-zinc-400 font-mono">
                  {c.ocpd_rating_a ? (
                    `${c.ocpd_rating_a}A`
                  ) : (
                    <span className="text-zinc-600">&mdash;</span>
                  )}
                </span>
              </div>
            );
          })}
        </>
      )}
    </SectionCard>
  );
}

function ObservationsSummarySection({
  observations,
  isRecording,
}: {
  observations: Observation[];
  isRecording: boolean;
}) {
  // Count by code
  const counts: Record<string, number> = {};
  for (const obs of observations) {
    counts[obs.code] = (counts[obs.code] || 0) + 1;
  }

  return (
    <SectionCard title={`Observations (${observations.length})`}>
      {observations.length === 0 ? (
        <span className="text-xs text-zinc-600">No observations</span>
      ) : (
        <>
          {/* Code count summary */}
          <div className="flex gap-2 mb-2">
            {(['C1', 'C2', 'C3', 'FI'] as const).map((code) =>
              counts[code] ? (
                <div key={code} className="flex items-center gap-1">
                  <ObservationBadge code={code} />
                  <span className="text-xs text-zinc-400">{counts[code]}</span>
                </div>
              ) : null
            )}
          </div>
          {/* Observation list */}
          {observations.map((obs, i) => (
            <div key={`obs-${i}`} className="flex gap-2 py-0.5 items-start">
              <ObservationBadge code={obs.code} />
              <span className="text-xs text-zinc-300 min-w-0 line-clamp-2">
                <TypingText
                  text={
                    obs.observation_text.length > 120
                      ? obs.observation_text.slice(0, 120) + '...'
                      : obs.observation_text
                  }
                  isRecording={isRecording}
                />
              </span>
            </div>
          ))}
        </>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const LiveFillView = memo(function LiveFillView({ job, isRecording }: LiveFillViewProps) {
  const install = job?.installation_details;
  const supply = job?.supply_characteristics;
  const board = job?.board_info;
  const circuits = job?.circuits ?? [];
  const observations = job?.observations ?? [];

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto h-full">
      {/* Header */}
      <div className="text-center">
        <p className="text-[10px] uppercase tracking-[2px] text-zinc-500 font-bold">
          Electrical Installation
        </p>
        <p className="text-[10px] uppercase tracking-[1.5px] text-zinc-500">Condition Report</p>
        {isRecording && (
          <div className="flex items-center justify-center gap-1.5 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[10px] font-semibold text-red-400">LIVE</span>
          </div>
        )}
      </div>

      <InstallationSection install={install} isRecording={isRecording} />
      <SupplySection supply={supply} isRecording={isRecording} />
      <MainSwitchSection supply={supply} isRecording={isRecording} />
      <BoardSection board={board} isRecording={isRecording} />
      <SPDSection supply={supply} isRecording={isRecording} />
      <EarthingSection supply={supply} isRecording={isRecording} />
      <CircuitsSummarySection circuits={circuits} isRecording={isRecording} />
      <ObservationsSummarySection observations={observations} isRecording={isRecording} />

      {/* Bottom listening indicator */}
      {isRecording && (
        <div className="flex items-center justify-center gap-2 py-4">
          <span className="w-2 h-2 rounded-full bg-red-500/80 animate-pulse" />
          <span className="text-xs text-zinc-500">Waiting for more data...</span>
        </div>
      )}
    </div>
  );
});
