'use client';

import * as React from 'react';

/**
 * PdfPreview — inline iframe renderer for a generated PDF Blob.
 *
 * Why a dedicated component: the only safe way to render a fetched
 * `application/pdf` Blob on the web is through an object URL. That URL
 * must be revoked (`URL.revokeObjectURL`) when it is no longer needed,
 * otherwise the Blob is pinned in memory for the life of the document —
 * and on long-running PWAs that's a multi-MB leak per generation.
 *
 * The component owns the URL lifecycle tightly:
 *   1. `useMemo` creates a fresh URL whenever the `blob` prop changes
 *      identity (re-generating a PDF replaces the Blob instance, which
 *      re-creates the URL).
 *   2. `useEffect` cleanup runs both on unmount AND before the next
 *      effect — so when `blob` changes, the previous URL is revoked
 *      before the new iframe swaps in.
 *
 * We use `<iframe>` rather than `<embed>` / `<object>` because it has
 * the most consistent cross-browser support for viewer chrome
 * (zoom, page navigation, download) and is the pattern iOS users are
 * accustomed to from Mobile Safari's PDF reader. `sandbox` is
 * intentionally omitted: a blob-URL PDF is same-origin but sandboxing
 * blocks the browser's built-in viewer from rendering controls on
 * Chrome/Firefox.
 *
 * The iframe's `title` is surfaced for screen readers so the preview
 * region has a meaningful label in the accessibility tree.
 */
export function PdfPreview({
  blob,
  title = 'Generated certificate PDF',
  className,
}: {
  blob: Blob;
  title?: string;
  className?: string;
}) {
  const url = React.useMemo(() => URL.createObjectURL(blob), [blob]);

  React.useEffect(() => {
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [url]);

  return (
    <iframe
      title={title}
      src={url}
      className={className}
      // Inline border removal keeps the iframe visually flush with the
      // SectionCard container; height is caller-controlled via className
      // so the tab can size the preview region appropriately.
      style={{ border: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
}
