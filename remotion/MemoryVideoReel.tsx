/**
 * remotion/MemoryVideoReel.tsx
 *
 * THE MEMORY VIDEO — the family's own account of their home, chaptered, on the
 * voiceover host, with NO avatar (lane 78D, blind spot 1; owner ruling in
 * lib/video/memory-video-gate.ts). Horizontal 1920×1080 for the living-room TV.
 *
 *   COVER     silent title card — "The story of <address>", the family's name
 *   CHAPTERS  one Sequence per clip, in the order the seller was asked: the
 *             chapter question as an eyebrow, the seller's words on screen
 *             VERBATIM (MODEL_MAY: "cut a caption strip VERBATIM"), the clip's
 *             narration playing under it (<Audio> per chapter — the
 *             voiceover host; no talking head, because nobody's face is the
 *             star of somebody else's memory)
 *   OUTRO     EndCard — "Recorded for the <family> family", brokerage as the
 *             maker's mark, no QR (a keepsake is not a funnel)
 *
 * LENGTH IS COMPUTED, NOT REGISTERED. Root.tsx's `calculateMetadata` sets
 * durationInFrames = memoryVideoDurationFrames(props) (lib/video/
 * memory-video-composition.ts), so the film runs exactly cover + every clip +
 * outro; the registered duration_frames is only the cap. This composition
 * therefore declares NO frame consts of its own — every slot comes from
 * memoryVideoChapterLayout over the props, and scripts/video-assembly-
 * simulator.ts proves the layout tiles the computed length.
 *
 * Captions: none. The seller's words are on screen for every clip already;
 * a second strip of the same words would cover them (finish-spec captions:
 * false, published there).
 */
import React from "react"
import { Audio } from "@remotion/media"
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { EndCard } from "./components/EndCard"
import {
  MEMORY_VIDEO_PAGE_CHARS,
  memoryVideoChapterLayout,
  memoryVideoCoverFrames,
  memoryVideoDurationFrames,
  splitForSynthesis,
  type MemoryVideoChapterProps,
} from "../lib/video/memory-video-composition"

export interface MemoryVideoReelProps {
  /** "The story of 14 Elm Street" — the film's title. */
  title: string
  /** "The Alvarez family" — whose story it is. */
  familyName: string
  /** "Home since 1979 · 46 years" — the tenure line under the title, or null. */
  tenureLine: string | null
  /** The clips, in chapter order. Each carries its own narration and frames. */
  chapters: MemoryVideoChapterProps[]
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

const ChapterScene: React.FC<{ chapter: MemoryVideoChapterProps; index: number; total: number; brand: MemoryVideoReelProps["brand"] }> = ({ chapter, index, total, brand }) => {
  const frame = useCurrentFrame()
  // The words are paged so a long answer stays readable; each page holds the
  // screen for a share of the clip proportional to its length, which is how
  // the narration reaches it (the same pace on both sides).
  const pages = splitForSynthesis(chapter.sellerWords, MEMORY_VIDEO_PAGE_CHARS)
  const totalChars = Math.max(1, pages.reduce((n, p) => n + p.length, 0))
  let acc = 0
  let pageIndex = 0
  for (let i = 0; i < pages.length; i++) {
    const startFrame = Math.floor((acc / totalChars) * chapter.durationFrames)
    if (frame >= startFrame) pageIndex = i
    acc += pages[i].length
  }
  const page = pages[pageIndex] ?? chapter.sellerWords
  const fontSize = Math.max(34, Math.min(60, Math.round(2200 / Math.sqrt(Math.max(60, page.length)))))
  const enter = interpolate(frame, [0, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const exit = interpolate(frame, [chapter.durationFrames - 12, chapter.durationFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ color: "#fff", opacity: Math.min(enter, exit) }}>
      {chapter.voiceoverUrl && <Audio src={chapter.voiceoverUrl} />}
      <div style={{ position: "absolute", top: 64, left: 100, right: 100, display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ fontSize: 22, letterSpacing: 5, color: brand.accentColor, fontWeight: 700, textTransform: "uppercase" }}>
          Chapter {index + 1} of {total}
        </div>
        <div style={{ fontSize: 22, letterSpacing: 3, opacity: 0.6 }}>{chapter.title}</div>
      </div>
      <div style={{ position: "absolute", top: 108, left: 100, width: 120, height: 4, borderRadius: 2, backgroundColor: brand.accentColor }} />
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

export const MemoryVideoReel: React.FC<MemoryVideoReelProps> = ({ title, familyName, tenureLine, chapters, brand }) => {
  const { fps } = useVideoConfig()
  const slots = memoryVideoChapterLayout({ chapters }, fps)
  const total = memoryVideoDurationFrames({ chapters }, fps)
  // The cover is the constant the layout starts after — read from the same
  // helper, so an EMPTY capture still renders cover + outro, never a cover
  // that swallows the whole film.
  const cover = Math.min(total, memoryVideoCoverFrames(fps))
  const lastEnd = slots.length > 0 ? slots[slots.length - 1].from + slots[slots.length - 1].durationInFrames : cover
  const outroFrom = Math.min(lastEnd, total)
  const outroFrames = Math.max(1, total - outroFrom)

  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <AbsoluteFill style={{ background: `radial-gradient(1400px 900px at 80% 10%, ${brand.accentColor}22, transparent 65%)` }} />
      <AbsoluteFill style={{ background: "radial-gradient(1800px 1200px at 50% 50%, transparent 55%, #00000055 100%)" }} />

      <Sequence from={0} durationInFrames={cover}>
        <CoverScene title={title} familyName={familyName} tenureLine={tenureLine} brand={brand} />
      </Sequence>

      {chapters.map((chapter, i) => (
        <Sequence key={`${chapter.id}-${i}`} from={slots[i].from} durationInFrames={slots[i].durationInFrames}>
          <ChapterScene chapter={chapter} index={i} total={chapters.length} brand={brand} />
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
