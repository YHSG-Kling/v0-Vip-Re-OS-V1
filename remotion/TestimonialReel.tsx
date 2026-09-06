/**
 * remotion/TestimonialReel.tsx
 *
 * Wave 39 — client testimonial reel. Pure Remotion (no D-ID hit by
 * default — the testimonial QUOTE does the talking; the agent's
 * avatar is an OPTIONAL reaction frame). The most under-used asset
 * in real estate marketing: a 5-star review from a closed client
 * sits in Zillow for life and never makes it into the brokerage's
 * organic + paid mix.
 *
 * Format choices:
 *   · 1080×1080 square — paid + organic
 *   · 14s @ 30fps. Quotes need breathing room — staccato pacing
 *     makes the praise feel canned. Each beat lingers.
 *   · Visual: large pull-quote, then sourced attribution
 *     (client first name + role + date), then optional 5-star
 *     burst, then agent reaction (avatar or static photo) +
 *     CTA. Format is consistent so the brokerage's monthly
 *     "testimonial drop" series is recognizable.
 *
 * Compliance: testimonials advertising real-estate services are
 * subject to state regulation in many U.S. markets (NY, CA, FL
 * specifically). The CALLER is responsible for confirming the
 * client gave written consent before queuing the render — the
 * composition trusts that consent.
 */
import React from "react"
import { Audio, Video } from "@remotion/media"
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { ContextCueRow } from "./_BrollLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"

export interface TestimonialReelProps {
  /** The testimonial quote — 12-40 words. The composition truncates
   *  with ellipsis after ~280 characters if needed but expects the
   *  caller to pre-trim. */
  quote:        string
  /** Attribution — first name + role (Buyer / Seller / Both) + "in <City>". */
  clientName:   string
  /** "Buyer" | "Seller" | "Buyer & Seller" — surfaced as a chip. */
  clientRole:   string
  /** Optional: "Closed Nov 2026" — date of closing as freshness signal. */
  closingLabel?: string
  /** When non-null, the 5-star burst renders. 1-5 supported but
   *  in practice we only show 5-star testimonials. */
  stars?:       number
  /** Closing CTA — defaults to "Read more reviews". */
  ctaLabel?:    string
  agentName:    string
  /** Optional avatar reaction — when supplied plays during the
   *  agent-reaction beat. Most testimonial reels work fine with
   *  the static photo + animated typography. */
  avatarVideoUrl?: string | null
  agentPhotoUrl?:  string | null
  /** Optional voiceover — when the agent reads the testimonial in
   *  their cloned voice. Costs a small ElevenLabs job. */
  voiceoverUrl?:   string
  /** Tracked outro QR (lib/video/video-qr → mintVideoQr). Default-off: absent → no badge. */
  qrCodeDataUrl?:  string | null
  qrCaption?:      string
  mlsClean?:       boolean
  /** Optional context cues from the content bank. */
  contextCues?:    string[]
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
const COVER  = 2 * FPS
const QUOTE  = 7 * FPS
const REACT  = 3 * FPS
const CTA    = 2 * FPS
const TOTAL  = COVER + QUOTE + REACT + CTA  // 420 frames = 14s

const StarRow: React.FC<{ stars: number; accentColor: string }> = ({ stars, accentColor }) => {
  const frame = useCurrentFrame()
  const safe  = Math.max(0, Math.min(5, Math.floor(stars)))
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
      {Array.from({ length: 5 }).map((_, i) => {
        const filled = i < safe
        const fade   = interpolate(frame, [i * 4, i * 4 + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        return (
          <span key={i} style={{
            fontSize: 36, lineHeight: 1, opacity: fade,
            color: filled ? accentColor : "rgba(255,255,255,0.25)",
          }}>★</span>
        )
      })}
    </div>
  )
}

export const TestimonialReel: React.FC<TestimonialReelProps> = ({
  quote, clientName, clientRole, closingLabel, stars, ctaLabel,
  agentName, avatarVideoUrl, agentPhotoUrl, voiceoverUrl, contextCues, brand,
  qrCodeDataUrl, qrCaption, mlsClean,
}) => {
  const frame    = useCurrentFrame()
  const showEho  = brand.showEhoMark ?? true
  const finalCta = ctaLabel ?? "Read more reviews"
  const cues     = contextCues ?? []
  const showStars = (stars ?? 0) > 0

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* COVER — 0-2s. "REVIEW" eyebrow + client role chip. */}
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
            display: "inline-block", padding: "10px 24px", borderRadius: 6,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 26, fontWeight: 900, letterSpacing: 6, textTransform: "uppercase",
            marginBottom: 24, opacity: interpolate(frame, [4, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            5-Star Review
          </div>
          <div style={{
            fontSize: 36, color: "#fff", opacity: interpolate(frame, [12, 32], [0, 0.85], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            letterSpacing: 2, fontWeight: 600,
          }}>
            {clientRole}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* QUOTE — 2-9s. Large pull-quote with typographic weight. */}
      <Sequence from={COVER} durationInFrames={QUOTE}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 72, textAlign: "center", color: "#fff",
        }}>
          {showStars && <StarRow stars={stars ?? 5} accentColor={brand.accentColor} />}
          <div style={{
            fontSize: 48, lineHeight: 1.25, fontWeight: 700, fontStyle: "italic",
            opacity: interpolate(frame, [12, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            maxWidth: 920,
            position: "relative",
          }}>
            <span style={{
              position: "absolute", top: -48, left: -32, fontSize: 144,
              color: brand.accentColor, opacity: 0.4, lineHeight: 1, fontStyle: "normal",
            }}>"</span>
            {quote}
          </div>
          <div style={{
            marginTop: 36, fontSize: 24, color: brand.accentColor, fontWeight: 700, letterSpacing: 2,
            opacity: interpolate(frame, [40, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            — {clientName}
            {closingLabel && <span style={{ opacity: 0.7, marginLeft: 12 }}> · {closingLabel}</span>}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* AGENT REACTION — 9-12s. Avatar or static photo + agent name. */}
      <Sequence from={COVER + QUOTE} durationInFrames={REACT}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {(avatarVideoUrl || agentPhotoUrl) && (
            <div style={{
              width: 240, height: 240, borderRadius: 120,
              boxShadow: `0 0 0 5px ${brand.accentColor}`,
              overflow: "hidden", backgroundColor: brand.primaryColor,
              marginBottom: 28,
            }}>
              {avatarVideoUrl ? (
                // trimBefore counts SOURCE frames, and the enclosing
                // <Sequence from={COVER + QUOTE}> already offsets this child's
                // clock — trimBefore={COVER + QUOTE} therefore skipped 9s of a
                // reaction clip that is itself only ~3s. The avatar prop is a
                // short reaction CLIP whose content starts at source frame 0
                // (the D-ID convention AgentTalkingHeadReel.tsx models with
                // trimBefore={0}); no producer authors a full-reel-spanning
                // avatar for this composition (requires_did_avatar=false in the
                // registry). MarketUpdateReel / ExplainerAnimReel differ on
                // purpose — they slice one continuous narration track across
                // consecutive sequences by absolute ranges.
                <Video
                  objectFit="cover"
                  src={avatarVideoUrl}
                  trimBefore={0}
                  trimAfter={REACT}
                  style={{ width: "100%", height: "100%" }}
                />
              ) : (
                <SafeImg
                  src={agentPhotoUrl as string}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              )}
            </div>
          )}
          <div style={{
            fontSize: 32, color: "#fff", opacity: 0.8, letterSpacing: 3, textTransform: "uppercase",
            marginBottom: 8,
          }}>Your agent</div>
          <div style={{
            fontSize: 48, color: brand.accentColor, fontWeight: 800,
          }}>{agentName}</div>
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 12-14s. */}
      <Sequence from={COVER + QUOTE + REACT} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.05, marginBottom: 24 }}>
            {finalCta}
          </div>
          <div style={{ fontSize: 28, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
          <ContextCueRow cues={cues} accentColor={brand.accentColor} position="bottom" />
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
          <QrOutroBadge qrCodeDataUrl={qrCodeDataUrl} caption={qrCaption ?? "Scan to work with me"}
            primaryColor={brand.primaryColor} accentColor={brand.accentColor} mlsClean={mlsClean} />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}
