/**
 * Trigger a browser download from a Blob + Content-Disposition header.
 */
export function downloadBlob(blob: Blob, fallbackFilename: string, disposition?: string | null): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
  a.download = filenameMatch?.[1] || fallbackFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
