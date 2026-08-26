/**
 * remotion/ExplainerAnimReel.tsx
 *
 * ANIMATED EXPLAINER reel — the in-stack answer to Manim. Where
 * AgentExplainerReel narrates three bullets next to a talking-head PIP, this
 * composition ANIMATES the real-estate *concept itself* as a diagram:
 *   · equity_over_time   → a draw-on equity curve (value line + equity wedge)
 *   · rate_buydown       → two payment bars that grow, with the savings callout
 *   · closing_timeline   → a stepped milestone path that lights up in sequence
 *   · what_monthly_buys  → price-tier bars that rise for each monthly budget
 * …with the agent's avatar PIP narrating over the top, exactly like
 * AgentExplainerReel. This is what Manim does (animated math/diagrams) done
 * natively in Remotion: deterministic, no Python, renders on the existing
 * Chromium rail.
 *
 * The diagram *content* is pure data from lib/charts/explainer-diagram.ts
 * (explainerDiagramSpec(topic, facts)); the geometry is the same deterministic
 * SVG primitives the chart reels use (lib/charts/geometry). This file only
 * ANIMATES — interpolate()/spring()/Sequence per .claude/skills/
 * remotion-best-practices. NO CSS transitions, NO Tailwind animation.
 *
 * 1080×1080 (square) · 18s @ 30fps = 540 frames. Mirrors AgentExplainerReel's
 * format + avatar-optional fallback so it slots into the same render rail.
 *
 * Timeline:
 *   0–3s    COVER     — eyebrow + title; avatar fades in
 *   3–15s   DIAGRAM   — the animated concept diagram (draws on), avatar PIP
 *   15–18s  CTA       — payoff line + agent name + EHO footer
 */
import React from "react"
import { Video } from "@remotion/media"
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion"
import {
  seriesToPoints,
  linePath,
  areaPath,
  verticalBars,
  type Point,
} from "../lib/charts/geometry"
import type {
  DiagramData,
  EquityOverTimeData,
  RateBuydownData,
  ClosingTimelineData,
  WhatMonthlyBuysData,
} from "../lib/charts/explainer-diagram"
import { CaptionLayer } from "./components/CaptionLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"
import type { CaptionCue } from "../lib/video/caption-plan"

export interface ExplainerAnimReelProps {
  /** Short eyebrow above the title. */
  eyebrow:  string
  /** Title for the cover + diagram. */
  title:    string
  /** Caption / assumptions line under the diagram (honest about estimates). */
  caption:  string
  /** Closing payoff line. */
  ctaLabel: string
  /** Whether the diagram has real data. When false, renders an honest
   *  "share your numbers" fallback instead of a fabricated chart. */
  hasData:  boolean
  /** The deterministic diagram data from explainerDiagramSpec(...).data. */
  diagram:  DiagramData | null
  agentName:      string
  avatarVideoUrl: string | null
  agentPhotoUrl:  string | null
  brand: {
    primaryColor:  string
    accentColor:   string
    logoUrl?:      string
    brokerageName: string
    showEhoMark?:  boolean
  }
  /** Tracked outro QR (lib/video/video-qr → mintVideoQr). Default-off: absent → no badge. */
  qrCodeDataUrl?: string | null
  qrCaption?:     string
  mlsClean?:      boolean
  /** SOUND-OFF CAPTIONS (additive + default-off). Word-accurate cues from real
   *  ElevenLabs alignment — preferred over captionScript. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — raw VO script text; timing estimated in-comp. */
  captionScript?: string | null
}

const FPS     = 30
const COVER   = 3 * FPS    // 0-3
const DIAGRAM = 12 * FPS   // 3-15
const CTA     = 3 * FPS    // 15-18
const TOTAL   = COVER + DIAGRAM + CTA  // 540

const ENTER = Easing.bezier(0.16, 1, 0.3, 1)

/** Avatar PIP — top-left 300×300, brand accent ring; avatar video / photo /
 *  initial-card fallback, identical contract to AgentExplainerReel. */
const AvatarPIP: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl:  string | null
  agentName:      string
  accentColor:    string
  primaryColor:   string
  startFrame:     number
  endFrame:       number
}> = ({ avatarVideoUrl, agentPhotoUrl, agentName, accentColor, primaryColor, startFrame, endFrame }) => {
  const ring: React.CSSProperties = {
    position: "absolute", top: 40, left: 40,
    width: 300, height: 300, borderRadius: 150,
    boxShadow: `0 0 0 6px ${accentColor}, 0 18px 36px rgba(0,0,0,0.3)`,
    overflow: "hidden", backgroundColor: primaryColor, zIndex: 5,
  }
  if (avatarVideoUrl) {
    return (
      <div style={ring}>
        <Video src={avatarVideoUrl} objectFit="cover" trimBefore={startFrame} trimAfter={endFrame}
          style={{ width: "100%", height: "100%" }} />
      </div>
    )
  }
  if (agentPhotoUrl) {
    return (
      <div style={ring}>
        <Img src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    )
  }
  return (
    <div style={{
      ...ring, backgroundColor: accentColor,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 120, color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}

// ── diagram canvas geometry ──────────────────────────────────────────────────
const CANVAS = { x: 90, y: 470, w: 900, h: 470 }   // diagram drawing region

const fmtMoney = (n: number): string =>
  n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`

/** Equity-over-time: value line draws on left→right; equity wedge (value −
 *  balance) fills under it. */
const EquityDiagram: React.FC<{ data: EquityOverTimeData; accent: string }> = ({ data, accent }) => {
  const frame = useCurrentFrame()
  const local = frame // diagram Sequence is frame-local
  const draw = interpolate(local, [10, 90], [0, 1], { easing: ENTER, extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  const values = data.points.map((p) => p.value)
  const balances = data.points.map((p) => p.balance)
  const lo = Math.min(...balances, 0)
  const hi = Math.max(...values)
  const box = { width: CANVAS.w, height: CANVAS.h, padX: 20, padY: 30 }
  const valuePts = seriesToPoints(values, box, { min: lo, max: hi })
  const balancePts = seriesToPoints(balances, box, { min: lo, max: hi })
  const baseY = box.height - box.padY

  // Reveal a left→right slice of the points for the draw-on effect.
  const shown = Math.max(2, Math.ceil(valuePts.length * draw))
  const vSlice = valuePts.slice(0, shown)
  const bSlice = balancePts.slice(0, shown)
  // Equity wedge = between the value line (top) and balance line (bottom).
  // Annotated at the CONSTRUCTION site rather than left to inference: the wedge
  // is the one point array in this file assembled by hand instead of returned by
  // seriesToPoints (lib/charts/geometry.ts:46), so it is the only one where a
  // shape mistake would surface as a silently malformed `d` attribute inside
  // linePath rather than as a type error here.
  const wedge: Point[] = [...vSlice, ...[...bSlice].reverse()]
  const wedgePath = wedge.length ? `${linePath(wedge)} Z` : ""

  const finalOp = interpolate(local, [80, 110], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  return (
    <svg viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`} width={CANVAS.w} height={CANVAS.h}
      style={{ position: "absolute", left: CANVAS.x, top: CANVAS.y }}>
      <path d={wedgePath} fill={`${accent}33`} />
      <path d={areaPath(bSlice, baseY)} fill="rgba(255,255,255,0.06)" />
      <path d={linePath(bSlice)} stroke="rgba(255,255,255,0.5)" strokeWidth={4} fill="none" />
      <path d={linePath(vSlice)} stroke={accent} strokeWidth={6} fill="none" strokeLinecap="round" />
      {/* final equity callout */}
      <g opacity={finalOp}>
        <text x={CANVAS.w - 24} y={48} textAnchor="end" fill={accent} fontSize={44} fontWeight={900} fontFamily="system-ui">
          {fmtMoney(data.finalEquity)}
        </text>
        <text x={CANVAS.w - 24} y={80} textAnchor="end" fill="rgba(255,255,255,0.7)" fontSize={22} fontFamily="system-ui">
          equity in year {data.points[data.points.length - 1].year}
        </text>
      </g>
    </svg>
  )
}

/** Rate-buydown: two payment bars grow up; the savings callout pops. */
const BuydownDiagram: React.FC<{ data: RateBuydownData; accent: string }> = ({ data, accent }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const payments = data.bars.map((b) => b.payment)
  const box = { width: CANVAS.w, height: CANVAS.h - 80, padX: 80, padY: 20, gap: 0.5 }
  const bars = verticalBars(payments, box, { min: 0, max: Math.max(...payments) * 1.1 })

  return (
    <div style={{ position: "absolute", left: CANVAS.x, top: CANVAS.y, width: CANVAS.w, height: CANVAS.h }}>
      <svg viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`} width={CANVAS.w} height={CANVAS.h}>
        {bars.map((b, i) => {
          const grow = spring({ frame: frame - 12 - i * 8, fps, config: { damping: 200 } })
          const h = b.h * grow
          const color = i === bars.length - 1 ? accent : "rgba(255,255,255,0.35)"
          return (
            <g key={i}>
              <rect x={b.x} y={b.y + (b.h - h)} width={b.w} height={h} rx={10} fill={color} />
              <text x={b.x + b.w / 2} y={b.y + (b.h - h) - 16} textAnchor="middle" fill="#fff" fontSize={36} fontWeight={800} fontFamily="system-ui" opacity={grow}>
                {fmtMoney(b.value)}
              </text>
              <text x={b.x + b.w / 2} y={box.height + 36} textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize={22} fontFamily="system-ui">
                {data.bars[i].label}
              </text>
            </g>
          )
        })}
      </svg>
      {data.monthlySavings > 0 && (
        <div style={{
          position: "absolute", right: 0, top: 0,
          padding: "12px 22px", borderRadius: 12, background: `${accent}22`,
          opacity: interpolate(frame, [60, 90], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}>
          <div style={{ color: accent, fontSize: 40, fontWeight: 900, fontFamily: "system-ui" }}>
            -{fmtMoney(data.monthlySavings)}/mo
          </div>
          <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 20, fontFamily: "system-ui" }}>
            {fmtMoney(data.annualSavings)}/yr saved
          </div>
        </div>
      )}
    </div>
  )
}

/** Closing timeline: a horizontal path whose milestone dots light up in
 *  sequence as the progress sweeps left→right. */
const TimelineDiagram: React.FC<{ data: ClosingTimelineData; accent: string }> = ({ data, accent }) => {
  const frame = useCurrentFrame()
  const sweep = interpolate(frame, [10, 110], [0, 1], { easing: ENTER, extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const n = data.steps.length
  const lineY = 140
  const x0 = 40, x1 = CANVAS.w - 40
  const xs = data.steps.map((s) => x0 + (x1 - x0) * (data.totalDays > 0 ? s.day / data.totalDays : (s.index / Math.max(1, n - 1))))
  const filledX = x0 + (x1 - x0) * sweep

  return (
    <svg viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`} width={CANVAS.w} height={CANVAS.h}
      style={{ position: "absolute", left: CANVAS.x, top: CANVAS.y }}>
      <line x1={x0} y1={lineY} x2={x1} y2={lineY} stroke="rgba(255,255,255,0.2)" strokeWidth={6} strokeLinecap="round" />
      <line x1={x0} y1={lineY} x2={filledX} y2={lineY} stroke={accent} strokeWidth={6} strokeLinecap="round" />
      {data.steps.map((s, i) => {
        const lit = filledX >= xs[i] - 1
        const x = xs[i]
        const up = i % 2 === 0
        const ly = up ? lineY - 40 : lineY + 40
        return (
          <g key={i} opacity={lit ? 1 : 0.35}>
            <circle cx={x} cy={lineY} r={lit ? 16 : 11} fill={lit ? accent : "rgba(255,255,255,0.4)"} />
            <text x={x} y={up ? ly : ly + 18} textAnchor="middle" fill="#fff" fontSize={20} fontWeight={700} fontFamily="system-ui">
              {s.label}
            </text>
            <text x={x} y={up ? ly - 24 : ly + 42} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize={16} fontFamily="system-ui">
              {s.day === 0 ? "Day 0" : `Day ${s.day}`}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** What-monthly-buys: price-tier bars rise; each labeled with budget → price. */
const MonthlyBuysDiagram: React.FC<{ data: WhatMonthlyBuysData; accent: string }> = ({ data, accent }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const prices = data.tiers.map((t) => t.price)
  const box = { width: CANVAS.w, height: CANVAS.h - 90, padX: 50, padY: 20, gap: 0.45 }
  const bars = verticalBars(prices, box, { min: 0, max: Math.max(...prices) * 1.12 })
  return (
    <svg viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`} width={CANVAS.w} height={CANVAS.h}
      style={{ position: "absolute", left: CANVAS.x, top: CANVAS.y }}>
      {bars.map((b, i) => {
        const grow = spring({ frame: frame - 12 - i * 10, fps, config: { damping: 200 } })
        const h = b.h * grow
        const isTarget = data.tiers[i].monthly === data.targetMonthly
        const color = isTarget ? accent : "rgba(255,255,255,0.35)"
        return (
          <g key={i}>
            <rect x={b.x} y={b.y + (b.h - h)} width={b.w} height={h} rx={10} fill={color} />
            <text x={b.x + b.w / 2} y={b.y + (b.h - h) - 16} textAnchor="middle" fill="#fff" fontSize={34} fontWeight={800} fontFamily="system-ui" opacity={grow}>
              {fmtMoney(data.tiers[i].price)}
            </text>
            <text x={b.x + b.w / 2} y={box.height + 36} textAnchor="middle" fill={isTarget ? accent : "rgba(255,255,255,0.7)"} fontSize={24} fontWeight={isTarget ? 800 : 600} fontFamily="system-ui">
              {data.tiers[i].label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

const Diagram: React.FC<{ data: DiagramData; accent: string }> = ({ data, accent }) => {
  switch (data.kind) {
    case "equity_over_time":  return <EquityDiagram data={data} accent={accent} />
    case "rate_buydown":      return <BuydownDiagram data={data} accent={accent} />
    case "closing_timeline":  return <TimelineDiagram data={data} accent={accent} />
    case "what_monthly_buys": return <MonthlyBuysDiagram data={data} accent={accent} />
  }
}

export const ExplainerAnimReel: React.FC<ExplainerAnimReelProps> = ({
  eyebrow, title, caption, ctaLabel, hasData, diagram,
  agentName, avatarVideoUrl, agentPhotoUrl, brand,
  captionsCues, captionScript, qrCodeDataUrl, qrCaption, mlsClean,
}) => {
  const frame   = useCurrentFrame()
  const showEho = brand.showEhoMark ?? true
  return (
    <AbsoluteFill style={{
      background: `radial-gradient(circle at 30% 0%, ${brand.primaryColor} 0%, #0b1220 85%)`,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* COVER — 0-3s */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {brand.logoUrl && (
            <Img src={brand.logoUrl} style={{
              height: 56, objectFit: "contain", marginBottom: 28,
              opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" }),
            }} />
          )}
          <div style={{
            display: "inline-block", padding: "8px 20px", borderRadius: 4,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 18, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase",
            marginBottom: 28, opacity: interpolate(frame, [4, 20], [0, 1], { extrapolateRight: "clamp" }),
          }}>
            {eyebrow}
          </div>
          <div style={{
            fontSize: 64, fontWeight: 800, color: "#fff", lineHeight: 1.1, maxWidth: 840,
            opacity: interpolate(frame, [12, 36], [0, 1], { extrapolateRight: "clamp" }),
            transform: `translateY(${interpolate(frame, [12, 36], [16, 0], { easing: ENTER, extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
          }}>
            {title}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* DIAGRAM — 3-15s */}
      <Sequence from={COVER} durationInFrames={DIAGRAM}>
        <AbsoluteFill>
          <AvatarPIP {...{ avatarVideoUrl, agentPhotoUrl, agentName,
            accentColor: brand.accentColor, primaryColor: brand.primaryColor,
            startFrame: COVER, endFrame: COVER + DIAGRAM }} />
          {/* Title strip (right of PIP) */}
          <div style={{ position: "absolute", top: 90, left: 380, right: 60 }}>
            <div style={{ width: 56, height: 6, background: brand.accentColor, borderRadius: 3, marginBottom: 14 }} />
            <div style={{ color: "#fff", fontSize: 40, fontWeight: 800, lineHeight: 1.05 }}>{title}</div>
          </div>

          {hasData && diagram ? (
            <Diagram data={diagram} accent={brand.accentColor} />
          ) : (
            <AbsoluteFill style={{
              display: "flex", alignItems: "center", justifyContent: "center", padding: 80,
            }}>
              <div style={{
                color: "rgba(255,255,255,0.85)", fontSize: 40, fontWeight: 700,
                textAlign: "center", maxWidth: 700, lineHeight: 1.3,
              }}>
                Share a few numbers and I&apos;ll show you exactly how this works for you.
              </div>
            </AbsoluteFill>
          )}

          {/* Caption — assumptions, honest about estimates */}
          <div style={{
            position: "absolute", left: 90, right: 90, bottom: 48,
            color: "rgba(255,255,255,0.6)", fontSize: 20, textAlign: "center", lineHeight: 1.35,
          }}>
            {caption}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 15-18s */}
      <Sequence from={COVER + DIAGRAM} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", color: "#fff",
        }}>
          <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.05, marginBottom: 24 }}>{ctaLabel}</div>
          <div style={{ fontSize: 36, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0, textAlign: "center",
            fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5,
          }}>
            {brand.brokerageName}{showEho && " · Equal Housing Opportunity"}
          </div>
          <QrOutroBadge qrCodeDataUrl={qrCodeDataUrl} caption={qrCaption ?? "Scan to book a consult"}
            primaryColor={brand.primaryColor} accentColor={brand.accentColor} mlsClean={mlsClean} />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>

      <CaptionLayer cues={captionsCues} script={captionScript} accentColor={brand.accentColor} />
    </AbsoluteFill>
  )
}
