/**
 * remotion/CMAReel.tsx — Wave 39 chart layer.
 *
 * The Comparative Market Analysis reel: a narrated, data-driven CMA as a
 * social/listing-presentation video. Chains the four chart components
 * (price trend → comps → days-on-market → affordability) with brokerage
 * brand chrome + an optional avatar/voiceover narration track. This is the
 * differentiator — MoxiWorks/kvCORE produce a static CMA PDF; we render an
 * animated, AI-search-citable CMA video.
 *
 * 1080×1080, 24s @ 30fps = 720 frames. Data comes from the caller's
 * RentCast/comps payload via inputProps (the m172 render queue + W40 ad
 * producer supply it). Charts are deterministic SVG (lib/charts/geometry).
 */
import React from "react"
import { Audio } from "@remotion/media"
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion"
import { PriceTrendLine } from "./charts/PriceTrendLine"
import { CompsBar, type CompRow } from "./charts/CompsBar"
import { DaysOnMarketBars } from "./charts/DaysOnMarketBars"
import { AffordabilityDonut, type DonutSegmentInput } from "./charts/AffordabilityDonut"
import { QrOutroBadge } from "./components/QrOutroBadge"

interface Brand {
  primaryColor:  string
  accentColor:   string
  brokerageName?: string
  agentName?:    string
  showEhoMark?:  boolean
}

export interface CMAReelProps {
  subjectAddress: string
  areaName:       string
  priceTrend:     { values: number[]; labels: string[] }
  comps:          CompRow[]
  daysOnMarket:   { values: number[]; labels: string[] }
  affordability:  { segments: DonutSegmentInput[]; centerValue: string }
  ctaLabel:       string
  brand:          Brand
  voiceoverUrl?:  string | null
  /** Tracked outro QR (lib/video/video-qr → mintVideoQr). Default-off: absent → no badge. */
  qrCodeDataUrl?: string | null
  qrCaption?:     string
  mlsClean?:      boolean
}

const Slide: React.FC<{ from: number; durationInFrames: number; title: string; accent: string; children: React.ReactNode }> = ({
  from, durationInFrames, title, accent, children,
}) => (
  <Sequence from={from} durationInFrames={durationInFrames}>
    <SlideBody title={title} accent={accent}>{children}</SlideBody>
  </Sequence>
)

const SlideBody: React.FC<{ title: string; accent: string; children: React.ReactNode }> = ({ title, accent, children }) => {
  const frame = useCurrentFrame()
  const titleY = interpolate(frame, [0, 12], [20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const op = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ padding: 70, justifyContent: "flex-start" }}>
      <div style={{ transform: `translateY(${titleY}px)`, opacity: op, marginBottom: 24 }}>
        <div style={{ width: 56, height: 6, background: accent, borderRadius: 3, marginBottom: 16 }} />
        <div style={{ color: "#fff", fontSize: 40, fontWeight: 800, fontFamily: "system-ui", letterSpacing: -0.5 }}>{title}</div>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</div>
    </AbsoluteFill>
  )
}

export const CMAReel: React.FC<CMAReelProps> = (props) => {
  const { brand } = props
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 30% 0%, ${brand.primaryColor} 0%, #0b1220 80%)` }}>
      {props.voiceoverUrl ? <Audio src={props.voiceoverUrl} /> : null}

      {/* Cover */}
      <Sequence from={0} durationInFrames={90}>
        <AbsoluteFill style={{ padding: 80, justifyContent: "center" }}>
          <div style={{ color: brand.accentColor, fontSize: 24, fontWeight: 700, letterSpacing: 4, fontFamily: "system-ui" }}>COMPARATIVE MARKET ANALYSIS</div>
          <div style={{ color: "#fff", fontSize: 64, fontWeight: 900, fontFamily: "system-ui", lineHeight: 1.05, marginTop: 16 }}>{props.subjectAddress}</div>
          <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 30, fontFamily: "system-ui", marginTop: 12 }}>{props.areaName}</div>
        </AbsoluteFill>
      </Sequence>

      <Slide from={90} durationInFrames={150} title="Median price trend" accent={brand.accentColor}>
        <PriceTrendLine values={props.priceTrend.values} labels={props.priceTrend.labels} color={brand.accentColor} />
      </Slide>

      <Slide from={240} durationInFrames={150} title="How it compares" accent={brand.accentColor}>
        <CompsBar rows={props.comps} subjectColor={brand.accentColor} />
      </Slide>

      <Slide from={390} durationInFrames={150} title="Days on market" accent={brand.accentColor}>
        <DaysOnMarketBars values={props.daysOnMarket.values} labels={props.daysOnMarket.labels} unit="d" />
      </Slide>

      <Slide from={540} durationInFrames={150} title="What it costs / month" accent={brand.accentColor}>
        <AffordabilityDonut segments={props.affordability.segments} centerValue={props.affordability.centerValue} />
      </Slide>

      {/* CTA */}
      <Sequence from={690} durationInFrames={30}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 80 }}>
          <div style={{ color: "#fff", fontSize: 48, fontWeight: 800, fontFamily: "system-ui", textAlign: "center" }}>{props.ctaLabel}</div>
          {brand.agentName && <div style={{ color: brand.accentColor, fontSize: 28, fontFamily: "system-ui", marginTop: 12 }}>{brand.agentName}</div>}
          <QrOutroBadge qrCodeDataUrl={props.qrCodeDataUrl} caption={props.qrCaption ?? "Scan for your home value"}
            primaryColor={brand.primaryColor} accentColor={brand.accentColor} mlsClean={props.mlsClean} />
        </AbsoluteFill>
      </Sequence>

      {/* Persistent brand footer */}
      <AbsoluteFill style={{ justifyContent: "flex-end", padding: 36, pointerEvents: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "rgba(255,255,255,0.55)", fontSize: 18, fontFamily: "system-ui" }}>
          <span>{brand.brokerageName ?? ""}</span>
          {brand.showEhoMark && <span>Equal Housing Opportunity</span>}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
