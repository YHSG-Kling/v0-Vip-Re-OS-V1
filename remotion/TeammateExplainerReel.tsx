/**
 * remotion/TeammateExplainerReel.tsx
 *
 * TEAMMATE VIDEO lane — the brand-kit frame around a D-ID avatar explainer.
 * Where AgentExplainerReel keeps the avatar in a PIP next to three bullets,
 * this composition puts the TEAMMATE (the agent's D-ID avatar, narrating with
 * their ElevenLabs voice) FULL-FRAME and wraps the clip in the tenant's brand
 * kit: a branded intro card, a persistent lower-third (agent + brokerage), a
 * logo watermark, and a branded outro CTA card with the tracked QR badge.
 *
 * Format:
 *   · 1080×1080 (square) — one render serves IG/FB feed, LinkedIn, X cards
 *   · 30s @ 30fps = 900 frames:
 *       0–2.5s   INTRO  — logo + eyebrow chip + title (brand card)
 *       2.5–27s  BODY   — full-frame avatar clip, lower-third, watermark
 *       27–30s   OUTRO  — CTA + agent name + brokerage/EHO line + QR badge
 *
 * The avatar mp4 arrives via input_props.avatarVideoUrl, wired in by
 * lib/video/avatar-render-orchestrator when the D-ID talk completes (the
 * commission stages avatarVideoUrl:null; the render is only enqueued AFTER
 * provider acceptance — no fake renders). When avatarVideoUrl is null
 * (defensive preview only) the body falls back to the agent photo card.
 *
 * Copy arrives pre-gated (Fair Housing + Them-First + brand voice ran at
 * commission time in lib/video/avatar-explainer). This composition trusts
 * what it is handed and never redrafts.
 */
import React from "react"
import { Video } from "@remotion/media"
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion"
import { CaptionLayer } from "./components/CaptionLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"
import type { CaptionCue } from "../lib/video/caption-plan"

export interface TeammateExplainerReelProps {
  /** Short eyebrow above the title (e.g. "BUYER BASICS"). 1-3 words. */
  eyebrow: string
  /** Main title — 4-8 words. The "what you'll learn" hook. */
  title: string
  /** Closing CTA — 2-4 words. */
  ctaLabel: string
  /** Agent's display name — lower-third + outro. */
  agentName: string
  /** D-ID-rendered avatar clip (agent narrating via their ElevenLabs voice). */
  avatarVideoUrl: string | null
  /** Static photo fallback when no avatar clip is available. */
  agentPhotoUrl: string | null
  /** Tracked outro QR (lib/video/video-qr). Default-off: absent → no badge. */
  qrCodeDataUrl?: string | null
  qrCaption?: string
  mlsClean?: boolean
  brand: {
    primaryColor: string
    accentColor: string
    logoUrl?: string
    brokerageName: string
    showEhoMark?: boolean
  }
  /** Word-accurate sound-off caption cues (ElevenLabs alignment) — preferred. */
  captionsCues?: CaptionCue[] | null
  /** Fallback: raw narration text; timing estimated in-composition. */
  captionScript?: string | null
}

const FPS   = 30
const INTRO = Math.round(2.5 * FPS) // 75
const BODY  = Math.round(24.5 * FPS) // 735
const OUTRO = 3 * FPS               // 90
const TOTAL = INTRO + BODY + OUTRO  // 900

/** Branded intro card — logo, eyebrow chip, title. */
const IntroCard: React.FC<{
  eyebrow: string
  title: string
  brand: TeammateExplainerReelProps["brand"]
}> = ({ eyebrow, title, brand }) => {
  const frame = useCurrentFrame()
  const barWidth = interpolate(frame, [8, INTRO - 8], [0, 320], { extrapolateRight: "clamp" })
  return (
    <AbsoluteFill
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: 72, textAlign: "center", backgroundColor: brand.primaryColor,
      }}
    >
      {brand.logoUrl ? (
        <Img
          src={brand.logoUrl}
          style={{ height: 64, objectFit: "contain", marginBottom: 30, opacity: interpolate(frame, [0, 12], [0, 1]) }}
        />
      ) : (
        <div style={{ fontSize: 22, letterSpacing: 4, textTransform: "uppercase", color: "#fff", opacity: 0.7 * interpolate(frame, [0, 12], [0, 1]), marginBottom: 30 }}>
          {brand.brokerageName}
        </div>
      )}
      <div
        style={{
          display: "inline-block", padding: "8px 22px", borderRadius: 4,
          backgroundColor: brand.accentColor, color: brand.primaryColor,
          fontSize: 20, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase",
          marginBottom: 30, opacity: interpolate(frame, [4, 18], [0, 1]),
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontSize: 66, fontWeight: 800, color: "#fff", lineHeight: 1.1, maxWidth: 880,
          opacity: interpolate(frame, [10, 32], [0, 1]),
          transform: `translateY(${interpolate(frame, [10, 32], [24, 0], { extrapolateRight: "clamp" })}px)`,
        }}
      >
        {title}
      </div>
      <div style={{ width: barWidth, height: 6, borderRadius: 3, backgroundColor: brand.accentColor, marginTop: 36 }} />
    </AbsoluteFill>
  )
}

/** Persistent lower-third: accent bar + agent name + brokerage. */
const LowerThird: React.FC<{
  agentName: string
  brokerageName: string
  primaryColor: string
  accentColor: string
}> = ({ agentName, brokerageName, primaryColor, accentColor }) => {
  const frame = useCurrentFrame()
  const slideIn = interpolate(frame, [0, 16], [-560, 0], { extrapolateRight: "clamp" })
  return (
    <div style={{ position: "absolute", left: 0, bottom: 168, transform: `translateX(${slideIn}px)` }}>
      <div
        style={{
          display: "flex", alignItems: "stretch",
          backgroundColor: `${primaryColor}E6`,
          borderRadius: "0 8px 8px 0", overflow: "hidden",
          boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ width: 10, backgroundColor: accentColor }} />
        <div style={{ padding: "16px 28px 16px 20px" }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#fff", lineHeight: 1.1 }}>{agentName}</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: accentColor, letterSpacing: 1, marginTop: 4 }}>
            {brokerageName}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Full-frame avatar body with watermark + lower-third. */
const AvatarBody: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl: string | null
  agentName: string
  title: string
  brand: TeammateExplainerReelProps["brand"]
}> = ({ avatarVideoUrl, agentPhotoUrl, agentName, title, brand }) => {
  const frame = useCurrentFrame()
  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor }}>
      {avatarVideoUrl ? (
        <Video
          objectFit="cover"
          src={avatarVideoUrl}
          style={{ width: "100%", height: "100%", opacity: fadeIn }}
        />
      ) : agentPhotoUrl ? (
        // Honest fallback frame — the avatar clip has not been wired in.
        <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 72, opacity: fadeIn }}>
          <div style={{ width: 460, height: 460, borderRadius: 230, overflow: "hidden", boxShadow: `0 0 0 8px ${brand.accentColor}` }}>
            <Img src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <div style={{ fontSize: 44, fontWeight: 700, color: "#fff", marginTop: 44, textAlign: "center", maxWidth: 860, lineHeight: 1.25 }}>
            {title}
          </div>
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", opacity: fadeIn }}>
          <div style={{ fontSize: 200, fontWeight: 800, color: brand.accentColor }}>
            {(agentName[0] ?? "A").toUpperCase()}
          </div>
        </AbsoluteFill>
      )}

      {/* Logo watermark — top-right, subtle. */}
      {brand.logoUrl && (
        <Img
          src={brand.logoUrl}
          style={{ position: "absolute", top: 40, right: 40, height: 52, objectFit: "contain", opacity: 0.85 }}
        />
      )}

      <LowerThird
        agentName={agentName}
        brokerageName={brand.brokerageName}
        primaryColor={brand.primaryColor}
        accentColor={brand.accentColor}
      />
    </AbsoluteFill>
  )
}

/** Branded outro CTA card. */
const OutroCard: React.FC<{
  ctaLabel: string
  agentName: string
  brand: TeammateExplainerReelProps["brand"]
  qrCodeDataUrl?: string | null
  qrCaption?: string
  mlsClean?: boolean
}> = ({ ctaLabel, agentName, brand, qrCodeDataUrl, qrCaption, mlsClean }) => {
  const frame = useCurrentFrame()
  const showEho = brand.showEhoMark ?? true
  return (
    <AbsoluteFill
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: 72, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
      }}
    >
      {brand.logoUrl && (
        <Img src={brand.logoUrl} style={{ height: 56, objectFit: "contain", marginBottom: 28, opacity: interpolate(frame, [0, 10], [0, 1]) }} />
      )}
      <div
        style={{
          fontSize: 76, fontWeight: 800, lineHeight: 1.05, marginBottom: 24, maxWidth: 900,
          opacity: interpolate(frame, [4, 20], [0, 1]),
          transform: `translateY(${interpolate(frame, [4, 20], [20, 0], { extrapolateRight: "clamp" })}px)`,
        }}
      >
        {ctaLabel}
      </div>
      <div style={{ fontSize: 38, color: brand.accentColor, fontWeight: 700, opacity: interpolate(frame, [12, 26], [0, 1]) }}>
        {agentName}
      </div>
      <div
        style={{
          position: "absolute", bottom: 26, left: 0, right: 0,
          textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5,
        }}
      >
        {brand.brokerageName}
        {showEho && " · Equal Housing Opportunity"}
      </div>
      <QrOutroBadge
        qrCodeDataUrl={qrCodeDataUrl}
        caption={qrCaption ?? "Scan to book a consult"}
        primaryColor={brand.primaryColor}
        accentColor={brand.accentColor}
        mlsClean={mlsClean}
      />
    </AbsoluteFill>
  )
}

export const TeammateExplainerReel: React.FC<TeammateExplainerReelProps> = ({
  eyebrow, title, ctaLabel, agentName, avatarVideoUrl, agentPhotoUrl,
  qrCodeDataUrl, qrCaption, mlsClean, brand, captionsCues, captionScript,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* INTRO — brand card */}
      <Sequence from={0} durationInFrames={INTRO}>
        <IntroCard eyebrow={eyebrow} title={title} brand={brand} />
      </Sequence>

      {/* BODY — full-frame teammate avatar with lower-third + watermark */}
      <Sequence from={INTRO} durationInFrames={BODY}>
        <AvatarBody
          avatarVideoUrl={avatarVideoUrl}
          agentPhotoUrl={agentPhotoUrl}
          agentName={agentName}
          title={title}
          brand={brand}
        />
      </Sequence>

      {/* OUTRO — brand CTA card */}
      <Sequence from={INTRO + BODY} durationInFrames={OUTRO}>
        <OutroCard
          ctaLabel={ctaLabel}
          agentName={agentName}
          brand={brand}
          qrCodeDataUrl={qrCodeDataUrl}
          qrCaption={qrCaption}
          mlsClean={mlsClean}
        />
      </Sequence>

      {/* Anchor frame keeps TOTAL authoritative for the registry (900). */}
      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>

      {/* Sound-off captions across the whole reel (default-off when absent). */}
      <CaptionLayer cues={captionsCues} script={captionScript} accentColor={brand.accentColor} />
    </AbsoluteFill>
  )
}
