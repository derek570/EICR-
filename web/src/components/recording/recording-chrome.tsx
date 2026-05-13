'use client';

import * as React from 'react';
import {
  Camera,
  Check,
  FileText,
  MessageSquare,
  Mic,
  MicOff,
  Pause,
  Play,
  Settings2,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useRecording, formatCost, formatElapsed } from '@/lib/recording-context';
import { useJobContext } from '@/lib/job-context';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Image as ImageIcon } from 'lucide-react';
import {
  getConfirmationModeEnabled,
  isTtsAvailable,
  setConfirmationModeEnabled,
  speakConfirmation,
} from '@/lib/recording/tts';
import { applyPresetToJob } from '@/lib/defaults/service';
import { ApplyDefaultsSheet } from '@/components/defaults/apply-defaults-sheet';
import { VadIndicator } from './vad-indicator';
import { ProcessingBadge } from './processing-badge';
import { PendingDataBanner } from './pending-data-banner';
import { AlertCard } from './alert-card';

/**
 * Recording chrome — in-page indicator + control surface that renders
 * over the live tab content while a recording session is running.
 *
 * Replaces the previous Dialog-based <RecordingOverlay>. The user wanted
 * the page (Overview tab with hero boxes, circuits, observations) to
 * stay visible during recording, with a red pulsing ring around the
 * viewport instead of a separate page or modal.
 *
 * Three pieces:
 *   1. <RecordingRing>     — fixed full-viewport breathing red border
 *   2. <TranscriptBar>     — top transcript pill (lives in transcript-bar.tsx
 *                            and is mounted by job/[id]/layout.tsx)
 *   3. <RecordingActionBar> — fixed bottom bar with state pill, mic-level
 *                            VU meter, iOS-parity action buttons + Pause/End
 *
 * The chrome only renders when state !== 'idle'. The idle Mic FAB
 * (FloatingActionBar) stays visible whenever the chrome is hidden, so
 * the inspector always has a way to start a session.
 */
export function RecordingChrome() {
  const { state } = useRecording();
  if (state === 'idle') return null;
  return (
    <>
      <RecordingRing state={state} />
      <RecordingActionBar />
    </>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Pulsing border around the entire viewport. Pointer-events:none so it
 * never steals taps from the live form underneath. Z-index sits above
 * the action bar's chrome but below modal/toast layers — the inspector
 * can still open a sheet while recording without the ring obscuring it.
 *
 * Colour shifts with the recording state so paused/sleeping reads as a
 * different mode without a separate component.
 */
function RecordingRing({ state }: { state: ReturnType<typeof useRecording>['state'] }) {
  const colour =
    state === 'error'
      ? 'var(--color-status-failed)'
      : state === 'sleeping'
        ? 'var(--color-status-limitation)'
        : state === 'requesting-mic'
          ? 'var(--color-status-processing)'
          : 'var(--color-status-failed)';
  return (
    <div
      aria-hidden
      className="cm-rec-ring pointer-events-none fixed inset-0 z-40"
      style={
        {
          '--rec-ring-color': colour,
        } as React.CSSProperties
      }
    />
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Bottom action bar — fixed at the foot of the viewport while recording.
 * Layout left-to-right:
 *
 *   [state pill | timer | cost]   [VU meter]   [Voice Defaults Apply CCU Doc Obs]   [End | Pause/Resume]
 *
 * The iOS-parity button cluster maps to web handlers where they exist:
 *   • CCU  → /circuits  (CCUPhotoCard already wires GPT Vision pipeline)
 *   • Doc  → /circuits  (DocumentCard already wires /api/analyze-document)
 *   • Obs  → /observations
 * Voice / Defaults / Apply are visual-only for now (iOS-only handlers
 * per the floating-action-bar.tsx history note); rendered as disabled
 * with an explanatory aria-label rather than non-functional buttons.
 */
function RecordingActionBar() {
  const {
    state,
    micLevel,
    elapsedSec,
    costUsd,
    errorMessage,
    processingCount,
    pendingReadings,
    questions,
    dismissQuestion,
    acceptQuestion,
    rejectQuestion,
    stop,
    pause,
    resume,
    captureObservationPhoto,
  } = useRecording();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const jobId = params?.id;

  const isActive = state === 'active';
  const isPaused = state === 'sleeping';

  // Confirmation-mode toggle — localStorage-persisted via the TTS
  // helper. Mirrors iOS `confirmationModeEnabled` (RecordingOverlay.
  // swift:74). The pill stays visually labelled "Voice" / "Muted" for
  // parity with iOS where the on-screen label is the same misnomer
  // ("Voice"); the aria-label below makes its actual scope explicit.
  // Initialised from storage on mount so the button reflects the
  // inspector's last choice. SSR renders as `false`; we hydrate after
  // mount to avoid localStorage access during render.
  const [voiceFeedbackOn, setVoiceFeedbackOn] = React.useState(false);
  const [ttsSupported, setTtsSupported] = React.useState(true);
  React.useEffect(() => {
    setVoiceFeedbackOn(getConfirmationModeEnabled());
    setTtsSupported(isTtsAvailable());
  }, []);
  const toggleVoiceFeedback = React.useCallback(() => {
    const next = !voiceFeedbackOn;
    setConfirmationModeEnabled(next);
    setVoiceFeedbackOn(next);
    // One-shot audible preview so the inspector gets immediate
    // feedback that the toggle works. `force: true` bypasses the
    // enabled check for the OFF→ON transition; on ON→OFF we stay
    // silent — speaking "confirmations off" would be jarring and
    // contradicts the preference just set.
    if (next) speakConfirmation('Confirmations on.', { force: true });
  }, [voiceFeedbackOn]);

  // End-session confirmation — iOS presents a parent-owned alert
  // ("End this recording session?") on the stop button. The web chrome
  // previously skipped the confirm; the parity ledger flags this as a
  // partial match. Wrap End behind a <ConfirmDialog>.
  const [endConfirmOpen, setEndConfirmOpen] = React.useState(false);
  const openEndConfirm = React.useCallback(() => setEndConfirmOpen(true), []);
  const confirmEnd = React.useCallback(() => {
    setEndConfirmOpen(false);
    stop();
  }, [stop]);

  const goToTab = React.useCallback(
    (slug: string) => {
      if (!jobId) return;
      router.push(`/job/${jobId}${slug}`);
    },
    [router, jobId]
  );

  // L2 obs-photo sprint (2026-05-13) — recording-time Photo capture.
  // The chooser sheet matches the iOS pattern at PhotoCaptureView.swift
  // (a SwiftUI `.fullScreenCover(item: $activePhotoMode)` with
  // Camera / Library cases). On PWA we drive the choice through two
  // hidden file inputs: the camera input uses `capture=environment`
  // to request the rear camera on iPad/iPhone Safari, while the
  // library input omits `capture` so the inspector gets the photos
  // app picker. Both fire `captureObservationPhoto` from the
  // recording context on change — see Phase 4 for the upload + auto-
  // link state machine.
  const [photoChooserOpen, setPhotoChooserOpen] = React.useState(false);
  const cameraInputRef = React.useRef<HTMLInputElement>(null);
  const libraryInputRef = React.useRef<HTMLInputElement>(null);
  const handlePhotoChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input value so picking the SAME file twice in a row
      // still fires onChange. Without this, iOS Safari's picker is a
      // no-op on re-select.
      event.target.value = '';
      if (!file) return;
      void captureObservationPhoto(file);
    },
    [captureObservationPhoto]
  );
  const openCamera = React.useCallback(() => {
    setPhotoChooserOpen(false);
    // Defer the click so the dialog's close animation doesn't race
    // with the iOS Safari camera prompt — a synchronous click during
    // dismiss can be silently swallowed.
    requestAnimationFrame(() => cameraInputRef.current?.click());
  }, []);
  const openLibrary = React.useCallback(() => {
    setPhotoChooserOpen(false);
    requestAnimationFrame(() => libraryInputRef.current?.click());
  }, []);

  // Defaults / Apply — Phase B (2026-05-03) port of iOS
  // RecordingOverlay.swift handlers. iOS shows the Defaults manager
  // and the preset picker as full-screen sheets. The PWA opens the
  // Apply sheet inline so recording stays live; "Defaults" navigates
  // to /settings/defaults — the inspector rarely edits presets while
  // recording, and pausing first via the Pause button is one tap.
  const { job, updateJob } = useJobContext();
  const [applyOpen, setApplyOpen] = React.useState(false);
  const onOpenDefaults = React.useCallback(() => {
    router.push('/settings/defaults');
  }, [router]);
  const onOpenApply = React.useCallback(() => setApplyOpen(true), []);

  return (
    <>
      {/* Badges + alert card float above the action bar so they survive
          landscape reorientation without colliding with the pill cluster.
          Kept pointer-events:auto on the AlertCard itself via the inner
          wrapper; the outer flex is pointer-events:none so taps pass
          through to the page. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[96px] z-40 flex flex-col items-center gap-2 px-3 md:bottom-[104px]">
        <div className="flex items-center gap-2">
          <ProcessingBadge count={processingCount} />
          <PendingDataBanner count={pendingReadings} />
        </div>
        {questions.length > 0 ? (
          <AlertCard
            questions={questions}
            onDismiss={dismissQuestion}
            onAccept={acceptQuestion}
            onReject={rejectQuestion}
          />
        ) : null}
      </div>

      <div
        role="toolbar"
        aria-label="Recording controls"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-2 pb-2 md:px-3 md:pb-4"
      >
        <div className="pointer-events-auto flex w-full max-w-[1100px] flex-row flex-wrap items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)]/95 px-2 py-1.5 shadow-[0_-12px_48px_rgba(0,0,0,0.55)] backdrop-blur-md md:flex-nowrap md:gap-3 md:rounded-[var(--radius-xl)] md:px-4 md:py-2.5">
          {/* ── Left: state pill + VAD dot + timer ──────────────────
              Phone portrait (iOS canon): keep this cluster compact —
              just status indicator + timer. Cost readout is iPad+ only
              so it doesn't crowd the small screen. */}
          <div className="flex items-center gap-1.5 md:gap-2.5">
            <StatePill state={state} />
            <VadIndicator state={state} />
            <span className="font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)] md:text-[15px]">
              {formatElapsed(elapsedSec)}
            </span>
            <span className="hidden text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)] md:inline">
              {formatCost(costUsd)}
            </span>
          </div>

          {/* ── Centre: VU meter (tablet+ only) ─────────────────────── */}
          <div className="hidden flex-1 md:block">
            <VuMeter level={micLevel} active={isActive} />
          </div>

          {/* ── Right: iOS-parity buttons + Pause/End ─────────────────
              iPhone portrait now mirrors iOS landscape (per inspector
              field-test feedback): inline Voice (TTS toggle), CCU, Doc,
              End, Pause. Defaults/Apply/Obs stay tablet-only because
              they open full-page sheets that are awkward mid-recording
              on phone (the inspector can pause and tap them on the
              installation tab instead). */}
          <div className="ml-auto flex items-center justify-end gap-1 md:gap-2">
            {ttsSupported ? (
              <ParityButton
                label={voiceFeedbackOn ? 'Voice' : 'Muted'}
                tone={voiceFeedbackOn ? 'green' : 'muted'}
                icon={voiceFeedbackOn ? Volume2 : VolumeX}
                onClick={toggleVoiceFeedback}
                ariaPressed={voiceFeedbackOn}
                ariaLabel={
                  voiceFeedbackOn
                    ? 'Disable spoken reading confirmations'
                    : 'Enable spoken reading confirmations'
                }
              />
            ) : null}
            {/* Defaults / Apply — tablet+ only, see comment above. */}
            <div className="hidden md:contents">
              <ParityButton
                label="Defaults"
                tone="violet"
                icon={Settings2}
                onClick={onOpenDefaults}
              />
              <ParityButton label="Apply" tone="green" icon={Check} onClick={onOpenApply} />
            </div>
            {/* CCU + Doc — always visible; primary mid-recording entry
                points for photo/document capture. */}
            <ParityButton
              label="CCU"
              tone="orange"
              icon={Camera}
              onClick={() => goToTab('/circuits')}
            />
            <ParityButton
              label="Doc"
              tone="cyan"
              icon={FileText}
              onClick={() => goToTab('/circuits')}
            />
            {/* Photo — L2 obs-photo sprint (2026-05-13). Always visible
                so a 360 px viewport still has it; iOS canon also keeps
                this button always-on while recording. Disabled when the
                state isn't active so a stray tap during requesting-mic
                doesn't open the chooser before the mic stream is up.
                Tap → chooser sheet with Camera / Library options
                (decision 0.6). */}
            <ParityButton
              label="Photo"
              tone="blue"
              icon={Camera}
              onClick={() => setPhotoChooserOpen(true)}
              disabled={!isActive}
              disabledReason="not recording"
              ariaLabel="Capture observation photo"
            />
            {/* Obs — tablet+ only, see comment above. */}
            <div className="hidden md:contents">
              <ParityButton
                label="Obs"
                tone="blue"
                icon={MessageSquare}
                onClick={() => goToTab('/observations')}
              />
            </div>

            {/* End — gated behind a confirm dialog so a stray tap on
                the bottom bar can't nuke an in-progress recording. */}
            <CircleButton
              label="End"
              icon={Square}
              onClick={openEndConfirm}
              background="var(--color-status-failed)"
            />
            {/* Pause / Resume — pause is greyed during requesting-mic so
                double-tapping mid-permission doesn't race the state
                machine; resume only enables from dozing/sleeping. */}
            {isPaused ? (
              <CircleButton
                label="Resume"
                icon={Play}
                onClick={resume}
                background="var(--color-brand-green)"
              />
            ) : (
              <CircleButton
                label="Pause"
                icon={Pause}
                onClick={pause}
                background="var(--color-status-processing)"
                disabled={!isActive}
              />
            )}
          </div>

          {errorMessage ? (
            <p
              role="alert"
              className="basis-full text-[12px] font-medium text-[var(--color-status-failed)]"
            >
              {errorMessage}
            </p>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={endConfirmOpen}
        onOpenChange={setEndConfirmOpen}
        title="End this recording session?"
        description="Any audio captured so far will be saved. You can start a new session afterwards."
        confirmLabel="End session"
        cancelLabel="Keep recording"
        destructive
        onConfirm={confirmEnd}
      />

      {/* Apply preset to job — Phase B (2026-05-03). Mirrors iOS
          ApplyDefaultsSheet.swift. The applier is non-destructive
          (only-fill-empty) so tapping Apply mid-job never overwrites
          a value the inspector typed; it only fills the holes. */}
      <ApplyDefaultsSheet
        open={applyOpen}
        certificateType={job.certificate_type ?? 'EICR'}
        onClose={() => setApplyOpen(false)}
        onApply={(preset) => {
          const patch = applyPresetToJob(preset, job);
          if (Object.keys(patch).length > 0) {
            updateJob(patch);
          }
        }}
      />

      {/* L2 obs-photo sprint (2026-05-13) — hidden file inputs.
          `capture="environment"` requests the rear camera on iPad/
          iPhone Safari (Apple's docs note iOS 17+ honours this
          reliably; older iPadOS falls back to a picker — same UX as
          the Library button below, just one tap wasted). The
          Library input intentionally omits `capture` so iOS surfaces
          the photo library picker. Both fire `handlePhotoChange`
          which delegates to `captureObservationPhoto` from the
          recording context (Phase 4 state machine). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handlePhotoChange}
        className="hidden"
        aria-hidden
        tabIndex={-1}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        onChange={handlePhotoChange}
        className="hidden"
        aria-hidden
        tabIndex={-1}
      />

      {/* Camera-vs-Library chooser. Matches iOS PhotoCaptureView's
          `.fullScreenCover(item: $activePhotoMode)` chooser
          (PhotoCaptureView.swift:32-186). Two tap targets only —
          inspector mid-recording doesn't want a settings page, just
          a fast pick. */}
      <Dialog open={photoChooserOpen} onOpenChange={setPhotoChooserOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>Add observation photo</DialogTitle>
          <DialogDescription>
            Capture a photo of the issue or pick one from your library. The photo links to the
            nearest observation automatically.
          </DialogDescription>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={openCamera}
              className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-5 text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <Camera className="h-8 w-8" strokeWidth={1.75} aria-hidden />
              <span className="text-sm font-semibold">Camera</span>
            </button>
            <button
              type="button"
              onClick={openLibrary}
              className="flex flex-col items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-5 text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-blue)]"
            >
              <ImageIcon className="h-8 w-8" strokeWidth={1.75} aria-hidden />
              <span className="text-sm font-semibold">Library</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ----------------------------------------------------------------------- */

function StatePill({ state }: { state: ReturnType<typeof useRecording>['state'] }) {
  const { label, colour, Icon } = React.useMemo(() => {
    switch (state) {
      case 'requesting-mic':
        return { label: 'Requesting mic', colour: 'var(--color-status-processing)', Icon: Mic };
      case 'active':
        return { label: 'Listening', colour: 'var(--color-brand-green)', Icon: Mic };
      case 'sleeping':
        return { label: 'Paused', colour: 'var(--color-status-limitation)', Icon: MicOff };
      case 'error':
        return { label: 'Error', colour: 'var(--color-status-failed)', Icon: MicOff };
      default:
        return { label: 'Idle', colour: 'var(--color-text-tertiary)', Icon: Mic };
    }
  }, [state]);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-white"
      style={{ background: colour }}
    >
      <span aria-hidden className="cm-pulse-dot h-1.5 w-1.5 rounded-full bg-white" />
      <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      {label}
    </span>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Mic-level VU meter — 24 vertical bars spread across the available
 * width, lit from the centre out as `level` rises. Driven directly off
 * `micLevel` (0..1) which the recording context throttles to ~60Hz off
 * the AudioWorklet RMS — fast enough to feel live, slow enough that
 * React renders don't choke.
 *
 * Bars are pre-allocated; their height is the only thing that changes
 * frame-to-frame, which keeps the diff trivial and the GPU off the
 * critical path.
 */
function VuMeter({ level, active }: { level: number; active: boolean }) {
  const bars = 24;
  const peak = Math.min(1, Math.max(0, level));
  return (
    <div aria-hidden className="flex h-9 w-full items-end justify-center gap-[3px] px-2 opacity-90">
      {Array.from({ length: bars }, (_, i) => {
        // Symmetric around the centre — peak at i === bars/2.
        const distFromCentre = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2);
        const idleHeight = 0.18 + 0.12 * (1 - distFromCentre);
        const liveHeight = active
          ? Math.max(idleHeight, peak * (1 - distFromCentre * 0.55))
          : idleHeight;
        return (
          <span
            key={i}
            className="w-[3px] rounded-full transition-[height] duration-100 ease-out"
            style={{
              height: `${Math.max(8, Math.round(liveHeight * 100))}%`,
              background: active ? 'var(--color-brand-green)' : 'var(--color-text-tertiary)',
              opacity: active ? 0.85 : 0.55,
            }}
          />
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

type ButtonTone = 'muted' | 'violet' | 'green' | 'orange' | 'cyan' | 'blue';

const TONE_BG: Record<ButtonTone, string> = {
  muted: 'rgba(255,255,255,0.10)',
  violet: '#a855f7',
  green: 'var(--color-brand-green)',
  orange: '#ff9f0a',
  cyan: '#22d3ee',
  blue: 'var(--color-brand-blue)',
};

/**
 * iOS-parity round button — small (40×40) coloured pill with an icon
 * and a label below, matching the iOS reference shot. Disabled buttons
 * still show their colour at reduced opacity so the layout stays
 * consistent between platforms; the `aria-label` is the source of truth
 * for screen readers.
 */
function ParityButton({
  label,
  tone,
  icon: Icon,
  onClick,
  disabled,
  disabledReason,
  ariaPressed,
  ariaLabel,
}: {
  label: string;
  tone: ButtonTone;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  /** When present, adds `aria-pressed` to the button — used for toggles
   *  (e.g. the Voice button) so screen readers can announce the state. */
  ariaPressed?: boolean;
  /** Override aria-label when the visible `label` is a friendly short
   *  form (e.g. "Voice") whose actual scope ("toggle reading
   *  confirmations") needs spelling out for assistive tech. */
  ariaLabel?: string;
}) {
  const resolvedLabel =
    ariaLabel ?? (disabled && disabledReason ? `${label} (${disabledReason})` : label);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={ariaPressed}
      aria-label={resolvedLabel}
      className={cn(
        'flex shrink-0 flex-col items-center gap-0.5 rounded-2xl px-1 py-1 text-white transition active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:px-2 md:py-1.5',
        disabled && 'cursor-not-allowed opacity-45'
      )}
    >
      <span
        className="flex h-8 w-8 items-center justify-center rounded-full shadow-[0_2px_10px_rgba(0,0,0,0.35)] md:h-9 md:w-9"
        style={{ background: TONE_BG[tone] }}
      >
        <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
      </span>
      {/* Label hidden on phone (icons are recognizable + the bar must
          fit five buttons + the status cluster on a 375 px screen).
          Icon-only on phone matches the iOS portrait bar density. */}
      <span className="hidden text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--color-text-secondary)] md:block">
        {label}
      </span>
    </button>
  );
}

/**
 * Larger control button (44×44) for End / Pause / Resume — the controls
 * the inspector reaches for most often. Bigger hit area, no label
 * underneath; the icon does the work.
 */
function CircleButton({
  label,
  icon: Icon,
  onClick,
  background,
  disabled,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  onClick: () => void;
  background: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white shadow-[0_4px_14px_rgba(0,0,0,0.45)] transition active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white',
        disabled && 'cursor-not-allowed opacity-45'
      )}
      style={{ background }}
    >
      <Icon className="h-4 w-4" strokeWidth={2.5} aria-hidden />
    </button>
  );
}
