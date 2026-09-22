/**
 * lib/video/memory-video-composition.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEMORY VIDEO'S TIMELINE, COMPUTED FROM THE NARRATION — pure.
 *
 * Lane 78D, blind spot (1). Lane 77D's per-type matrix found the memory video
 * (owner: "a seller dictated video going over the history of the house so the
 * family has it") was the ONE owner type with no Remotion composition: "a
 * multi-minute dictation does not fit any registered body window (the longest
 * avatar window is 24.5 s) and every composition renders at fixed registered
 * geometry". This module is the fix's arithmetic, shared by three consumers:
 *   · remotion/MemoryVideoReel.tsx  — lays chapters out with it (relative
 *     import; this file must stay free of server-only / Node imports);
 *   · lib/video/memory-video-render.ts — the stager, sizing each chapter's
 *     frames from the real narration it just synthesised;
 *   · remotion/Root.tsx `calculateMetadata` — the composition's duration IS
 *     memoryVideoDurationFrames(props), so a film is exactly as long as the
 *     family's story, never a hand-tabled body window (owner, wave 78: "the
 *     video needs to be long enough to achieve the reason for making the
 *     video"). The registered duration_frames (MEMORY_VIDEO_MAX_FRAMES) is a
 *     CAP the render cache / cost estimate can plan against, not the length.
 *
 * PURPOSE "memory": no word budget. The seller's words are the script and are
 * never trimmed to fit (MODEL_MAY_NOT in memory-video-gate.ts); what IS sized
 * is the timeline, from the narration, chapter by chapter. The only provider
 * limit that applies is the synthesis cap per request (reel-voiceover.ts
 * MAX_SCRIPT_CHARS): a chapter longer than that is split on SENTENCE
 * boundaries into parts, each its own clip, so nothing past the cap is lost.
 */
// RELATIVE on purpose: remotion/MemoryVideoReel.tsx and remotion/Root.tsx
// import this module and the Remotion bundle resolves no `@/` alias (no file
// under remotion/ uses one — measured 2026-09-22).
import { spokenSentences, spokenWords, estimateDurationSeconds } from "./script-structure"

/** The purpose this composition serves — read by the stager and the proof, never a free string. */
export const MEMORY_VIDEO_PURPOSE = "memory" as const

export const MEMORY_VIDEO_COMPOSITION_ID = "MemoryVideoReel" as const

/** Silent title card before the first chapter. */
export const MEMORY_VIDEO_COVER_SECONDS = 4
/** Branded "recorded with" end card after the last chapter. */
export const MEMORY_VIDEO_OUTRO_SECONDS = 4
/** Breath after each chapter's last word before the next chapter opens. */
export const MEMORY_VIDEO_CHAPTER_TAIL_SECONDS = 0.75
/**
 * THE CAP — the registered duration_frames at 30 fps (20 minutes). Six
 * chapters, each split into ≤ MAX_SCRIPT_CHARS parts at ~14 spoken chars/s,
 * cannot reach it; it exists so the render cache, the cost estimate and the
 * coordinator have a planning bound, and memoryVideoDurationFrames never
 * exceeds it.
 */
export const MEMORY_VIDEO_MAX_SECONDS = 20 * 60

/** ONE chapter as the composition receives it — a clip per (chapter, part). */
export interface MemoryVideoChapterProps {
  /** memory-video-gate prompt id (arrival, the_people, …) — the chapter key. */
  id: string
  /** The question the seller answered, shown as the chapter eyebrow. */
  title: string
  /** The seller's words for THIS clip, verbatim. */
  sellerWords: string
  /** Hosted narration for this clip, or null when synthesis was unavailable (the words still show on screen). */
  voiceoverUrl: string | null
  /** Frames this clip plays — computed from the narration by chapterDurationFrames. */
  durationFrames: number
}

export interface MemoryVideoTimelineProps {
  chapters: ReadonlyArray<Pick<MemoryVideoChapterProps, "durationFrames">>
}

export interface ChapterSlot { from: number; durationInFrames: number }

/** Characters per on-screen page of the seller's words in a chapter (remotion/MemoryVideoReel.tsx turns the page as the narration reaches it). */
export const MEMORY_VIDEO_PAGE_CHARS = 420

/** Frames the silent cover holds — the point every chapter slot is laid out after. */
export function memoryVideoCoverFrames(fps: number): number {
  return Math.round(MEMORY_VIDEO_COVER_SECONDS * Math.max(1, fps))
}

/** Frames one clip plays: its narration plus the chapter tail, never below one frame. */
export function chapterDurationFrames(narrationSeconds: number, fps: number): number {
  const s = Number.isFinite(narrationSeconds) && narrationSeconds > 0 ? narrationSeconds : 0
  return Math.max(1, Math.ceil((s + MEMORY_VIDEO_CHAPTER_TAIL_SECONDS) * Math.max(1, fps)))
}

/** Seconds a clip is expected to run when no measured alignment exists — the fleet's one pace (WORDS_PER_MINUTE). */
export function estimatedChapterSeconds(sellerWords: string): number {
  return estimateDurationSeconds(spokenWords(sellerWords).length)
}

/** Composition-absolute slots for the chapters, in order, starting after the cover. */
export function memoryVideoChapterLayout(props: MemoryVideoTimelineProps, fps: number): ChapterSlot[] {
  let from = memoryVideoCoverFrames(fps)
  const out: ChapterSlot[] = []
  for (const ch of props.chapters) {
    const d = Math.max(1, Math.floor(Number(ch.durationFrames) || 0) || 1)
    out.push({ from, durationInFrames: d })
    from += d
  }
  return out
}

/**
 * THE LENGTH — cover + every chapter clip + outro, in frames, clamped to the
 * cap. Root.tsx hands this to Remotion as the composition's durationInFrames.
 */
export function memoryVideoDurationFrames(props: MemoryVideoTimelineProps, fps: number): number {
  const f = Math.max(1, fps)
  const cover = memoryVideoCoverFrames(f)
  const outro = Math.round(MEMORY_VIDEO_OUTRO_SECONDS * f)
  const body = memoryVideoChapterLayout(props, f).reduce((sum, s) => sum + s.durationInFrames, 0)
  return Math.min(Math.round(MEMORY_VIDEO_MAX_SECONDS * f), cover + body + outro)
}

/**
 * Split one chapter's words into synthesis-sized parts on SENTENCE boundaries.
 * Every character of the input is in exactly one part (a sentence longer than
 * the cap on its own is kept whole and flagged by the caller, never cut
 * mid-word); an empty input yields no parts.
 */
export function splitForSynthesis(sellerWords: string, maxChars: number): string[] {
  const cap = Math.max(1, Math.floor(maxChars))
  const sentences = spokenSentences(sellerWords)
  if (sentences.length === 0) return sellerWords.trim() ? [sellerWords.trim()] : []
  const parts: string[] = []
  let current = ""
  for (const s of sentences) {
    const next = current ? `${current} ${s}` : s
    if (next.length <= cap || !current) current = next
    else { parts.push(current); current = s }
  }
  if (current) parts.push(current)
  return parts
}
