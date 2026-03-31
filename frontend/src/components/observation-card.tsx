'use client';

import { useState, useEffect, useCallback } from 'react';
import { Observation, Regulation, api, JobPhoto } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PhotoPicker } from '@/components/photo-picker';
import { PhotoUpload } from '@/components/photo-upload';
import { RegulationLookup } from '@/components/regulation-lookup';
import { Trash2, Image as ImageIcon, Plus, X, Link as LinkIcon, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ObservationCardProps {
  observation: Observation;
  index: number;
  userId: string;
  jobId: string;
  onChange: (index: number, observation: Observation) => void;
  onDelete: (index: number) => void;
}

const codeColors: Record<string, string> = {
  C1: 'bg-red-500',
  C2: 'bg-orange-500',
  C3: 'bg-blue-500',
  FI: 'bg-purple-500',
};

const codeLabels: Record<string, string> = {
  C1: 'Danger Present',
  C2: 'Potentially Dangerous',
  C3: 'Improvement Recommended',
  FI: 'Further Investigation',
};

export function ObservationCard({
  observation,
  index,
  userId,
  jobId,
  onChange,
  onDelete,
}: ObservationCardProps) {
  const [showPhotoPicker, setShowPhotoPicker] = useState(false);
  const [showRegulationLookup, setShowRegulationLookup] = useState(false);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);

  // Load photo blob URLs when photos change, revoke old ones on cleanup
  useEffect(() => {
    if (!observation.photos || observation.photos.length === 0) return;

    let cancelled = false;
    const blobUrls: string[] = [];

    const loadPhotos = async () => {
      const urls: Record<string, string> = {};
      for (const filename of observation.photos!) {
        try {
          const blob = await api.getPhotoBlob(userId, jobId, filename);
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          blobUrls.push(url);
          urls[filename] = url;
        } catch {
          // Skip failed photos
        }
      }
      if (!cancelled) setPhotoUrls(urls);
    };
    loadPhotos();

    return () => {
      cancelled = true;
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [observation.photos, userId, jobId]);

  const updateField = (field: keyof Observation, value: string | string[]) => {
    onChange(index, { ...observation, [field]: value });
  };

  const handlePhotoSelect = (selectedPhotos: string[]) => {
    updateField('photos', selectedPhotos);
  };

  const handlePhotoUpload = (photo: JobPhoto) => {
    const currentPhotos = observation.photos || [];
    updateField('photos', [...currentPhotos, photo.filename]);
  };

  const removePhoto = (filename: string) => {
    const currentPhotos = observation.photos || [];
    updateField(
      'photos',
      currentPhotos.filter((p) => p !== filename)
    );
  };

  const handleRegulationSelect = (regulation: Regulation) => {
    // Build the regulation reference text
    const regText = `Contrary to BS 7671 Regulation ${regulation.ref} — ${regulation.recommended_action}`;

    // Append to existing observation text (or replace if empty)
    const currentText = observation.observation_text.trim();
    const newText = currentText ? `${currentText}\n\n${regText}` : regText;

    onChange(index, { ...observation, observation_text: newText });
    setShowRegulationLookup(false);
  };

  const isLinkedToSchedule = !!observation.schedule_item;

  // Close lightbox on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setViewingPhoto(null);
  }, []);

  useEffect(() => {
    if (viewingPhoto) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [viewingPhoto, handleKeyDown]);

  return (
    <div className="bg-white border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <select
            value={observation.code}
            onChange={(e) => updateField('code', e.target.value as Observation['code'])}
            aria-label="Observation severity code"
            className={cn(
              'h-10 w-16 rounded-full text-white font-bold text-center appearance-none cursor-pointer',
              codeColors[observation.code]
            )}
          >
            <option value="C1">C1</option>
            <option value="C2">C2</option>
            <option value="C3">C3</option>
            <option value="FI">FI</option>
          </select>
          <div>
            <span className="text-sm text-muted-foreground">{codeLabels[observation.code]}</span>
            {isLinkedToSchedule && (
              <div className="flex items-center gap-1 text-xs text-blue-600 mt-0.5">
                <LinkIcon className="h-3 w-3" />
                <span>Linked to {observation.schedule_item}</span>
              </div>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(index)}
          className="text-red-500 hover:text-red-700 hover:bg-red-50"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Schedule description (if linked) */}
      {observation.schedule_description && (
        <div className="text-sm">
          <label className="text-xs text-muted-foreground">Regulation</label>
          <div className="mt-1 px-3 py-2 bg-slate-50 border rounded-md text-sm text-slate-700">
            {observation.schedule_item} - {observation.schedule_description}
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-muted-foreground">Location</label>
        <Input
          value={observation.item_location}
          onChange={(e) => updateField('item_location', e.target.value)}
          placeholder="e.g., Kitchen socket, Consumer unit"
          className="mt-1"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground">Observation</label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRegulationLookup(!showRegulationLookup)}
            className="h-7 text-xs gap-1"
          >
            <BookOpen className="h-3 w-3" />
            Add Regulation
          </Button>
        </div>
        <textarea
          value={observation.observation_text}
          onChange={(e) => updateField('observation_text', e.target.value)}
          placeholder="Description of the issue..."
          className="mt-1 w-full min-h-[80px] rounded-md border border-input px-3 py-2 text-sm resize-y"
        />

        {/* Regulation Lookup Panel */}
        {showRegulationLookup && (
          <div className="mt-2">
            <RegulationLookup
              onSelect={handleRegulationSelect}
              onClose={() => setShowRegulationLookup(false)}
            />
          </div>
        )}
      </div>

      <div>
        <label className="text-xs text-muted-foreground">Schedule Item</label>
        <Input
          value={observation.schedule_item || ''}
          onChange={(e) => updateField('schedule_item', e.target.value)}
          placeholder="e.g., 4.5, 5.3"
          className="mt-1"
          disabled={isLinkedToSchedule}
        />
        {isLinkedToSchedule && (
          <p className="text-xs text-muted-foreground mt-1">
            This observation is linked from the Inspection Schedule. Deleting it will set the
            schedule item to tick.
          </p>
        )}
      </div>

      {/* Photo section */}
      <div>
        <label className="text-xs text-muted-foreground">Photos</label>
        {/* Photo preview grid - 128x128 thumbnails */}
        {observation.photos && observation.photos.length > 0 && (
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {observation.photos.map((filename) => (
              <div
                key={filename}
                className="relative aspect-square rounded-lg overflow-hidden border-2 border-gray-200 bg-gray-100 group cursor-pointer hover:border-blue-400 transition-colors"
                onClick={() => setViewingPhoto(filename)}
              >
                {photoUrls[filename] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photoUrls[filename]}
                    alt="Observation evidence photo"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageIcon className="h-8 w-8 text-gray-400" />
                  </div>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removePhoto(filename);
                  }}
                  className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Photo action buttons */}
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPhotoPicker(true)}
            className="h-9"
          >
            <Plus className="h-4 w-4 mr-1" />
            Select
          </Button>
          <PhotoUpload
            userId={userId}
            jobId={jobId}
            onUpload={handlePhotoUpload}
            variant="compact"
            className="h-9"
          />
        </div>
      </div>

      {/* Photo lightbox - full screen view */}
      {viewingPhoto && photoUrls[viewingPhoto] && (
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
            src={photoUrls[viewingPhoto]}
            alt="Observation evidence photo"
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

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
