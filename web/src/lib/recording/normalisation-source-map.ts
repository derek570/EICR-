/**
 * Normalisation SOURCE MAP (A02D RegexFreshOccurrenceV1) — a token-aligned
 * map from every span of the matcher's normalised window back to the unique
 * raw span it came from. Pure: no matcher import, so the matcher can import
 * this without a cycle.
 *
 * Alignment: tokens (non-whitespace runs) of the raw and normalised text are
 * aligned by longest common subsequence on byte-equal tokens. An anchored
 * token maps 1:1 (identity within the token); the changed run between two
 * anchors maps, as a whole, to the raw run between the same anchors (the
 * spoken words "nought point three five" → "0.35"). A changed run with NO
 * raw tokens (a pure insertion) has no unique origin and is AMBIGUOUS — the
 * plan makes such a span client-regex-ineligible (it still goes verbatim to
 * the server).
 */
interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokenise(s: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null)
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

interface AlignmentBlock {
  /** Raw token index range [rs, re). */
  readonly rs: number;
  readonly re: number;
  /** Normalised token index range [ns, ne). */
  readonly ns: number;
  readonly ne: number;
  /** True when the block is one anchored (byte-equal) token pair. */
  readonly anchored: boolean;
}

export interface RawSpanMapping {
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly ambiguous: boolean;
}

export interface SourceMap {
  readonly raw: string;
  readonly normalised: string;
  /** Map a span of the NORMALISED text (window coordinates) to the raw
   *  window span it came from. */
  mapSpan(start: number, end: number): RawSpanMapping;
}

/** Token-level LCS alignment: unchanged tokens are anchors mapping 1:1
 *  (identity within the token); the changed runs between anchors map, as a
 *  whole, to the raw run between the same anchors. A changed run with NO
 *  raw tokens (a pure insertion) is ambiguous. */
function alignTokens(rawTokens: Token[], normTokens: Token[]): AlignmentBlock[] {
  const n = rawTokens.length;
  const m = normTokens.length;
  // LCS table (n+1)x(m+1) over token text equality.
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        rawTokens[i].text === normTokens[j].text
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const blocks: AlignmentBlock[] = [];
  let i = 0;
  let j = 0;
  let pendingRs = 0;
  let pendingNs = 0;
  const flushChanged = () => {
    if (pendingRs < i || pendingNs < j) {
      blocks.push({ rs: pendingRs, re: i, ns: pendingNs, ne: j, anchored: false });
    }
  };
  while (i < n && j < m) {
    if (rawTokens[i].text === normTokens[j].text) {
      flushChanged();
      blocks.push({ rs: i, re: i + 1, ns: j, ne: j + 1, anchored: true });
      i++;
      j++;
      pendingRs = i;
      pendingNs = j;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  i = n;
  j = m;
  flushChanged();
  return blocks;
}

export function buildSourceMap(raw: string, normalised: string): SourceMap {
  const rawTokens = tokenise(raw);
  const normTokens = tokenise(normalised);
  const blocks = alignTokens(rawTokens, normTokens);
  // Per normalised token → its block.
  const blockOfNorm: AlignmentBlock[] = new Array(normTokens.length);
  for (const b of blocks) for (let k = b.ns; k < b.ne; k++) blockOfNorm[k] = b;
  return {
    raw,
    normalised,
    mapSpan(start: number, end: number): RawSpanMapping {
      let rawStart = Number.POSITIVE_INFINITY;
      let rawEnd = Number.NEGATIVE_INFINITY;
      let ambiguous = false;
      let touched = false;
      for (let k = 0; k < normTokens.length; k++) {
        const t = normTokens[k];
        if (t.start >= end) break;
        if (t.end <= start) continue;
        touched = true;
        const b = blockOfNorm[k];
        if (!b) {
          ambiguous = true;
          continue;
        }
        if (b.anchored) {
          const rt = rawTokens[b.rs];
          const from = Math.max(start, t.start) - t.start;
          const to = Math.min(end, t.end) - t.start;
          rawStart = Math.min(rawStart, rt.start + from);
          rawEnd = Math.max(rawEnd, rt.start + to);
        } else if (b.re > b.rs) {
          rawStart = Math.min(rawStart, rawTokens[b.rs].start);
          rawEnd = Math.max(rawEnd, rawTokens[b.re - 1].end);
        } else {
          ambiguous = true;
        }
      }
      if (!touched || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
        return { rawStart: 0, rawEnd: 0, ambiguous: true };
      }
      return { rawStart, rawEnd, ambiguous };
    },
  };
}
