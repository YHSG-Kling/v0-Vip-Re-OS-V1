/**
 * remotion/NeighborhoodSpotlightReel.tsx
 *
 * Wave 39 — neighborhood-focused content reel. The "I'm the
 * neighborhood expert" play that wins listings and converts buyer
 * leads. Built around B-roll: the composition pulls 3-6 short
 * lifestyle clips (cafés, parks, the walkable street, the school
 * gate, the sunset over the bay) and weaves them under data
 * highlights + agent-narrated voiceover.
 *
 * Format choices:
 *   · 1080×1080 square — paid + organic
 *   · 16s @ 30fps. Long enough to land the "I know this place"
 *     vibe; short enough for paid feed.
 *   · B-roll-heavy by design. Without B-roll the composition falls
 *     back to a solid-brand card with the data highlights — still
 *     ships, but the lift comes from the lifestyle footage.
 *   · No D-ID by default — neighborhood reels work great as text +
 *     B-roll + agent's cloned voice via ElevenLabs TTS (cheap;
 *     ~$0.05 per render). The agent's avatar PIP is OPTIONAL for
 *     brokerages with strong personal brand.
 *
 * Data highlights (the data row across the bottom) come from the
 * existing market-data path — same source as MarketUpdateReel.
 * Composer typically pulls 2 highlights here; the format reads
 * cleanly with 1-3.
 */
import React from "react"
import { Audio, Video } from "@remotion/media"
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { BrollLayer, ContextCueRow, type BrollClip } from "./_BrollLayer"
import { CaptionLayer } from "./components/CaptionLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"
import type { CaptionCue } from "../lib/video/caption-plan"

export interface NeighborhoodHighlight {
  /** Short label — "Median price", "Walk score". 1-3 words. */
  label: string
  /** Display value — "$675K", "92 / 100", "12 min". */
  value: string
}

export interface NeighborhoodSpotlightReelProps {
  /** Neighborhood name — "Brickell", "Coral Gables", "Wynwood". */
  neighborhood: string
  /** Tagline — "Where rooftops meet the bay." 4-10 words.
   *  This is the FEEL of the place, not data. */
  tagline:      string
  /** 1-3 highlights surfaced as small data chips across the
   *  bottom of the body section. Composer typically picks 2. */
  highlights:   NeighborhoodHighlight[]
  /** B-roll clips — the heart of this format. 3-6 ideal. Each
   *  clip can be an image OR video URL; the helper detects. */
  brollClips:   BrollClip[]
  /** Closing CTA — defaults to "Want a private tour?". */
  ctaLabel?:    string
  agentName:    string
  agentPhone?:  string
  /** Optional voiceover — the agent narrating the spotlight in
   *  their cloned voice. The pre-W38 TTS path supplies the mp3. */
  voiceoverUrl?: string
  /** Tracked outro QR (lib/video/video-qr → mintVideoQr). Default-off: absent → no badge. */
  qrCodeDataUrl?: string | null
  qrCaption?:     string
  mlsClean?:      boolean
  /** Optional agent avatar — small PIP in the body section. Most
   *  neighborhood reels skip this and lean on the voice. */
  avatarVideoUrl?: string | null
  agentPhotoUrl?:  string | null
  /** Optional context-bank cues (e.g. "Trending: Brickell", "From
   *  competitor scan: 32% more listings vs Q2"). */
  contextCues?: string[]
  brand: {
    primaryColor:    string
    accentColor:     string
    logoUrl?:        string
    brokerageName:   string
    showEhoMark?:    boolean
    licenseLine?:    string
  }
  /** SOUND-OFF CAPTIONS (additive + default-off). Word-accurate cues from real
   *  ElevenLabs alignment — preferred over captionScript. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — raw VO script text; timing estimated in-comp. */
  captionScript?: string | null
}

const FPS    = 30
const COVER  = 3  * FPS
const BODY   = 11 * FPS
const CTA    = 2  * FPS
const TOTAL  = COVER + BODY + CTA  // 480 frames = 16s

export const NeighborhoodSpotlightReel: React.FC<NeighborhoodSpotlightReelProps> = ({
  neighborhood, tagline, highlights, brollClips, ctaLabel,
  agentName, agentPhone, voiceoverUrl, avatarVideoUrl, agentPhotoUrl,
  contextCues, brand, captionsCues, captionScript, qrCodeDataUrl, qrCaption, mlsClean,
}) => {
  const frame    = useCurrentFrame()
  const showEho  = brand.showEhoMark ?? true
  const finalCta = ctaLabel ?? "Want a private tour?"
  const cues     = contextCues ?? []
  const overlay  = `${brand.primaryColor}A6`  // ~65% alpha — clips still readable

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* B-roll layer — plays under the entire reel when supplied.
          When no clips are passed, the layer returns null and the
          brand background carries through. */}
      {brollClips.length > 0 && (
        <BrollLayer clips={brollClips} totalFrames={TOTAL} overlayColor={overlay} loop />
      )}

      {/* COVER — 0-3s. Neighborhood name + tagline. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {brand.logoUrl && (
            <SafeImg src={brand.logoUrl} style={{
              height: 56, objectFit: "contain", marginBottom: 32,
              opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }} />
          )}
          <div style={{
            display: "inline-block", padding: "8px 20px", borderRadius: 4,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 18, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase",
            marginBottom: 24, opacity: interpolate(frame, [4, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            Neighborhood spotlight
          </div>
          <div style={{
            fontSize: 96, fontWeight: 900, color: "#fff", lineHeight: 0.98,
            opacity: interpolate(frame, [12, 32], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            textShadow: "0 4px 24px rgba(0,0,0,0.45)",
          }}>
            {neighborhood}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* BODY — 3-14s. Tagline + highlights + optional agent PIP. */}
      <Sequence from={COVER} durationInFrames={BODY}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", justifyContent: "space-between",
          padding: 56,
        }}>
          {/* Top tagline */}
          <div style={{
            fontSize: 44, fontWeight: 700, color: "#fff", lineHeight: 1.2,
            textAlign: "center", maxWidth: 880, marginLeft: "auto", marginRight: "auto",
            textShadow: "0 4px 16px rgba(0,0,0,0.45)",
            opacity: interpolate(frame, [6, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {tagline}
          </div>

          {/* Optional agent PIP — small, bottom-left */}
          {(avatarVideoUrl || agentPhotoUrl) && (
            <div style={{
              position: "absolute", bottom: 160, left: 40,
              width: 180, height: 180, borderRadius: 90,
              boxShadow: `0 0 0 4px ${brand.accentColor}`,
              overflow: "hidden", backgroundColor: brand.primaryColor,
            }}>
              {avatarVideoUrl ? (
                // trimBefore counts SOURCE frames, and the enclosing
                // <Sequence from={COVER}> has already offset this child's clock —
                // so trimBefore={COVER} here skipped the clip's first 3s TWICE.
                // The D-ID pipeline's clips start speaking at source frame 0
                // (the convention AgentTalkingHeadReel.tsx models with
                // trimBefore={0} trimAfter={BODY}); no producer authors a
                // full-reel-spanning avatar mp4 for this composition
                // (remotion_compositions.requires_did_avatar=false, and every
                // producer stages avatarVideoUrl:null). MarketUpdateReel /
                // ExplainerAnimReel legitimately differ: they slice ONE
                // continuous narration track across consecutive sequences by
                // absolute frame ranges, which is why their PIPs trim by
                // startFrame/endFrame and this one must not.
                <Video src={avatarVideoUrl} objectFit="cover" trimBefore={0} trimAfter={BODY}
                  style={{ width: "100%", height: "100%" }} />
              ) : (
                <SafeImg src={agentPhotoUrl as string} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              )}
            </div>
          )}

          {/* Highlight chips along the bottom */}
          <div style={{ display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
            {highlights.slice(0, 3).map((h, i) => (
              <div key={i} style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                padding: "16px 24px", borderRadius: 8,
                backgroundColor: "rgba(0,0,0,0.65)",
                color: "#fff", minWidth: 180,
                opacity: interpolate(frame, [40 + i * 8, 60 + i * 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              }}>
                <div style={{ fontSize: 36, fontWeight: 900, color: brand.accentColor, lineHeight: 1 }}>
                  {h.value}
                </div>
                <div style={{
                  fontSize: 14, opacity: 0.85, letterSpacing: 2, marginTop: 6,
                  textTransform: "uppercase",
                }}>
                  {h.label}
                </div>
              </div>
            ))}
          </div>
          <ContextCueRow cues={cues} accentColor={brand.accentColor} position="top" />
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 14-16s. */}
      <Sequence from={COVER + BODY} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 56, fontWeight: 800, lineHeight: 1.1, marginBottom: 24 }}>
            {finalCta}
          </div>
          <div style={{ fontSize: 32, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
          {agentPhone && (
            <div style={{ fontSize: 24, color: "#fff", opacity: 0.85, marginTop: 12 }}>{agentPhone}</div>
          )}
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0,
            textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5,
          }}>
            {brand.brokerageName}{showEho && " · Equal Housing Opportunity"}
            {brand.licenseLine && (
              <>
                <br/>
                {brand.licenseLine}
              </>
            )}
          </div>
          <QrOutroBadge qrCodeDataUrl={qrCodeDataUrl} caption={qrCaption ?? "Scan for the neighborhood guide"}
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
