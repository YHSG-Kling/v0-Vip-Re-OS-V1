/**
 * remotion/MemoryVideoReel.tsx
 *
 * THE MEMORY VIDEO — the family's own account of their home, chaptered, in the
 * SELLER'S OWN VOICE, with NO avatar (lane 78D, blind spot 1; owner ruling in
 * lib/video/memory-video-gate.ts). Horizontal 1920×1080 for the living-room TV.
 *
 * WAVE 80C — TWO MODES (owner: "either … a full video with the seller on
 * screen walking the home with the story or an uploaded audio of the seller
 * talking about the home … and photos of the home are used for the visuals"):
 *
 *   COVER     silent title card — "The story of <address>", the family's name
 *   CHAPTERS  one Sequence per chapter, in the order the seller was asked:
 *             · seller_walkthrough  — the seller's own clip fills the frame
 *               (chapter.videoUrl → body-visual `client_footage`); the chapter
 *               question rides as an eyebrow, the words as a caption strip;
 *             · seller_audio_photos — the seller's own audio (<Audio
 *               chapter.voiceoverUrl>) under the home's photos, each photo a
 *               KenBurnsPhoto (the ONE photo renderer) in a slot CUT FROM THE
 *               BODY-VISUAL PLAN (photoSlotsForSegment → kenBurnsPlan for the
 *               motion) — never hand-timed; a blurred copy of the photo is the
 *               backdrop (plan background `blurred_photo`); the words ride as
 *               a caption strip, paged as before;
 *             · no plan / no media on the row (an older render) → the words
 *               on screen exactly as lane 78D drew them.
 *   OUTRO     EndCard — "Recorded for the <family> family", brokerage as the
 *             maker's mark, no QR (a keepsake is not a funnel)
 *
 * LENGTH IS COMPUTED, NOT REGISTERED. Root.tsx's `calculateMetadata` sets
 * durationInFrames = memoryVideoDurationFrames(props) (lib/video/
 * memory-video-composition.ts), so the film runs exactly cover + every clip +
 * outro; the registered duration_frames is only the cap. This composition
 * therefore declares NO frame consts of its own — every slot comes from
 * memoryVideoChapterLayout over the props, and scripts/video-assembly-
 * simulator.ts proves the layout tiles the computed length. The cover and the
 * outro are the composition's registered BOOKENDS (duration-model.ts, wave
 * 80C), so fitBodyVisualPlan's split and the chapter layout agree.
 *
 * Captions: the seller's words are on screen for every clip (verbatim —
 * MODEL_MAY); no second CaptionLayer (finish-spec captions: false, published).
 */
import React from "react"
import { Audio, Video } from "@remotion/media"
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { EndCard } from "./components/EndCard"
import { KenBurnsPhoto } from "./components/KenBurnsPhoto"
import { kenBurnsPlan } from "../lib/video/ken-burns-plan"
import { fitBodyVisualPlan, photoSlotsForSegment, type BodyVisualPlan, type BodyVisualSegment } from "../lib/video/body-visual-model"
import {
  MEMORY_VIDEO_PAGE_CHARS,
  memoryVideoChapterLayout,
  memoryVideoCoverFrames,
  memoryVideoDurationFrames,
  splitForSynthesis,
  type MemoryVideoChapterProps,
  type MemoryVideoMode,
} from "../lib/video/memory-video-composition"

export interface MemoryVideoReelProps {
  /** "The story of 14 Elm Street" — the film's title. */
  title: string
  /** "The Alvarez family" — whose story it is. */
  familyName: string
  /** "Home since 1979 · 46 years" — the tenure line under the title, or null. */
  tenureLine: string | null
  /** The clips, in chapter order. Each carries the seller's own recording and its frames. */
  chapters: MemoryVideoChapterProps[]
  /** How the film is made (lib/video/memory-video-composition.ts MEMORY_VIDEO_MODES). Absent → the words-only layout. */
  mode?: MemoryVideoMode | null
  /** The home's photos (seller_audio_photos) — assigned to chapters by the plan. */
  photoUrls?: string[] | null
  /** The director's per-chapter screen plan (lib/video/body-visual-model.ts), re-fitted here. */
  bodyVisualPlan?: BodyVisualPlan | null
  brand: {
    primaryColor: string
    accentColor: string
    logoUrl?: string
    brokerageName: string
    /** Equal Housing Opportunity mark on the end card. Defaults true. */
    showEhoMark?: boolean
  }
}

const CoverScene: React.FC<Pick<MemoryVideoReelProps, "title" | "familyName" | "tenureLine" | "brand">> = ({ title, familyName, tenureLine, brand }) => {
  const frame = useCurrentFrame()
  const fade = (from: number, to: number) => ({
    opacity: interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    translate: `0 ${interpolate(frame, [from, to], [24, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px`,
  })
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 120, textAlign: "center", color: "#fff" }}>
      <div style={{ fontSize: 26, letterSpacing: 8, color: brand.accentColor, fontWeight: 700, textTransform: "uppercase", ...fade(0, 18) }}>
        A memory video
      </div>
      <div style={{ fontSize: 96, fontWeight: 800, lineHeight: 1.05, marginTop: 28, maxWidth: 1500, textShadow: "0 10px 44px rgba(0,0,0,0.35)", ...fade(8, 30) }}>
        {title}
      </div>
      <div style={{ fontSize: 40, marginTop: 28, color: "#ffffffd9", ...fade(18, 40) }}>
        {familyName}
      </div>
      {tenureLine && (
        <div style={{ fontSize: 30, marginTop: 14, color: brand.accentColor, fontWeight: 600, ...fade(26, 48) }}>
          {tenureLine}
        </div>
      )}
    </AbsoluteFill>
  )
}

/** The page of the seller's words under the playhead — paged so a long answer stays readable, at the narration's pace. */
function pageAt(sellerWords: string, frame: number, durationFrames: number): { page: string; pageIndex: number; pages: string[] } {
  const pages = splitForSynthesis(sellerWords, MEMORY_VIDEO_PAGE_CHARS)
  const totalChars = Math.max(1, pages.reduce((n, p) => n + p.length, 0))
  let acc = 0
  let pageIndex = 0
  for (let i = 0; i < pages.length; i++) {
    const startFrame = Math.floor((acc / totalChars) * durationFrames)
    if (frame >= startFrame) pageIndex = i
    acc += pages[i].length
  }
  return { page: pages[pageIndex] ?? sellerWords, pageIndex, pages }
}

const ChapterEyebrow: React.FC<{ index: number; total: number; title: string; accentColor: string }> = ({ index, total, title, accentColor }) => (
  <>
    <div style={{ position: "absolute", top: 64, left: 100, right: 100, display: "flex", alignItems: "center", gap: 20 }}>
      <div style={{ fontSize: 22, letterSpacing: 5, color: accentColor, fontWeight: 700, textTransform: "uppercase" }}>
        Chapter {index + 1} of {total}
      </div>
      <div style={{ fontSize: 22, letterSpacing: 3, opacity: 0.6 }}>{title}</div>
    </div>
    <div style={{ position: "absolute", top: 108, left: 100, width: 120, height: 4, borderRadius: 2, backgroundColor: accentColor }} />
  </>
)

/** The seller's words as a caption strip over footage / photos (both media modes). */
const WordsStrip: React.FC<{ sellerWords: string; frame: number; durationFrames: number }> = ({ sellerWords, frame, durationFrames }) => {
  const { page, pageIndex, pages } = pageAt(sellerWords, frame, durationFrames)
  const fontSize = Math.max(28, Math.min(40, Math.round(1800 / Math.sqrt(Math.max(60, page.length)))))
  return (
    <div style={{ position: "absolute", left: 120, right: 120, bottom: 96, padding: "22px 32px", borderRadius: 14, backgroundColor: "rgba(0,0,0,0.55)", color: "#fff" }}>
      <div style={{ fontSize, lineHeight: 1.35, fontWeight: 500 }}>{page}</div>
      {pages.length > 1 && <div style={{ marginTop: 10, fontSize: 18, letterSpacing: 3, opacity: 0.5 }}>{pageIndex + 1} / {pages.length}</div>}
    </div>
  )
}

const ChapterScene: React.FC<{
  chapter: MemoryVideoChapterProps
  index: number
  total: number
  brand: MemoryVideoReelProps["brand"]
  segment: BodyVisualSegment | null
  plan: BodyVisualPlan | null
  mode: MemoryVideoMode | null
  photoUrls: string[]
}> = ({ chapter, index, total, brand, segment, plan, mode, photoUrls }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const enter = interpolate(frame, [0, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const exit = interpolate(frame, [chapter.durationFrames - 12, chapter.durationFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // THE TREATMENT this chapter's plan segment chose — client_footage (the
  // seller on screen), property_photos (the home under the seller's audio),
  // or the words alone. A row with media but no plan (rendered outside the
  // stager) falls back to the MODE it was saved in; a treatment whose media is
  // missing degrades to the words (never a black frame); the gate refuses
  // that upstream.
  const treatment = segment?.treatment
    ?? (mode === "seller_walkthrough" && chapter.videoUrl ? "client_footage" : mode === "seller_audio_photos" && photoUrls.length > 0 ? "property_photos" : null)
  const showFootage = treatment === "client_footage" && !!chapter.videoUrl
  // Slots from the plan; without one, this chapter's photo is its index into
  // the list (cycling) — one photo per chapter, the recommendation the capture
  // rail reports.
  const photoSlots = treatment === "property_photos" && photoUrls.length > 0
    ? (plan && segment ? photoSlotsForSegment(plan, segment.index, photoUrls.length) : [{ from: 0, durationInFrames: chapter.durationFrames, photoIndex: index % photoUrls.length }])
    : []
  // The motion comes from the ONE Ken Burns planner over THIS chapter's
  // assigned photos and window; the slot boundaries come from the plan. The
  // planner tiles the same window with its cross-fades, so clips and slots
  // agree on the count and the total.
  const clips = photoSlots.length > 0
    ? kenBurnsPlan(photoSlots.map((s) => photoUrls[s.photoIndex]), chapter.durationFrames, { fps, maxClips: photoSlots.length, crossfadeFrames: Math.round(fps * 0.4) })
    : []
  const backdropUrl = clips.length > 0 ? clips[Math.min(clips.length - 1, Math.max(0, clips.findIndex((c) => frame < c.fromFrame + c.durationFrames)))]?.url ?? null : null

  if (showFootage) {
    return (
      <AbsoluteFill style={{ color: "#fff", opacity: Math.min(enter, exit) }}>
        {/* client_footage — the seller on screen, walking the home; the clip carries its own sound. */}
        <Video src={chapter.videoUrl as string} objectFit="cover" trimAfter={chapter.durationFrames} style={{ width: "100%", height: "100%" }} />
        <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(0,0,0,0.55), transparent 35%)" }} />
        <ChapterEyebrow index={index} total={total} title={chapter.title} accentColor={brand.accentColor} />
        <WordsStrip sellerWords={chapter.sellerWords} frame={frame} durationFrames={chapter.durationFrames} />
      </AbsoluteFill>
    )
  }

  if (clips.length > 0) {
    return (
      <AbsoluteFill style={{ color: "#fff", opacity: Math.min(enter, exit) }}>
        {chapter.voiceoverUrl && <Audio src={chapter.voiceoverUrl} />}
        {/* blurred_photo background — the current photo, blurred and darkened, behind the letterboxed motion. */}
        {backdropUrl && (
          <SafeImg src={backdropUrl} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(40px) brightness(0.45)", scale: "1.1" }} />
        )}
        {clips.map((clip, i) => (
          <Sequence key={`${chapter.id}-photo-${i}`} from={clip.fromFrame} durationInFrames={clip.durationFrames} layout="none">
            <KenBurnsPhoto clip={clip} brand={brand} showCaption={false} />
          </Sequence>
        ))}
        <ChapterEyebrow index={index} total={total} title={chapter.title} accentColor={brand.accentColor} />
        <WordsStrip sellerWords={chapter.sellerWords} frame={frame} durationFrames={chapter.durationFrames} />
      </AbsoluteFill>
    )
  }

  // The words alone (lane 78D's layout) — an older render row with no media.
  const { page, pageIndex, pages } = pageAt(chapter.sellerWords, frame, chapter.durationFrames)
  const fontSize = Math.max(34, Math.min(60, Math.round(2200 / Math.sqrt(Math.max(60, page.length)))))
  return (
    <AbsoluteFill style={{ color: "#fff", opacity: Math.min(enter, exit) }}>
      {chapter.voiceoverUrl && <Audio src={chapter.voiceoverUrl} />}
      <ChapterEyebrow index={index} total={total} title={chapter.title} accentColor={brand.accentColor} />
      <AbsoluteFill style={{ padding: "180px 160px 140px", justifyContent: "center" }}>
        <div style={{ fontSize, lineHeight: 1.35, fontWeight: 500, maxWidth: 1560, textShadow: "0 6px 30px rgba(0,0,0,0.3)" }}>
          {page}
        </div>
        {pages.length > 1 && (
          <div style={{ marginTop: 36, fontSize: 20, letterSpacing: 3, opacity: 0.5 }}>
            {pageIndex + 1} / {pages.length}
          </div>
        )}
      </AbsoluteFill>
      {brand.logoUrl && (
        <SafeImg src={brand.logoUrl} style={{ position: "absolute", bottom: 48, right: 100, height: 44, objectFit: "contain", opacity: 0.6 }} />
      )}
    </AbsoluteFill>
  )
}

export const MemoryVideoReel: React.FC<MemoryVideoReelProps> = ({ title, familyName, tenureLine, chapters, brand, mode, photoUrls, bodyVisualPlan }) => {
  const { fps, durationInFrames } = useVideoConfig()
  const slots = memoryVideoChapterLayout({ chapters }, fps)
  const total = memoryVideoDurationFrames({ chapters }, fps)
  // The cover is the constant the layout starts after — read from the same
  // helper, so an EMPTY capture still renders cover + outro, never a cover
  // that swallows the whole film.
  const cover = Math.min(total, memoryVideoCoverFrames(fps))
  const lastEnd = slots.length > 0 ? slots[slots.length - 1].from + slots[slots.length - 1].durationInFrames : cover
  const outroFrom = Math.min(lastEnd, total)
  const outroFrames = Math.max(1, total - outroFrom)
  // The plan, re-fitted to the render's own length; one segment per chapter.
  const plan = fitBodyVisualPlan(bodyVisualPlan, "MemoryVideoReel", durationInFrames)
  const photos = (photoUrls ?? []).filter((u) => typeof u === "string" && u.length > 0)

  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <AbsoluteFill style={{ background: `radial-gradient(1400px 900px at 80% 10%, ${brand.accentColor}22, transparent 65%)` }} />
      <AbsoluteFill style={{ background: "radial-gradient(1800px 1200px at 50% 50%, transparent 55%, #00000055 100%)" }} />

      <Sequence from={0} durationInFrames={cover}>
        <CoverScene title={title} familyName={familyName} tenureLine={tenureLine} brand={brand} />
      </Sequence>

      {chapters.map((chapter, i) => (
        <Sequence key={`${chapter.id}-${i}`} from={slots[i].from} durationInFrames={slots[i].durationInFrames}>
          <ChapterScene chapter={chapter} index={i} total={chapters.length} brand={brand}
            segment={plan?.segments[i] ?? null} plan={plan} mode={mode ?? null} photoUrls={photos} />
        </Sequence>
      ))}

      <Sequence from={outroFrom} durationInFrames={outroFrames}>
        <EndCard
          brand={brand}
          headline={`Recorded for the ${familyName}`}
          subline="A story that belongs to you"
          detail={`Made with ${brand.brokerageName}`}
          logoHeight={64}
          showQr={false}
          fadeInFrames={20}
        />
      </Sequence>
    </AbsoluteFill>
  )
}
