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
import { Audio } from "@remotion/media"
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion"
import { computeAssemblyTimeline } from "../lib/video/assembly-timeline"
import { compositionBookends } from "../lib/video/duration-model"
import { SafeImg } from "./components/SafeImg"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { mlsNeutralTitle } from "../lib/video/render-cut"
import { CaptionLayer } from "./components/CaptionLayer"
import type { CaptionCue } from "../lib/video/caption-plan"
import { cinemaBadgeSlot, cinemaDisclosureStyle, cinemaFrame, slideDisclosureText } from "../lib/video/cinema-finish"
import { brollMountWindows, fitBodyVisualPlan, photoSpansAround, type BodyVisualPlan } from "../lib/video/body-visual-model"
import { PlannedBrollLayer, type BrollClip } from "./_BrollLayer"

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
    /** Wave 91 (lane 91E): the brokerage attribution on the end card — every producer stages it. */
    brokerageName?: string
    licenseLine?:   string
  }
  voiceoverUrl?: string
  /** Paid-ad CTA the brokerage wants on screen for the final
   *  beat. Defaults to "Tour this listing". Brokerage can override
   *  per campaign — e.g. "Get pricing", "See more photos". */
  ctaLabel?: string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to tour". */
  qrCaption?: string
  /** SOUND-OFF CAPTIONS (additive + default-off). Word-accurate cues from real
   *  ElevenLabs alignment — preferred over captionScript. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — raw VO script text; timing estimated in-comp. */
  captionScript?: string | null
  /** Wave 81C — THE MLS CUT (lib/video/render-cut.ts): no logo, no name, no phone, no CTA, no QR; the address instead. */
  mlsClean?: boolean
  /** WAVE 92 (lane 92E) — the cutaway footage the Video Director picked (lib/video/broll-picker.ts)
   *  when brollBenefit says this listing has too few photos to fill its narration. Before this the
   *  Director staged clips here and NOTHING read them (no b-roll layer — lane 91E's open item). */
  brollClips?: BrollClip[]
  /** "own" = the listing's own footage; anything else is stock — never on the MLS cut. */
  brollSource?: "own" | "stock" | null
  /** The staged body-visual plan: footage plays ONLY in the segments it cut to b-roll. */
  bodyVisualPlan?: BodyVisualPlan | null
}

const FPS    = 30
// THE BODY IS COMPUTED, NOT TYPED (wave 78, lib/video/duration-model.ts):
// `PHOTOS = 8 * FPS` stood here. Bookends come from the ONE registry; the
// photo window is whatever the render's durationInFrames leaves between them.
const BOOKENDS = compositionBookends("JustListedReelSquare")
const COVER  = BOOKENDS.introFrames
const CTA    = BOOKENDS.outroFrames
void FPS

/** Ken-Burns zoom factor — slow 1.0 → 1.08 over the photo's visible
 *  window. Subtle enough that the photo still reads as a single
 *  image, lively enough that the feed scroll doesn't read it as a
 *  static frame and skip past. */
function kenBurnsScale(localFrame: number, span: number): number {
  return interpolate(localFrame, [0, span], [1, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp", output: "perceptual-scale" })
}

export const JustListedReelSquare: React.FC<JustListedReelSquareProps> = ({
  hook, address, cityState, price, bedrooms, bathrooms, sqft,
  imageUrls, brand, voiceoverUrl, ctaLabel, qrCodeDataUrl, qrCaption,
  captionsCues, captionScript, mlsClean, brollClips, brollSource, bodyVisualPlan,
}) => {
  const frame      = useCurrentFrame()
  const { durationInFrames, width, height } = useVideoConfig()
  const { safe } = cinemaFrame(width, height)
  const timeline   = computeAssemblyTimeline({ durationInFrames, introFrames: COVER, outroFrames: CTA })
  const PHOTOS     = timeline.body.durationInFrames
  const images     = imageUrls.slice(0, 4)
  // WAVE 92 (lane 92E): footage only in the plan's narration gaps (brollMountWindows — never the
  // CTA end card), never stock on the MLS cut; the photos tile the frames the footage leaves
  // (photoSpansAround) so no photo repeats under the narration.
  const footage    = mlsClean && brollSource !== "own" ? [] : (brollClips ?? [])
  const brollWins  = footage.length > 0 ? brollMountWindows(fitBodyVisualPlan(bodyVisualPlan, "JustListedReelSquare", durationInFrames), { within: timeline.body }) : []
  const photoSpans = photoSpansAround(PHOTOS, brollWins.map((w) => ({ from: w.from - COVER, durationInFrames: w.durationInFrames })), images.length)
  const showEho    = brand.showEhoMark ?? true
  // Wave 91 (lane 91E): brokerage · Equal Housing Opportunity · licence, composed ONCE
  // (slideDisclosureText). The MLS cut stays unbranded — the mark alone (lib/video/render-cut.ts).
  const disclosure = slideDisclosureText({ brokerageName: mlsClean ? null : brand.brokerageName, showEhoMark: showEho, licenseLine: mlsClean ? null : brand.licenseLine })
  const finalCta   = mlsClean ? mlsNeutralTitle(address, cityState) : (ctaLabel ?? "Tour this listing")

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
            color: brand.accentColor, fontWeight: 700, opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {hook}
          </div>
          <div style={{
            fontSize: 80, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            marginTop: 28, opacity: interpolate(frame, [10, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {address}
          </div>
          <div style={{
            fontSize: 36, color: "#fff", opacity: interpolate(frame, [20, 40], [0, 0.85], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            marginTop: 16,
          }}>
            {cityState}
          </div>
          <div style={{
            position: "absolute", top: safe.top, left: safe.left, color: "#fff", opacity: 0.85,
            fontSize: 22, fontWeight: 600, letterSpacing: 2,
          }}>
            {!mlsClean && brand.logoUrl ? <SafeImg src={brand.logoUrl} style={{ height: 56, objectFit: "contain" }} /> : null}
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
          photoSpans.map((p, idx) => (
            <Sequence key={idx} from={p.from} durationInFrames={p.durationInFrames}>
              <PhotoFrame url={images[p.photoIndex]} span={p.durationInFrames} />
            </Sequence>
          ))
        )}
        <PlannedBrollLayer clips={footage} windows={brollWins} offset={COVER}
          overlayColor={`${brand.primaryColor}59`} clipCaptions={false} filmGrain />
        {/* Persistent facts strip. Floats over the photos so the
            viewer always sees the offer without waiting for a card
            section. Bottom-anchored so it doesn't compete with the
            photo's natural focal point.
            WAVE 91 (lane 91E — the real render, after-JustListedReelSquare-mid.png): the price
            sat 32 px from the frame's edge, inside the player's bottom UI and UNDER the burned-in
            caption band — the JustSoldReelSquare defect, same strip. The gradient still reaches
            the edge; the TEXT stands in the badge slot, above the caption band. */}
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            padding: `32px ${cinemaBadgeSlot(width, height).right}px ${cinemaBadgeSlot(width, height).bottom}px ${cinemaBadgeSlot(width, height).left}px`,
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
          {!mlsClean && brand.agentName && (
            <div style={{ fontSize: 40, color: brand.accentColor, fontWeight: 700 }}>{brand.agentName}</div>
          )}
          {!mlsClean && brand.agentPhone && (
            <div style={{ fontSize: 32, color: "#fff", opacity: 0.85, marginTop: 12 }}>
              {brand.agentPhone}
            </div>
          )}
          {disclosure && (
            /* Wave 89 — the disclosure on the safe bottom inset at the caption
               step (cinemaDisclosureStyle); it was a 24 px corner in 16 px type. */
            <div style={{ position: "absolute", ...cinemaDisclosureStyle(width, height), color: "#fff" }}>
              {disclosure}
            </div>
          )}
          <QrOutroBadge
            mlsClean={mlsClean}
            qrCodeDataUrl={qrCodeDataUrl}
            caption={qrCaption ?? "Scan to tour"}
            primaryColor={brand.primaryColor}
            accentColor={brand.accentColor}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Total duration sanity check — this guarantees the
          renderer always knows the length even if a Sequence is
          missing its photos. */}
      <Sequence from={durationInFrames - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>

      {/* NO CAPTION OVER BRANDING (wave 57) — clip before the CTA/QR tile. */}
      <CaptionLayer cues={captionsCues} script={captionScript} accentColor={brand.accentColor}
        hiddenFromFrame={COVER + PHOTOS} />
    </AbsoluteFill>
  )
}

const PhotoFrame: React.FC<{ url: string; span: number }> = ({ url, span }) => {
  const frame = useCurrentFrame()
  const scale = kenBurnsScale(frame, span)
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <SafeImg
        src={url}
        style={{
          width: "100%", height: "100%", objectFit: "cover",
          scale, transformOrigin: "center center",
        }}
      />
    </AbsoluteFill>
  )
}
