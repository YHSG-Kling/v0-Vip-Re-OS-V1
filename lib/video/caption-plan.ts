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
// LANE 74D — closes the gap named in this file's own sibling module (realism-profile.ts
// §"SCRIPT AUDIO TAGS → CAPTIONS": "once withNaturalPauses lands, whatever module emits the
// TAGGED script for TTS must hand buildCaptionPlan/captionScript the UNTAGGED string — a
// contract this file cannot enforce from here because the tagged producer does not exist yet").
// Both withNaturalPauses (wave 57) AND enforceExpressiveAudioTagBudget (wave 73D — ElevenLabs v3
// [laughs]/[chuckles]/[sighs]/[whispers] tags, kept up to a per-script budget ON THE SCRIPT TEXT
// ITSELF for the v3 lane) now exist, and neither producer strips its own tags before the SAME
// script/alignment reaches a caption path — app/actions/video/generate-script.ts stores the
// budget-capped script (which may still carry authorized tags) as the one value both TTS
// (lib/video/reel-voiceover.ts) and captions read. Rather than trust every future caller to
// remember the two-step "strip before you hand this to captions" contract, this IS "the one
// place a viewer would actually see raw text" the sibling module's own comment names — every cue
// this function returns is stripped, unconditionally, regardless of caller or timing path.
import { stripExpressiveAudioTags, stripNaturalPauseMarkup } from "./realism-profile"

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

/**
 * One WORD inside a cue, with the absolute frame it is spoken — the timing the
 * CaptionLayer's kinetic highlight reads (lane 77D; the skill's
 * remotion-captions/display-captions.md "Word highlighting" pattern, applied
 * to this repo's phrase-cue shape rather than TikTokPage tokens). On the
 * alignment path this is the REAL first-character time of the word; on the
 * even-distribution path it is the same honest estimate the cue itself is,
 * spread across the cue by character length. `text` carries no whitespace —
 * the layer joins with a single space, the same spelling `spokenWords`
 * splits on.
 */
export interface CaptionWord {
  text: string
  /** Absolute frame this word starts. Always inside its cue's window. */
  fromFrame: number
}

/** One on-screen caption cue the Remotion CaptionLayer renders. */
export interface CaptionCue {
  /** The phrase text shown for this cue (≤ maxWordsPerCue words). */
  text: string
  /** Absolute frame this cue appears. */
  fromFrame: number
  /** How many frames this cue stays on screen (before the next cue / end). */
  durationFrames: number
  /** Per-word timing for the kinetic highlight. OPTIONAL and additive: a cue
   *  built before lane 77D (a stored input_props row) has none, and the layer
   *  renders the plain phrase exactly as before. When present it satisfies:
   *  words.join(" ") === text, words[0].fromFrame === fromFrame, frames are
   *  non-decreasing and every one lies in [fromFrame, fromFrame+durationFrames). */
  words?: CaptionWord[]
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
    const cues = stripTagsFromCues(cuesFromAlignment(source, usableFrames, safeFps, maxWords, minCueFrames))
    if (cues.length > 0) return { cues, timingSource: "alignment" }
    // Alignment present but unusable (all-whitespace / empty arrays, or every
    // word an authorized tag that stripped to nothing) → empty.
    return { cues: [], timingSource: "empty" }
  }

  // ── Path B — even-distribution ESTIMATE from the script text ─────────────
  const text = typeof source === "string" ? source : ""
  const words = splitWords(text)
  if (words.length === 0) return { cues: [], timingSource: "empty" }

  const cues = stripTagsFromCues(cuesFromEvenDistribution(words, usableFrames, maxWords, minCueFrames))
  return { cues, timingSource: cues.length > 0 ? "even" : "empty" }
}

/**
 * PURE. The choke point named in this file's header comment above — applied to EVERY cue this
 * function ever returns, on both timing paths: strips ElevenLabs v3 expressive audio tags
 * ("[laughs]", …) and natural-pause markup from the cue TEXT (never touches timing), then drops
 * any cue that stripped down to nothing (a cue that was ENTIRELY a tag — e.g. a standalone
 * "[laughs]" phrase — would otherwise render a blank caption box; a real cue's timing/duration is
 * untouched, so a dropped tag-only cue simply leaves its neighbour's caption on screen slightly
 * longer, the same "caption-free is a normal state" posture this file already takes for an empty
 * plan).
 */
function stripTagsFromCues(cues: CaptionCue[]): CaptionCue[] {
  const out: CaptionCue[] = []
  for (const cue of cues) {
    const text = stripExpressiveAudioTags(stripNaturalPauseMarkup(cue.text)).trim()
    if (!text) continue
    // The words get the SAME strip, word by word, so a tag-only word ("[laughs]")
    // drops out of the highlight track exactly as it drops out of the text — the
    // join invariant (words.join(" ") === text) survives because both sides ran
    // the same function. A word that stripped to several tokens ("[sighs]well"
    // → "well") keeps its timing.
    const words = cue.words
      ?.map((w) => ({ text: stripExpressiveAudioTags(stripNaturalPauseMarkup(w.text)).trim(), fromFrame: w.fromFrame }))
      .filter((w) => w.text.length > 0)
    const joined = words?.map((w) => w.text).join(" ")
    // If the per-word strip and the whole-text strip ever disagree (a tag that
    // spanned a space), drop the word track rather than ship a highlight that
    // does not match the phrase — the plain cue is the honest fallback.
    out.push(words && words.length > 0 && joined === text ? { ...cue, text, words } : { text, fromFrame: cue.fromFrame, durationFrames: cue.durationFrames })
  }
  return out
}

/**
 * Spread a cue's words across its window by character weight — the even-
 * distribution path's per-word estimate, and the layer's fallback when a cue
 * arrives with timing for the phrase but not the words. The first word always
 * starts AT the cue's own fromFrame; later words never leave the window.
 * PURE. Exported for the CaptionLayer and its proof.
 */
export function evenWordFrames(words: string[], fromFrame: number, durationFrames: number): CaptionWord[] {
  if (words.length === 0) return []
  const span = Math.max(1, Math.floor(durationFrames))
  const weights = words.map((w) => Math.max(1, w.length))
  const total = weights.reduce((s, w) => s + w, 0)
  const out: CaptionWord[] = []
  let acc = 0
  for (let i = 0; i < words.length; i++) {
    const offset = i === 0 ? 0 : Math.min(span - 1, Math.round((acc / total) * span))
    out.push({ text: words[i], fromFrame: fromFrame + offset })
    acc += weights[i]
  }
  return out
}

/** Clamp a cue's word frames into its (possibly re-anchored) window and keep
 *  them non-decreasing — the one place the invariant is enforced after any
 *  shift/clip/nudge. Returns undefined when the cue carries no word track. */
function boundWords(words: CaptionWord[] | undefined, fromFrame: number, durationFrames: number): CaptionWord[] | undefined {
  if (!words || words.length === 0) return undefined
  const last = fromFrame + Math.max(1, durationFrames) - 1
  let floor = fromFrame
  return words.map((w, i) => {
    const f = i === 0 ? fromFrame : Math.max(floor, Math.min(last, Math.floor(w.fromFrame)))
    floor = f
    return { text: w.text, fromFrame: f }
  })
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

  // Re-walk to attach each phrase's first-word startFrame — and every word's
  // own REAL start frame for the kinetic highlight (lane 77D).
  const cues: CaptionCue[] = []
  let wordIdx = 0
  for (const phrase of phrases) {
    const firstWord = words[wordIdx]
    const fromFrame = Math.min(usableFrames - 1, firstWord ? firstWord.startFrame : 0)
    const timed = words.slice(wordIdx, wordIdx + phrase.length)
      .map((w) => ({ text: w.text, fromFrame: Math.min(usableFrames - 1, w.startFrame) }))
    cues.push({ text: phrase.join(" "), fromFrame, durationFrames: 0, words: timed })
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
    cues.push({ text: texts[i], fromFrame, durationFrames, words: evenWordFrames(phrases[i], fromFrame, durationFrames) })
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
    const words = boundWords(ordered[i].words, from, durationFrames)
    out.push(words ? { text: ordered[i].text, fromFrame: from, durationFrames, words } : { text: ordered[i].text, fromFrame: from, durationFrames })
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

/**
 * shiftCaptionCues — PURE, additive helper (wave 59 realism audit).
 *
 * THE DEFECT THIS CLOSES. Several avatar-fronted reels (MarketUpdateReel,
 * AgentExplainerReel, ExplainerAnimReel, TeammateExplainerReel) open on a
 * SILENT COVER/INTRO tile (a title card with no `<Audio>`/`<Video>` mounted at
 * all) before the avatar clip — which carries its OWN baked-in narration
 * audio — starts, at an absolute frame > 0 (`COVER`/`INTRO`). `CaptionLayer`'s
 * even-distribution fallback (Path B, `buildCaptionPlan` off raw script text)
 * used to be planned against the WHOLE composition's `durationInFrames`
 * starting at frame 0, so its first cue's words were placed over that silent
 * cover tile — a caption with no audio behind it at all, exactly the kind of
 * mismatch a real, professionally-edited video never has (the owner's realism
 * ruling this file's header already cites).
 *
 * THE FIX. Plan the fallback estimate against the narration window's OWN
 * length (`hiddenFromFrame - visibleFromFrame`), then re-anchor every cue back
 * onto absolute frames with this function. Pure re-indexing — the plan's
 * relative pacing (which `buildCaptionPlan` already computed correctly for a
 * window of that length) is untouched. See remotion/components/CaptionLayer.tsx
 * `visibleFromFrame`.
 */
export function shiftCaptionCues(cues: CaptionCue[], offsetFrames: number): CaptionCue[] {
  if (!Number.isFinite(offsetFrames) || offsetFrames === 0) return cues
  const shift = Math.floor(offsetFrames)
  return cues.map((c) => {
    const fromFrame = Math.max(0, c.fromFrame + shift)
    const words = boundWords(c.words?.map((w) => ({ text: w.text, fromFrame: w.fromFrame + shift })), fromFrame, c.durationFrames)
    return words ? { ...c, fromFrame, words } : { text: c.text, fromFrame, durationFrames: c.durationFrames }
  })
}

/**
 * clipCaptionCuesFromFrame — the START-side twin of clipCaptionCuesBeforeFrame
 * (below), for PRECOMPUTED cues (Path A) that might still reach into a silent
 * cover tile. Drops any cue that ends at/before `visibleFromFrame` entirely,
 * and shortens a straddling cue to start exactly AT the boundary (mirrors
 * clipCaptionCuesBeforeFrame's own straddle rule — never cut a cue's TEXT
 * short, only its dead-air lead-in). Null/undefined/non-finite/<=0
 * `visibleFromFrame` is a no-op (additive/opt-in, same posture as every other
 * prop on this layer).
 */
export function clipCaptionCuesFromFrame(
  cues: CaptionCue[],
  visibleFromFrame: number | null | undefined,
): CaptionCue[] {
  if (typeof visibleFromFrame !== "number" || !Number.isFinite(visibleFromFrame) || visibleFromFrame <= 0) return cues
  const from = Math.floor(visibleFromFrame)
  const out: CaptionCue[] = []
  for (const c of cues) {
    const end = c.fromFrame + c.durationFrames
    if (end <= from) continue
    const fromFrame = Math.max(c.fromFrame, from)
    const durationFrames = end - fromFrame
    if (durationFrames <= 0) continue
    const words = boundWords(c.words, fromFrame, durationFrames)
    out.push(words ? { text: c.text, fromFrame, durationFrames, words } : { text: c.text, fromFrame, durationFrames })
  }
  return out
}

/**
 * clipCaptionCuesBeforeFrame — wave 57 realism audit ("this includes ai
 * created videos" — b-roll/imagery, music, CAPTIONS, intro/outro/branding).
 *
 * THE DEFECT THIS CLOSES. Every reel that mounts `<CaptionLayer>` mounts it
 * ONCE, at the composition root, over the ENTIRE timeline (remotion/
 * MarketUpdateReel.tsx and eight siblings — AgentExplainerReel,
 * ExplainerAnimReel, JustListedReel, JustListedReelSquare, JustSoldReelSquare,
 * NeighborhoodSpotlightReel, PartnersMeetingReel, PhotoWalkthroughReel,
 * TeammateExplainerReel). Every one of those reels ALSO ends on a branding/CTA
 * tile — brokerage name, the Equal Housing Opportunity mark, a QR code — drawn
 * in the SAME lower-third band `CaptionLayer`'s default `bottomPercent` (78)
 * occupies. A caption cue whose window reaches into that tile draws ON TOP of
 * the compliance mark and the QR code — legible burned-in captions over a
 * video's own branding card is not how a real, professionally-edited
 * real-estate video reads; an un-clipped caption track is a tell that nobody
 * looked at the composite, the opposite of the owner's realism ruling.
 *
 * THE FIX. Cut the caption track off at the frame the branding tile starts —
 * never trim mid-cue into a half-visible phrase, never leave a cue dangling
 * past the timeline. `CaptionLayer`'s `hiddenFromFrame` prop calls this.
 *
 * PURE. Drops any cue that starts AT or AFTER `cutoffFrame` entirely, and
 * SHORTENS a cue that starts before the cutoff but would otherwise still be
 * showing when it arrives (never lets a cue's window cross the boundary).
 * `cutoffFrame` null/undefined/non-finite → returns `cues` unchanged (opt-in,
 * same posture as every other additive prop on this layer).
 */
export function clipCaptionCuesBeforeFrame(
  cues: CaptionCue[],
  cutoffFrame: number | null | undefined,
): CaptionCue[] {
  if (typeof cutoffFrame !== "number" || !Number.isFinite(cutoffFrame)) return cues
  const cutoff = Math.max(0, Math.floor(cutoffFrame))
  const out: CaptionCue[] = []
  for (const c of cues) {
    if (c.fromFrame >= cutoff) continue
    const end = c.fromFrame + c.durationFrames
    const durationFrames = end > cutoff ? cutoff - c.fromFrame : c.durationFrames
    if (durationFrames <= 0) continue
    const words = boundWords(c.words, c.fromFrame, durationFrames)
    out.push(words ? { text: c.text, fromFrame: c.fromFrame, durationFrames, words } : { text: c.text, fromFrame: c.fromFrame, durationFrames })
  }
  return out
}

/**
 * activeWordIndex — PURE helper the CaptionLayer uses for the kinetic
 * highlight: the index of the word being spoken at `frame` inside `cue`, i.e.
 * the LAST word whose fromFrame <= frame. -1 when the cue carries no word
 * track or the frame precedes its first word (the layer then renders the plain
 * phrase). Bounds-safe like activeCueIndex.
 */
export function activeWordIndex(cue: CaptionCue, frame: number): number {
  const words = cue.words
  if (!words || words.length === 0) return -1
  let idx = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i].fromFrame <= frame) idx = i
    else break
  }
  return idx
}
