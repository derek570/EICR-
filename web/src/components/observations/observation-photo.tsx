'use client';

import * as React from 'react';
import { ImageOff } from 'lucide-react';
import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Authenticated photo renderer.
 *
 * The photo endpoint (`/api/job/:userId/:jobId/photos/:filename`) requires
 * a bearer token, so a plain `<img src>` won't work — the browser never
 * attaches our Authorization header on an image request. Instead, fetch
 * the bytes via `api.fetchPhotoBlob`, wrap in `URL.createObjectURL`, and
 * revoke on unmount (or when any of the inputs change) to avoid leaking
 * blob URLs.
 *
 * Behaviour:
 * - Loading  → neutral skeleton
 * - Error    → broken-image icon + accessible label
 * - Success  → `<img>` with the blob URL, cover-cropped to its container
 *
 * By default the `thumbnail` URL variant is requested (backend serves a
 * scaled JPEG) so grids are cheap; opt into the full-resolution image by
 * passing `thumbnail={false}`.
 */
export function ObservationPhoto({
  userId,
  jobId,
  filename,
  alt,
  thumbnail = true,
  className,
}: {
  userId: string;
  jobId: string;
  filename: string;
  alt?: string;
  thumbnail?: boolean;
  className?: string;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setStatus('loading');
    setUrl(null);

    api
      .fetchPhotoBlob(userId, jobId, filename, { thumbnail })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        // Log to console for debugging but don't bubble — a broken
        // thumbnail shouldn't take down the whole observation sheet.
        const message =
          err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message;
        console.warn(`ObservationPhoto load failed [${filename}]: ${message}`);
        setStatus('error');
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [userId, jobId, filename, thumbnail]);

  if (status === 'ready' && url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- blob: URL, not a remote asset
      <img
        src={url}
        alt={alt ?? 'Observation photo'}
        className={cn('h-full w-full object-cover', className)}
      />
    );
  }

  if (status === 'error') {
    return (
      <div
        role="img"
        aria-label="Photo failed to load"
        className={cn(
          'flex h-full w-full items-center justify-center bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)]',
          className
        )}
      >
        <ImageOff className="h-5 w-5" aria-hidden />
      </div>
    );
  }

  // Loading skeleton — subtle pulse so the grid doesn't jitter.
  return (
    <div
      aria-hidden
      className={cn('h-full w-full animate-pulse bg-[var(--color-surface-2)]', className)}
    />
  );
}
