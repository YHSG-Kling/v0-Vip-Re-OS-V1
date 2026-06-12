/**
 * remotion/AgentTalkingHeadReel.tsx
 *
 * Wave 39 — the D-ID + ElevenLabs differentiator composition. No
 * competitor (Moxi, Rave, BoldTrail, kvCORE) ships an ad-ready
 * talking-head with the agent's CLONED voice + branded chrome.
 * This is the composition that surfaces the avatar pipeline already
 * built (lib/did/index.ts) as a paid-ad placement.
 *
 * Composition shape (14s @ 30fps = 420 frames, 1080×1080 square so it
 * survives Meta/IG feed crop):
 *
 *   0–2s   COVER         — brand logo + hook label + agent name
 *   2–12s  AVATAR VIDEO  — embed the D-ID MP4 via Remotion's <Video>;
 *                          persistent caption strip on top with the
 *                          line being spoken (passed in as `caption`)
 *                          so the muted-feed viewer reads it too
 *   12–14s OUTRO         — CTA + phone + EHO mark
 *
 * The D-ID video URL is rendered upstream — lib/did/index.ts queues
 * the D-ID Talks job, the poll-did-videos cron downloads the
 * finished MP4 and composites the logo overlay via Sharp+ffmpeg.
 * By the time this composition renders, props.avatarVideoUrl points
 * at the brokerage's CDN-served logo-stamped MP4.
 *
 * Why a square wrapper around an avatar video:
 *   · D-ID returns a 512×512 talking head by default; we letterbox
 *     it onto a 1080×1080 brand canvas so the agent's face stays
 *     centered and the brokerage chrome owns the edges
 *   · Meta feed crops vertical/portrait to square; designing for
 *     square first avoids the bad crop
 *   · The avatar video is OPTIONAL — when null (D-ID still
 *     rendering, or brokerage hasn't set up an avatar yet), the
 *     composition falls back to a static brand card with the
 *     caption line as the visual centerpiece. Renders ad-ready
 *     either way; the renderer never has to refuse the job.
 *
 * Compliance: the spoken script + caption are pre-gated upstream
 * via the same compliance gate the voicedrop preset path uses (the
 * Fair Housing + Them-First check at preset save). This composition
 * trusts what it's handed and DOES NOT redraft on its own.
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
import { QrOutroBadge } from "./components/QrOutroBadge"

export interface AgentTalkingHeadReelProps {
  /** Top hook label — short eyebrow (e.g. "MARKET UPDATE", "JUST LISTED",
   *  "MEET YOUR AGENT"). 1-3 words. */
  hook:        string
  /** Agent's display name — shows in cover + outro. */
  agentName:   string
  /** The line the avatar is "saying" right now. Surfaced as a
   *  caption strip on top of the avatar video so muted viewers see
   *  the message. Capped to ~12 words for readability at 1080px. */
  caption:     string
  /** Final CTA — what the viewer should do after watching. 2-5 words. */
  ctaLabel:    string
  /** D-ID-rendered + logo-composited MP4 URL. NULL when no avatar
   *  is available; composition falls back to a static brand card. */
  avatarVideoUrl: string | null
  /** Agent photo URL — used as the cover image when no avatar
   *  video is available, and as the small chip in the outro. */
  agentPhotoUrl:  string | null
  /** Optional voiceover MP3 URL. When the avatar video already
   *  contains the agent's voice (the normal D-ID path), leave this
   *  null. When the brokerage opted into a separate ElevenLabs TTS
   *  layer (e.g. multi-language), point at the synthesized track. */
  voiceoverUrl?:  string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to connect". */
  qrCaption?:     string
  brand: {
    primaryColor:    string
    accentColor:     string
    logoUrl?:        string
    brokerageName:   string
    agentPhone?:     string
    showEhoMark?:    boolean
    licenseLine?:    string
  }
}

const FPS    = 30
const TOTAL  = 14 * FPS
const COVER  = 2  * FPS
const BODY   = 10 * FPS
const OUTRO  = 2  * FPS

export const AgentTalkingHeadReel: React.FC<AgentTalkingHeadReelProps> = ({
  hook, agentName, caption, ctaLabel, avatarVideoUrl, agentPhotoUrl,
  qrCodeDataUrl, qrCaption, brand,
}) => {
  const frame   = useCurrentFrame()
  const showEho = brand.showEhoMark ?? true

  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* COVER — 0-2s. Brand badge + hook + agent name. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {brand.logoUrl ? (
            <Img src={brand.logoUrl} style={{ height: 72, objectFit: "contain", marginBottom: 32, opacity: interpolate(frame, [0, 12], [0, 1]) }} />
          ) : (
            <div style={{
              fontSize: 22, letterSpacing: 4, textTransform: "uppercase", color: "#fff", opacity: 0.7, marginBottom: 32,
            }}>{brand.brokerageName}</div>
          )}
          <div style={{
            fontSize: 28, letterSpacing: 6, textTransform: "uppercase",
            color: brand.accentColor, fontWeight: 700,
            opacity: interpolate(frame, [5, 20], [0, 1]),
          }}>
            {hook}
          </div>
          <div style={{
            fontSize: 72, fontWeight: 800, color: "#fff", lineHeight: 1.05, marginTop: 24,
            opacity: interpolate(frame, [15, 35], [0, 1]),
          }}>
            {agentName}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* BODY — 2-12s. Avatar video centered in a brand letterbox,
          caption strip on top, brokerage chrome at corners. */}
      <Sequence from={COVER} durationInFrames={BODY}>
        <AbsoluteFill style={{ backgroundColor: brand.primaryColor }}>
          {avatarVideoUrl ? (
            <Video
              src={avatarVideoUrl}
              startFrom={0}
              endAt={BODY}
              style={{
                position: "absolute",
                top: 90, left: 90, width: 900, height: 900,
                objectFit: "cover",
                borderRadius: 12,
                boxShadow: `0 0 0 6px ${brand.accentColor}`,
              }}
            />
          ) : agentPhotoUrl ? (
            <Img
              src={agentPhotoUrl}
              style={{
                position: "absolute",
                top: 90, left: 90, width: 900, height: 900,
                objectFit: "cover",
                borderRadius: 12,
                boxShadow: `0 0 0 6px ${brand.accentColor}`,
              }}
            />
          ) : (
            <div style={{
              position: "absolute",
              top: 90, left: 90, width: 900, height: 900,
              backgroundColor: brand.accentColor, borderRadius: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 320, color: brand.primaryColor, fontWeight: 800,
            }}>
              {(agentName[0] ?? "A").toUpperCase()}
            </div>
          )}

          {/* Caption strip — top, brand-accent background. Sits above
              the avatar so a muted viewer reads the message even when
              the audio is off. */}
          <div style={{
            position: "absolute", top: 24, left: 24, right: 24,
            padding: "16px 28px",
            backgroundColor: brand.accentColor,
            color: brand.primaryColor,
            fontSize: 26, fontWeight: 700, lineHeight: 1.25,
            borderRadius: 8, textAlign: "center",
          }}>
            {caption}
          </div>

          {/* Bottom-left brand chip — persistent so any frame
              screenshot stays attributable. */}
          <div style={{
            position: "absolute", bottom: 24, left: 24,
            padding: "8px 16px", borderRadius: 6,
            backgroundColor: "rgba(0,0,0,0.55)", color: "#fff",
            fontSize: 18, fontWeight: 600,
          }}>
            {brand.brokerageName}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* OUTRO — 12-14s. CTA + phone + EHO mark. Solid brand
          background so the avatar-to-card transition is clean. */}
      <Sequence from={COVER + BODY} durationInFrames={OUTRO}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.05, marginBottom: 32 }}>
            {ctaLabel}
          </div>
          {brand.agentPhone && (
            <div style={{ fontSize: 36, color: brand.accentColor, fontWeight: 700 }}>
              {brand.agentPhone}
            </div>
          )}
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0,
            textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5,
          }}>
            {brand.brokerageName}
            {showEho && " · Equal Housing Opportunity"}
            {brand.licenseLine && (
              <>
                <br/>
                {brand.licenseLine}
              </>
            )}
          </div>
          <QrOutroBadge
            qrCodeDataUrl={qrCodeDataUrl}
            caption={qrCaption ?? "Scan to connect"}
            primaryColor={brand.primaryColor}
            accentColor={brand.accentColor}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Total duration sanity sentinel. */}
      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}
