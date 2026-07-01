/**
 * remotion/AgentExplainerReel.tsx
 *
 * Wave 39 — generic explainer composition. Reusable across the
 * highest-engagement educational formats in real estate:
 *   "3 things to know before bidding"
 *   "what closing costs actually cover"
 *   "the difference between pre-qualified and pre-approved"
 *   "what your inspection report should flag"
 *
 * Format choices:
 *   · 1080×1080 (square) so the same render serves Meta/IG feed,
 *     LinkedIn sponsored content, and X/Twitter cards
 *   · 18s @ 30fps = 540 frames — long enough for the avatar to
 *     deliver three bullets + intro/outro, short enough that paid
 *     completion-rate doesn't collapse
 *   · Avatar lives in a TOP-LEFT 360×360 picture-in-picture so it
 *     stays present on every frame; the bullet content takes the
 *     center-right region. Studies of explainer-format social
 *     consistently show a persistent talking head beats cuts.
 *
 * Shape (timeline):
 *   0–3s   COVER       — eyebrow + title; avatar fades in
 *   3–6s   BULLET 1    — left avatar, right bullet 1 with index "1"
 *   6–10s  BULLET 2    — avatar, bullet 2 with index "2"
 *   10–15s BULLET 3    — avatar, bullet 3 with index "3"
 *   15–18s CTA         — avatar steps full-frame, agent name + CTA
 *
 * The avatar mp4 + voiceover sync is done upstream (D-ID Talks
 * stitches the three bullets into one continuous narration). When
 * the avatar is null, the composition falls back to a typography-
 * only version that still ships ad-ready.
 *
 * Caller passes pre-gated copy. The composition does no compliance
 * checks itself; the preset save path ran Fair Housing + Them-First
 * before the render queued.
 */
import React from "react"
import {
  AbsoluteFill,
  Img,
  Sequence,
  Video,
  interpolate,
  useCurrentFrame,
} from "remotion"
import { CaptionLayer } from "./components/CaptionLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"
import type { CaptionCue } from "../lib/video/caption-plan"

export interface AgentExplainerReelProps {
  /** Short eyebrow above title (e.g. "FIRST-TIME BUYER"). 1-3 words. */
  eyebrow:     string
  /** Main title — 4-8 words. The "what you'll learn" hook. */
  title:       string
  /** Exactly three bullets — each 6-14 words. The composition
   *  is shaped around the three-bullet rhythm; longer lists lose
   *  retention in the format. */
  bullets:     [string, string, string]
  /** Closing CTA — 2-4 words. */
  ctaLabel:    string
  /** Agent's display name — shows in cover + outro. */
  agentName:   string
  /** D-ID-rendered avatar video URL with the agent narrating
   *  the cover + 3 bullets + CTA in one continuous take. */
  avatarVideoUrl: string | null
  /** Static photo fallback when no avatar video is available. */
  agentPhotoUrl:  string | null
  /** Tracked outro QR (lib/video/video-qr → mintVideoQr). Default-off: absent → no badge. */
  qrCodeDataUrl?: string | null
  qrCaption?:     string
  mlsClean?:      boolean
  brand: {
    primaryColor:    string
    accentColor:     string
    logoUrl?:        string
    brokerageName:   string
    showEhoMark?:    boolean
  }
  /** SOUND-OFF CAPTIONS (additive + default-off). Word-accurate cues from real
   *  ElevenLabs alignment — preferred over captionScript. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — raw VO script text; timing estimated in-comp. */
  captionScript?: string | null
}

const FPS    = 30
const COVER  = 3  * FPS
const B1     = 3  * FPS  // 3-6
const B2     = 4  * FPS  // 6-10
const B3     = 5  * FPS  // 10-15
const CTA    = 3  * FPS  // 15-18
const TOTAL  = COVER + B1 + B2 + B3 + CTA

/** Avatar PIP — 360×360, top-left, with the brand accent ring.
 *  Sized so it stays present without eating the bullet column.
 *  When no video is available, falls back to the agent photo or
 *  an initial card. */
const AvatarPIP: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl:  string | null
  agentName:      string
  accentColor:    string
  primaryColor:   string
  startFrame:     number
  endFrame:       number
}> = ({ avatarVideoUrl, agentPhotoUrl, agentName, accentColor, primaryColor, startFrame, endFrame }) => {
  const ringStyle: React.CSSProperties = {
    position: "absolute", top: 48, left: 48,
    width: 360, height: 360,
    borderRadius: 180,
    boxShadow: `0 0 0 6px ${accentColor}`,
    overflow: "hidden",
    backgroundColor: primaryColor,
  }
  if (avatarVideoUrl) {
    return (
      <div style={ringStyle}>
        <Video
          src={avatarVideoUrl}
          startFrom={startFrame}
          endAt={endFrame}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    )
  }
  if (agentPhotoUrl) {
    return (
      <div style={ringStyle}>
        <Img src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    )
  }
  return (
    <div style={{
      ...ringStyle,
      backgroundColor: accentColor,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 140, color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}

const BulletPanel: React.FC<{
  index:        1 | 2 | 3
  text:         string
  accentColor:  string
}> = ({ index, text, accentColor }) => {
  const frame = useCurrentFrame()
  const indexFade  = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" })
  const textFade   = interpolate(frame, [8, 24], [0, 1], { extrapolateRight: "clamp" })
  return (
    <div style={{
      position: "absolute", top: 0, right: 0, bottom: 0,
      left: 440, padding: 56,
      display: "flex", flexDirection: "column", justifyContent: "center",
    }}>
      <div style={{
        fontSize: 140, fontWeight: 900, color: accentColor, lineHeight: 0.9,
        marginBottom: 16, opacity: indexFade,
      }}>
        {index}.
      </div>
      <div style={{
        fontSize: 44, fontWeight: 700, color: "#fff", lineHeight: 1.25,
        opacity: textFade,
      }}>
        {text}
      </div>
    </div>
  )
}

export const AgentExplainerReel: React.FC<AgentExplainerReelProps> = ({
  eyebrow, title, bullets, ctaLabel, agentName, avatarVideoUrl, agentPhotoUrl, brand,
  captionsCues, captionScript, qrCodeDataUrl, qrCaption, mlsClean,
}) => {
  const frame   = useCurrentFrame()
  const showEho = brand.showEhoMark ?? true
  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
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
              opacity: interpolate(frame, [0, 12], [0, 1]),
            }} />
          )}
          <div style={{
            display: "inline-block", padding: "8px 20px", borderRadius: 4,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 18, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase",
            marginBottom: 28, opacity: interpolate(frame, [4, 20], [0, 1]),
          }}>
            {eyebrow}
          </div>
          <div style={{
            fontSize: 64, fontWeight: 800, color: "#fff", lineHeight: 1.1,
            maxWidth: 840, opacity: interpolate(frame, [12, 36], [0, 1]),
          }}>
            {title}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* BULLET 1 — 3-6s */}
      <Sequence from={COVER} durationInFrames={B1}>
        <AbsoluteFill>
          <AvatarPIP {...{ avatarVideoUrl, agentPhotoUrl, agentName,
            accentColor: brand.accentColor, primaryColor: brand.primaryColor,
            startFrame: COVER, endFrame: COVER + B1 }} />
          <BulletPanel index={1} text={bullets[0]} accentColor={brand.accentColor} />
        </AbsoluteFill>
      </Sequence>

      {/* BULLET 2 — 6-10s */}
      <Sequence from={COVER + B1} durationInFrames={B2}>
        <AbsoluteFill>
          <AvatarPIP {...{ avatarVideoUrl, agentPhotoUrl, agentName,
            accentColor: brand.accentColor, primaryColor: brand.primaryColor,
            startFrame: COVER + B1, endFrame: COVER + B1 + B2 }} />
          <BulletPanel index={2} text={bullets[1]} accentColor={brand.accentColor} />
        </AbsoluteFill>
      </Sequence>

      {/* BULLET 3 — 10-15s */}
      <Sequence from={COVER + B1 + B2} durationInFrames={B3}>
        <AbsoluteFill>
          <AvatarPIP {...{ avatarVideoUrl, agentPhotoUrl, agentName,
            accentColor: brand.accentColor, primaryColor: brand.primaryColor,
            startFrame: COVER + B1 + B2, endFrame: COVER + B1 + B2 + B3 }} />
          <BulletPanel index={3} text={bullets[2]} accentColor={brand.accentColor} />
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 15-18s */}
      <Sequence from={COVER + B1 + B2 + B3} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.05, marginBottom: 24 }}>
            {ctaLabel}
          </div>
          <div style={{ fontSize: 36, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0,
            textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5,
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
