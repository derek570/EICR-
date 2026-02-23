"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api-client";
import type { JobPhoto } from "@/lib/types";
import { toast } from "sonner";
import { Loader2, X, Image as ImageIcon, ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function PhotoImage({
  userId,
  jobId,
  filename,
  className,
  onClick,
}: {
  userId: string;
  jobId: string;
  filename: string;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const revokeRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getPhotoBlob(userId, jobId, filename).then((url) => {
      if (!cancelled) {
        revokeRef.current = url;
        setSrc(url);
      } else {
        URL.revokeObjectURL(url);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (revokeRef.current) {
        URL.revokeObjectURL(revokeRef.current);
      }
    };
  }, [userId, jobId, filename]);

  if (!src) {
    return (
      <div className={cn("flex items-center justify-center bg-gray-100", className)}>
        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
      </div>
    );
  }

  /* eslint-disable-next-line @next/next/no-img-element */
  return <img src={src} alt={filename} className={className} loading="lazy" onClick={onClick} />;
}

interface PhotoGalleryProps {
  userId: string;
  jobId: string;
  /** If provided, gallery acts as a picker with selection */
  selectable?: boolean;
  selectedPhotos?: string[];
  onSelectionChange?: (filenames: string[]) => void;
  /** Refreshes gallery when this value changes */
  refreshKey?: number;
}

export function PhotoGallery({
  userId,
  jobId,
  selectable = false,
  selectedPhotos = [],
  onSelectionChange,
  refreshKey,
}: PhotoGalleryProps) {
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxPhoto, setLightboxPhoto] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set(selectedPhotos));

  const loadPhotos = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getJobPhotos(userId, jobId);
      setPhotos(data);
    } catch (error) {
      console.error("Failed to load photos:", error);
      toast.error("Failed to load photos");
    } finally {
      setLoading(false);
    }
  }, [userId, jobId]);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos, refreshKey]);

  useEffect(() => {
    setSelection(new Set(selectedPhotos));
  }, [selectedPhotos]);

  const toggleSelection = (filename: string) => {
    const newSelection = new Set(selection);
    if (newSelection.has(filename)) {
      newSelection.delete(filename);
    } else {
      newSelection.add(filename);
    }
    setSelection(newSelection);
    onSelectionChange?.(Array.from(newSelection));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className="text-center py-12">
        <ImageIcon className="h-12 w-12 mx-auto text-gray-300 mb-3" />
        <p className="text-sm text-gray-500">No photos uploaded for this job</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
        {photos.map((photo) => {
          const isSelected = selection.has(photo.filename);
          return (
            <div key={photo.filename} className="relative group">
              <button
                onClick={() =>
                  selectable
                    ? toggleSelection(photo.filename)
                    : setLightboxPhoto(photo.filename)
                }
                className={cn(
                  "relative aspect-square rounded-lg overflow-hidden border-2 w-full transition-all",
                  "hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[var(--brand-blue)]",
                  selectable && isSelected
                    ? "border-[var(--brand-blue)] ring-2 ring-[var(--brand-blue)]/30"
                    : "border-gray-200",
                )}
              >
                <PhotoImage
                  userId={userId}
                  jobId={jobId}
                  filename={photo.filename}
                  className="w-full h-full object-cover"
                />
                {selectable && isSelected && (
                  <div className="absolute inset-0 bg-[var(--brand-blue)]/20 flex items-center justify-center">
                    <div className="bg-[var(--brand-blue)] text-white rounded-full p-1.5">
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  </div>
                )}
                {!selectable && (
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <ZoomIn className="h-6 w-6 text-white" />
                  </div>
                )}
              </button>
              <p className="text-[10px] text-gray-400 truncate mt-1 px-0.5">
                {photo.filename}
              </p>
            </div>
          );
        })}
      </div>

      {/* Lightbox */}
      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxPhoto(null)}
        >
          <button
            onClick={() => setLightboxPhoto(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
          <PhotoImage
            userId={userId}
            jobId={jobId}
            filename={lightboxPhoto}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="absolute bottom-4 text-white/70 text-sm">{lightboxPhoto}</p>
        </div>
      )}
    </>
  );
}
