"use client";

import { useState } from "react";
import { useJobContext } from "../layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InlineObservationForm } from "@/components/observations/inline-observation-form";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Observation, InspectionItem } from "@/lib/types";
import { EICR_SCHEDULE_SECTIONS, INSPECTION_OUTCOMES } from "@/lib/constants";

type OutcomeType = (typeof INSPECTION_OUTCOMES)[number];

const outcomeLabels: Record<string, string> = {
  tick: "\u2713",
  "N/A": "N/A",
  C1: "C1",
  C2: "C2",
  C3: "C3",
  LIM: "LIM",
};

function findLinkedObservation(observations: Observation[], scheduleItem: string): Observation | undefined {
  return observations.find((obs) => obs.schedule_item === scheduleItem);
}

function isCodeOutcome(outcome: OutcomeType): outcome is "C1" | "C2" | "C3" {
  return outcome === "C1" || outcome === "C2" || outcome === "C3";
}

export default function InspectionPage() {
  const { job, updateJob, certificateType, user } = useJobContext();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const schedule = job.inspection_schedule || { items: {} };
  const markSection7NA = schedule.markSection7NA ?? true;
  const hasMicrogeneration = schedule.hasMicrogeneration ?? false;
  const isTTEarthing = schedule.isTTEarthing ?? false;

  const microgenerationItems = ["2.0", "4.11", "4.21", "4.22"];

  if (certificateType !== "EICR") {
    return (
      <div className="p-6">
        <p className="text-gray-500">This page is for EICR certificates. Use the EIC Inspection tab for EIC certificates.</p>
      </div>
    );
  }

  const updateFlag = (flag: "markSection7NA" | "hasMicrogeneration" | "isTTEarthing", value: boolean) => {
    updateJob({
      inspection_schedule: { ...schedule, [flag]: value },
    });
  };

  const updateItem = (itemId: string, outcome: OutcomeType, description: string) => {
    const currentOutcome = getOutcome(itemId);
    const wasCode = isCodeOutcome(currentOutcome);
    const isCode = isCodeOutcome(outcome);

    const updatedItems = {
      ...schedule.items,
      [itemId]: { ...schedule.items[itemId], outcome },
    };

    let updatedObservations = [...job.observations];

    if (isCode && !wasCode) {
      const existingObs = findLinkedObservation(updatedObservations, itemId);
      if (!existingObs) {
        const newObservation: Observation = {
          code: outcome as "C1" | "C2" | "C3",
          item_location: "",
          observation_text: "",
          schedule_item: itemId,
          schedule_description: description,
          photos: [],
        };
        updatedObservations = [...updatedObservations, newObservation];
      } else {
        updatedObservations = updatedObservations.map((obs) =>
          obs.schedule_item === itemId ? { ...obs, code: outcome as "C1" | "C2" | "C3" } : obs,
        );
      }
    } else if (!isCode && wasCode) {
      updatedObservations = updatedObservations.filter((obs) => obs.schedule_item !== itemId);
    } else if (isCode && wasCode && outcome !== currentOutcome) {
      updatedObservations = updatedObservations.map((obs) =>
        obs.schedule_item === itemId ? { ...obs, code: outcome as "C1" | "C2" | "C3" } : obs,
      );
    }

    updateJob({
      inspection_schedule: { ...schedule, items: updatedItems },
      observations: updatedObservations,
    });
  };

  const updateLinkedObservation = (scheduleItem: string, updatedObservation: Observation) => {
    const updatedObservations = job.observations.map((obs) =>
      obs.schedule_item === scheduleItem ? updatedObservation : obs,
    );
    updateJob({ observations: updatedObservations });
  };

  const toggleSection = (section: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    setExpandedSections(newExpanded);
  };

  const expandAll = () => setExpandedSections(new Set(Object.keys(EICR_SCHEDULE_SECTIONS)));
  const collapseAll = () => setExpandedSections(new Set());

  const getOutcome = (itemId: string): OutcomeType => {
    if (markSection7NA && itemId.startsWith("7.")) return "N/A";
    if (microgenerationItems.includes(itemId)) return hasMicrogeneration ? "tick" : "N/A";
    if (itemId === "3.1") return isTTEarthing ? "N/A" : "tick";
    if (itemId === "3.2") return isTTEarthing ? "tick" : "N/A";

    const linkedObs = findLinkedObservation(job.observations, itemId);
    if (linkedObs && isCodeOutcome(linkedObs.code as OutcomeType)) {
      return linkedObs.code as OutcomeType;
    }

    return (schedule.items[itemId]?.outcome as OutcomeType) || "tick";
  };

  const getOutcomeColor = (outcome: OutcomeType): string => {
    switch (outcome) {
      case "C1": return "bg-red-100 text-red-800 border-red-300";
      case "C2": return "bg-orange-100 text-orange-800 border-orange-300";
      case "C3": return "bg-blue-100 text-blue-800 border-blue-300";
      case "LIM": return "bg-yellow-100 text-yellow-800 border-yellow-300";
      case "N/A": return "bg-gray-100 text-gray-600 border-gray-300";
      default: return "bg-green-100 text-green-800 border-green-300";
    }
  };

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">EICR Inspection Schedule</h2>
        <div className="flex gap-2">
          <button onClick={expandAll} className="text-sm text-brand-blue hover:underline">Expand All</button>
          <span className="text-gray-400">|</span>
          <button onClick={collapseAll} className="text-sm text-brand-blue hover:underline">Collapse All</button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-4">
          {/* TT Earthing Toggle */}
          <div className="flex items-center gap-3 pb-3 border-b">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isTTEarthing}
                onChange={(e) => updateFlag("isTTEarthing", e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm font-medium">TT Earthing System</span>
            </label>
            <span className="text-xs text-gray-500">
              {isTTEarthing ? "(3.2 ticked, 3.1 N/A)" : "(3.1 ticked, 3.2 N/A)"}
            </span>
          </div>

          {/* Microgeneration Toggle */}
          <div className="flex items-center gap-3 pb-3 border-b">
            <span className="text-sm font-medium">Microgeneration / Solar / Batteries:</span>
            <div className="flex gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="microgeneration" checked={!hasMicrogeneration} onChange={() => updateFlag("hasMicrogeneration", false)} className="h-4 w-4" />
                <span className="text-sm">No</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="microgeneration" checked={hasMicrogeneration} onChange={() => updateFlag("hasMicrogeneration", true)} className="h-4 w-4" />
                <span className="text-sm">Yes</span>
              </label>
            </div>
            <span className="text-xs text-gray-500">
              {hasMicrogeneration ? "(2.0, 4.11, 4.21, 4.22 ticked)" : "(2.0, 4.11, 4.21, 4.22 N/A)"}
            </span>
          </div>

          {/* Section 7 Toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={markSection7NA}
              onChange={(e) => updateFlag("markSection7NA", e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="text-sm">Mark ALL Section 7 items as N/A (special locations not present)</span>
          </label>
        </CardContent>
      </Card>

      {Object.entries(EICR_SCHEDULE_SECTIONS).map(([sectionName, items]) => {
        const isExpanded = expandedSections.has(sectionName);
        const isSection7 = sectionName.startsWith("7.");

        return (
          <Card key={sectionName}>
            <CardHeader
              className="cursor-pointer select-none py-3"
              onClick={() => toggleSection(sectionName)}
            >
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {sectionName}
                {isSection7 && markSection7NA && (
                  <span className="text-xs text-gray-500 ml-2">(all N/A)</span>
                )}
              </CardTitle>
            </CardHeader>
            {isExpanded && (
              <CardContent className="pt-0">
                <div className="divide-y">
                  {Object.entries(items).map(([itemId, description]) => {
                    const outcome = getOutcome(itemId);
                    const isSection7Item = itemId.startsWith("7.");
                    const isMicrogenerationItem = microgenerationItems.includes(itemId);
                    const isEarthingItem = itemId === "3.1" || itemId === "3.2";
                    const disabled = (isSection7Item && markSection7NA) || isMicrogenerationItem || isEarthingItem;

                    const linkedObservation = findLinkedObservation(job.observations, itemId);
                    const showObservationForm = isCodeOutcome(outcome) && linkedObservation;

                    return (
                      <div key={itemId} className="border-b last:border-b-0">
                        <div className="py-3 flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-sm mr-2">{itemId}</span>
                            <span className="text-sm text-gray-500">{description}</span>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            {INSPECTION_OUTCOMES.map((opt) => (
                              <button
                                key={opt}
                                onClick={() => !disabled && updateItem(itemId, opt, description)}
                                disabled={disabled}
                                className={cn(
                                  "px-2 py-1 text-xs font-medium rounded border transition-colors min-w-[36px]",
                                  outcome === opt
                                    ? getOutcomeColor(opt)
                                    : "bg-white border-gray-200 text-gray-500 hover:border-gray-400",
                                  disabled && "opacity-50 cursor-not-allowed",
                                )}
                              >
                                {outcomeLabels[opt]}
                              </button>
                            ))}
                          </div>
                        </div>

                        {showObservationForm && linkedObservation && (
                          <InlineObservationForm
                            observation={linkedObservation}
                            scheduleItem={itemId}
                            scheduleDescription={description}
                            onChange={(updatedObs) => updateLinkedObservation(itemId, updatedObs)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}

      <div className="text-xs text-gray-500 space-y-1">
        <p><span className="font-medium">{"\u2713"}</span> = Inspected and satisfactory</p>
        <p><span className="font-medium">N/A</span> = Not applicable</p>
        <p><span className="font-medium text-red-600">C1</span> = Danger present - requires urgent attention</p>
        <p><span className="font-medium text-orange-600">C2</span> = Potentially dangerous - requires improvement</p>
        <p><span className="font-medium text-blue-600">C3</span> = Improvement recommended</p>
        <p><span className="font-medium text-yellow-600">LIM</span> = Limitation - unable to inspect</p>
      </div>
    </div>
  );
}
