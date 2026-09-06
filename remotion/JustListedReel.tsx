/**
 * remotion/JustListedReel.tsx
 *
 * Branded property reel composition for the Just Listed / Just Sold /
 * Price Update auto-promo flow (Wave 14). 25 seconds @ 30 fps:
 *
 *   0–2s   CoverFrame      — brokerage logo + "Just Listed" hook + address
 *   2–18s  PropertyImages  — image grid panning ken-burns through up to
 *                            8 property photos (sort_order asc); the 16s
 *                            window is split evenly across however many
 *                            photos arrived (2s each at the full 8), with
 *                            a 0.3s crossfade
 *   18–22s FactCards       — price / beds / baths / sqft in brand colors
 *   22–25s CTAFrame        — agent name + phone + "DM me to tour"
 *
 * Voiceover audio (ElevenLabs cloned voice) plays under the entire reel
 * via the <Audio> primitive — the agent's cloned voice narrates the
 * facts while the visuals show the property.
 *
 * Branding pulls from props.brand (brokerage primary + accent colors,
 * logo URL, EHO mark when set on the brokerage). The composition is
 * pure-data — no DB access; the render endpoint resolves data and
 * passes it in via inputProps.
 */
import React from "react"
import { Audio } from "@remotion/media"
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { CaptionLayer } from "./components/CaptionLayer"
import type { CaptionCue } from "../lib/video/caption-plan"

export interface JustListedReelProps {
  /** Hook label — "Just Listed" / "Just Sold" / "Price Update". */
  hook: string
  /** Property address line. */
  address: string
  /** "City, ST". */
  cityState: string
  /** USD-formatted price string, e.g. "$625,000". */
  price: string
  bedrooms: string
  bathrooms: string
  sqft: string
  /** Property images in display order. 1-8 images supported. */
  imageUrls: string[]
  /** Brokerage + agent branding. */
  brand: {
    primaryColor: string
    accentColor:  string
    logoUrl?:     string
    agentName?:   string
    agentPhone?:  string
    showEhoMark?: boolean
  }
  /** Voiceover MP3 URL (our Supabase storage). Optional — composition
   *  works silent if the TTS step failed. */
  voiceoverUrl?: string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to tour". */
  qrCaption?: string
  /** SOUND-OFF CAPTIONS (additive + default-off). Precomputed word-accurate cues
   *  built upstream from REAL ElevenLabs alignment — preferred. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — the raw VO script text; the CaptionLayer
   *  estimates timing in-composition when no cues are supplied. Absent → no captions. */
  captionScript?: string | null
}

// 25 seconds @ 30 fps = 750 frames. Component breakdown in frames:
const FRAMES = {
  COVER_END:    60,    // 0–2s
  IMAGES_START: 60,
  IMAGES_END:   540,   // 16s of images (8 × 2s)
  FACTS_START:  540,
  FACTS_END:    660,   // 4s of facts
  CTA_START:    660,
  CTA_END:      750,   // 3s
} as const

export const JustListedReel: React.FC<JustListedReelProps> = (props) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#111" }}>
      {props.voiceoverUrl && <Audio src={props.voiceoverUrl} />}

      <Sequence from={0} durationInFrames={FRAMES.COVER_END}>
        <CoverFrame {...props} />
      </Sequence>

      <Sequence from={FRAMES.IMAGES_START} durationInFrames={FRAMES.IMAGES_END - FRAMES.IMAGES_START}>
        <PropertyImages images={props.imageUrls.slice(0, 8)} />
      </Sequence>

      <Sequence from={FRAMES.FACTS_START} durationInFrames={FRAMES.FACTS_END - FRAMES.FACTS_START}>
        <FactCards {...props} />
      </Sequence>

      <Sequence from={FRAMES.CTA_START} durationInFrames={FRAMES.CTA_END - FRAMES.CTA_START}>
        <CTAFrame {...props} />
        <QrOutroBadge
          qrCodeDataUrl={props.qrCodeDataUrl}
          caption={props.qrCaption ?? "Scan to tour"}
          primaryColor={props.brand.primaryColor}
          accentColor={props.brand.accentColor}
        />
      </Sequence>

      {props.brand.showEhoMark && <EhoBadge />}

      <CaptionLayer
        cues={props.captionsCues}
        script={props.captionScript}
        accentColor={props.brand.accentColor}
      />
    </AbsoluteFill>
  )
}

// ─── Frames ─────────────────────────────────────────────────────────────────

const CoverFrame: React.FC<JustListedReelProps> = ({ hook, address, cityState, brand }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 15, 45, 60], [0, 1, 1, 0.85], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, opacity, padding: 80 }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: "100%" }}>
        {brand.logoUrl && (
          <SafeImg src={brand.logoUrl} style={{ width: 200, height: "auto", marginBottom: 40 }} />
        )}
        <h1 style={{ color: "white", fontSize: 96, margin: 0, fontWeight: 800, letterSpacing: -1 }}>
          {hook}
        </h1>
        <p style={{ color: "white", fontSize: 56, marginTop: 24, opacity: 0.9 }}>{address}</p>
        <p style={{ color: brand.accentColor, fontSize: 36, marginTop: 8 }}>{cityState}</p>
      </div>
    </AbsoluteFill>
  )
}

const PropertyImages: React.FC<{ images: string[] }> = ({ images }) => {
  const frame = useCurrentFrame()
  // The window is divided across however many images actually arrived — the
  // same idiom as JustListedReelSquare/Horizontal's `perPhoto`. This used to be
  // a fixed 60 frames (2s), sized for the full 8 images: with fewer, the last
  // slide's crossfade-out clamped opacity to 0 and the remaining seconds of the
  // 16s window rendered EMPTY (gradient over the #111 background) while the
  // voiceover kept narrating.
  const windowFrames = FRAMES.IMAGES_END - FRAMES.IMAGES_START
  const slideFrames = images.length > 0 ? windowFrames / images.length : windowFrames
  const idx = Math.min(images.length - 1, Math.floor(frame / slideFrames))
  const localFrame = frame - idx * slideFrames
  // Ken-burns: subtle scale + drift over each slide
  const scale = interpolate(localFrame, [0, slideFrames], [1.0, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp", output: "perceptual-scale" })
  const opacity = interpolate(localFrame, [0, 8, slideFrames - 8, slideFrames], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const url = images[idx]
  if (!url) return null
  return (
    <AbsoluteFill>
      <SafeImg
        src={url}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          scale,
          opacity,
        }}
      />
      <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(0,0,0,0.6), transparent 40%)" }} />
    </AbsoluteFill>
  )
}

const FactCards: React.FC<JustListedReelProps> = ({ price, bedrooms, bathrooms, sqft, brand }) => {
  const frame = useCurrentFrame()
  const enter = interpolate(frame, [0, 20], [60, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const cards = [
    { label: "Price",    value: price    || "—" },
    { label: "Beds",     value: bedrooms || "—" },
    { label: "Baths",    value: bathrooms|| "—" },
    { label: "Sq Ft",    value: sqft     || "—" },
  ].filter((c) => c.value !== "—")
  return (
    <AbsoluteFill style={{ backgroundColor: "#fff", padding: 80, justifyContent: "center" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(cards.length, 4)}, 1fr)`,
        gap: 32,
        translate: `0 ${enter}px`,
        opacity,
      }}>
        {cards.map((c) => (
          <div key={c.label}
            style={{
              padding: 32,
              backgroundColor: brand.primaryColor,
              borderRadius: 16,
              color: "white",
              textAlign: "center",
            }}>
            <div style={{ fontSize: 28, opacity: 0.75, fontWeight: 500 }}>{c.label}</div>
            <div style={{ fontSize: 64, fontWeight: 800, marginTop: 12 }}>{c.value}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  )
}

const CTAFrame: React.FC<JustListedReelProps> = ({ brand }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 15, 75, 90], [0, 1, 1, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, padding: 80, justifyContent: "center", opacity }}>
      {brand.logoUrl && (
        <SafeImg src={brand.logoUrl} style={{ width: 160, height: "auto", marginBottom: 32 }} />
      )}
      <h1 style={{ color: "white", fontSize: 80, margin: 0, fontWeight: 800 }}>DM me to tour.</h1>
      {brand.agentName && (
        <p style={{ color: brand.accentColor, fontSize: 48, marginTop: 32, fontWeight: 600 }}>
          {brand.agentName}
        </p>
      )}
      {brand.agentPhone && (
        <p style={{ color: "white", fontSize: 40, opacity: 0.9, marginTop: 8 }}>{brand.agentPhone}</p>
      )}
    </AbsoluteFill>
  )
}

const EhoBadge: React.FC = () => (
  <div style={{
    position: "absolute",
    bottom: 24,
    left: 24,
    backgroundColor: "rgba(255,255,255,0.9)",
    color: "#000",
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
  }}>
    Equal Housing Opportunity
  </div>
)
