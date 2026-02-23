"use client";

import { useState, useCallback, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Upload,
  X,
  FileAudio,
  Image,
  Loader2,
  ArrowLeft,
  Camera,
  Mic,
  FileText,
  ChevronDown,
  ChevronUp,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api, OcrExtractedData } from "@/lib/api";
import OcrUpload from "@/components/ocr-upload";

interface UploadFile {
  file: File;
  id: string;
  preview?: string;
}

function UploadPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const certificateType = searchParams.get("type") === "EIC" ? "EIC" : "EICR";

  const [files, setFiles] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // OCR import state
  const [showOcrImport, setShowOcrImport] = useState(false);
  const [ocrData, setOcrData] = useState<OcrExtractedData | null>(null);
  const [isCreatingJob, setIsCreatingJob] = useState(false);
  const [showOcrPreview, setShowOcrPreview] = useState(false);

  // Check auth on mount
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
    }
  }, [router]);

  // Handle file selection
  const handleFiles = useCallback((newFiles: FileList | File[]) => {
    const fileArray = Array.from(newFiles);
    const validFiles = fileArray.filter((file) => {
      // Accept audio and image files
      const isAudio = file.type.startsWith("audio/") || /\.(m4a|mp3|wav|aac)$/i.test(file.name);
      const isImage = file.type.startsWith("image/") || /\.(jpg|jpeg|png|heic)$/i.test(file.name);
      return isAudio || isImage;
    });

    if (validFiles.length < fileArray.length) {
      toast.error("Some files were skipped. Only audio and image files are accepted.");
    }

    const uploadFiles: UploadFile[] = validFiles.map((file) => ({
      file,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));

    setFiles((prev) => [...prev, ...uploadFiles]);
  }, []);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  // Remove file
  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.preview) {
        URL.revokeObjectURL(file.preview);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  // Upload and process
  const handleUpload = async () => {
    if (files.length === 0) {
      toast.error("Please select files to upload");
      return;
    }

    setIsUploading(true);
    setUploadProgress(10);

    try {
      const result = await api.uploadAndProcess(files.map((f) => f.file), certificateType);
      setUploadProgress(100);

      // Store the new job ID so dashboard can auto-navigate when done
      if (result.jobId) {
        localStorage.setItem("pendingJobId", result.jobId);
      }

      toast.success("Job started! Processing your files...");

      // Redirect to dashboard
      setTimeout(() => {
        router.push("/dashboard");
      }, 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  // Get file icon based on type
  const getFileIcon = (file: File) => {
    if (file.type.startsWith("audio/") || /\.(m4a|mp3|wav|aac)$/i.test(file.name)) {
      return <FileAudio className="h-8 w-8 text-purple-500" />;
    }
    return <Image className="h-8 w-8 text-blue-500" />;
  };

  // Format file size
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const audioCount = files.filter(
    (f) => f.file.type.startsWith("audio/") || /\.(m4a|mp3|wav|aac)$/i.test(f.file.name)
  ).length;
  const imageCount = files.length - audioCount;

  // OCR handlers
  const handleOcrExtracted = useCallback((data: OcrExtractedData) => {
    setOcrData(data);
    setShowOcrPreview(true);
  }, []);

  const handleCreateJobFromOcr = async () => {
    if (!ocrData) return;

    setIsCreatingJob(true);
    try {
      const result = await api.createJobFromOcr(ocrData, certificateType);

      toast.success(`Job created: ${result.address}`);

      // Navigate to the new job
      setTimeout(() => {
        router.push(`/dashboard`);
      }, 500);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create job");
      setIsCreatingJob(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <h1 className="text-2xl font-bold">New {certificateType}</h1>
          <span className={`px-2 py-1 rounded text-xs font-medium ${
            certificateType === "EIC" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"
          }`}>
            {certificateType}
          </span>
        </div>

        {/* Upload area */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Upload Files</CardTitle>
            <CardDescription>
              Add audio recordings and photos of the consumer unit
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Drop zone */}
            <div
              className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-slate-300 hover:border-slate-400"
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="audio/*,image/*,.m4a,.mp3,.wav,.aac,.jpg,.jpeg,.png,.heic"
                className="hidden"
                onChange={(e) => e.target.files && handleFiles(e.target.files)}
              />

              <Upload className="h-12 w-12 mx-auto text-slate-400 mb-4" />

              <p className="text-lg font-medium mb-2">
                Drag and drop files here
              </p>
              <p className="text-sm text-muted-foreground mb-4">
                Audio recordings (.m4a, .mp3) and photos (.jpg, .png, .heic)
              </p>

              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Camera className="h-4 w-4 mr-2" />
                  Add Photos
                </Button>
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Mic className="h-4 w-4 mr-2" />
                  Add Audio
                </Button>
              </div>
            </div>

            {/* File list */}
            {files.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium">
                    Selected Files ({files.length})
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {audioCount} audio, {imageCount} photos
                  </p>
                </div>

                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {files.map((f) => (
                    <div
                      key={f.id}
                      className="flex items-center gap-3 p-3 bg-slate-100 rounded-lg"
                    >
                      {f.preview ? (
                        <img
                          src={f.preview}
                          alt=""
                          className="h-12 w-12 object-cover rounded"
                        />
                      ) : (
                        getFileIcon(f.file)
                      )}

                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{f.file.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatSize(f.file.size)}
                        </p>
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeFile(f.id)}
                        disabled={isUploading}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Progress and submit */}
        {isUploading && (
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <div className="flex-1">
                  <p className="font-medium">Uploading and processing...</p>
                  <div className="h-2 bg-slate-200 rounded-full mt-2 overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Submit button */}
        <Button
          className="w-full"
          size="lg"
          onClick={handleUpload}
          disabled={files.length === 0 || isUploading}
        >
          {isUploading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Upload className="h-4 w-4 mr-2" />
              Upload & Process ({files.length} files)
            </>
          )}
        </Button>

        {/* Divider */}
        <div className="relative my-8">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-300" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-slate-50 px-3 text-muted-foreground">or</span>
          </div>
        </div>

        {/* Import Previous Certificate */}
        <Card className="mb-6">
          <CardHeader
            className="cursor-pointer"
            onClick={() => setShowOcrImport(!showOcrImport)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-amber-100 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-amber-700" />
                </div>
                <div>
                  <CardTitle className="text-lg">Import Previous Certificate</CardTitle>
                  <CardDescription>
                    Upload an existing EICR PDF or photo to extract data
                  </CardDescription>
                </div>
              </div>
              {showOcrImport ? (
                <ChevronUp className="h-5 w-5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
          </CardHeader>

          {showOcrImport && (
            <CardContent>
              <OcrUpload onExtracted={handleOcrExtracted} />

              {/* Extracted data preview */}
              {ocrData && showOcrPreview && (
                <div className="mt-6 space-y-4">
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-500" />
                    Extracted Data Preview
                  </h3>

                  {/* Installation details */}
                  {ocrData.installation_details?.address && (
                    <div className="p-3 bg-slate-50 rounded-lg space-y-1">
                      <p className="text-sm font-medium text-muted-foreground">Property</p>
                      <p className="font-medium">{ocrData.installation_details.address}</p>
                      {ocrData.installation_details.postcode && (
                        <p className="text-sm text-muted-foreground">{ocrData.installation_details.postcode}</p>
                      )}
                      {ocrData.installation_details.client_name && (
                        <p className="text-sm">Client: {ocrData.installation_details.client_name}</p>
                      )}
                    </div>
                  )}

                  {/* Supply info */}
                  {(ocrData.supply_characteristics?.earthing_arrangement || ocrData.board_info?.manufacturer) && (
                    <div className="p-3 bg-slate-50 rounded-lg space-y-1">
                      <p className="text-sm font-medium text-muted-foreground">Supply & Board</p>
                      <div className="flex flex-wrap gap-3 text-sm">
                        {ocrData.supply_characteristics?.earthing_arrangement && (
                          <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                            {ocrData.supply_characteristics.earthing_arrangement}
                          </span>
                        )}
                        {ocrData.board_info?.manufacturer && (
                          <span className="px-2 py-0.5 bg-slate-200 rounded">
                            {ocrData.board_info.manufacturer}
                          </span>
                        )}
                        {ocrData.supply_characteristics?.earth_loop_impedance_ze && (
                          <span className="px-2 py-0.5 bg-slate-200 rounded">
                            Ze: {ocrData.supply_characteristics.earth_loop_impedance_ze}
                          </span>
                        )}
                        {ocrData.supply_characteristics?.prospective_fault_current && (
                          <span className="px-2 py-0.5 bg-slate-200 rounded">
                            PFC: {ocrData.supply_characteristics.prospective_fault_current}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Circuits summary */}
                  {ocrData.circuits && ocrData.circuits.length > 0 && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-sm font-medium text-muted-foreground mb-2">
                        Circuits ({ocrData.circuits.length})
                      </p>
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {ocrData.circuits.map((c, i) => (
                          <div key={i} className="flex items-center gap-2 text-sm">
                            <span className="w-6 text-right font-mono text-muted-foreground">
                              {c.circuit_ref || i + 1}
                            </span>
                            <span className="flex-1 truncate">
                              {c.circuit_designation || "Unknown"}
                            </span>
                            {c.ocpd_type && c.ocpd_rating_a && (
                              <span className="text-muted-foreground">
                                {c.ocpd_type}{c.ocpd_rating_a}A
                              </span>
                            )}
                            {c.measured_zs_ohm && (
                              <span className="text-muted-foreground">
                                Zs:{c.measured_zs_ohm}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Observations summary */}
                  {ocrData.observations && ocrData.observations.length > 0 && (
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-sm font-medium text-muted-foreground mb-2">
                        Observations ({ocrData.observations.length})
                      </p>
                      <div className="space-y-1">
                        {ocrData.observations.map((obs, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                              obs.code === "C1" ? "bg-red-100 text-red-700" :
                              obs.code === "C2" ? "bg-orange-100 text-orange-700" :
                              obs.code === "C3" ? "bg-yellow-100 text-yellow-700" :
                              "bg-blue-100 text-blue-700"
                            }`}>
                              {obs.code}
                            </span>
                            <span className="truncate">{obs.observation_text || obs.item_location}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Create job button */}
                  <Button
                    className="w-full"
                    size="lg"
                    onClick={handleCreateJobFromOcr}
                    disabled={isCreatingJob}
                  >
                    {isCreatingJob ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Creating Job...
                      </>
                    ) : (
                      <>
                        <Zap className="h-4 w-4 mr-2" />
                        Create Job from Import
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function UploadPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    }>
      <UploadPageContent />
    </Suspense>
  );
}
