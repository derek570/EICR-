"use client";

import { useJobContext } from "../layout";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DesignConstruction } from "@/lib/types";

export default function DesignPage() {
  const { job, updateJob, certificateType } = useJobContext();

  if (certificateType !== "EIC") {
    return (
      <div className="p-6">
        <p className="text-gray-500">This page is only available for EIC certificates.</p>
      </div>
    );
  }

  const design: DesignConstruction = job.design_construction || {
    departures_from_bs7671: "",
  };

  const updateField = <K extends keyof DesignConstruction>(field: K, value: DesignConstruction[K]) => {
    updateJob({ design_construction: { ...design, [field]: value } });
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-lg font-semibold">Design &amp; Construction</h2>

      <Card>
        <CardHeader><CardTitle className="text-base">Departures from BS 7671</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="departures">Departures from BS 7671 (if any)</Label>
            <Textarea
              id="departures"
              value={design.departures_from_bs7671 || ""}
              onChange={(e) => updateField("departures_from_bs7671", e.target.value)}
              placeholder="Enter 'None' if no departures, or describe any departures from the standard..."
              rows={4}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="details">Details of Departures</Label>
            <Textarea
              id="details"
              value={design.departure_details || ""}
              onChange={(e) => updateField("departure_details", e.target.value)}
              placeholder="Provide details of any departures and the reasons for them..."
              rows={4}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
