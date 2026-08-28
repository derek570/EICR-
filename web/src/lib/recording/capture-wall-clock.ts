/**
 * PLAN-E-TERM — the session's PIECEWISE capture-sample → wall-clock map.
 *
 * The loss ledger tracks CAPTURE-domain sample ranges only (16 kHz, one
 * shared clock per recording session). Captured sample time is NOT
 * continuous wall time: the capture clock stands still through a pause,
 * an interruption, and the TTS-excluded interval (the mic tap early-
 * returns while a clip plays), so a single session-start anchor would put
 * a reading lost after a ten-minute pause near the PRE-pause time and send
 * the inspector to the wrong window (split-round-9). This map records a
 * fresh anchor at session start AND at every capture discontinuity, and a
 * lost range derives its window through the piece containing it.
 *
 * Discontinuities are DETECTED from the data rather than declared by each
 * edit site: every captured segment carries its start sample and its
 * ingress wall-clock; when the wall-clock diverges from the sample-
 * extrapolated time by more than `toleranceMs`, capture was discontinuous
 * and a new anchor starts a new piece. Any pause/interruption/TTS gap of
 * any kind — including ones no edit site names — is covered.
 *
 * Swift twin: `CaptureWallClock.swift`.
 */

import { UPLINK_SAMPLE_RATE_HZ } from './sample-offset';

export interface CaptureWallAnchor {
  /** Capture-domain sample offset at which this piece starts. */
  readonly sampleOffset: number;
  /** Wall-clock epoch ms at that sample. */
  readonly wallMs: number;
}

export interface WallClockWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/** Larger than any scheduler jitter between mic callbacks (~128–4096
 *  sample blocks = 8–256 ms), smaller than any real pause. */
export const CAPTURE_WALL_CLOCK_TOLERANCE_MS = 250;

export class CaptureWallClock {
  private readonly anchors: CaptureWallAnchor[] = [];

  constructor(private readonly toleranceMs: number = CAPTURE_WALL_CLOCK_TOLERANCE_MS) {}

  /**
   * Observe one captured segment: its start sample and the wall-clock at
   * ingress. Returns true iff a NEW anchor was recorded (the first
   * observation, or a discontinuity).
   */
  observe(sampleOffset: number, wallMs: number): boolean {
    if (!Number.isFinite(sampleOffset) || !Number.isFinite(wallMs)) return false;
    const last = this.anchors[this.anchors.length - 1];
    if (!last) {
      this.forceNextAnchor = false;
      this.anchors.push({ sampleOffset, wallMs });
      return true;
    }
    if (sampleOffset < last.sampleOffset) return false; // never rewinds
    const expected =
      last.wallMs + ((sampleOffset - last.sampleOffset) * 1000) / UPLINK_SAMPLE_RATE_HZ;
    if (!this.forceNextAnchor && Math.abs(wallMs - expected) <= this.toleranceMs) return false;
    this.forceNextAnchor = false;
    this.anchors.push({ sampleOffset, wallMs });
    return true;
  }

  /**
   * A DECLARED discontinuity (pause/resume, interruption end, TTS-exclusion
   * release): the NEXT observation starts a new piece unconditionally, even
   * when the gap is inside the jitter tolerance. Detection covers every
   * gap the tolerance can see; this covers the named seams below it
   * (Codex E-TERM cycle-1).
   */
  markDiscontinuity(): void {
    this.forceNextAnchor = true;
  }

  private forceNextAnchor = false;

  /** Wall-clock epoch ms for a capture-domain sample, through the piece
   *  containing it. `null` before any anchor exists. */
  wallMsAt(sampleOffset: number): number | null {
    if (this.anchors.length === 0) return null;
    let piece = this.anchors[0];
    for (const a of this.anchors) {
      if (a.sampleOffset <= sampleOffset) piece = a;
      else break;
    }
    return piece.wallMs + ((sampleOffset - piece.sampleOffset) * 1000) / UPLINK_SAMPLE_RATE_HZ;
  }

  /** The wall-clock window of a half-open capture range `[start, end)`.
   *  Each bound resolves through its OWN piece, so a range straddling a
   *  discontinuity spans the real gap. */
  windowOf(range: { readonly start: number; readonly end: number }): WallClockWindow | null {
    const startMs = this.wallMsAt(range.start);
    if (startMs === null) return null;
    if (range.end <= range.start) return { startMs, endMs: startMs };
    // The EXCLUSIVE end resolves through the piece containing the range's
    // LAST sample (+ one sample), so a range ending exactly at a forced
    // anchor never swallows the gap that follows it (Codex mini-review).
    const lastMs = this.wallMsAt(range.end - 1);
    if (lastMs === null) return null;
    const endMs = lastMs + 1000 / UPLINK_SAMPLE_RATE_HZ;
    return { startMs, endMs: Math.max(startMs, endMs) };
  }

  get anchorCount(): number {
    return this.anchors.length;
  }

  /** Read-only snapshot for tests / diagnostics. */
  get pieces(): readonly CaptureWallAnchor[] {
    return this.anchors;
  }
}
