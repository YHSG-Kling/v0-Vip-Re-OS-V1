/**
 * remotion/JustListedReelSquare.tsx
 *
 * Wave 39 — square (1:1) variant of JustListedReel for paid ad
 * placements. Meta/Instagram FEED ads default to 1:1 (anything taller
 * gets cropped to 1080×1080 by the player); LinkedIn promoted posts
 * use the same ratio. The 9:16 vertical reel stays the organic
 * format; this composition is what the W40 ad creator picks when
 * staging a paid placement.
 *
 * Format choices vs the vertical reel:
 *   · 12s total (vs 25s) — paid feed completion-rate falls off a
 *     cliff after ~10s; we trim to the highest-signal moments
 *   · No fact-cards section — paid viewers don't read price/beds
 *     inline; the CTA carries the offer. The vertical reel keeps
 *     them for organic where dwell-time is longer.
 *   · Larger headline + CTA — square format crops at the bottom on
 *     mobile feed; oversized type survives that crop
 *
 * Voiceover is OPTIONAL and OFF by default. Most Meta feed users
 * scroll muted; the visual + caption overlay carries the message.
 * If voice IS supplied, it still plays — agents who explicitly opt
 * in their cloned voice (Wave 38 TTS) get the brand consistency.
 *
 * Props shape mirrors JustListedReelProps so the W40 ad creator can
 * reuse the same data payload across organic and paid renders.
 */
import React from "react"
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion"

export interface JustListedReelSquareProps {
  hook:      string
  address:   string
  cityState: string
  price:     string
  bedrooms:  string
  bathrooms: string
  sqft:      string
  /** Property images in display order. 1-4 used in this format
   *  (paid placement attention budget is shorter than organic). */
  imageUrls: string[]
  brand: {
    primaryColor: string
    accentColor:  string
    logoUrl?:     string
    agentName?:   string
    agentPhone?:  string
    /** Equal Housing Opportunity mark — required for paid real-
     *  estate ads in most U.S. markets. The vertical reel keeps it
     *  optional for non-listing organic content; here it defaults
     *  to true. */
    showEhoMark?: boolean
  }
  voiceoverUrl?: string
  /** Paid-ad CTA the brokerage wants on screen for the final
   *  beat. Defaults to "Tour this listing". Brokerage can override
   *  per campaign — e.g. "Get pricing", "See more photos". */
  ctaLabel?: string
}

const FPS    = 30
const TOTAL  = 12 * FPS                          // 360 frames
const COVER  = 2  * FPS                          // 0-2s
const PHOTOS = 8  * FPS                          // 2-10s
const CTA    = 2  * FPS                          // 10-12s

/** Ken-Burns zoom factor — slow 1.0 → 1.08 over the photo's visible
 *  window. Subtle enough that the photo still reads as a single
 *  image, lively enough that the feed scroll doesn't read it as a
 *  static frame and skip past. */
function kenBurnsScale(localFrame: number, span: number): number {
  return interpolate(localFrame, [0, span], [1, 1.08], { extrapolateRight: "clamp" })
}

export const JustListedReelSquare: React.FC<JustListedReelSquareProps> = ({
  hook, address, cityState, price, bedrooms, bathrooms, sqft,
  imageUrls, brand, voiceoverUrl, ctaLabel,
}) => {
  const frame      = useCurrentFrame()
  const images     = imageUrls.slice(0, 4)
  const perPhoto   = images.length > 0 ? PHOTOS / images.length : PHOTOS
  const showEho    = brand.showEhoMark ?? true
  const finalCta   = ctaLabel ?? "Tour this listing"

  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* COVER — 0-2s. Brand chip top + hook + address. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
          padding: 64, textAlign: "center",
        }}>
          <div style={{
            fontSize: 28, letterSpacing: 6, textTransform: "uppercase",
            color: brand.accentColor, fontWeight: 700, opacity: interpolate(frame, [0, 15], [0, 1]),
          }}>
            {hook}
          </div>
          <div style={{
            fontSize: 80, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            marginTop: 28, opacity: interpolate(frame, [10, 30], [0, 1]),
          }}>
            {address}
          </div>
          <div style={{
            fontSize: 36, color: "#fff", opacity: interpolate(frame, [20, 40], [0, 0.85]),
            marginTop: 16,
          }}>
            {cityState}
          </div>
          <div style={{
            position: "absolute", top: 40, left: 40, color: "#fff", opacity: 0.85,
            fontSize: 22, fontWeight: 600, letterSpacing: 2,
          }}>
            {brand.logoUrl ? <Img src={brand.logoUrl} style={{ height: 56, objectFit: "contain" }} /> : null}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* PHOTOS — 2-10s. Ken-Burns through up to 4 images with a
          persistent caption strip across the bottom showing price +
          bed/bath/sqft so feed scrollers see the facts even with
          sound off. */}
      <Sequence from={COVER} durationInFrames={PHOTOS}>
        {images.length === 0 ? (
          <AbsoluteFill style={{
            backgroundColor: brand.primaryColor, display: "flex",
            alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 36, opacity: 0.55,
          }}>
            Photos coming soon
          </AbsoluteFill>
        ) : (
          images.map((url, idx) => {
            const start    = idx * perPhoto
            return (
              <Sequence key={idx} from={start} durationInFrames={perPhoto}>
                <PhotoFrame url={url} span={perPhoto} />
              </Sequence>
            )
          })
        )}
        {/* Persistent facts strip. Floats over the photos so the
            viewer always sees the offer without waiting for a card
            section. Bottom-anchored so it doesn't compete with the
            photo's natural focal point. */}
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            padding: "32px 56px",
            background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%)",
            color: "#fff",
          }}>
            <div style={{ fontSize: 58, fontWeight: 800, marginBottom: 12 }}>{price}</div>
            <div style={{ fontSize: 28, fontWeight: 500, opacity: 0.9 }}>
              {bedrooms} bd · {bathrooms} ba · {sqft} sqft
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 10-12s. Agent name + phone + CTA + EHO mark.
          Survives the bottom-crop that Meta feed applies on some
          devices because the offer language is centered. */}
      <Sequence from={COVER + PHOTOS} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor,
        }}>
          <div style={{
            fontSize: 80, fontWeight: 800, color: "#fff", lineHeight: 1.1, marginBottom: 28,
          }}>
            {finalCta}
          </div>
          {brand.agentName && (
            <div style={{ fontSize: 40, color: brand.accentColor, fontWeight: 700 }}>{brand.agentName}</div>
          )}
          {brand.agentPhone && (
            <div style={{ fontSize: 32, color: "#fff", opacity: 0.85, marginTop: 12 }}>
              {brand.agentPhone}
            </div>
          )}
          {showEho && (
            <div style={{
              position: "absolute", bottom: 24, left: 24,
              fontSize: 16, color: "#fff", opacity: 0.5, letterSpacing: 1,
            }}>
              Equal Housing Opportunity
            </div>
          )}
        </AbsoluteFill>
      </Sequence>

      {/* Total duration sanity check — this guarantees the
          renderer always knows the length even if a Sequence is
          missing its photos. */}
      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}

const PhotoFrame: React.FC<{ url: string; span: number }> = ({ url, span }) => {
  const frame = useCurrentFrame()
  const scale = kenBurnsScale(frame, span)
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={url}
        style={{
          width: "100%", height: "100%", objectFit: "cover",
          transform: `scale(${scale})`, transformOrigin: "center center",
        }}
      />
    </AbsoluteFill>
  )
}
