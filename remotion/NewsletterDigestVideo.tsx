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
import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion"
import { QrOutroBadge } from "./components/QrOutroBadge"

export interface NewsletterDigestVideoProps {
  subject:        string
  marketBeat:     string       // e.g. "Median price up 3.2% vs last month"
  sectionTitles:  string[]     // up to 3 (e.g. "Market Update", "New Listings", "Local News")
  brand: {
    primaryColor:  string
    accentColor:   string
    logoUrl?:      string
    brokerageName: string
  }
  voiceoverUrl?:  string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to read". */
  qrCaption?:     string
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
    </AbsoluteFill>
  )
}

const IntroFrame: React.FC<NewsletterDigestVideoProps> = ({ subject, brand }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 15, 45, 60], [0, 1, 1, 0.9], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ padding: 80, justifyContent: "center", opacity }}>
      {brand.logoUrl && (
        <Img src={brand.logoUrl} style={{ width: 220, height: "auto", marginBottom: 48 }} />
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
  const slideFrames = 70 // ~2.3s per title
  const idx = Math.min(titles.length - 1, Math.floor(frame / slideFrames))
  const localFrame = frame - idx * slideFrames
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
  return (
    <AbsoluteFill style={{ padding: 80, justifyContent: "center", opacity }}>
      {brand.logoUrl && (
        <Img src={brand.logoUrl} style={{ width: 180, height: "auto", marginBottom: 32 }} />
      )}
      <h1 style={{ color: "white", fontSize: 72, margin: 0, fontWeight: 800, lineHeight: 1.1 }}>
        Open the email
      </h1>
      <p style={{ color: brand.accentColor, fontSize: 48, marginTop: 16, fontWeight: 600 }}>
        for this week's full digest
      </p>
      <QrOutroBadge
        qrCodeDataUrl={qrCodeDataUrl}
        caption={qrCaption ?? "Scan to read"}
        primaryColor={brand.primaryColor}
        accentColor={brand.accentColor}
      />
    </AbsoluteFill>
  )
}
