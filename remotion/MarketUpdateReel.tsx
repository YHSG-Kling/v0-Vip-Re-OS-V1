/**
 * remotion/MarketUpdateReel.tsx
 *
 * Wave 39 — monthly / weekly market-update explainer reel. Data-
 * driven format the brokerage's content engine fires automatically
 * from the existing market-data-refresh cron: each cycle pulls the
 * latest median price, days-on-market, and inventory trend for the
 * brokerage's farm area, and renders a fresh reel.
 *
 * Format choices:
 *   · 1080×1080 (square) for Meta/IG feed + LinkedIn
 *   · 16s @ 30fps = 480 frames — 3 stat cards × 4s each + cover +
 *     CTA. Long enough to land the data, short enough to retain.
 *   · Each stat card has the same shape: HUGE NUMBER, label, delta
 *     vs prior period with up/down arrow + accent color. The visual
 *     consistency makes the format scannable; the homeowner doesn't
 *     have to re-orient for each stat.
 *   · Persistent avatar PIP top-right so the agent is "narrating
 *     the data" — the differentiator vs the generic Realtor.com /
 *     Redfin market-stat clip embeds competitors share.
 *
 * Timeline:
 *   0–2s   COVER     — area name + period
 *   2–6s   STAT 1    — median sale price + MoM delta
 *   6–10s  STAT 2    — average days on market + delta
 *   10–14s STAT 3    — active listings count + delta
 *   14–16s CTA       — "Want a personalized take?" + agent contact
 *
 * Direction (up/down/flat) and the visual treatment (green/red/
 * neutral) come from the caller — the composer's job is to phrase
 * each metric so "up" is good for the audience. For median price
 * UP is sellers' good news; for days-on-market UP is buyers' good
 * news. The composition trusts the caller's direction choice and
 * just renders.
 */
import React from "react"
import { Video } from "@remotion/media"
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { CaptionLayer } from "./components/CaptionLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"
import type { CaptionCue } from "../lib/video/caption-plan"

export type StatDirection = "up_good" | "up_bad" | "down_good" | "down_bad" | "flat"

export interface MarketStat {
  /** Big number — pre-formatted by the composer ("$675K", "12 days",
   *  "84 listings"). The composition doesn't do number formatting. */
  value:        string
  /** Short label under the number — "MEDIAN SALE PRICE", "AVG DAYS ON MARKET". */
  label:        string
  /** Delta vs prior period — "+3.2% MoM", "-2 days vs last week".
   *  Optional; some stats don't have a meaningful prior. */
  delta?:       string
  direction:    StatDirection
}

export interface MarketUpdateReelProps {
  /** The market area the data covers — "Brickell", "Coral Gables".
   *  Shows on the cover + as a persistent chip on every stat card. */
  areaName:    string
  /** The period the stats cover — "October 2026", "Week of Nov 4". */
  period:      string
  /** Exactly three stats. The format's rhythm depends on three. */
  stats:       [MarketStat, MarketStat, MarketStat]
  /** Closing CTA — "Want my take on your block?" defaults. */
  ctaLabel?:   string
  agentName:   string
  agentPhone?: string
  /** D-ID narration video for the whole reel. */
  avatarVideoUrl: string | null
  agentPhotoUrl:  string | null
  brand: {
    primaryColor:   string
    accentColor:    string
    /** Positive-direction color — defaults to a calm green so the
     *  reel doesn't look like a finance ad. */
    upColor?:       string
    /** Negative-direction color — soft red. */
    downColor?:     string
    logoUrl?:       string
    brokerageName:  string
    showEhoMark?:   boolean
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

const FPS    = 30
const COVER  = 2 * FPS
const STAT   = 4 * FPS
const CTA    = 2 * FPS
const TOTAL  = COVER + STAT * 3 + CTA  // 480 frames = 16s

const DIR_TONE: Record<StatDirection, "good" | "bad" | "neutral"> = {
  up_good:    "good",
  up_bad:     "bad",
  down_good:  "good",
  down_bad:   "bad",
  flat:       "neutral",
}

const DIR_ARROW: Record<StatDirection, string> = {
  up_good:    "▲",
  up_bad:     "▲",
  down_good:  "▼",
  down_bad:   "▼",
  flat:       "→",
}

const StatCard: React.FC<{
  stat:         MarketStat
  index:        1 | 2 | 3
  accentColor:  string
  upColor:      string
  downColor:    string
}> = ({ stat, index, accentColor, upColor, downColor }) => {
  const frame    = useCurrentFrame()
  const tone     = DIR_TONE[stat.direction]
  const dirColor = tone === "good" ? upColor : tone === "bad" ? downColor : "#9CA3AF"

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      justifyContent: "center", alignItems: "flex-start",
      padding: "0 88px 0 88px",
    }}>
      {/* Stat index chip */}
      <div style={{
        display: "inline-block", padding: "6px 16px", borderRadius: 4,
        backgroundColor: accentColor, color: "#0F172A",
        fontSize: 18, fontWeight: 700, letterSpacing: 4, marginBottom: 24,
        opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      }}>
        STAT {index}
      </div>

      {/* Huge number */}
      <div style={{
        fontSize: 168, fontWeight: 900, lineHeight: 0.95, color: "#fff",
        opacity: interpolate(frame, [6, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        marginBottom: 16,
      }}>
        {stat.value}
      </div>

      {/* Label */}
      <div style={{
        fontSize: 28, letterSpacing: 4, color: "#fff", opacity: 0.7,
        textTransform: "uppercase", marginBottom: 28,
      }}>
        {stat.label}
      </div>

      {/* Delta with arrow */}
      {stat.delta && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 12,
          padding: "10px 20px", borderRadius: 8,
          backgroundColor: `${dirColor}33`,  // 20% alpha
          color: dirColor, fontSize: 28, fontWeight: 700,
          opacity: interpolate(frame, [18, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}>
          <span style={{ fontSize: 32 }}>{DIR_ARROW[stat.direction]}</span>
          <span>{stat.delta}</span>
        </div>
      )}
    </div>
  )
}

const AreaChip: React.FC<{ areaName: string; period: string; accentColor: string }> = ({
  areaName, period, accentColor,
}) => (
  <div style={{
    position: "absolute", top: 32, left: 32,
    padding: "8px 16px", borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.55)", color: "#fff",
    fontSize: 16, fontWeight: 600, letterSpacing: 2,
  }}>
    <span style={{ color: accentColor }}>●</span>{" "}
    {areaName.toUpperCase()} · {period.toUpperCase()}
  </div>
)

const AvatarPIP: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl:  string | null
  agentName:      string
  startFrame:     number
  endFrame:       number
  accentColor:    string
  primaryColor:   string
}> = ({ avatarVideoUrl, agentPhotoUrl, agentName, startFrame, endFrame, accentColor, primaryColor }) => {
  const ring: React.CSSProperties = {
    position: "absolute", top: 32, right: 32,
    width: 200, height: 200, borderRadius: 100,
    boxShadow: `0 0 0 4px ${accentColor}, 0 18px 36px rgba(0,0,0,0.25)`,
    overflow: "hidden", backgroundColor: primaryColor,
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
        <SafeImg src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    )
  }
  return (
    <div style={{
      ...ring, backgroundColor: accentColor,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 80, color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}

export const MarketUpdateReel: React.FC<MarketUpdateReelProps> = ({
  areaName, period, stats, ctaLabel, agentName, agentPhone,
  avatarVideoUrl, agentPhotoUrl, brand, captionsCues, captionScript,
  qrCodeDataUrl, qrCaption, mlsClean,
}) => {
  const frame     = useCurrentFrame()
  const upColor   = brand.upColor   ?? "#22C55E"
  const downColor = brand.downColor ?? "#EF4444"
  const showEho   = brand.showEhoMark ?? true
  const finalCta  = ctaLabel ?? "Want my take on your block?"

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* COVER — 0-2s */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {brand.logoUrl && (
            <SafeImg src={brand.logoUrl} style={{
              height: 64, objectFit: "contain", marginBottom: 36,
              opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }} />
          )}
          <div style={{
            display: "inline-block", padding: "10px 24px", borderRadius: 6,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 18, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase",
            marginBottom: 28, opacity: interpolate(frame, [6, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            Market update
          </div>
          <div style={{
            fontSize: 80, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            opacity: interpolate(frame, [12, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {areaName}
          </div>
          <div style={{
            fontSize: 32, color: "#fff", opacity: interpolate(frame, [18, 36], [0, 0.7], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            marginTop: 16,
          }}>
            {period}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* STAT 1 — 2-6s */}
      <Sequence from={COVER} durationInFrames={STAT}>
        <AbsoluteFill style={{ backgroundColor: brand.primaryColor }}>
          <AreaChip areaName={areaName} period={period} accentColor={brand.accentColor} />
          <AvatarPIP {...{ avatarVideoUrl, agentPhotoUrl, agentName,
            accentColor: brand.accentColor, primaryColor: brand.primaryColor,
            startFrame: COVER, endFrame: COVER + STAT }} />
          <StatCard stat={stats[0]} index={1} accentColor={brand.accentColor}
            upColor={upColor} downColor={downColor} />
        </AbsoluteFill>
      </Sequence>

      {/* STAT 2 — 6-10s */}
      <Sequence from={COVER + STAT} durationInFrames={STAT}>
        <AbsoluteFill style={{ backgroundColor: brand.primaryColor }}>
          <AreaChip areaName={areaName} period={period} accentColor={brand.accentColor} />
          <AvatarPIP {...{ avatarVideoUrl, agentPhotoUrl, agentName,
            accentColor: brand.accentColor, primaryColor: brand.primaryColor,
            startFrame: COVER + STAT, endFrame: COVER + STAT * 2 }} />
          <StatCard stat={stats[1]} index={2} accentColor={brand.accentColor}
            upColor={upColor} downColor={downColor} />
        </AbsoluteFill>
      </Sequence>

      {/* STAT 3 — 10-14s */}
      <Sequence from={COVER + STAT * 2} durationInFrames={STAT}>
        <AbsoluteFill style={{ backgroundColor: brand.primaryColor }}>
          <AreaChip areaName={areaName} period={period} accentColor={brand.accentColor} />
          <AvatarPIP {...{ avatarVideoUrl, agentPhotoUrl, agentName,
            accentColor: brand.accentColor, primaryColor: brand.primaryColor,
            startFrame: COVER + STAT * 2, endFrame: COVER + STAT * 3 }} />
          <StatCard stat={stats[2]} index={3} accentColor={brand.accentColor}
            upColor={upColor} downColor={downColor} />
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 14-16s */}
      <Sequence from={COVER + STAT * 3} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 56, fontWeight: 800, lineHeight: 1.1, marginBottom: 28 }}>
            {finalCta}
          </div>
          <div style={{ fontSize: 36, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
          {agentPhone && (
            <div style={{ fontSize: 28, color: "#fff", opacity: 0.85, marginTop: 12 }}>{agentPhone}</div>
          )}
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0,
            textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1,
          }}>
            {brand.brokerageName}{showEho && " · Equal Housing Opportunity"}
          </div>
          <QrOutroBadge qrCodeDataUrl={qrCodeDataUrl} caption={qrCaption ?? "Scan for the full market report"}
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
