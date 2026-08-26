/**
 * lib/video/caption-plan.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE caption planner for the SOUND-OFF CAPTION BURN-IN feature. 85% of social
 * video plays MUTED, so every voiced reel needs animated on-screen captions
 * synced to the ElevenLabs voiceover.
 *
 * buildCaptionPlan(scriptOrAlignment, totalFrames, fps, opts) → ordered caption
 * cues { text, fromFrame, durationFrames }. Two timing sources, in priority:
 *
 *   (A) REAL alignment (PREFERRED · word-accurate)
 *       When the caller passes the per-character alignment returned by
 *       ElevenLabs' /v1/text-to-speech/{voice}/with-timestamps endpoint
 *       (lib/voice/elevenlabs-tts.ts synthesizeSpeechWithTimestamps), we group
 *       characters → words → ≤N-word phrase cues and place each cue at the REAL
 *       frame its first word is spoken. These captions are genuinely synced to
 *       the voice. timingSource: "alignment".
 *
 *   (B) EVEN-DISTRIBUTION (FALLBACK · honest ESTIMATE)
 *       When only the script TEXT + the VO duration (totalFrames) are known
 *       (ElevenLabs' default synthesizeSpeech returns NO alignment), we split the
 *       script into phrase cues and distribute them PROPORTIONALLY across the
 *       timeline weighted by each cue's character length (longer phrases dwell
 *       longer). This is a DETERMINISTIC ESTIMATE — NOT word-accurate — and is
 *       labelled timingSource: "even" so callers never claim sync they don't have.
 *
 * HONEST empty: no script + no alignment → []. The composition's CaptionLayer
 * then renders nothing (the reel is exactly as it was before captions existed).
 *
 * No DB, no React, no Remotion imports — unit-testable in isolation
 * (scripts/captions-simulator.ts).
 */
import { spokenWords } from "./script-structure"

// ── Alignment shape (mirrors ElevenLabs CharacterAlignmentResponseModel) ──────
/**
 * Per-character alignment as returned by ElevenLabs' with-timestamps endpoint.
 * The three arrays are parallel (same length): the i-th character is spoken from
 * character_start_times_seconds[i] to character_end_times_seconds[i].
 */
export interface CharacterAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

/** One on-screen caption cue the Remotion CaptionLayer renders. */
export interface CaptionCue {
  /** The phrase text shown for this cue (≤ maxWordsPerCue words). */
  text: string
  /** Absolute frame this cue appears. */
  fromFrame: number
  /** How many frames this cue stays on screen (before the next cue / end). */
  durationFrames: number
}

export interface CaptionPlan {
  cues: CaptionCue[]
  /** "alignment" = word-accurate (real ElevenLabs timestamps); "even" = honest
   *  even-distribution ESTIMATE; "empty" = no script → no cues. */
  timingSource: "alignment" | "even" | "empty"
}

export interface BuildCaptionPlanOptions {
  /** Max words per phrase cue. Clamped to 1..8. Default 4 (readable muted). */
  maxWordsPerCue?: number
  /** Minimum frames a cue stays on screen (readability floor). Default 18 (0.6s
   *  @30fps). A cue never dwells less than this even if its words are quick. */
  minCueFrames?: number
  /** Leave the last `tailPaddingFrames` of the timeline caption-free so the
   *  final cue isn't clipped at the very last frame. Default 0. */
  tailPaddingFrames?: number
}

/** The first argument: either the raw script TEXT (fallback) or real alignment. */
export type CaptionSource = string | CharacterAlignment | null | undefined

function isAlignment(x: CaptionSource): x is CharacterAlignment {
  return (
    !!x &&
    typeof x === "object" &&
    Array.isArray((x as CharacterAlignment).characters) &&
    Array.isArray((x as CharacterAlignment).character_start_times_seconds)
  )
}

/** Split a script into words, stripping surrounding whitespace. Empty → [].
 *  TOMBSTONE: the body moved to `spokenWords` in lib/video/script-structure.ts,
 *  which the narration cap also counts with — one spelling of "how many words is
 *  this script" across the video lane (§6). The local name is kept because it is
 *  used a dozen times below and reads better inside the caption arithmetic. */
const splitWords = spokenWords

/** Group an ordered word list into ≤maxWords-per-phrase chunks, breaking
 *  PREFERENTIALLY at sentence punctuation so a cue never straddles a sentence. */
function chunkWords(words: string[], maxWords: number): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  for (const w of words) {
    current.push(w)
    const endsSentence = /[.!?]["')\]]?$/.test(w)
    if (current.length >= maxWords || endsSentence) {
      chunks.push(current)
      current = []
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * buildCaptionPlan — PURE. Produce ordered caption cues from REAL alignment when
 * present, else an HONEST even-distribution estimate from the script text.
 */
export function buildCaptionPlan(
  source: CaptionSource,
  totalFrames: number,
  fps: number,
  opts: BuildCaptionPlanOptions = {},
): CaptionPlan {
  const maxWords = Math.max(1, Math.min(8, Math.floor(opts.maxWordsPerCue ?? 4) || 4))
  const safeFps = fps > 0 ? fps : 30
  const safeTotal = Math.max(0, Math.floor(totalFrames))
  const minCueFrames = Math.max(1, Math.floor(opts.minCueFrames ?? Math.round(safeFps * 0.6)))
  const tailPad = Math.max(0, Math.floor(opts.tailPaddingFrames ?? 0))
  const usableFrames = Math.max(0, safeTotal - tailPad)

  if (usableFrames <= 0) return { cues: [], timingSource: "empty" }

  // ── Path A — REAL alignment (word-accurate) ──────────────────────────────
  if (isAlignment(source)) {
    const cues = cuesFromAlignment(source, usableFrames, safeFps, maxWords, minCueFrames)
    if (cues.length > 0) return { cues, timingSource: "alignment" }
    // Alignment present but unusable (all-whitespace / empty arrays) → empty.
    return { cues: [], timingSource: "empty" }
  }

  // ── Path B — even-distribution ESTIMATE from the script text ─────────────
  const text = typeof source === "string" ? source : ""
  const words = splitWords(text)
  if (words.length === 0) return { cues: [], timingSource: "empty" }

  const cues = cuesFromEvenDistribution(words, usableFrames, maxWords, minCueFrames)
  return { cues, timingSource: cues.length > 0 ? "even" : "empty" }
}

// ─── Path A: alignment → word-timed phrase cues ──────────────────────────────

interface TimedWord {
  text: string
  startFrame: number
}

/**
 * Walk the per-character alignment, accumulating characters into WORDS (split on
 * whitespace), stamping each word with the frame its FIRST character is spoken.
 * Then chunk words into phrases and place each phrase cue at its first word's
 * frame, dwelling until the next phrase (or the timeline end).
 */
function cuesFromAlignment(
  a: CharacterAlignment,
  usableFrames: number,
  fps: number,
  maxWords: number,
  minCueFrames: number,
): CaptionCue[] {
  const chars = a.characters
  const starts = a.character_start_times_seconds
  const n = Math.min(chars.length, starts.length)
  if (n === 0) return []

  const words: TimedWord[] = []
  let buf = ""
  let bufStartSec: number | null = null
  for (let i = 0; i < n; i++) {
    const ch = chars[i]
    if (/\s/.test(ch)) {
      if (buf) {
        words.push({ text: buf, startFrame: Math.max(0, Math.round((bufStartSec ?? 0) * fps)) })
        buf = ""
        bufStartSec = null
      }
      continue
    }
    if (buf === "") bufStartSec = starts[i]
    buf += ch
  }
  if (buf) words.push({ text: buf, startFrame: Math.max(0, Math.round((bufStartSec ?? 0) * fps)) })
  if (words.length === 0) return []

  // Chunk into phrases on word boundaries / sentence punctuation.
  const phrases = chunkWords(words.map((w) => w.text), maxWords)

  // Re-walk to attach each phrase's first-word startFrame.
  const cues: CaptionCue[] = []
  let wordIdx = 0
  for (const phrase of phrases) {
    const firstWord = words[wordIdx]
    const fromFrame = Math.min(usableFrames - 1, firstWord ? firstWord.startFrame : 0)
    cues.push({ text: phrase.join(" "), fromFrame, durationFrames: 0 })
    wordIdx += phrase.length
  }

  // Fill durations from the gap to the next cue; clamp the last to the timeline.
  return finalizeDurations(cues, usableFrames, minCueFrames)
}

// ─── Path B: even-distribution estimate ──────────────────────────────────────

/**
 * Split words into phrase cues, then distribute the usable timeline across cues
 * PROPORTIONALLY to each cue's character length (longer phrases dwell longer).
 * Deterministic estimate — labelled "even" by the caller.
 */
function cuesFromEvenDistribution(
  words: string[],
  usableFrames: number,
  maxWords: number,
  minCueFrames: number,
): CaptionCue[] {
  const phrases = chunkWords(words, maxWords)
  if (phrases.length === 0) return []

  const texts = phrases.map((p) => p.join(" "))
  const weights = texts.map((t) => Math.max(1, t.length))
  const totalWeight = weights.reduce((s, w) => s + w, 0)

  // Assign each cue a proportional slice, accumulating fractional remainders so
  // the cues tile the WHOLE timeline exactly (last cue ends at usableFrames).
  const cues: CaptionCue[] = []
  let cursor = 0
  let acc = 0
  for (let i = 0; i < texts.length; i++) {
    acc += (weights[i] / totalWeight) * usableFrames
    const end = i === texts.length - 1 ? usableFrames : Math.round(acc)
    const fromFrame = cursor
    const durationFrames = Math.max(1, end - fromFrame)
    cues.push({ text: texts[i], fromFrame, durationFrames })
    cursor = end
  }

  return finalizeDurations(cues, usableFrames, minCueFrames)
}

// ─── Shared: tile durations + enforce readability floor ──────────────────────

/**
 * Given cues with fromFrame set (durationFrames may be 0/placeholder), compute
 * each cue's durationFrames as the gap to the NEXT cue's fromFrame, clamp the
 * last cue to the timeline end, and enforce the minCueFrames readability floor
 * without ever overlapping the next cue or exceeding the timeline.
 *
 * Guarantees: cues are ordered by fromFrame, non-overlapping, every duration
 * >= 1, and the union stays within [0, usableFrames].
 */
function finalizeDurations(
  cues: CaptionCue[],
  usableFrames: number,
  minCueFrames: number,
): CaptionCue[] {
  if (cues.length === 0) return []

  // Ensure strictly non-decreasing, in-bounds fromFrames.
  const ordered = cues
    .map((c) => ({ ...c, fromFrame: Math.max(0, Math.min(usableFrames - 1, Math.floor(c.fromFrame))) }))
    .sort((a, b) => a.fromFrame - b.fromFrame)

  // De-dup identical start frames by nudging forward (keeps strict ordering so
  // no two cues are ever active on the same frame).
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].fromFrame <= ordered[i - 1].fromFrame) {
      ordered[i].fromFrame = Math.min(usableFrames - 1, ordered[i - 1].fromFrame + 1)
    }
  }

  const out: CaptionCue[] = []
  for (let i = 0; i < ordered.length; i++) {
    const from = ordered[i].fromFrame
    const nextFrom = i < ordered.length - 1 ? ordered[i + 1].fromFrame : usableFrames
    // Natural duration = gap to next cue. Apply the readability floor, but never
    // let a cue spill past the next cue's start (no overlap) or the timeline.
    const gap = Math.max(1, nextFrom - from)
    const isLast = i === ordered.length - 1
    const cap = isLast ? usableFrames - from : nextFrom - from
    const durationFrames = Math.max(1, Math.min(Math.max(gap, minCueFrames), cap))
    out.push({ text: ordered[i].text, fromFrame: from, durationFrames })
  }
  return out
}

/**
 * activeCueIndex — PURE helper the CaptionLayer uses to pick the cue on screen
 * at a given frame. Returns -1 when no cue is active (so the layer renders
 * nothing). Bounds-safe: frames before the first cue or after the last cue's
 * window yield -1.
 */
export function activeCueIndex(cues: CaptionCue[], frame: number): number {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]
    if (frame >= c.fromFrame && frame < c.fromFrame + c.durationFrames) return i
  }
  return -1
}
