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
import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { CaptionLayer } from "./components/CaptionLayer"
import type { CaptionCue } from "../lib/video/caption-plan"

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
}

const FPS    = 30
const TOTAL  = 12 * FPS
const COVER  = 2  * FPS
const PHOTOS = 8  * FPS
const CTA    = 2  * FPS

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
  captionsCues, captionScript,
}) => {
  const frame    = useCurrentFrame()
  const images   = imageUrls.slice(0, 4)
  const perPhoto = images.length > 0 ? PHOTOS / images.length : PHOTOS
  const showEho  = brand.showEhoMark ?? true
  const finalCta = ctaLabel ?? "List your home with me"
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
            transform: `scale(${interpolate(frame, [0, 15], [0.8, 1])})`,
            opacity: interpolate(frame, [0, 12], [0, 1]),
          }}>
            SOLD
          </div>
          <div style={{
            fontSize: 64, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            marginTop: 32, opacity: interpolate(frame, [10, 30], [0, 1]),
          }}>
            {address}
          </div>
          <div style={{
            fontSize: 32, color: "#fff", opacity: interpolate(frame, [20, 40], [0, 0.85]),
            marginTop: 16,
          }}>
            {cityState}
          </div>
          {brand.logoUrl && (
            <div style={{ position: "absolute", top: 40, left: 40 }}>
              <Img src={brand.logoUrl} style={{ height: 56, objectFit: "contain", opacity: 0.85 }} />
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
          images.map((url, idx) => {
            const start = idx * perPhoto
            return (
              <Sequence key={idx} from={start} durationInFrames={perPhoto}>
                <SoldPhotoFrame url={url} span={perPhoto} />
              </Sequence>
            )
          })
        )}

        {/* Top-right SOLD badge — small, persistent */}
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div style={{
            position: "absolute", top: 24, right: 24,
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
              position: "absolute", top: 80, right: 24,
              padding: "8px 16px",
              backgroundColor: "rgba(255,255,255,0.95)",
              color: brand.primaryColor,
              fontSize: 18, fontWeight: 700, letterSpacing: 2,
              borderRadius: 6,
            }}>
              {badge}
            </div>
          )}

          {/* Bottom facts strip — sold price + days on market */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            padding: "32px 56px",
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
          <QrOutroBadge
            qrCodeDataUrl={qrCodeDataUrl}
            caption={qrCaption ?? "Scan to list with me"}
            primaryColor={brand.primaryColor}
            accentColor={brand.accentColor}
          />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>

      <CaptionLayer cues={captionsCues} script={captionScript} accentColor={brand.accentColor} />
    </AbsoluteFill>
  )
}

const SoldPhotoFrame: React.FC<{ url: string; span: number }> = ({ url, span }) => {
  const frame = useCurrentFrame()
  const scale = interpolate(frame, [0, span], [1, 1.08], { extrapolateRight: "clamp" })
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
