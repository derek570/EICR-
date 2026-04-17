'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { toast } from 'sonner';
import { Loader2, Upload } from 'lucide-react';

interface PhotoUploadProps {
  userId: string;
  jobId: string;
  onUpload: () => void;
}

export function PhotoUpload({ userId, jobId, onUpload }: PhotoUploadProps) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    setUploading(true);
    try {
      const result = await api.uploadJobPhoto(userId, jobId, file);
      if (result.success) {
        onUpload();
        toast.success('Photo uploaded');
      }
    } catch (error) {
      console.error('Failed to upload photo:', error);
      toast.error('Failed to upload photo');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileSelect}
        disabled={uploading}
      />
      <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
        {uploading ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Uploading...
          </>
        ) : (
          <>
            <Upload className="h-4 w-4 mr-2" />
            Upload Photo
          </>
        )}
      </Button>
    </>
  );
}
