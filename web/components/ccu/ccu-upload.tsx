"use client";

import { useState, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Camera, Upload, Loader2, X, ImageIcon } from "lucide-react";
import { api } from "@/lib/api-client";
import type { CCUAnalysisResult } from "@/lib/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface CCUUploadProps {
  onAnalysisComplete: (result: CCUAnalysisResult) => void;
}

export function CCUUpload({ onAnalysisComplete }: CCUUploadProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      toast.error("Image must be under 20MB");
      return;
    }

    setSelectedFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleAnalyze = async () => {
    if (!selectedFile) return;

    setAnalyzing(true);
    try {
      const result = await api.analyzeCcu(selectedFile);
      onAnalysisComplete(result);
      toast.success(
        `Found ${result.circuits.length} circuit${result.circuits.length !== 1 ? "s" : ""}`,
      );
    } catch (error) {
      console.error("CCU analysis failed:", error);
      toast.error("Failed to analyze photo. Please try again.");
    } finally {
      setAnalyzing(false);
    }
  };

  const clearSelection = () => {
    setSelectedFile(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-5 w-5" />
          CCU Photo Analysis
        </CardTitle>
        <CardDescription>
          Upload a photo of the consumer unit to automatically extract circuit data
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!preview ? (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
              isDragOver
                ? "border-[var(--brand-blue)] bg-blue-50"
                : "border-gray-300 hover:border-gray-400 hover:bg-gray-50",
            )}
          >
            <div className="flex flex-col items-center gap-3">
              <div className="p-3 rounded-full bg-gray-100">
                <Upload className="h-6 w-6 text-gray-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700">
                  Drop a photo here or click to browse
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  JPEG or PNG, max 20MB
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative rounded-lg overflow-hidden border bg-gray-50">
              <img
                src={preview}
                alt="Consumer unit preview"
                className="w-full max-h-[400px] object-contain"
              />
              <button
                onClick={clearSelection}
                className="absolute top-2 right-2 p-1.5 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <ImageIcon className="h-4 w-4" />
              <span className="truncate">{selectedFile?.name}</span>
              <span className="text-gray-400">
                ({(selectedFile?.size ?? 0 / 1024 / 1024).toFixed(1)} MB)
              </span>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />

        {preview && (
          <div className="flex gap-2">
            <Button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="flex-1"
            >
              {analyzing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Camera className="h-4 w-4 mr-2" />
                  Analyze Photo
                </>
              )}
            </Button>
            <Button onClick={clearSelection} variant="outline" disabled={analyzing}>
              Clear
            </Button>
          </div>
        )}

        {analyzing && (
          <p className="text-sm text-gray-500 text-center">
            GPT Vision is reading the consumer unit. Usually takes 10-15 seconds.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
