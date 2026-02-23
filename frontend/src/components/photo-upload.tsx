"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, JobPhoto } from "@/lib/api";
import { toast } from "sonner";
import { Camera, Loader2, Upload } from "lucide-react";

interface PhotoUploadProps {
  userId: string;
  jobId: string;
  onUpload: (photo: JobPhoto) => void;
  variant?: "button" | "compact";
  className?: string;
}

export function PhotoUpload({
  userId,
  jobId,
  onUpload,
  variant = "button",
  className,
}: PhotoUploadProps) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Image must be smaller than 10MB");
      return;
    }

    setUploading(true);
    try {
      const result = await api.uploadJobPhoto(userId, jobId, file);
      if (result.success) {
        onUpload(result.photo);
        toast.success("Photo uploaded");
      }
    } catch (error) {
      console.error("Failed to upload photo:", error);
      toast.error("Failed to upload photo");
    } finally {
      setUploading(false);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const triggerUpload = () => {
    fileInputRef.current?.click();
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment" // Use back camera on mobile
        className="hidden"
        onChange={handleFileSelect}
        disabled={uploading}
      />

      {variant === "compact" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={triggerUpload}
          disabled={uploading}
          className={className}
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
        </Button>
      ) : (
        <Button
          variant="outline"
          onClick={triggerUpload}
          disabled={uploading}
          className={className}
        >
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
      )}
    </>
  );
}
