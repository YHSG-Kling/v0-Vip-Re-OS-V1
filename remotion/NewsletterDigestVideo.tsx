/**
 * remotion/NewsletterDigestVideo.tsx
 *
 * Cost-bounded newsletter video — rendered ONCE per newsletter_campaigns row
 * and embedded in every recipient's email body. $0.30 per campaign,
 * regardless of recipient count, instead of $0.30 × N.
 *
 * 20 seconds @ 30fps = 600 frames. Vertical 9:16 (1080×1920) so the embedded
 * <video> renders well on mobile email clients (which is where most
 * recipients open).
 *
 *   0–2s   IntroFrame      — brokerage logo + campaign subject line
 *   2–10s  MarketBeat      — "This week in your market" headline strip with
 *                            a key stat (median price / inventory / DOM —
 *                            passed via inputProps.marketBeat)
 *   10–17s SectionHighlights — up to 3 newsletter section titles flashing
 *                              ("Market Update • New Listings • Local News")
 *   17–20s OutroCta        — "Open the email to read this week's digest"
 *
 * Voiceover (ElevenLabs cloned voice) narrates over the entire reel.
 * Composition is pure-data; the render endpoint resolves brand + facts
 * and passes inputProps.
 */
import React from "react"
import { Audio } from "@remotion/media"
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { CaptionLayer } from "./components/CaptionLayer"
import { evenShotSlots } from "../lib/video/assembly-timeline"
import type { CaptionCue } from "../lib/video/caption-plan"

export interface NewsletterDigestVideoProps {
  subject:        string
  marketBeat:     string       // e.g. "Median price up 3.2% vs last month"
  sectionTitles:  string[]     // up to 3 (e.g. "Market Update", "New Listings", "Local News")
  brand: {
    primaryColor:  string
    accentColor:   string
    logoUrl?:      string
    brokerageName: string
    /** Equal Housing Opportunity mark on the outro. Defaults true. This is
     *  MARKET/listing-facing content (median price, inventory, DOM figures)
     *  mailed to every recipient's inbox, so it carries the same fair-housing
     *  mark every other listing/market reel in remotion/** renders (JustListedReel,
     *  MarketUpdateReel, CMAReel, …) — this composition was the one video-shaped
     *  composition in the registry with no showEhoMark prop at all (found in the
     *  wave-48 assembly audit; scripts/video-assembly-simulator.ts §branding
     *  asserts every MARKETING/CHART_REEL composition declares + renders it). */
    showEhoMark?:  boolean
  }
  voiceoverUrl?:  string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to read". */
  qrCaption?:     string
  /** SOUND-OFF CAPTIONS (additive + default-off, wave 61). Precomputed word-accurate
   *  cues built upstream from REAL ElevenLabs alignment — preferred. See CaptionLayer. */
  captionsCues?:  CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — the raw VO script text; CaptionLayer estimates
   *  timing in-composition when no cues are supplied. Absent → no captions. */
  captionScript?: string | null
}

const FRAMES = {
  INTRO_END:    60,
  MARKET_START: 60,
  MARKET_END:   300,
  SECTIONS_START: 300,
  SECTIONS_END:   510,
  OUTRO_START:    510,
  OUTRO_END:      600,
} as const

export const NewsletterDigestVideo: React.FC<NewsletterDigestVideoProps> = (props) => {
  return (
    <AbsoluteFill style={{ backgroundColor: props.brand.primaryColor }}>
      {props.voiceoverUrl && <Audio src={props.voiceoverUrl} />}

      <Sequence from={0} durationInFrames={FRAMES.INTRO_END}>
        <IntroFrame {...props} />
      </Sequence>

      <Sequence from={FRAMES.MARKET_START} durationInFrames={FRAMES.MARKET_END - FRAMES.MARKET_START}>
        <MarketBeat {...props} />
      </Sequence>

      <Sequence from={FRAMES.SECTIONS_START} durationInFrames={FRAMES.SECTIONS_END - FRAMES.SECTIONS_START}>
        <SectionHighlights titles={props.sectionTitles.slice(0, 3)} brand={props.brand} />
      </Sequence>

      <Sequence from={FRAMES.OUTRO_START} durationInFrames={FRAMES.OUTRO_END - FRAMES.OUTRO_START}>
        <OutroCta {...props} />
      </Sequence>

      {/* NO CAPTION OVER THE OUTRO CTA/QR TILE (wave 61, mirrors JustListedReel.tsx) —
          clip before FRAMES.OUTRO_START. */}
      <CaptionLayer
        cues={props.captionsCues}
        script={props.captionScript}
        accentColor={props.brand.accentColor}
        hiddenFromFrame={FRAMES.OUTRO_START}
      />
    </AbsoluteFill>
  )
}

const IntroFrame: React.FC<NewsletterDigestVideoProps> = ({ subject, brand }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 15, 45, 60], [0, 1, 1, 0.9], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ padding: 80, justifyContent: "center", opacity }}>
      {brand.logoUrl && (
        <SafeImg src={brand.logoUrl} style={{ width: 220, height: "auto", marginBottom: 48 }} />
      )}
      <p style={{ color: brand.accentColor, fontSize: 38, fontWeight: 600, marginBottom: 12 }}>
        {brand.brokerageName}
      </p>
      <h1 style={{ color: "white", fontSize: 88, margin: 0, fontWeight: 800, lineHeight: 1.1 }}>
        {subject}
      </h1>
    </AbsoluteFill>
  )
}

const MarketBeat: React.FC<NewsletterDigestVideoProps> = ({ marketBeat, brand }) => {
  const frame = useCurrentFrame()
  const enter = interpolate(frame, [0, 20], [60, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ backgroundColor: "#fff", padding: 80, justifyContent: "center" }}>
      <div style={{
        backgroundColor: brand.primaryColor,
        padding: 64,
        borderRadius: 24,
        translate: `0 ${enter}px`,
        opacity,
      }}>
        <p style={{ color: brand.accentColor, fontSize: 32, fontWeight: 700, marginBottom: 24, textTransform: "uppercase", letterSpacing: 2 }}>
          This week in your market
        </p>
        <h2 style={{ color: "white", fontSize: 72, margin: 0, fontWeight: 800, lineHeight: 1.15 }}>
          {marketBeat}
        </h2>
      </div>
    </AbsoluteFill>
  )
}

const SectionHighlights: React.FC<{ titles: string[]; brand: NewsletterDigestVideoProps["brand"] }> = ({ titles, brand }) => {
  const frame = useCurrentFrame()
  // The SECTIONS window is divided across however many titles actually
  // arrived — the same idiom remotion/JustListedReel.tsx's PropertyImages
  // already uses (lib/video/assembly-timeline.ts evenShotSlots, §6, wave
  // 48's finding replicated here). This used to be a fixed 70 frames
  // (~2.3s/title), sized for exactly 3 titles (`sectionTitles.slice(0, 3)`
  // above): with fewer than 3, `idx` clamped at `titles.length - 1` while
  // `localFrame` kept climbing past `slideFrames`, so the interpolate's
  // `extrapolateRight: "clamp"` held opacity at its LAST breakpoint value —
  // 0 — for the remainder of the 210-frame window. A 1- or 2-title digest
  // (the common case) faded the last title out by frame 70 and then showed
  // BLANK for the rest of SectionHighlights while the voiceover kept
  // narrating over it.
  const windowFrames = FRAMES.SECTIONS_END - FRAMES.SECTIONS_START
  const slots = evenShotSlots(windowFrames, Math.max(1, titles.length))
  const idxFound = slots.findIndex((s) => frame < s.from + s.durationInFrames)
  const idx = idxFound >= 0 ? idxFound : Math.max(0, slots.length - 1)
  const activeSlot = slots[idx] ?? { from: 0, durationInFrames: windowFrames }
  const slideFrames = activeSlot.durationInFrames
  const localFrame = frame - activeSlot.from
  const opacity = interpolate(localFrame, [0, 10, slideFrames - 10, slideFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const t = titles[idx] ?? ""
  return (
    <AbsoluteFill style={{ padding: 80, justifyContent: "center" }}>
      <p style={{ color: brand.accentColor, fontSize: 36, fontWeight: 600, marginBottom: 16, opacity: 0.9 }}>
        Inside this week's digest
      </p>
      <h1 style={{ color: "white", fontSize: 104, fontWeight: 800, lineHeight: 1.05, margin: 0, opacity }}>
        {t}
      </h1>
    </AbsoluteFill>
  )
}

const OutroCta: React.FC<NewsletterDigestVideoProps> = ({ brand, qrCodeDataUrl, qrCaption }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const showEho = brand.showEhoMark ?? true
  return (
    <AbsoluteFill style={{ padding: 80, justifyContent: "center", opacity }}>
      {brand.logoUrl && (
        <SafeImg src={brand.logoUrl} style={{ width: 180, height: "auto", marginBottom: 32 }} />
      )}
      <h1 style={{ color: "white", fontSize: 72, margin: 0, fontWeight: 800, lineHeight: 1.1 }}>
        Open the email
      </h1>
      <p style={{ color: brand.accentColor, fontSize: 48, marginTop: 16, fontWeight: 600 }}>
        for this week's full digest
      </p>
      <div style={{
        position: "absolute", bottom: 26, left: 0, right: 0,
        textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5, color: "#fff",
      }}>
        {brand.brokerageName}{showEho && " · Equal Housing Opportunity"}
      </div>
      <QrOutroBadge
        qrCodeDataUrl={qrCodeDataUrl}
        caption={qrCaption ?? "Scan to read"}
        primaryColor={brand.primaryColor}
        accentColor={brand.accentColor}
      />
    </AbsoluteFill>
  )
}
