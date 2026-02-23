"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Observation, JobPhoto, api } from "@/lib/api";
import { PhotoPicker } from "@/components/photo-picker";
import { PhotoUpload } from "@/components/photo-upload";
import { Image as ImageIcon, X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface InlineObservationFormProps {
  observation: Observation;
  scheduleItem: string;
  scheduleDescription: string;
  userId: string;
  jobId: string;
  onChange: (observation: Observation) => void;
}

export function InlineObservationForm({
  observation,
  scheduleItem,
  scheduleDescription,
  userId,
  jobId,
  onChange,
}: InlineObservationFormProps) {
  const [showPhotoPicker, setShowPhotoPicker] = useState(false);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  // Load photo URLs when photos change
  useEffect(() => {
    const loadPhotoUrls = async () => {
      if (!observation.photos || observation.photos.length === 0) return;

      const urls: Record<string, string> = {};
      for (const filename of observation.photos) {
        urls[filename] = await api.getPhotoUrl(userId, jobId, filename);
      }
      setPhotoUrls(urls);
    };
    loadPhotoUrls();
  }, [observation.photos, userId, jobId]);

  const updateField = (field: keyof Observation, value: string | string[]) => {
    onChange({ ...observation, [field]: value });
  };

  const handlePhotoSelect = (selectedPhotos: string[]) => {
    updateField("photos", selectedPhotos);
  };

  const handlePhotoUpload = (photo: JobPhoto) => {
    const currentPhotos = observation.photos || [];
    updateField("photos", [...currentPhotos, photo.filename]);
  };

  const removePhoto = (filename: string) => {
    const currentPhotos = observation.photos || [];
    updateField("photos", currentPhotos.filter(p => p !== filename));
  };

  return (
    <div className="bg-slate-50 border-t p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <span
          className={cn(
            "px-2 py-0.5 rounded text-white text-xs font-bold",
            observation.code === "C1" && "bg-red-500",
            observation.code === "C2" && "bg-orange-500",
            observation.code === "C3" && "bg-blue-500"
          )}
        >
          {observation.code}
        </span>
        <span>Observation</span>
      </div>

      {/* Regulation line (read-only) */}
      <div className="text-sm">
        <label className="text-xs text-muted-foreground">Regulation</label>
        <div className="mt-1 px-3 py-2 bg-white border rounded-md text-sm text-slate-700">
          {scheduleItem} - {scheduleDescription}
        </div>
      </div>

      {/* Location input */}
      <div>
        <label className="text-xs text-muted-foreground">Location</label>
        <Input
          value={observation.item_location}
          onChange={(e) => updateField("item_location", e.target.value)}
          placeholder="e.g., Kitchen, Consumer unit, First floor"
          className="mt-1"
        />
      </div>

      {/* Observation text */}
      <div>
        <label className="text-xs text-muted-foreground">Observation</label>
        <textarea
          value={observation.observation_text}
          onChange={(e) => updateField("observation_text", e.target.value)}
          placeholder="Describe the issue observed..."
          className="mt-1 w-full min-h-[80px] rounded-md border border-input px-3 py-2 text-sm resize-y"
        />
      </div>

      {/* Photo section */}
      <div>
        <label className="text-xs text-muted-foreground">Photos</label>
        <div className="mt-1 flex flex-wrap gap-2 items-center">
          {/* Display selected photos */}
          {observation.photos && observation.photos.map((filename) => (
            <div
              key={filename}
              className="relative w-16 h-16 rounded-md overflow-hidden border bg-gray-100 group"
            >
              {photoUrls[filename] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photoUrls[filename]}
                  alt={filename}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ImageIcon className="h-6 w-6 text-gray-400" />
                </div>
              )}
              <button
                onClick={() => removePhoto(filename)}
                className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}

          {/* Photo action buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPhotoPicker(true)}
              className="h-9"
            >
              <Plus className="h-4 w-4 mr-1" />
              Select from job
            </Button>
            <PhotoUpload
              userId={userId}
              jobId={jobId}
              onUpload={handlePhotoUpload}
              variant="button"
              className="h-9"
            />
          </div>
        </div>
      </div>

      {/* Photo Picker Modal */}
      <PhotoPicker
        userId={userId}
        jobId={jobId}
        isOpen={showPhotoPicker}
        onClose={() => setShowPhotoPicker(false)}
        selectedPhotos={observation.photos || []}
        onSelect={handlePhotoSelect}
      />
    </div>
  );
}
