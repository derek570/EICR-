"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CertificateType } from "@/lib/types";

interface CreateJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateJob: (certificateType: CertificateType, address?: string) => Promise<void>;
}

export function CreateJobDialog({ open, onOpenChange, onCreateJob }: CreateJobDialogProps) {
  const [certType, setCertType] = useState<CertificateType>("EICR");
  const [address, setAddress] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    setIsCreating(true);
    try {
      await onCreateJob(certType, address.trim() || undefined);
      setAddress("");
      onOpenChange(false);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Certificate</DialogTitle>
          <DialogDescription>
            Create a new electrical certificate job.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Certificate Type</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={certType === "EICR" ? "default" : "outline"}
                className={certType === "EICR" ? "bg-blue-600 hover:bg-blue-700" : ""}
                onClick={() => setCertType("EICR")}
              >
                EICR
              </Button>
              <Button
                type="button"
                variant={certType === "EIC" ? "default" : "outline"}
                className={certType === "EIC" ? "bg-emerald-600 hover:bg-emerald-700" : ""}
                onClick={() => setCertType("EIC")}
              >
                EIC
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">Address (optional)</Label>
            <Input
              id="address"
              placeholder="e.g., 12 High Street, London"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Job"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
