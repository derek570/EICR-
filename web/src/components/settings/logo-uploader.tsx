'use client';

import * as React from 'react';
import { ImageOff, Upload, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/types';
import { Button } from '@/components/ui/button';

/**
 * LogoUploader — company branding image picker.
 *
 * Why it's bespoke and not a generic photo picker:
 *  - Logos render on every PDF cert header, so the preview box mirrors
 *    the actual ~200×60 PDF slot (short-wide) to give admins a realistic
 *    idea of how their logo will look stamped.
 *  - Uploads go to a dedicated endpoint (`/api/settings/:userId/logo`)
 *    that returns an S3 key we MERGE into `company_settings.logo_file`
 *    — we don't PUT the settings blob from here. The parent form owns
 *    the save; we just hand back the key via `onUploaded`.
 *  - Reads existing logos via the auth'd blob-fetch pattern (browsers
 *    can't attach the bearer token to a bare S3 URL), matching the
 *    observation-photo + signature-canvas implementations.
 *
 * Behaviour:
 *  - Has an existing logo → shows the image + Replace + Remove buttons.
 *  - No logo → shows a dashed "click to upload" drop target.
 *  - Uploading → disables controls and shows "Uploading…".
 *  - Remove clears the key in memory via `onUploaded(null)` — it does
 *    NOT delete the S3 object (orphans are cheap; we don't have a delete
 *    endpoint and adding one for this case isn't worth the scope creep).
 *
 * Disabled state used when the current user isn't a company admin; the
 * parent is also expected to hide the uploader entirely in that case,
 * but passing `disabled` is belt-and-braces.
 */
export function LogoUploader({
  userId,
  logoFile,
  onUploaded,
  disabled = false,
}: {
  userId: string;
  /** Current S3 key from `company_settings.logo_file`, if any. */
  logoFile?: string | null;
  /** Called after a successful upload with the new S3 key (or null on remove). */
  onUploaded: (key: string | null) => void;
  disabled?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear so the same filename can be re-selected next time.
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.uploadCompanyLogo(userId, file);
      onUploaded(res.logo_file);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Upload failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFile}
        disabled={disabled || busy}
        className="hidden"
      />

      {logoFile ? (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3">
          <div className="flex h-16 w-48 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-white">
            <LogoPreview userId={userId} logoFile={logoFile} />
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="h-4 w-4" aria-hidden />
              {busy ? 'Uploading…' : 'Replace'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => onUploaded(null)}
              className="text-[var(--color-status-failed)] hover:bg-[color-mix(in_oklab,var(--color-status-failed)_10%,transparent)]"
            >
              <X className="h-4 w-4" aria-hidden />
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || busy}
          className="flex h-28 w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-1)] text-[var(--color-text-secondary)] transition hover:border-[var(--color-brand-blue)] hover:text-[var(--color-brand-blue)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Upload className="h-5 w-5" aria-hidden />
          <span className="text-[13px] font-medium">
            {busy ? 'Uploading…' : 'Click to upload logo'}
          </span>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">
            PNG or JPEG, up to 10 MB
          </span>
        </button>
      )}

      {error ? (
        <p role="alert" className="text-[12px] text-[var(--color-status-failed)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Private blob-backed image loader. Kept colocated because the fetch key +
// object-URL lifecycle is tightly coupled to the uploader — other callers
// wouldn't benefit from extracting it.

function LogoPreview({ userId, logoFile }: { userId: string; logoFile: string }) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setStatus('loading');
    setUrl(null);

    api
      .fetchLogoBlob(userId, logoFile)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [userId, logoFile]);

  if (status === 'ready' && url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- blob: URL, not a remote asset
      <img src={url} alt="Company logo" className="max-h-full max-w-full object-contain" />
    );
  }

  if (status === 'error') {
    return <ImageOff className="h-5 w-5 text-[var(--color-text-tertiary)]" aria-hidden />;
  }

  return <div className="h-full w-full animate-pulse bg-[var(--color-surface-2)]" />;
}
