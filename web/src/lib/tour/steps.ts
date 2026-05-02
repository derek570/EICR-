/**
 * Tour step definitions — port of iOS
 * `CertMateUnified/Sources/Services/TourManager.swift`.
 *
 * Two phases:
 *   1. **Dashboard** (2 steps): home overview + defaults explanation,
 *      narrated on `/dashboard` first-run.
 *   2. **Job** (8 steps): overview / CCU photo tip / how to give
 *      readings / multi-circuit shortcut / voice + observations / obs
 *      photo + reminder / voice queries + commands / PDF generation,
 *      narrated when the inspector lands on a job-detail screen.
 *
 * Narration strings are copied verbatim from iOS so future iOS edits
 * port mechanically — keep the wording and the comment markers in sync.
 *
 * Each step carries:
 *   - `id` — stable slug, used as the localStorage / IDB key for
 *     "have I seen this step?" and as the TTS cache key.
 *   - `selector` — CSS selector resolved via `document.querySelector`
 *     when the highlight mounts. If the target isn't present (the user
 *     navigated away mid-tour), the overlay degrades to a centred tip
 *     with no spotlight.
 *   - `title` — short heading for the popover card.
 *   - `body` — short copy for the popover (paragraph-form). When the
 *     tour speaks, this is the displayed-while-narrating text.
 *   - `narration` — full TTS narration text. iOS canon. Falls back to
 *     `body` if the runtime doesn't expose SpeechSynthesis.
 *   - `placement` — where the tip should float relative to the
 *     target. Defaults to `'bottom'`.
 *   - `tabSlug` — for job-tour steps only, the path slug (relative to
 *     `/job/[id]`) the controller should navigate to before showing
 *     this step. iOS uses a tab index; on web we navigate paths.
 *
 * Selectors rely on `data-tour` attributes injected on the dashboard
 * + job-detail screens. Using data attributes (not ids/classNames)
 * keeps the tour decoupled from visual classes so refactors don't
 * silently break the walkthrough.
 */

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'center';

export interface TourStep {
  id: string;
  selector: string | null;
  title: string;
  body: string;
  /** Full TTS narration — iOS canon. Phase D (2026-05-03). */
  narration?: string;
  placement?: TourPlacement;
  /** For job-tour steps: the slug under `/job/[id]` to navigate to
   *  before showing the step (e.g. '' for Overview, '/pdf' for PDF). */
  tabSlug?: string;
}

/**
 * Dashboard tour — 2 steps. iOS canon narrations preserved verbatim.
 * The shorter `body` is what the popover shows; `narration` is the
 * longer text for TTS. Web Speech API speaks the narration in the
 * user's selected voice on the OS — quality varies by browser, so the
 * body remains visible as a fallback / for accessibility.
 */
export const DASHBOARD_TOUR_STEPS: readonly TourStep[] = Object.freeze([
  {
    id: 'home',
    selector: '[data-tour="hero"]',
    title: 'Welcome to CertMate',
    body: 'This is the home screen — start a new job, find past jobs, or open Defaults / Company / Staff to set up your account.',
    narration:
      'Welcome to CertMate. This is the home screen, where you can start a new job and find your past jobs. From here you can set default values that will appear automatically in every certificate, configure default cable sizes for circuits, add your company details, and manage your staff profiles.',
    placement: 'bottom',
  },
  {
    id: 'defaults',
    selector: '[data-tour="setup-tools"]',
    title: 'Set up your defaults',
    body: 'Set the values that stay the same across most inspections — supply type, earthing, default cable sizes for each circuit type — so they auto-fill on every new certificate.',
    narration:
      "This is where you set your default values — things like supply type, earthing arrangement, installation age, and other details that stay the same across most of your inspections. You can also set default cable sizes for different circuit types — for example, two point five mil twin and earth for ring finals, one point five mil for lighting, and six mil for cookers. These will automatically fill in when you start a new certificate. Note that cable sizes are limited by the OCPD rating — a six amp MCB with one mil cable is fine for lighting, but a thirty two amp ring final needs two point five mil minimum. I'd recommend setting these up before starting your first job.",
    placement: 'top',
  },
]);

/**
 * Job-detail tour — 8 steps. iOS canon narrations preserved verbatim
 * from `TourManager.jobSteps`. Steps 1-7 land on Overview; step 8
 * navigates to the PDF tab.
 */
export const JOB_TOUR_STEPS: readonly TourStep[] = Object.freeze([
  {
    id: 'job-overview',
    selector: '[data-tour="transcript-bar"]',
    title: 'Getting started',
    body: 'Most screens work best in landscape. Talk naturally and the form fills in. The transcript bar at the top shows what you said, live.',
    narration:
      "Once you start a job, this is where you'll land. Most screens work best in landscape, so turn your device sideways. Talk naturally and clearly, and the form will start filling in with what you've spoken. You can see everything you're saying live in the transcript bar at the top.",
    placement: 'bottom',
    tabSlug: '',
  },
  {
    id: 'job-ccu',
    selector: '[data-tour="ccu-button"]',
    title: 'Take a CCU photo first',
    body: 'Tap the orange CCU button to photograph the consumer unit before recording — circuits and BS numbers get captured automatically. RCD types may need clarification.',
    narration:
      'It works best if you take a photo of the consumer unit using the orange CCU button before you start, so I can capture the circuit names and BS numbers. RCD types can be tricky because the symbols are very small — I may ask you for clarification on those.',
    placement: 'top',
    tabSlug: '',
  },
  {
    id: 'job-readings',
    selector: '[data-tour="circuits-table"]',
    title: 'How to give readings',
    body: 'Say which circuit and which test, then the value. e.g. "Circuit four, insulation resistance, live to earth, greater than 999 megaohms." AirPods help.',
    narration:
      "Before giving a reading, say which circuit it relates to, either by name or number, and which test it is. For example: 'Circuit four, insulation resistance, live to earth, greater than nine nine nine megger ohms.' If I didn't hear you clearly, I may ask follow-up questions. Using AirPods helps a lot with audio clarity.",
    placement: 'top',
    tabSlug: '',
  },
  {
    id: 'job-multi',
    selector: '[data-tour="circuits-table"]',
    title: 'Multi-circuit shortcut',
    body: 'Apply the same value across many circuits in one phrase: "RCD trip time for circuits one to five is 25 milliseconds."',
    narration:
      "You can also set the same value for multiple circuits at once. For example, say 'RCD trip time for circuits one to five is twenty five milliseconds' and I'll fill in all five circuits in one go. This works for any test result or circuit field.",
    placement: 'top',
    tabSlug: '',
  },
  {
    id: 'job-voice',
    selector: '[data-tour="voice-button"]',
    title: 'Voice confirmations & observations',
    body: 'Press Voice to hear confirmations read back. Say "observation" to log a finding — code, regulation, and schedule item are filled in automatically.',
    narration:
      "If you'd like me to read back confirmations, press the voice button. To make an observation, just say 'observation' and I'll write up what you say in the Observations tab — assigning the appropriate code, regulation reference, and schedule location if you haven't specified them. These can easily be changed in the Observations tab afterwards.",
    placement: 'top',
    tabSlug: '',
  },
  {
    id: 'job-obs-photo',
    selector: '[data-tour="obs-button"]',
    title: 'Photos for observations',
    body: 'Tap Obs to attach a photo to your last spoken observation (within ~1 minute). Always check readings before sending — I can make mistakes.',
    narration:
      "You can also take a photo using the Obs button at the bottom of the screen — as long as it's taken within one minute of a spoken observation, the photo will be automatically attached to that observation in the Observations tab. Please remember that I can make mistakes — always check all readings and observations before sending.",
    placement: 'top',
    tabSlug: '',
  },
  {
    id: 'job-queries',
    selector: '[data-tour="transcript-bar"]',
    title: 'Voice queries & commands',
    body: 'Ask "what\'s the Zs for circuit three?" or say "move circuits 7 and 8 to positions 2 and 3" or "calculate Zs for all circuits" — I\'ll handle it hands-free.',
    narration:
      "You can also ask me questions or give me commands while you're recording. For example, just say 'move circuits seven and eight to positions two and three' — and I'll rearrange them for you. Or ask 'what's the Zs for circuit three?' and I'll read the value back. You can say things like 'add a new circuit called immersion heater'. If you'd like the Zs values calculating or the R1+R2 values calculating for a circuit or for all circuits, just ask. I'll confirm what I've done so you can keep working hands-free.",
    placement: 'top',
    tabSlug: '',
  },
  {
    id: 'job-pdf',
    selector: '[data-tour="generate-pdf"]',
    title: 'Generate the certificate',
    body: 'Preview and generate the PDF here. Always check it thoroughly before sending. Tour complete — you can replay it any time from Dashboard or /settings/about.',
    narration:
      "This is where you can preview and generate a PDF of your completed certificate. Please check it thoroughly before sending to your client. That's the tour complete — you're ready to start your first job. If you don't want to hear this again, please hit the Guided Tour button on the homepage to turn it off.",
    placement: 'top',
    tabSlug: '/pdf',
  },
]);

export const DASHBOARD_TOUR_TOTAL = DASHBOARD_TOUR_STEPS.length;
export const JOB_TOUR_TOTAL = JOB_TOUR_STEPS.length;
/** Total step count across both phases — used by the iOS-canon
 *  "Step N of M" progress label. */
export const OVERALL_TOUR_TOTAL = DASHBOARD_TOUR_TOTAL + JOB_TOUR_TOTAL;
