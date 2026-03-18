"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { getUser } from "@/lib/auth";
import { useJobStore } from "@/lib/store";
import { syncCurrentJob } from "@/lib/sync";
import type { JobDetail, User } from "@/lib/types";

export function useJob(jobId: string) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const {
    currentJob,
    isDirty,
    isSyncing,
    isOnline,
    loadJob,
    updateCircuits,
    updateObservations,
    updateBoardInfo,
    updateBoards,
    updateInstallationDetails,
    updateSupplyCharacteristics,
    updateInspectionSchedule,
    setInspectorId,
    updateExtentAndType,
    updateDesignConstruction,
    clearJob,
  } = useJobStore();

  useEffect(() => {
    const storedUser = getUser();
    if (!storedUser) {
      router.push("/login");
      return;
    }
    setUser(storedUser);
    useJobStore.getState().setUser(storedUser.id);

    async function loadJobData() {
      try {
        if (navigator.onLine) {
          const jobData = await api.getJob(storedUser!.id, jobId);
          await loadJob(jobId, jobData, storedUser!.id);
        } else {
          const { getLocalJob } = await import("@/lib/db");
          const localJob = await getLocalJob(jobId);
          if (localJob) {
            await loadJob(jobId, {
              id: localJob.id,
              address: localJob.address,
              status: localJob.status,
              created_at: localJob.created_at,
              certificate_type: localJob.certificate_type || "EICR",
              circuits: localJob.circuits,
              observations: localJob.observations,
              board_info: localJob.board_info,
              boards: localJob.boards,
              installation_details: localJob.installation_details,
              supply_characteristics: localJob.supply_characteristics,
              inspection_schedule: localJob.inspection_schedule,
              inspector_id: localJob.inspector_id,
              extent_and_type: localJob.extent_and_type,
              design_construction: localJob.design_construction,
            }, storedUser!.id);
          } else {
            toast.error("Job not available offline");
            router.push("/dashboard");
          }
        }
      } catch {
        const { getLocalJob } = await import("@/lib/db");
        const localJob = await getLocalJob(jobId);
        if (localJob) {
          await loadJob(jobId, {
            id: localJob.id,
            address: localJob.address,
            status: localJob.status,
            created_at: localJob.created_at,
            certificate_type: localJob.certificate_type || "EICR",
            circuits: localJob.circuits,
            observations: localJob.observations,
            board_info: localJob.board_info,
            boards: localJob.boards,
            installation_details: localJob.installation_details,
            supply_characteristics: localJob.supply_characteristics,
            inspection_schedule: localJob.inspection_schedule,
            inspector_id: localJob.inspector_id,
            extent_and_type: localJob.extent_and_type,
            design_construction: localJob.design_construction,
          }, storedUser!.id);
          toast.info("Loaded from offline cache");
        } else {
          toast.error("Failed to load job");
          router.push("/dashboard");
        }
      } finally {
        setLoading(false);
      }
    }

    loadJobData();

    return () => {
      clearJob();
    };
  }, [jobId]);

  const updateJob = useCallback(
    (updates: Partial<JobDetail>) => {
      if (updates.circuits) updateCircuits(updates.circuits);
      if (updates.observations) updateObservations(updates.observations);
      if (updates.board_info) updateBoardInfo(updates.board_info);
      if (updates.boards) updateBoards(updates.boards);
      if (updates.installation_details) updateInstallationDetails(updates.installation_details);
      if (updates.supply_characteristics) updateSupplyCharacteristics(updates.supply_characteristics);
      if (updates.inspection_schedule) updateInspectionSchedule(updates.inspection_schedule);
      if (updates.inspector_id) setInspectorId(updates.inspector_id);
      if (updates.extent_and_type) updateExtentAndType(updates.extent_and_type);
      if (updates.design_construction) updateDesignConstruction(updates.design_construction);
    },
    [updateCircuits, updateObservations, updateBoardInfo, updateBoards, updateInstallationDetails, updateSupplyCharacteristics, updateInspectionSchedule, setInspectorId, updateExtentAndType, updateDesignConstruction],
  );

  const save = useCallback(async () => {
    const success = await syncCurrentJob();
    if (success) {
      toast.success("Job saved");
    } else if (!isOnline) {
      toast.info("Saved locally - will sync when online");
    } else {
      toast.error("Failed to save job");
    }
  }, [isOnline]);

  return {
    job: currentJob,
    user,
    loading,
    isDirty,
    isSyncing,
    isOnline,
    updateJob,
    save,
    certificateType: (currentJob?.certificate_type || "EICR") as "EICR" | "EIC",
  };
}
