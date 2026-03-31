'use client';

import { useState, useRef, useCallback } from 'react';
import { Upload, FileText, Image, Loader2, X, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, OcrExtractedData } from '@/lib/api';

interface OcrUploadProps {
  onExtracted: (data: OcrExtractedData) => void;
}

type UploadStatus = 'idle' | 'uploading' | 'extracting' | 'success' | 'error';

export default function OcrUpload({ onExtracted }: OcrUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [extractedSummary, setExtractedSummary] = useState<{
    circuits: number;
    observations: number;
    address: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback((selectedFile: File) => {
    const ext = selectedFile.name.split('.').pop()?.toLowerCase();
    const allowed = ['pdf', 'jpg', 'jpeg', 'png'];
    if (!ext || !allowed.includes(ext)) {
      setErrorMessage(`Unsupported file type .${ext}. Please use PDF, JPG, or PNG.`);
      return;
    }

    setFile(selectedFile);
    setStatus('idle');
    setErrorMessage('');
    setExtractedSummary(null);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (selected) handleFileSelect(selected);
    },
    [handleFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) handleFileSelect(dropped);
    },
    [handleFileSelect]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const removeFile = useCallback(() => {
    setFile(null);
    setStatus('idle');
    setErrorMessage('');
    setExtractedSummary(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleExtract = async () => {
    if (!file) return;

    setStatus('uploading');
    setProgress(20);
    setErrorMessage('');

    try {
      // Simulate upload progress
      setProgress(40);
      setStatus('extracting');

      const result = await api.ocrCertificate(file);

      setProgress(100);
      setStatus('success');

      const summary = {
        circuits: result.data.circuits?.length || 0,
        observations: result.data.observations?.length || 0,
        address: result.data.installation_details?.address || 'Unknown address',
      };
      setExtractedSummary(summary);

      // Pass extracted data to parent
      onExtracted(result.data);
    } catch (error) {
      setStatus('error');
      setProgress(0);
      setErrorMessage(
        error instanceof Error ? error.message : 'Extraction failed. Please try again.'
      );
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return <FileText className="h-8 w-8 text-red-500" />;
    return <Image className="h-8 w-8 text-blue-500" />;
  };

  const isProcessing = status === 'uploading' || status === 'extracting';

  return (
    <div className="space-y-4">
      {/* File drop zone */}
      {!file && (
        <div
          className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-slate-400 transition-colors"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={handleInputChange}
          />
          <Upload className="h-10 w-10 mx-auto text-slate-400 mb-3" />
          <p className="font-medium text-slate-700 mb-1">
            Drop a certificate here or click to browse
          </p>
          <p className="text-sm text-muted-foreground">PDF, JPG, or PNG (max 100MB)</p>
        </div>
      )}

      {/* Selected file display */}
      {file && (
        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border">
          {getFileIcon(file.name)}
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">{file.name}</p>
            <p className="text-sm text-muted-foreground">{formatFileSize(file.size)}</p>
          </div>
          {!isProcessing && status !== 'success' && (
            <Button variant="ghost" size="sm" onClick={removeFile}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* Progress indicator */}
      {isProcessing && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm font-medium">
              {status === 'uploading' ? 'Uploading certificate...' : 'Extracting data with AI...'}
            </span>
          </div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          {status === 'extracting' && (
            <p className="text-xs text-muted-foreground">
              This may take 15-30 seconds depending on the document size.
            </p>
          )}
        </div>
      )}

      {/* Success state */}
      {status === 'success' && extractedSummary && (
        <div className="flex items-start gap-3 p-3 bg-green-50 border border-green-200 rounded-lg">
          <CheckCircle className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium text-green-800">Data extracted successfully</p>
            <p className="text-sm text-green-700 mt-1">{extractedSummary.address}</p>
            <p className="text-sm text-green-600">
              {extractedSummary.circuits} circuits, {extractedSummary.observations} observations
              found
            </p>
          </div>
        </div>
      )}

      {/* Error state */}
      {status === 'error' && errorMessage && (
        <div className="flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium text-red-800">Extraction failed</p>
            <p className="text-sm text-red-600 mt-1">{errorMessage}</p>
          </div>
        </div>
      )}

      {/* Inline error for file validation */}
      {!file && errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

      {/* Extract button */}
      {file && status !== 'success' && (
        <Button className="w-full" onClick={handleExtract} disabled={isProcessing}>
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Extracting...
            </>
          ) : status === 'error' ? (
            'Retry Extraction'
          ) : (
            <>
              <FileText className="h-4 w-4 mr-2" />
              Extract Certificate Data
            </>
          )}
        </Button>
      )}
    </div>
  );
}
