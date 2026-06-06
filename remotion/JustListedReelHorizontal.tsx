/**
 * remotion/JustListedReelHorizontal.tsx
 *
 * Wave 39 — horizontal (16:9) variant of the JustListed family.
 * Closes the YouTube / Facebook in-stream / CTV-OTT placement gap;
 * the rest of the library has been square-or-vertical first.
 *
 * Format choices:
 *   · 1920×1080 horizontal — YouTube ads, FB in-stream, OTT/CTV
 *     ad placements. 16:9 IS the canonical TV ratio; nothing else
 *     looks right on a 65" screen above a couch.
 *   · 20s @ 30fps — YouTube ads have higher attention budget than
 *     muted feed; we earn the extra 8s with smoother pacing +
 *     larger photo holds (5s each vs 2s in the square reel).
 *   · Voiceover ON by default unless explicitly stripped — the
 *     muted-feed assumption that drives the square format doesn't
 *     apply on YouTube / CTV.
 *
 * Visual rhythm:
 *   0–3s   COVER         — wide brand header + "Just Listed" hook
 *   3–13s  PHOTO REEL    — 2 photos × 5s with ken-burns + lower-
 *                          third facts overlay (split left half
 *                          for the visual, right half for facts)
 *   13–17s SPLIT FACTS   — agent name + photo + price/beds/baths
 *                          + address in a clean horizontal split
 *   17–20s OUTRO CTA     — full-width CTA + agent contact + EHO
 */
import React from "react"
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion"

export interface JustListedReelHorizontalProps {
  hook:      string
  address:   string
  cityState: string
  price:     string
  bedrooms:  string
  bathrooms: string
  sqft:      string
  imageUrls: string[]
  brand: {
    primaryColor: string
    accentColor:  string
    logoUrl?:     string
    agentName?:   string
    agentPhone?:  string
    showEhoMark?: boolean
    licenseLine?: string
  }
  voiceoverUrl?: string
  ctaLabel?:    string
}

const FPS    = 30
const TOTAL  = 20 * FPS              // 600
const COVER  = 3  * FPS               // 90
const PHOTOS = 10 * FPS               // 300
const FACTS  = 4  * FPS               // 120
const CTA    = 3  * FPS               // 90

const BrandHeader: React.FC<{
  logoUrl?: string; brokerageName?: string
}> = ({ logoUrl }) => (
  <div style={{
    position: "absolute", top: 32, left: 32, right: 32,
    display: "flex", alignItems: "center", justifyContent: "space-between",
  }}>
    {logoUrl ? (
      <Img src={logoUrl} style={{ height: 40, objectFit: "contain" }} />
    ) : <div />}
    <div style={{
      width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff", opacity: 0.5,
    }} />
  </div>
)

const PhotoFrame: React.FC<{ url: string; span: number }> = ({ url, span }) => {
  const frame = useCurrentFrame()
  const scale = interpolate(frame, [0, span], [1, 1.05], { extrapolateRight: "clamp" })
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img src={url} style={{
        width: "100%", height: "100%", objectFit: "cover",
        transform: `scale(${scale})`, transformOrigin: "center center",
      }} />
    </AbsoluteFill>
  )
}

export const JustListedReelHorizontal: React.FC<JustListedReelHorizontalProps> = ({
  hook, address, cityState, price, bedrooms, bathrooms, sqft,
  imageUrls, brand, voiceoverUrl, ctaLabel,
}) => {
  const frame    = useCurrentFrame()
  const images   = imageUrls.slice(0, 2)
  const perPhoto = images.length > 0 ? PHOTOS / images.length : PHOTOS
  const showEho  = brand.showEhoMark ?? true
  const finalCta = ctaLabel ?? "Tour this listing"

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* COVER — 0-3s. Wide horizontal header treatment. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 80, textAlign: "center",
        }}>
          <BrandHeader logoUrl={brand.logoUrl} />
          <div style={{
            fontSize: 32, letterSpacing: 8, textTransform: "uppercase",
            color: brand.accentColor, fontWeight: 800,
            opacity: interpolate(frame, [0, 18], [0, 1]),
          }}>
            {hook}
          </div>
          <div style={{
            fontSize: 124, fontWeight: 900, color: "#fff", lineHeight: 1.0,
            marginTop: 32, opacity: interpolate(frame, [14, 36], [0, 1]),
          }}>
            {address}
          </div>
          <div style={{
            fontSize: 44, color: "#fff", opacity: interpolate(frame, [28, 50], [0, 0.85]),
            marginTop: 20, letterSpacing: 4,
          }}>
            {cityState}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* PHOTOS — 3-13s. Split layout: photo (60%) + facts (40%). */}
      <Sequence from={COVER} durationInFrames={PHOTOS}>
        <AbsoluteFill style={{ display: "flex" }}>
          <div style={{ width: "60%", height: "100%", position: "relative" }}>
            {images.length > 0 ? (
              images.map((url, idx) => {
                const start = idx * perPhoto
                return (
                  <Sequence key={idx} from={start} durationInFrames={perPhoto}>
                    <PhotoFrame url={url} span={perPhoto} />
                  </Sequence>
                )
              })
            ) : (
              <AbsoluteFill style={{
                backgroundColor: brand.primaryColor, display: "flex",
                alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 32, opacity: 0.5,
              }}>
                Photos coming soon
              </AbsoluteFill>
            )}
          </div>
          <div style={{
            width: "40%", height: "100%",
            backgroundColor: brand.primaryColor, color: "#fff",
            padding: 80, display: "flex", flexDirection: "column", justifyContent: "center",
          }}>
            <div style={{ fontSize: 28, opacity: 0.7, letterSpacing: 4, textTransform: "uppercase", marginBottom: 24 }}>
              The Listing
            </div>
            <div style={{ fontSize: 96, fontWeight: 900, color: brand.accentColor, lineHeight: 1, marginBottom: 28 }}>
              {price}
            </div>
            <div style={{ fontSize: 32, opacity: 0.9, lineHeight: 1.4 }}>
              {bedrooms} bedrooms<br/>
              {bathrooms} bathrooms<br/>
              {sqft} sqft
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* SPLIT FACTS — 13-17s. Agent identity establishment. */}
      <Sequence from={COVER + PHOTOS} durationInFrames={FACTS}>
        <AbsoluteFill style={{
          padding: 80, display: "flex", flexDirection: "column", justifyContent: "center",
          color: "#fff", backgroundColor: brand.primaryColor,
        }}>
          <BrandHeader logoUrl={brand.logoUrl} />
          <div style={{ fontSize: 44, opacity: 0.85, letterSpacing: 4, textTransform: "uppercase", marginBottom: 20 }}>
            Your agent
          </div>
          {brand.agentName && (
            <div style={{ fontSize: 124, fontWeight: 900, color: brand.accentColor, lineHeight: 1 }}>
              {brand.agentName}
            </div>
          )}
          {brand.agentPhone && (
            <div style={{ fontSize: 48, opacity: 0.8, marginTop: 24 }}>{brand.agentPhone}</div>
          )}
        </AbsoluteFill>
      </Sequence>

      {/* OUTRO CTA — 17-20s. */}
      <Sequence from={COVER + PHOTOS + FACTS} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 80, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <BrandHeader logoUrl={brand.logoUrl} />
          <div style={{ fontSize: 108, fontWeight: 900, lineHeight: 1.05, marginBottom: 32 }}>
            {finalCta}
          </div>
          {brand.agentName && (
            <div style={{ fontSize: 44, color: brand.accentColor, fontWeight: 700 }}>{brand.agentName}</div>
          )}
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0,
            textAlign: "center", fontSize: 16, opacity: 0.55, letterSpacing: 1,
          }}>
            {showEho && "Equal Housing Opportunity · "}{brand.licenseLine ?? ""}
          </div>
        </AbsoluteFill>
      </Sequence>

      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}
