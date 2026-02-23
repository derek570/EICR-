"use client";

import { useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { JobPhoto } from "@/lib/types";
import { toast } from "sonner";
import { Camera, Loader2, Upload, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface PhotoUploadProps {
  userId: string;
  jobId: string;
  onUpload: (photo: JobPhoto) => void;
  variant?: "button" | "compact" | "dropzone";
  className?: string;
  multiple?: boolean;
}

export function PhotoUpload({
  userId,
  jobId,
  onUpload,
  variant = "button",
  className,
  multiple = true,
}: PhotoUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error(`${file.name} is not an image`);
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error(`${file.name} exceeds 20MB limit`);
      return;
    }

    try {
      const result = await api.uploadJobPhoto(userId, jobId, file);
      if (result.success) {
        onUpload(result.photo);
      }
    } catch (error) {
      console.error("Failed to upload:", error);
      toast.error(`Failed to upload ${file.name}`);
    }
  };

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;

      setUploading(true);
      setUploadCount(0);

      for (let i = 0; i < fileArray.length; i++) {
        setUploadCount(i + 1);
        await uploadFile(fileArray[i]);
      }

      setUploading(false);
      setUploadCount(0);
      toast.success(
        `Uploaded ${fileArray.length} photo${fileArray.length !== 1 ? "s" : ""}`,
      );

      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [userId, jobId, onUpload],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const triggerUpload = () => fileInputRef.current?.click();

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        className="hidden"
        onChange={handleFileSelect}
        disabled={uploading}
      />

      {variant === "dropzone" ? (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragOver(false);
          }}
          onClick={triggerUpload}
          className={cn(
            "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
            isDragOver
              ? "border-[var(--brand-blue)] bg-blue-50"
              : "border-gray-300 hover:border-gray-400 hover:bg-gray-50",
            className,
          )}
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
              <p className="text-sm text-gray-500">
                Uploading {uploadCount}...
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Plus className="h-6 w-6 text-gray-400" />
              <p className="text-sm text-gray-500">
                Drop photos here or click to upload
              </p>
            </div>
          )}
        </div>
      ) : variant === "compact" ? (
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
              Uploading {uploadCount > 0 ? `(${uploadCount})` : ""}...
            </>
          ) : (
            <>
              <Upload className="h-4 w-4 mr-2" />
              Upload Photos
            </>
          )}
        </Button>
      )}
    </>
  );
}
