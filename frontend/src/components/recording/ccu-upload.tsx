"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Camera, Loader2, Upload } from "lucide-react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.85;

interface CCUUploadProps {
  onAnalysisComplete: (analysis: Record<string, unknown>) => void;
}

function scaleImage(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      const longest = Math.max(width, height);

      if (longest > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / longest;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Failed to create image blob"));
        },
        "image/jpeg",
        JPEG_QUALITY,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };

    img.src = url;
  });
}

export function CCUUpload({ onAnalysisComplete }: CCUUploadProps) {
  const [analysing, setAnalysing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const analysePhoto = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Please select an image file");
        return;
      }

      setAnalysing(true);
      try {
        const scaled = await scaleImage(file);

        const formData = new FormData();
        formData.append("image", scaled, "ccu.jpg");

        const token = localStorage.getItem("token");
        const res = await fetch(`${API_BASE_URL}/api/analyze-ccu`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Server error ${res.status}`);
        }

        const analysis = await res.json();
        onAnalysisComplete(analysis);
      } catch (error) {
        console.error("CCU analysis failed:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to analyse photo",
        );
      } finally {
        setAnalysing(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [onAnalysisComplete],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) analysePhoto(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) analysePhoto(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={`flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed p-8 transition-colors ${
        dragOver
          ? "border-blue-500 bg-blue-500/10"
          : "border-zinc-700 bg-zinc-900/50"
      } ${analysing ? "pointer-events-none opacity-60" : ""}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileSelect}
        disabled={analysing}
      />

      {analysing ? (
        <>
          <Loader2 className="h-10 w-10 animate-spin text-blue-400" />
          <p className="text-sm text-zinc-400">
            Analysing consumer unit photo...
          </p>
        </>
      ) : (
        <>
          <Camera className="h-10 w-10 text-zinc-500" />
          <p className="text-center text-sm text-zinc-400">
            Drop a consumer unit photo here, or click to select
          </p>
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4 mr-2" />
            Select Photo
          </Button>
        </>
      )}
    </div>
  );
}
