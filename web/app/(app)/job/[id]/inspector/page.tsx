"use client";

import { useState, useEffect } from "react";
import { useJobContext } from "../layout";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api-client";
import type { InspectorProfile } from "@/lib/types";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export default function InspectorPage() {
  const { job, updateJob, user } = useJobContext();
  const [profiles, setProfiles] = useState<InspectorProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>(job.inspector_id || "");

  useEffect(() => {
    async function loadProfiles() {
      if (!user) return;
      try {
        const data = await api.getInspectorProfiles(user.id);
        setProfiles(data);
        if (job.inspector_id && data.some((p) => p.id === job.inspector_id)) {
          setSelectedId(job.inspector_id);
        } else if (data.length > 0) {
          const defaultProfile = data.find((p) => p.id === "default") || data[0];
          setSelectedId(defaultProfile.id);
        }
      } catch (error) {
        console.error("Failed to load inspector profiles:", error);
        toast.error("Failed to load inspector profiles");
      } finally {
        setLoading(false);
      }
    }
    loadProfiles();
  }, [user, job.inspector_id]);

  const handleSelectInspector = (inspectorId: string) => {
    setSelectedId(inspectorId);
    updateJob({ inspector_id: inspectorId });
    toast.success("Inspector selected");
  };

  const selectedProfile = profiles.find((p) => p.id === selectedId);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px]">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-lg font-semibold">Inspector Profile</h2>

      <Card>
        <CardHeader><CardTitle className="text-base">Select Inspector</CardTitle></CardHeader>
        <CardContent>
          {profiles.length === 0 ? (
            <p className="text-sm text-gray-500">No inspector profiles found. Add profiles in Settings.</p>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="inspector">Inspector</Label>
              <select
                id="inspector"
                value={selectedId}
                onChange={(e) => handleSelectInspector(e.target.value)}
                className="w-full h-10 rounded-md border border-gray-300 px-3 bg-white text-sm"
              >
                <option value="">Select an inspector...</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}{profile.organisation ? ` - ${profile.organisation}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedProfile && (
        <Card>
          <CardHeader><CardTitle className="text-base">Inspector Details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="font-medium text-gray-500">Name</dt>
                <dd>{selectedProfile.name}</dd>
              </div>
              {selectedProfile.organisation && (
                <div>
                  <dt className="font-medium text-gray-500">Organisation</dt>
                  <dd>{selectedProfile.organisation}</dd>
                </div>
              )}
              {selectedProfile.position && (
                <div>
                  <dt className="font-medium text-gray-500">Position</dt>
                  <dd>{selectedProfile.position}</dd>
                </div>
              )}
              {selectedProfile.enrolment_number && (
                <div>
                  <dt className="font-medium text-gray-500">Enrolment Number</dt>
                  <dd>{selectedProfile.enrolment_number}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-gray-500">To add or edit inspector profiles, go to Settings.</p>
    </div>
  );
}
