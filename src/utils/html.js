/**
 * Text processing utilities for transcription pipeline
 */

/**
 * Strip markdown artefacts from transcription output.
 */
export function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // **bold**
    .replace(/^#{1,6}\s+/gm, "")             // # headers
    .replace(/^[-*]\s+/gm, "")               // - bullets / * bullets
    .replace(/\[(\d{1,2}:\d{2})\]/g, "")     // [MM:SS] timestamps
    .replace(/^(RAW_TRANSCRIPT|TEST_VALUES|PHOTO_MOMENTS):?\s*/gim, "")  // section names
    .replace(/\n{3,}/g, "\n\n")              // collapse excess newlines
    .trim();
}

/**
 * Detect if a transcript is just Gemini describing silence/background noise
 * rather than actual speech.
 */
export function isNoSpeechDescription(text) {
  if (!text || text.trim().length === 0) return false;

  const lower = text.toLowerCase();

  const NOISE_PATTERNS = [
    /no speech/i,
    /does not contain any speech/i,
    /contains only background/i,
    /no spoken words/i,
    /no audible speech/i,
    /there is no.*speech/i,
    /no discernible speech/i,
    /only.*background\s*(noise|sounds?|audio)/i,
    /silence|silent.*audio/i,
    /no.*vocal.*content/i,
    /^\[?sound of\b/i,
    /^\[?sounds? of\b/i,
    /^\[?noise of\b/i,
    /^\[?knocking\b/i,
    /^\[?tapping\b/i,
    /^\[?clicking\b/i,
    /^\[?rustling\b/i,
    /^\[?footsteps\b/i,
    /^\(.*sounds?\)/i,
    /^(?:a\s+)?(?:child|baby|toddler)\s+(?:is\s+)?(?:speaking|talking|babbling|crying|laughing)/i,
    /^the audio (?:contains?|features?|includes?|consists? of|is)/i,
    /^this audio (?:contains?|features?|includes?|consists? of|is)/i,
    /^(?:the|this) (?:recording|clip|segment) (?:contains?|features?|includes?)/i,
  ];

  const matchesNoise = NOISE_PATTERNS.some(p => p.test(lower));
  if (!matchesNoise) return false;

  const EICR_TERMS = /\b(circuit|ohm|bonding|rcd|mcb|rcbo|breaker|insulation|polarity|zs|ze|r1|r2|megohm|observation|defect|socket|lighting|ring|radial|cooker|shower)\b/i;
  if (EICR_TERMS.test(lower)) {
    return false;
  }

  return true;
}
