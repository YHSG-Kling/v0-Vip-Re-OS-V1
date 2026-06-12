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
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { kenBurnsPlan, type KenBurnsClip } from "../lib/video/ken-burns-plan"

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
}

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

// Bookend windows (frames @ 30fps). Cover = 2s, outro = 3s. The PHOTO TOUR
// fills everything in between; its length is computed from the composition's
// durationInFrames so the same component works at any registered duration.
const COVER_FRAMES = 60
const OUTRO_FRAMES = 90

export const PhotoWalkthroughReel: React.FC<PhotoWalkthroughReelProps> = (props) => {
  const { durationInFrames, fps } = useVideoConfig()

  // The tour occupies the middle. Guard tiny durations so the body window is
  // always positive even at minimal registered lengths.
  const coverFrames = Math.min(COVER_FRAMES, Math.floor(durationInFrames * 0.15))
  const outroFrames = Math.min(OUTRO_FRAMES, Math.floor(durationInFrames * 0.2))
  const bodyStart = coverFrames
  const bodyFrames = Math.max(1, durationInFrames - coverFrames - outroFrames)
  const outroStart = bodyStart + bodyFrames

  // Plan the Ken Burns tour from the photo set. Empty photos → [] (honest).
  const clips = kenBurnsPlan(props.imageUrls, bodyFrames, {
    fps,
    captions: props.captions,
  })

  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0b0c" }}>
      {props.voiceoverUrl && <Audio src={props.voiceoverUrl} />}

      <Sequence from={0} durationInFrames={coverFrames}>
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

      {props.brand.showEhoMark && <EhoBadge />}
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
          transform: `translateY(${rise}px)`,
        }}
      >
        {brand.logoUrl && (
          <Img src={brand.logoUrl} style={{ width: 200, height: "auto", marginBottom: 40 }} />
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

/**
 * One Ken Burns photo: scale + pan via interpolate over the clip's LOCAL frame
 * window (the wrapping Sequence resets useCurrentFrame to 0 at the clip start),
 * plus a lead-in/lead-out opacity cross-fade. Renders the synthesized room
 * caption pinned bottom-left.
 */
const KenBurnsPhoto: React.FC<{ clip: KenBurnsClip; brand: PhotoWalkthroughReelProps["brand"] }> = ({
  clip,
  brand,
}) => {
  const frame = useCurrentFrame()
  const dur = clip.durationFrames

  // Ken Burns scale + pan. translate is expressed as a PERCENT of the frame
  // (panFromXY/panToXY are %), so we drive translate via percent units.
  const scale = interpolate(frame, [0, dur], [clip.startScale, clip.endScale], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const panX = interpolate(frame, [0, dur], [clip.panFromXY[0], clip.panToXY[0]], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const panY = interpolate(frame, [0, dur], [clip.panFromXY[1], clip.panToXY[1]], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // Cross-fade: fade IN over the leading edge, fade OUT over the trailing
  // cross-fade window so the next clip (which has already mounted underneath)
  // shows through. The final clip has crossfadeFrames === 0 → no trailing fade.
  const fadeIn = Math.min(dur, clip.crossfadeFrames > 0 ? clip.crossfadeFrames : 10)
  const fadeOutStart = dur - clip.crossfadeFrames
  const opacity = interpolate(
    frame,
    [0, fadeIn, Math.max(fadeIn, fadeOutStart), dur],
    [0, 1, 1, clip.crossfadeFrames > 0 ? 0 : 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  )

  // Caption fades in just after the photo lands.
  const captionOpacity = interpolate(frame, [Math.min(fadeIn, 8), Math.min(fadeIn, 8) + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={clip.url}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translate(${panX}%, ${panY}%)`,
        }}
      />
      {/* Bottom gradient so the caption is legible over any photo. */}
      <AbsoluteFill
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62), transparent 38%)" }}
      />
      {clip.roomLabel && (
        <div
          style={{
            position: "absolute",
            bottom: 56,
            left: 56,
            opacity: captionOpacity,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 56,
              height: 6,
              borderRadius: 3,
              backgroundColor: brand.accentColor,
            }}
          />
          <div
            style={{
              color: "white",
              fontSize: 46,
              fontWeight: 800,
              letterSpacing: -0.5,
              fontFamily: FONT,
              textShadow: "0 2px 12px rgba(0,0,0,0.4)",
            }}
          >
            {clip.roomLabel}
          </div>
        </div>
      )}
    </AbsoluteFill>
  )
}

// ─── Outro ───────────────────────────────────────────────────────────────────

const OutroCTA: React.FC<PhotoWalkthroughReelProps> = ({ brand, ctaLabel }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, padding: 80, justifyContent: "center", opacity }}>
      {brand.logoUrl && (
        <Img src={brand.logoUrl} style={{ width: 160, height: "auto", marginBottom: 32 }} />
      )}
      <h1 style={{ color: "white", fontSize: 76, margin: 0, fontWeight: 800, fontFamily: FONT }}>
        {ctaLabel || "DM me to tour."}
      </h1>
      {brand.agentName && (
        <p style={{ color: brand.accentColor, fontSize: 44, marginTop: 32, fontWeight: 600, fontFamily: FONT }}>
          {brand.agentName}
        </p>
      )}
      {brand.agentPhone && (
        <p style={{ color: "white", fontSize: 38, opacity: 0.9, marginTop: 8, fontFamily: FONT }}>
          {brand.agentPhone}
        </p>
      )}
    </AbsoluteFill>
  )
}

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

const EhoBadge: React.FC = () => (
  <div
    style={{
      position: "absolute",
      bottom: 24,
      left: 24,
      backgroundColor: "rgba(255,255,255,0.9)",
      color: "#000",
      padding: "6px 12px",
      borderRadius: 6,
      fontSize: 14,
      fontWeight: 600,
      fontFamily: FONT,
    }}
  >
    Equal Housing Opportunity
  </div>
)
