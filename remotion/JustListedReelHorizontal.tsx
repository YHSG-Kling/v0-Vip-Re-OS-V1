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
import { Audio } from "@remotion/media"
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { computeAssemblyTimeline } from "../lib/video/assembly-timeline"
import { bodyTailFrames, compositionBookends } from "../lib/video/duration-model"
import { SafeImg } from "./components/SafeImg"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { mlsNeutralTitle } from "../lib/video/render-cut"
import { CaptionLayer } from "./components/CaptionLayer"
import type { CaptionCue } from "../lib/video/caption-plan"
import { cinemaDisclosureStyle, cinemaFrame, slideDisclosureText } from "../lib/video/cinema-finish"
import { brollMountWindows, fitBodyVisualPlan, photoSpansAround, type BodyVisualPlan } from "../lib/video/body-visual-model"
import { PlannedBrollLayer, type BrollClip } from "./_BrollLayer"

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
    /** Wave 91 (lane 91E): the brokerage attribution on the end card — every producer stages it. */
    brokerageName?: string
  }
  voiceoverUrl?: string
  ctaLabel?:    string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to tour". */
  qrCaption?: string
  /** SOUND-OFF CAPTIONS (additive + default-off, wave 61). Precomputed word-accurate
   *  cues built upstream from REAL alignment — preferred. Same prop shape as the
   *  sibling JustListedReel/JustListedReelSquare. See CaptionLayer. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — the raw VO script text; CaptionLayer estimates
   *  timing in-composition when no cues are supplied. Absent → no captions. */
  captionScript?: string | null
  /** Wave 81C — THE MLS CUT (lib/video/render-cut.ts): no logo, no name, no phone, no CTA, no QR; the address instead. */
  mlsClean?: boolean
  /** WAVE 92 (lane 92E) — cutaway footage for the narration gaps a photo-scarce listing leaves
   *  (brollBenefit, lib/video/body-visual-model.ts); it plays in the PHOTO panel, only where the
   *  staged plan cut it, never across the facts column or the end card. */
  brollClips?: BrollClip[]
  /** "own" = the listing's own footage; anything else is stock — never on the MLS cut. */
  brollSource?: "own" | "stock" | null
  bodyVisualPlan?: BodyVisualPlan | null
}

// THE BODY IS COMPUTED, NOT TYPED (wave 78, lib/video/duration-model.ts):
// `PHOTOS = 10 * FPS` stood here. Bookends come from the ONE registry; the
// agent-facts tile is a fixed design beat INSIDE the body; the photo window
// is whatever the render's durationInFrames leaves.
const BOOKENDS = compositionBookends("JustListedReelHorizontal")
const COVER  = BOOKENDS.introFrames
// The agent-facts tile's length is REGISTERED (lane 93A): duration-model
// bodyTail / bodyTailFrames — the number the visual plan carves out too.
const CTA    = BOOKENDS.outroFrames

// Wave 89 — the header sits inside the frame's safe insets (it was a typed 32 px
// band, inside the platform's top UI band).
const BrandHeader: React.FC<{
  logoUrl?: string; brokerageName?: string; top: number; left: number; right: number
}> = ({ logoUrl, top, left, right }) => (
  <div style={{
    position: "absolute", top, left, right,
    display: "flex", alignItems: "center", justifyContent: "space-between",
  }}>
    {logoUrl ? (
      <SafeImg src={logoUrl} style={{ height: 40, objectFit: "contain" }} />
    ) : <div />}
    <div style={{
      width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff", opacity: 0.5,
    }} />
  </div>
)

const PhotoFrame: React.FC<{ url: string; span: number }> = ({ url, span }) => {
  const frame = useCurrentFrame()
  const scale = interpolate(frame, [0, span], [1, 1.05], { extrapolateLeft: "clamp", extrapolateRight: "clamp", output: "perceptual-scale" })
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <SafeImg src={url} style={{
        width: "100%", height: "100%", objectFit: "cover",
        scale, transformOrigin: "center center",
      }} />
    </AbsoluteFill>
  )
}

export const JustListedReelHorizontal: React.FC<JustListedReelHorizontalProps> = ({
  hook, address, cityState, price, bedrooms, bathrooms, sqft,
  imageUrls, brand, voiceoverUrl, ctaLabel, qrCodeDataUrl, qrCaption,
  captionsCues, captionScript, mlsClean, brollClips, brollSource, bodyVisualPlan,
}) => {
  const frame    = useCurrentFrame()
  const { durationInFrames, width, height } = useVideoConfig()
  const { safe } = cinemaFrame(width, height)
  const timeline = computeAssemblyTimeline({ durationInFrames, introFrames: COVER, outroFrames: CTA })
  const BODY     = timeline.body.durationInFrames
  const FACTS_FRAMES = bodyTailFrames("JustListedReelHorizontal", BODY)
  const PHOTOS   = BODY - FACTS_FRAMES
  const images   = imageUrls.slice(0, 2)
  // WAVE 92 (lane 92E): footage only in the plan's narration gaps inside the photo window;
  // the photos tile what the footage leaves (photoSpansAround — no photo repeats).
  const footage  = mlsClean && brollSource !== "own" ? [] : (brollClips ?? [])
  const brollWins = footage.length > 0 ? brollMountWindows(fitBodyVisualPlan(bodyVisualPlan, "JustListedReelHorizontal", durationInFrames), { within: { from: COVER, durationInFrames: PHOTOS } }) : []
  const photoSpans = photoSpansAround(PHOTOS, brollWins.map((w) => ({ from: w.from - COVER, durationInFrames: w.durationInFrames })), images.length)
  const showEho  = brand.showEhoMark ?? true
  const disclosure = slideDisclosureText({ brokerageName: mlsClean ? null : brand.brokerageName, showEhoMark: showEho, licenseLine: mlsClean ? null : brand.licenseLine })
  const finalCta = mlsClean ? mlsNeutralTitle(address, cityState) : (ctaLabel ?? "Tour this listing")

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
          <BrandHeader logoUrl={mlsClean ? undefined : brand.logoUrl} top={safe.top} left={safe.left} right={safe.right} />
          <div style={{
            fontSize: 32, letterSpacing: 8, textTransform: "uppercase",
            color: brand.accentColor, fontWeight: 800,
            opacity: interpolate(frame, [0, 18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {hook}
          </div>
          <div style={{
            fontSize: 124, fontWeight: 900, color: "#fff", lineHeight: 1.0,
            marginTop: 32, opacity: interpolate(frame, [14, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {address}
          </div>
          <div style={{
            fontSize: 44, color: "#fff", opacity: interpolate(frame, [28, 50], [0, 0.85], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            marginTop: 20, letterSpacing: 4,
          }}>
            {cityState}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* PHOTOS — 3-13s. Split layout: photo (60%) + facts (40%). */}
      <Sequence from={COVER} durationInFrames={PHOTOS}>
        {/* WAVE 92 (lane 92E — the real render): <AbsoluteFill> is a COLUMN flexbox, so the
            "split layout" stacked the 60 % photo panel ABOVE the facts column and squeezed the
            photo (and now the footage) into the top third of the frame. The split is a ROW. */}
        <AbsoluteFill style={{ display: "flex", flexDirection: "row" }}>
          <div style={{ width: "60%", height: "100%", position: "relative" }}>
            {images.length > 0 ? (
              photoSpans.map((p, idx) => (
                <Sequence key={idx} from={p.from} durationInFrames={p.durationInFrames}>
                  <PhotoFrame url={images[p.photoIndex]} span={p.durationInFrames} />
                </Sequence>
              ))
            ) : (
              <AbsoluteFill style={{
                backgroundColor: brand.primaryColor, display: "flex",
                alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 32, opacity: 0.5,
              }}>
                Photos coming soon
              </AbsoluteFill>
            )}
            <PlannedBrollLayer clips={footage} windows={brollWins} offset={COVER}
              overlayColor={`${brand.primaryColor}40`} clipCaptions={false} filmGrain />
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
      <Sequence from={COVER + PHOTOS} durationInFrames={FACTS_FRAMES}>
        <AbsoluteFill style={{
          padding: 80, display: "flex", flexDirection: "column", justifyContent: "center",
          color: "#fff", backgroundColor: brand.primaryColor,
        }}>
          <BrandHeader logoUrl={mlsClean ? undefined : brand.logoUrl} top={safe.top} left={safe.left} right={safe.right} />
          <div style={{ fontSize: 44, opacity: 0.85, letterSpacing: 4, textTransform: "uppercase", marginBottom: 20 }}>
            {mlsClean ? cityState : "Your agent"}
          </div>
          {!mlsClean && brand.agentName && (
            <div style={{ fontSize: 124, fontWeight: 900, color: brand.accentColor, lineHeight: 1 }}>
              {brand.agentName}
            </div>
          )}
          {!mlsClean && brand.agentPhone && (
            <div style={{ fontSize: 48, opacity: 0.8, marginTop: 24 }}>{brand.agentPhone}</div>
          )}
        </AbsoluteFill>
      </Sequence>

      {/* OUTRO CTA — 17-20s. */}
      <Sequence from={COVER + BODY} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 80, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <BrandHeader logoUrl={mlsClean ? undefined : brand.logoUrl} top={safe.top} left={safe.left} right={safe.right} />
          <div style={{ fontSize: 108, fontWeight: 900, lineHeight: 1.05, marginBottom: 32 }}>
            {finalCta}
          </div>
          {!mlsClean && brand.agentName && (
            <div style={{ fontSize: 44, color: brand.accentColor, fontWeight: 700 }}>{brand.agentName}</div>
          )}
          {/* Wave 89 — the disclosure on the safe bottom inset at the caption
              step (cinemaDisclosureStyle); it was 24 px from the edge in 16 px type. */}
          {/* Wave 91 (lane 91E): brokerage · Equal Housing Opportunity · licence through the ONE
              composer (slideDisclosureText) — it printed the mark and the licence with no brokerage
              name, and a dangling " · " when no licence was staged. The MLS cut stays unbranded. */}
          <div style={{ position: "absolute", ...cinemaDisclosureStyle(width, height) }}>
            {disclosure}
          </div>
          <QrOutroBadge
            mlsClean={mlsClean}
            qrCodeDataUrl={qrCodeDataUrl}
            caption={qrCaption ?? "Scan to tour"}
            primaryColor={brand.primaryColor}
            accentColor={brand.accentColor}
          />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={durationInFrames - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>

      {/* NO CAPTION OVER BRANDING/CTA (wave 61, mirrors JustListedReel.tsx) —
          clip before the CTA tile at COVER + BODY. */}
      <CaptionLayer
        cues={captionsCues}
        script={captionScript}
        accentColor={brand.accentColor}
        hiddenFromFrame={COVER + BODY}
      />
    </AbsoluteFill>
  )
}
