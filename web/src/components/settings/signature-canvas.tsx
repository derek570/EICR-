'use client';

import * as React from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

/**
 * SignatureCanvas — pen-drawn signature capture, ported from iOS
 * `SignatureCaptureView.swift`.
 *
 * Rendering: single HTML5 `<canvas>` driven by Pointer Events. Strokes
 * are built from raw point arrays (matches iOS) and rendered with
 * quadratic-curve smoothing (Catmull-Rom-lite) so the pen-trail feels
 * continuous even at low sample rates. Stored in state as `lines:
 * Point[][]` so undo (clear) is a one-assignment operation and
 * re-render is cheap (paint-to-canvas, not React-tree).
 *
 * Background handling:
 *   - If `initialUrl` is provided, we draw that image as the background
 *     on mount and treat it as "has signature" so the Clear button shows.
 *   - When the user starts drawing, we don't erase the background — the
 *     canvas is flattened on export (`toBlob`), so adding strokes on top
 *     of an existing signature produces a merged PNG. That matches iOS
 *     behaviour (iOS overlays the existing PNG then draws on top).
 *
 * Export: imperative handle exposes `getBlob()` and `clear()`. Parent
 * decides when to upload (we don't auto-POST on every stroke — iOS
 * doesn't either; uploads fire on form save).
 *
 * Accessibility: the canvas has an aria-label and a visible Clear
 * button. On `prefers-reduced-motion: reduce` we skip the subtle fade
 * when clearing (straight wipe).
 */

export interface SignatureCanvasHandle {
  /** Returns the current canvas as a PNG Blob, or null if untouched. */
  getBlob: () => Promise<Blob | null>;
  /** Clears all strokes and any loaded background. */
  clear: () => void;
  /** True if the user has drawn or a background was loaded. */
  hasContent: () => boolean;
}

interface Point {
  x: number;
  y: number;
}

export interface SignatureCanvasProps {
  /**
   * User id for authed signature fetch. Required when `initialSignatureFile`
   * is set — the canvas needs it to call `api.fetchSignatureBlob`.
   */
  userId?: string;
  /**
   * S3 key of an existing signature (from `inspector.signature_file`).
   * Loaded as the canvas background so the user can see what's there
   * and choose to keep, amend, or clear it.
   */
  initialSignatureFile?: string | null;
  height?: number;
}

export const SignatureCanvas = React.forwardRef<SignatureCanvasHandle, SignatureCanvasProps>(
  function SignatureCanvas({ userId, initialSignatureFile, height = 180 }, ref) {
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const linesRef = React.useRef<Point[][]>([]);
    const currentLineRef = React.useRef<Point[]>([]);
    const backgroundImgRef = React.useRef<HTMLImageElement | null>(null);
    const [hasStrokes, setHasStrokes] = React.useState(false);
    const [hasBackground, setHasBackground] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);

    // --- Draw ---------------------------------------------------------------
    const drawLine = React.useCallback((ctx: CanvasRenderingContext2D, points: Point[]) => {
      if (points.length === 0) return;
      if (points.length === 1) {
        const p = points[0];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
      } else {
        for (let i = 1; i < points.length; i++) {
          const mid = {
            x: (points[i - 1].x + points[i].x) / 2,
            y: (points[i - 1].y + points[i].y) / 2,
          };
          ctx.quadraticCurveTo(points[i - 1].x, points[i - 1].y, mid.x, mid.y);
        }
        const last = points[points.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
    }, []);

    const redraw = React.useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      // Background (existing signature, if loaded).
      const bg = backgroundImgRef.current;
      if (bg) {
        const scale = Math.min(rect.width / bg.width, rect.height / bg.height);
        const w = bg.width * scale;
        const h = bg.height * scale;
        const x = (rect.width - w) / 2;
        const y = (rect.height - h) / 2;
        ctx.drawImage(bg, x, y, w, h);
      }

      // Ink style. Black at 2.5px with rounded joins mirrors iOS stroke.
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#000';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const line of linesRef.current) drawLine(ctx, line);
      if (currentLineRef.current.length > 0) drawLine(ctx, currentLineRef.current);
    }, [drawLine]);

    // --- Canvas sizing (handle DPR for crispness on retina) ---------------
    const resize = React.useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }, [redraw]);

    React.useEffect(() => {
      resize();
      const onResize = () => resize();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, [resize]);

    // --- Load background signature -----------------------------------------
    React.useEffect(() => {
      if (!initialSignatureFile || !userId) return;
      let cancelled = false;
      let objectUrl: string | null = null;
      (async () => {
        try {
          const blob = await api.fetchSignatureBlob(userId, initialSignatureFile);
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            if (cancelled) return;
            backgroundImgRef.current = img;
            setHasBackground(true);
            redraw();
          };
          img.onerror = () => setLoadError('Failed to render saved signature');
          img.src = objectUrl;
        } catch {
          if (!cancelled) setLoadError('Failed to load saved signature');
        }
      })();
      return () => {
        cancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }, [initialSignatureFile, userId, redraw]);

    // --- Pointer handling --------------------------------------------------
    const getPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      currentLineRef.current = [getPoint(e)];
      redraw();
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (currentLineRef.current.length === 0) return;
      currentLineRef.current.push(getPoint(e));
      redraw();
    };

    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      try {
        (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore — not every browser supports capture release mid-chain */
      }
      if (currentLineRef.current.length > 0) {
        linesRef.current.push(currentLineRef.current);
        currentLineRef.current = [];
        setHasStrokes(true);
      }
      redraw();
    };

    // --- Imperative handle -------------------------------------------------
    React.useImperativeHandle(
      ref,
      () => ({
        async getBlob() {
          const canvas = canvasRef.current;
          if (!canvas) return null;
          if (!hasStrokes && !hasBackground) return null;
          return new Promise<Blob | null>((resolve) => {
            canvas.toBlob((blob) => resolve(blob), 'image/png');
          });
        },
        clear() {
          linesRef.current = [];
          currentLineRef.current = [];
          backgroundImgRef.current = null;
          setHasStrokes(false);
          setHasBackground(false);
          redraw();
        },
        hasContent() {
          return hasStrokes || hasBackground;
        },
      }),
      [hasStrokes, hasBackground, redraw]
    );

    const hasAny = hasStrokes || hasBackground;

    return (
      <div className="flex flex-col gap-2">
        <div
          className="relative w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-white"
          style={{ height }}
        >
          {!hasAny ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="text-[13px] text-[var(--color-text-tertiary)]/80">Sign here</span>
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full touch-none"
            style={{ touchAction: 'none' }}
            aria-label="Signature capture area"
            role="img"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>
        <div className="flex items-center justify-between text-[12px]">
          {loadError ? (
            <span className="text-[var(--color-status-failed)]">{loadError}</span>
          ) : (
            <span className="text-[var(--color-text-tertiary)]">
              Draw your signature above — it will be saved when you save the profile.
            </span>
          )}
          {hasAny ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                linesRef.current = [];
                currentLineRef.current = [];
                backgroundImgRef.current = null;
                setHasStrokes(false);
                setHasBackground(false);
                redraw();
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
);
