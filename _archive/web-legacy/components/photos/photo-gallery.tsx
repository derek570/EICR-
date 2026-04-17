'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Loader2, Image as ImageIcon, X } from 'lucide-react';
import type { JobPhoto } from '@/lib/types';

interface PhotoGalleryProps {
  userId: string;
  jobId: string;
  refreshKey: number;
}

export function PhotoGallery({ userId, jobId, refreshKey }: PhotoGalleryProps) {
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  const [photoBlobs, setPhotoBlobs] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    const loadPhotos = async () => {
      setLoading(true);
      try {
        const result = await api.getJobPhotos(userId, jobId);
        if (!cancelled) {
          setPhotos(result);

          const blobs: Record<string, string> = {};
          for (const photo of result) {
            try {
              const blobUrl = await api.getPhotoBlob(userId, jobId, photo.filename);
              if (!cancelled) blobs[photo.filename] = blobUrl;
            } catch {
              // Skip failed photos
            }
          }
          if (!cancelled) setPhotoBlobs(blobs);
        }
      } catch (error) {
        console.error('Failed to load photos:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadPhotos();
    return () => {
      cancelled = true;
    };
  }, [userId, jobId, refreshKey]);

  useEffect(() => {
    if (!viewingPhoto) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewingPhoto(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [viewingPhoto]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-50 rounded-lg border">
        <ImageIcon className="h-12 w-12 mx-auto text-gray-300 mb-3" />
        <p className="text-gray-500">No photos uploaded yet</p>
        <p className="text-sm text-gray-400 mt-1">Use the upload button to add job photos</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {photos.map((photo) => (
          <div
            key={photo.filename}
            className="relative aspect-square rounded-lg overflow-hidden border bg-gray-100 cursor-pointer hover:border-blue-400 transition-colors group"
            onClick={() => setViewingPhoto(photo.filename)}
          >
            {photoBlobs[photo.filename] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoBlobs[photo.filename]}
                alt={photo.filename}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <ImageIcon className="h-8 w-8 text-gray-400" />
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <p className="text-xs text-white truncate">{photo.filename}</p>
            </div>
          </div>
        ))}
      </div>

      {viewingPhoto && photoBlobs[viewingPhoto] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo lightbox"
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setViewingPhoto(null)}
        >
          <button
            className="absolute top-4 right-4 text-white bg-white/20 hover:bg-white/30 rounded-full p-2"
            onClick={() => setViewingPhoto(null)}
            aria-label="Close photo"
          >
            <X className="h-6 w-6" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoBlobs[viewingPhoto]}
            alt="Job photo"
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
