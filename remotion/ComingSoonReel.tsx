/**
 * remotion/ComingSoonReel.tsx
 *
 * Wave 39 — pre-listing teaser. Most real-estate marketing fires
 * AFTER the listing is active on the MLS; the agent's window to
 * generate pre-MLS demand (the days when interested buyers haven't
 * been bidding-fatigued by 30 competing listings yet) is wasted. This
 * composition is the agent's pre-listing weapon: a 12-second teaser
 * that announces "coming soon" with the property photo blurred or
 * teased + the agent's CTA to "DM me to be first in line".
 *
 * Format choices:
 *   · 1080×1080 square — paid + organic both
 *   · 12s @ 30fps — same paid-feed sweet spot as JustListedReelSquare
 *   · NO D-ID by default. Pre-listing is brand-tone, not narrative;
 *     we save the D-ID + ElevenLabs cost for live-listing pieces.
 *     If the brokerage opts in via avatarVideoUrl, the avatar plays
 *     in a small bottom-right PIP — but the format works fine
 *     without it.
 *   · B-roll OPTIONAL — when supplied the layer plays under a tint
 *     so the headline stays legible. Falls back to a solid brand
 *     background otherwise. Cheap render.
 *
 * MLS compliance: many MLSes restrict pre-listing marketing under
 * Clear Cooperation rules — public marketing of an off-MLS listing
 * has a 1-day window from first marketing → MLS submission. The
 * CALLER (not this composition) verifies the listing's Clear
 * Cooperation status before queuing the render.
 */
import React from "react"
import { Audio, Video } from "@remotion/media"
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion"
import { BrollLayer, ContextCueRow, type BrollClip } from "./_BrollLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"

export interface ComingSoonReelProps {
  /** Property address line. NULL when the brokerage wants a
   *  silhouette-only teaser (the address is the surprise). */
  address:    string | null
  /** "City, ST" — always shown, even when address is hidden. */
  cityState:  string
  /** Optional teaser detail line — "4 BD · 3 BA · pool" / "rooftop
   *  3-bed in Wynwood". The composition shows it as a small chip.
   *  When null, the format leans on visuals alone. */
  teaser?:    string | null
  /** Optional property photo — usually a SIDE/REAR angle or a
   *  blurred hero; the standard "hero from the curb" is reserved
   *  for the live listing reel. */
  heroImageUrl?: string | null
  /** Date string — "This Friday", "Coming Nov 21", "Coming next week". */
  whenString: string
  /** CTA — defaults to "DM me to be first in line". */
  ctaLabel?:  string
  /** Optional B-roll — neighborhood lifestyle shots are the
   *  go-to here (sunset over the bay, walkable street, café
   *  patio). Helper layer crossfades between clips. */
  brollClips?: BrollClip[]
  /** Optional content-bank cue chips — "Trending: low inventory",
   *  "Top searched in your zip". Composer pulls these from the
   *  competitor-intel content bank when available. */
  contextCues?: string[]
  /** Optional avatar PIP — pre-listing format usually skips it,
   *  but a brokerage with a strong personal brand may want
   *  the agent's face present. */
  avatarVideoUrl?: string | null
  agentPhotoUrl?:  string | null
  agentName:       string
  /** Optional voiceover (TTS) — same opt-in posture as avatar. */
  voiceoverUrl?:   string
  /** Tracked outro QR (lib/video/video-qr → mintVideoQr). Default-off: absent → no badge. */
  qrCodeDataUrl?:  string | null
  qrCaption?:      string
  mlsClean?:       boolean
  brand: {
    primaryColor:    string
    accentColor:     string
    logoUrl?:        string
    brokerageName:   string
    showEhoMark?:    boolean
    licenseLine?:    string
  }
}

const FPS    = 30
const COVER  = 3  * FPS
const BODY   = 7  * FPS
const CTA    = 2  * FPS
const TOTAL  = COVER + BODY + CTA  // 360 frames = 12s

export const ComingSoonReel: React.FC<ComingSoonReelProps> = ({
  address, cityState, teaser, heroImageUrl, whenString, ctaLabel,
  brollClips, contextCues, avatarVideoUrl, agentPhotoUrl, agentName,
  voiceoverUrl, brand, qrCodeDataUrl, qrCaption, mlsClean,
}) => {
  const frame    = useCurrentFrame()
  const showEho  = brand.showEhoMark ?? true
  const finalCta = ctaLabel ?? "DM me to be first in line"
  const cues     = contextCues ?? []
  const clips    = brollClips ?? []
  const hasBroll = clips.length > 0
  const overlay  = `${brand.primaryColor}B3`  // ~70% alpha tint

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* B-roll under everything when available. */}
      {hasBroll && (
        <BrollLayer
          clips={clips}
          totalFrames={TOTAL}
          overlayColor={overlay}
          loop
        />
      )}

      {/* COVER — 0-3s. "COMING SOON" badge with accent burst. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {brand.logoUrl && (
            <Img src={brand.logoUrl} style={{
              height: 56, objectFit: "contain", marginBottom: 32,
              opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }} />
          )}
          <div style={{
            display: "inline-block",
            padding: "14px 36px", borderRadius: 6,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 36, fontWeight: 900, letterSpacing: 8, textTransform: "uppercase",
            scale: interpolate(frame, [0, 18], [0.85, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", output: "perceptual-scale" }),
            opacity: interpolate(frame, [0, 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            Coming Soon
          </div>
          <div style={{
            fontSize: 64, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            marginTop: 32, opacity: interpolate(frame, [14, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {whenString}
          </div>
          <div style={{
            fontSize: 28, color: "#fff", opacity: interpolate(frame, [24, 48], [0, 0.7], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            marginTop: 12, letterSpacing: 3,
          }}>
            {cityState}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* BODY — 3-10s. Optional hero teaser + address reveal */}
      <Sequence from={COVER} durationInFrames={BODY}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {heroImageUrl && (
            <div style={{
              width: 720, height: 480, borderRadius: 16,
              overflow: "hidden", marginBottom: 36,
              boxShadow: `0 0 0 6px ${brand.accentColor}, 0 32px 64px rgba(0,0,0,0.45)`,
              filter: "blur(2px) saturate(1.05)",
            }}>
              <Img src={heroImageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          )}
          {address ? (
            <div style={{
              fontSize: 56, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            }}>{address}</div>
          ) : (
            <div style={{
              fontSize: 48, fontWeight: 700, color: brand.accentColor, letterSpacing: 4,
              textTransform: "uppercase",
            }}>The address drops soon</div>
          )}
          {teaser && (
            <div style={{
              marginTop: 20,
              padding: "8px 20px", borderRadius: 6,
              backgroundColor: "rgba(0,0,0,0.55)", color: "#fff",
              fontSize: 24, fontWeight: 600, letterSpacing: 2,
            }}>
              {teaser}
            </div>
          )}
          <ContextCueRow cues={cues} accentColor={brand.accentColor} position="bottom" />
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 10-12s. Agent + DM CTA. Small avatar PIP optional. */}
      <Sequence from={COVER + BODY} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          {(avatarVideoUrl || agentPhotoUrl) && (
            <div style={{
              width: 140, height: 140, borderRadius: 70, marginBottom: 20,
              boxShadow: `0 0 0 4px ${brand.accentColor}`,
              overflow: "hidden", backgroundColor: brand.primaryColor,
            }}>
              {avatarVideoUrl ? (
                // trimBefore counts SOURCE frames, and the enclosing
                // <Sequence from={COVER + BODY}> already offsets this child's
                // clock — trimBefore={COVER + BODY} therefore skipped 10s of an
                // opt-in PIP clip whose content starts at source frame 0 (the
                // D-ID convention AgentTalkingHeadReel.tsx models with
                // trimBefore={0}); no producer authors a full-reel-spanning
                // avatar for this composition (requires_did_avatar=false in the
                // registry; promo-composition stages avatarVideoUrl:null).
                // MarketUpdateReel / ExplainerAnimReel differ on purpose — they
                // slice one continuous narration track across consecutive
                // sequences by absolute frame ranges.
                <Video src={avatarVideoUrl} objectFit="cover"
                  trimBefore={0} trimAfter={CTA}
                  style={{ width: "100%", height: "100%" }} />
              ) : (
                <Img src={agentPhotoUrl as string} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              )}
            </div>
          )}
          <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1.05, marginBottom: 16 }}>
            {finalCta}
          </div>
          <div style={{ fontSize: 28, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
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
          <QrOutroBadge qrCodeDataUrl={qrCodeDataUrl} caption={qrCaption ?? "Scan to see the listing"}
            primaryColor={brand.primaryColor} accentColor={brand.accentColor} mlsClean={mlsClean} />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}
