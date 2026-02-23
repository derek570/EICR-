"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { api, JobPhoto } from "@/lib/api";
import { toast } from "sonner";
import { Loader2, X, Check, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface PhotoPickerProps {
  userId: string;
  jobId: string;
  isOpen: boolean;
  onClose: () => void;
  selectedPhotos: string[];
  onSelect: (photos: string[]) => void;
}

export function PhotoPicker({
  userId,
  jobId,
  isOpen,
  onClose,
  selectedPhotos,
  onSelect,
}: PhotoPickerProps) {
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Set<string>>(new Set(selectedPhotos));

  useEffect(() => {
    if (isOpen) {
      loadPhotos();
      setSelection(new Set(selectedPhotos));
    }
  }, [isOpen, userId, jobId, selectedPhotos]);

  // Revoke blob URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(photoUrls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const loadPhotos = async () => {
    setLoading(true);
    // Revoke any existing blob URLs
    Object.values(photoUrls).forEach((url) => URL.revokeObjectURL(url));
    try {
      const data = await api.getJobPhotos(userId, jobId);
      setPhotos(data);

      const urls: Record<string, string> = {};
      for (const photo of data) {
        try {
          const blob = await api.getPhotoBlob(userId, jobId, photo.filename);
          urls[photo.filename] = URL.createObjectURL(blob);
        } catch {
          // Skip failed photos
        }
      }
      setPhotoUrls(urls);
    } catch (error) {
      console.error("Failed to load photos:", error);
      toast.error("Failed to load job photos");
    } finally {
      setLoading(false);
    }
  };

  const togglePhoto = (filename: string) => {
    const newSelection = new Set(selection);
    if (newSelection.has(filename)) {
      newSelection.delete(filename);
    } else {
      newSelection.add(filename);
    }
    setSelection(newSelection);
  };

  const handleConfirm = () => {
    onSelect(Array.from(selection));
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ImageIcon className="h-5 w-5" />
            Select Photos
            {selection.size > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                ({selection.size} selected)
              </span>
            )}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[calc(90vh-140px)]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : photos.length === 0 ? (
            <div className="text-center py-12">
              <ImageIcon className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No photos available for this job</p>
              <p className="text-sm text-muted-foreground mt-1">
                Upload photos using the upload button below
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {photos.map((photo) => {
                const isSelected = selection.has(photo.filename);
                return (
                  <button
                    key={photo.filename}
                    onClick={() => togglePhoto(photo.filename)}
                    className={cn(
                      "relative aspect-square rounded-lg overflow-hidden border-2 transition-all",
                      "hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary",
                      isSelected ? "border-primary ring-2 ring-primary/30" : "border-gray-200"
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photoUrls[photo.filename] || ""}
                      alt="Observation evidence photo"
                      className="w-full h-full object-cover"
                    />
                    {isSelected && (
                      <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                        <div className="bg-primary text-white rounded-full p-1">
                          <Check className="h-4 w-4" />
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex justify-between items-center p-4 border-t bg-gray-50">
          <span className="text-sm text-muted-foreground">
            {selection.size} photo{selection.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleConfirm}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
