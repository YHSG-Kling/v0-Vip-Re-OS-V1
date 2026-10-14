/**
 * remotion/JustSoldReelSquare.tsx
 *
 * Wave 39 — Just Sold variant of JustListedReelSquare. Same 1080×1080
 * square format and 12s duration, but the messaging stack is
 * fundamentally different: this composition's job is SOCIAL PROOF,
 * not LISTING DISCOVERY.
 *
 * Why a separate composition (vs adding a "sold" flag to JustListed):
 *   · The opening hook is "SOLD" not "AVAILABLE" — distinct typographic
 *     treatment (heavier weight, accent-color burst) signals execution
 *   · The facts strip surfaces SOLD PRICE + "days on market" — the
 *     two metrics that build "this agent moves listings" trust
 *   · Optional "above asking" badge — when soldPrice > listPrice we
 *     show "SOLD $X ABOVE ASKING" as social proof for the agent's
 *     pricing accuracy. Falls back silently when listPrice is null.
 *   · The CTA is "List with me" / "Get your home's number" — buyer-
 *     intent CTAs would be off-frame for a sold property
 *
 * Compliance: shows the property address + city/state with the SOLD
 * treatment AFTER the closing has been recorded. Caller path
 * verifies closing before queuing the render — Fair Housing aside,
 * advertising a "sold" property that hasn't closed is a regulatory
 * issue in some states.
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

export interface JustSoldReelSquareProps {
  address:   string
  cityState: string
  /** Final sold price string, e.g. "$640,000". */
  soldPrice: string
  /** Original list price, optional. When present AND soldOverList
   *  is computable, the composition shows the "ABOVE ASKING" badge. */
  listPrice?: string | null
  /** Days on market — used as a trust signal "Closed in N days". */
  daysOnMarket?: number | null
  /** 1-4 property images (post-close, exterior preferred — the
   *  listing may still have a "Sold" sticker on the sign in the
   *  photo, which is on-brand). */
  imageUrls: string[]
  /** CTA — defaults to "List your home with me" (the typical
   *  seller-side intent for a JustSold post). */
  ctaLabel?: string
  brand: {
    primaryColor: string
    accentColor:  string
    logoUrl?:     string
    agentName?:   string
    agentPhone?:  string
    showEhoMark?: boolean
    /** Wave 91 (lane 91E): the brokerage attribution on the end card — every producer stages it. */
    brokerageName?: string
    licenseLine?:   string
  }
  voiceoverUrl?: string
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to list with me". */
  qrCaption?: string
  /** SOUND-OFF CAPTIONS (additive + default-off). Word-accurate cues from real
   *  ElevenLabs alignment — preferred over captionScript. */
  captionsCues?: CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — raw VO script text; timing estimated in-comp. */
  captionScript?: string | null
  /** Wave 81C — THE MLS CUT (lib/video/render-cut.ts): no logo, no name, no phone, no CTA, no QR; the address instead. */
  mlsClean?: boolean
  /** WAVE 92 (lane 92E) — cutaway footage for the narration gaps a photo-scarce sale leaves
   *  (brollBenefit, lib/video/body-visual-model.ts); played only where the staged plan cut it. */
  brollClips?: BrollClip[]
  /** "own" = the listing's own footage; anything else is stock — never on the MLS cut. */
  brollSource?: "own" | "stock" | null
  bodyVisualPlan?: BodyVisualPlan | null
}

const FPS    = 30
// THE BODY IS COMPUTED, NOT TYPED (wave 78, lib/video/duration-model.ts):
// `PHOTOS = 8 * FPS` stood here. Bookends come from the ONE registry; the
// photo window is whatever the render's durationInFrames leaves between them.
const BOOKENDS = compositionBookends("JustSoldReelSquare")
const COVER  = BOOKENDS.introFrames
const CTA    = BOOKENDS.outroFrames
void FPS

/** Compute the "above asking" badge text when we have both prices.
 *  Returns null when prices aren't both present or numeric-parseable
 *  or when sold isn't strictly above list. */
function aboveAskingBadge(sold: string, list: string | null | undefined): string | null {
  if (!list) return null
  const cleanNum = (s: string) => Number(s.replace(/[^\d.]/g, ""))
  const s = cleanNum(sold)
  const l = cleanNum(list)
  if (!Number.isFinite(s) || !Number.isFinite(l) || s <= l) return null
  const diff = s - l
  // Round to nearest $1k for the badge; precision on social ads
  // adds clutter without trust.
  const roundedK = Math.round(diff / 1000)
  return `$${roundedK}K ABOVE ASKING`
}

export const JustSoldReelSquare: React.FC<JustSoldReelSquareProps> = ({
  address, cityState, soldPrice, listPrice, daysOnMarket, imageUrls,
  ctaLabel, brand, voiceoverUrl, qrCodeDataUrl, qrCaption,
  captionsCues, captionScript, mlsClean, brollClips, brollSource, bodyVisualPlan,
}) => {
  const frame    = useCurrentFrame()
  const { durationInFrames, width, height } = useVideoConfig()
  const { safe } = cinemaFrame(width, height)
  const timeline = computeAssemblyTimeline({ durationInFrames, introFrames: COVER, outroFrames: CTA })
  const PHOTOS   = timeline.body.durationInFrames
  const images   = imageUrls.slice(0, 4)
  // WAVE 92 (lane 92E): footage only in the plan's narration gaps, never on the end card or as
  // stock on the MLS cut; the photos tile the frames the footage leaves (no photo repeats).
  const footage  = mlsClean && brollSource !== "own" ? [] : (brollClips ?? [])
  const brollWins = footage.length > 0 ? brollMountWindows(fitBodyVisualPlan(bodyVisualPlan, "JustSoldReelSquare", durationInFrames), { within: timeline.body }) : []
  const photoSpans = photoSpansAround(PHOTOS, brollWins.map((w) => ({ from: w.from - COVER, durationInFrames: w.durationInFrames })), images.length)
  const showEho  = brand.showEhoMark ?? true
  // Wave 91 (lane 91E): brokerage · Equal Housing Opportunity · licence, composed ONCE
  // (slideDisclosureText). The MLS cut stays unbranded — the mark alone (lib/video/render-cut.ts).
  const disclosure = slideDisclosureText({ brokerageName: mlsClean ? null : brand.brokerageName, showEhoMark: showEho, licenseLine: mlsClean ? null : brand.licenseLine })
  const factsSlot = cinemaBadgeSlot(width, height)
  const finalCta = mlsClean ? mlsNeutralTitle(address, cityState) : (ctaLabel ?? "List your home with me")
  const badge    = aboveAskingBadge(soldPrice, listPrice ?? null)

  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* COVER — 0-2s. SOLD treatment with accent burst. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
          padding: 64, textAlign: "center",
        }}>
          <div style={{
            display: "inline-block",
            padding: "16px 36px",
            backgroundColor: brand.accentColor,
            color: brand.primaryColor,
            fontSize: 64, fontWeight: 900, letterSpacing: 6,
            borderRadius: 8,
            scale: interpolate(frame, [0, 15], [0.8, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", output: "perceptual-scale" }),
            opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            SOLD
          </div>
          <div style={{
            fontSize: 64, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            marginTop: 32, opacity: interpolate(frame, [10, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {address}
          </div>
          <div style={{
            fontSize: 32, color: "#fff", opacity: interpolate(frame, [20, 40], [0, 0.85], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            marginTop: 16,
          }}>
            {cityState}
          </div>
          {!mlsClean && brand.logoUrl && (
            <div style={{ position: "absolute", top: safe.top, left: safe.left }}>
              <SafeImg src={brand.logoUrl} style={{ height: 56, objectFit: "contain", opacity: 0.85 }} />
            </div>
          )}
        </AbsoluteFill>
      </Sequence>

      {/* PHOTOS — 2-10s. Ken-burns + persistent SOLD PRICE strip +
          optional ABOVE ASKING badge at top-right. */}
      <Sequence from={COVER} durationInFrames={PHOTOS}>
        {images.length === 0 ? (
          <AbsoluteFill style={{
            backgroundColor: brand.primaryColor, display: "flex",
            alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 36, opacity: 0.55,
          }}>
            Closed — congratulations to the seller
          </AbsoluteFill>
        ) : (
          photoSpans.map((p, idx) => (
            <Sequence key={idx} from={p.from} durationInFrames={p.durationInFrames}>
              <SoldPhotoFrame url={images[p.photoIndex]} span={p.durationInFrames} />
            </Sequence>
          ))
        )}
        <PlannedBrollLayer clips={footage} windows={brollWins} offset={COVER}
          overlayColor={`${brand.primaryColor}59`} clipCaptions={false} filmGrain />

        {/* Top-right SOLD badge — small, persistent */}
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          {/* Wave 89 — inside the safe insets (it was a typed 24 px corner, inside the platform's top UI band). */}
          <div style={{
            position: "absolute", top: safe.top, right: safe.right,
            padding: "10px 20px",
            backgroundColor: brand.accentColor,
            color: brand.primaryColor,
            fontSize: 22, fontWeight: 900, letterSpacing: 3,
            borderRadius: 6,
          }}>
            SOLD
          </div>
          {badge && (
            <div style={{
              position: "absolute", top: safe.top + 56, right: safe.right,
              padding: "8px 16px",
              backgroundColor: "rgba(255,255,255,0.95)",
              color: brand.primaryColor,
              fontSize: 18, fontWeight: 700, letterSpacing: 2,
              borderRadius: 6,
            }}>
              {badge}
            </div>
          )}

          {/* Bottom facts strip — sold price + days on market.
              WAVE 91 (lane 91E — the real render, before-JustSoldReelSquare-mid.png): the
              strip's text sat at the frame's bottom edge (padding 32 px), inside the
              player's bottom UI AND under the burned-in caption band, so every cue was
              printed across the sold price. The gradient still reaches the edge; the TEXT
              stands in the badge slot, above the caption band (cinemaBadgeSlot). */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            padding: `32px ${factsSlot.right}px ${factsSlot.bottom}px ${factsSlot.left}px`,
            background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%)",
            color: "#fff",
          }}>
            <div style={{ fontSize: 58, fontWeight: 800, marginBottom: 8 }}>{soldPrice}</div>
            {(daysOnMarket ?? null) !== null && (
              <div style={{ fontSize: 26, fontWeight: 500, opacity: 0.9 }}>
                Closed in {daysOnMarket} {daysOnMarket === 1 ? "day" : "days"}
              </div>
            )}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 10-12s. Seller-intent CTA + agent + EHO. */}
      <Sequence from={COVER + PHOTOS} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor,
        }}>
          <div style={{
            fontSize: 72, fontWeight: 800, color: "#fff", lineHeight: 1.1, marginBottom: 28,
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
            caption={qrCaption ?? "Scan to list with me"}
            primaryColor={brand.primaryColor}
            accentColor={brand.accentColor}
          />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={durationInFrames - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>

      {/* NO CAPTION OVER BRANDING (wave 57) — clip before the CTA/QR tile. */}
      <CaptionLayer cues={captionsCues} script={captionScript} accentColor={brand.accentColor}
        hiddenFromFrame={COVER + PHOTOS} />
    </AbsoluteFill>
  )
}

const SoldPhotoFrame: React.FC<{ url: string; span: number }> = ({ url, span }) => {
  const frame = useCurrentFrame()
  const scale = interpolate(frame, [0, span], [1, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp", output: "perceptual-scale" })
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
