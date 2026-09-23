/**
 * remotion/PhotoWalkthroughReel.tsx
 *
 * CINEMATIC photo→walkthrough reel. Turns a flat MLS photo set into a MOVING
 * property tour so a listing with NO video still gets a scroll-stopping reel.
 *
 * The motion is planned PURELY upstream by lib/video/ken-burns-plan.ts
 * (kenBurnsPlan(photos, bodyFrames, opts) → one KenBurnsClip per photo). This
 * composition renders that plan verbatim:
 *
 *   0–2s   CoverFrame      — brokerage logo + hook + address (brand chrome)
 *   2s..   PhotoTour       — each photo as an <Img> with a Ken Burns move
 *                            (interpolate scale + translate over its window)
 *                            and a cross-fade into the next photo; a narrated
 *                            room/tour-beat caption rides each clip via Sequence
 *   last 3s OutroCTA       — agent name + phone + "DM me to tour" + QrOutroBadge
 *
 * Remotion best-practices honored:
 *   · Ken Burns = interpolate(useCurrentFrame()) driving scale + translate over
 *     each photo's frame window. NO CSS transitions, NO Tailwind animation.
 *   · Cross-fade = interpolate opacity at the clip's leading/trailing edges.
 *   · <Img> from "remotion" (not bare <img>); objectFit: "cover" handles
 *     arbitrary photo aspect ratios with no letterboxing.
 *   · Easing.bezier for the editorial pan/zoom curve.
 *
 * Honest fallback: when imageUrls is empty (kenBurnsPlan → []), the body shows
 * a branded "tour coming soon" card instead of a broken render. The Director
 * sees the empty plan and won't pick this format, but the composition is still
 * safe to render directly (Studio preview / defaultProps).
 *
 * Pure-data: no DB access. The render endpoint resolves listing_media photos
 * (file_url, sort_order asc) + brand + optional voiceover/QR and passes them in
 * via inputProps. Reuses the same brand/QR/voiceover contract as JustListedReel
 * so it slots into the same render pipeline + bookends + music-mood.
 */
import React from "react"
import { Audio } from "@remotion/media"
import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { CaptionLayer } from "./components/CaptionLayer"
import { EqualHousingMark } from "./components/EqualHousingMark"
import { EndCard } from "./components/EndCard"
import { KenBurnsPhoto } from "./components/KenBurnsPhoto"
import { kenBurnsPlan, type KenBurnsClip } from "../lib/video/ken-burns-plan"
import { computeAssemblyTimeline } from "../lib/video/assembly-timeline"
import { compositionBookends } from "../lib/video/duration-model"
import type { CaptionCue } from "../lib/video/caption-plan"

export interface PhotoWalkthroughReelProps {
  /** Hook label — "Just Listed" / "Take the Tour" / "Step Inside". */
  hook: string
  /** Property address line. */
  address: string
  /** "City, ST". */
  cityState: string
  /** Property photo URLs in display order (listing_media.file_url, sort_order asc). */
  imageUrls: string[]
  /** Optional per-photo captions (room labels). Aligned to imageUrls order;
   *  missing entries fall back to generic tour beats from the plan. */
  captions?: (string | null | undefined)[]
  /** Brokerage + agent branding (same shape as JustListedReel). */
  brand: {
    primaryColor: string
    accentColor:  string
    logoUrl?:     string
    agentName?:   string
    agentPhone?:  string
    showEhoMark?: boolean
  }
  /** Outro CTA line. Defaults to "DM me to tour." */
  ctaLabel?: string
  /** Voiceover MP3 URL (our Supabase storage). Optional — silent if absent. */
  voiceoverUrl?: string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional + default-off. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR. Defaults to "Scan to tour". */
  qrCaption?: string
  /** MLS-bound cut — suppresses the agent-branded QR badge. */
  mlsClean?: boolean
  /** SOUND-OFF CAPTIONS (additive + default-off). Word-accurate cues from real
   *  ElevenLabs alignment — preferred over captionScript. These are the VO-synced
   *  captions; the per-photo `captions`/roomLabels above are a separate concern. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — raw VO script text; timing estimated in-comp. */
  captionScript?: string | null
}

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

// Bookend windows, from the ONE registry (lib/video/duration-model.ts, wave
// 78 — cover 2s, outro 3s). The PHOTO TOUR fills everything in between; its
// length is computed from the composition's durationInFrames so the same
// component works at any duration calculateMetadata sizes it to.
const BOOKENDS = compositionBookends("PhotoWalkthroughReel")
const COVER_FRAMES = BOOKENDS.introFrames
const OUTRO_FRAMES = BOOKENDS.outroFrames

export const PhotoWalkthroughReel: React.FC<PhotoWalkthroughReelProps> = (props) => {
  const { durationInFrames, fps } = useVideoConfig()

  // The tour occupies the middle. lib/video/assembly-timeline.ts derives the
  // split from the composition's OWN durationInFrames (never a literal) so
  // the same component works at any registered length, and it guarantees
  // intro + body + outro === durationInFrames exactly — no gap, no overrun —
  // even at a pathologically short registration (scripts/video-assembly-
  // simulator.ts §sums proves this against every registered geometry).
  const timeline = computeAssemblyTimeline({
    durationInFrames,
    introFrames: COVER_FRAMES,
    outroFrames: OUTRO_FRAMES,
  })
  const { from: bodyStart, durationInFrames: bodyFrames } = timeline.body
  const { from: outroStart, durationInFrames: outroFrames } = timeline.outro

  // Plan the Ken Burns tour from the photo set. Empty photos → [] (honest).
  const clips = kenBurnsPlan(props.imageUrls, bodyFrames, {
    fps,
    captions: props.captions,
  })

  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0b0c" }}>
      {props.voiceoverUrl && <Audio src={props.voiceoverUrl} />}

      <Sequence from={0} durationInFrames={timeline.intro.durationInFrames}>
        <CoverFrame {...props} />
      </Sequence>

      <Sequence from={bodyStart} durationInFrames={bodyFrames}>
        {clips.length > 0 ? (
          <PhotoTour clips={clips} brand={props.brand} />
        ) : (
          <FallbackCard {...props} />
        )}
      </Sequence>

      <Sequence from={outroStart} durationInFrames={outroFrames}>
        <OutroCTA {...props} />
        <QrOutroBadge
          qrCodeDataUrl={props.qrCodeDataUrl}
          caption={props.qrCaption ?? "Scan to tour"}
          primaryColor={props.brand.primaryColor}
          accentColor={props.brand.accentColor}
          mlsClean={props.mlsClean}
        />
      </Sequence>

      {props.brand.showEhoMark && <EqualHousingMark variant="badge" fontFamily={FONT} />}

      {/* NO CAPTION OVER BRANDING (wave 57) — clip before the outro/QR tile. */}
      <CaptionLayer
        cues={props.captionsCues}
        script={props.captionScript}
        accentColor={props.brand.accentColor}
        hiddenFromFrame={outroStart}
      />
    </AbsoluteFill>
  )
}

// ─── Cover ───────────────────────────────────────────────────────────────────

const CoverFrame: React.FC<PhotoWalkthroughReelProps> = ({ hook, address, cityState, brand }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 15, 45, 60], [0, 1, 1, 0.92], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const rise = interpolate(frame, [0, 30], [40, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, opacity, padding: 80 }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          height: "100%",
          translate: `0 ${rise}px`,
        }}
      >
        {brand.logoUrl && (
          <SafeImg src={brand.logoUrl} style={{ width: 200, height: "auto", marginBottom: 40 }} />
        )}
        <h1 style={{ color: "white", fontSize: 92, margin: 0, fontWeight: 800, letterSpacing: -1, fontFamily: FONT }}>
          {hook}
        </h1>
        {address && (
          <p style={{ color: "white", fontSize: 52, marginTop: 24, opacity: 0.92, fontFamily: FONT }}>{address}</p>
        )}
        {cityState && (
          <p style={{ color: brand.accentColor, fontSize: 34, marginTop: 8, fontFamily: FONT }}>{cityState}</p>
        )}
      </div>
    </AbsoluteFill>
  )
}

// ─── Photo tour ──────────────────────────────────────────────────────────────

const PhotoTour: React.FC<{ clips: KenBurnsClip[]; brand: PhotoWalkthroughReelProps["brand"] }> = ({
  clips,
  brand,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0b0c" }}>
      {clips.map((clip, i) => (
        <Sequence key={i} from={clip.fromFrame} durationInFrames={clip.durationFrames} layout="none">
          <KenBurnsPhoto clip={clip} brand={brand} />
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}

// TOMBSTONE (wave 80C, CLAUDE.md §1.1): the private `KenBurnsPhoto` that
// stood here (scale + pan over the clip's local window, cross-fade, room
// caption) MOVED to remotion/components/KenBurnsPhoto.tsx — the survivor —
// because MemoryVideoReel's seller_audio_photos mode renders the home's
// photos with the same component. Imported above; behaviour byte-identical
// here (showCaption defaults to true).

// ─── Outro ───────────────────────────────────────────────────────────────────

// TOMBSTONE (lane 78D, §1.1): the private `OutroCTA` (CTA + agent name +
// phone, no QR — the EHO badge on this reel rides the cover via
// <EqualHousingMark>) was MERGED onto remotion/components/EndCard.tsx — the
// ONE end card the four outros in this fleet now share. The outro window is
// still whatever computeAssemblyTimeline derives.
const OutroCTA: React.FC<PhotoWalkthroughReelProps> = ({ brand, ctaLabel }) => (
  <EndCard
    brand={brand}
    headline={ctaLabel || "DM me to tour."}
    subline={brand.agentName ?? null}
    detail={brand.agentPhone ?? null}
    footer={null}
    align="start"
    logoHeight={56}
    fontFamily={FONT}
    showQr={false}
  />
)

// ─── Fallback (no photos) ─────────────────────────────────────────────────────

const FallbackCard: React.FC<PhotoWalkthroughReelProps> = ({ address, cityState, brand }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  return (
    <AbsoluteFill
      style={{
        backgroundColor: brand.primaryColor,
        padding: 80,
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        opacity,
      }}
    >
      <div style={{ color: brand.accentColor, fontSize: 30, fontWeight: 700, letterSpacing: 2, fontFamily: FONT }}>
        PROPERTY TOUR
      </div>
      <h1 style={{ color: "white", fontSize: 64, margin: "24px 0 0", fontWeight: 800, fontFamily: FONT }}>
        {address || "New listing"}
      </h1>
      {cityState && (
        <p style={{ color: "white", fontSize: 36, opacity: 0.85, marginTop: 12, fontFamily: FONT }}>{cityState}</p>
      )}
      <p style={{ color: "white", fontSize: 30, opacity: 0.7, marginTop: 40, fontFamily: FONT }}>
        Photos coming soon — message me for the full gallery.
      </p>
    </AbsoluteFill>
  )
}

// EhoBadge MERGED onto the survivor remotion/components/EqualHousingMark.tsx:58
// (variant="badge" fontFamily={FONT} reproduces this exact positioning/style).
// Tombstone — do not reintroduce a third local copy of the mark (§6).
