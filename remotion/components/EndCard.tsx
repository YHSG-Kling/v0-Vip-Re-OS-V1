/**
 * remotion/components/EndCard.tsx
 *
 * THE ONE end card (lane 78D, §6 — lane 77D named "four private outros with
 * different prop shapes" as the next consolidation). Merged onto this
 * survivor, each with a tombstone at its old declaration:
 *   · remotion/PartnersMeetingReel.tsx   `OutroScene`  (centered, layered background, "Presented by…" line)
 *   · remotion/NewsletterDigestVideo.tsx `OutroCta`    (start-aligned, headline + accent subline, QR)
 *   · remotion/PhotoWalkthroughReel.tsx  `OutroCTA`    (start-aligned, CTA + agent name + phone, no QR)
 *   · remotion/TeammateExplainerReel.tsx `OutroCard`   (centered, CTA + agent name, QR, mlsClean)
 * remotion/MemoryVideoReel.tsx (lane 78D) mounts it too.
 *
 * WHAT IT RENDERS, in order: logo (when set) → headline → accent rule
 * (centered layout only) → subline (accent colour) → detail (plain) → a small
 * footer line at the bottom carrying the fair-housing mark → the tracked QR
 * badge (when a data URL is given and `showQr` is not false). Every caller's
 * Sequence duration is untouched — the card only fills the frames it is given.
 *
 * FAIR HOUSING: the "Equal Housing Opportunity" text is rendered HERE, once,
 * whenever `brand.showEhoMark` is not false and a footer line exists.
 * scripts/video-assembly-simulator.ts §branding recognises an imported-and-
 * rendered <EndCard> as inheritance of the mark (same rule as
 * <EqualHousingMark>), so a composition that mounts this card is not accused
 * of omitting it — and §endCard proves this file renders the literal.
 *
 * Animation is `interpolate(useCurrentFrame())` only (no CSS transitions —
 * they render as a static frame); movement uses `translate`, never a
 * `transform` string (Studio-editable, remotion-setup §5).
 */
import React from "react"
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./SafeImg"
import { QrOutroBadge } from "./QrOutroBadge"

export interface EndCardBrand {
  primaryColor: string
  accentColor: string
  logoUrl?: string | null
  brokerageName?: string
  /** Equal Housing Opportunity mark on the footer line. Defaults true. */
  showEhoMark?: boolean
}

export interface EndCardProps {
  brand: EndCardBrand
  /** The big line — a CTA, the brokerage name, "Open the email", "Thank you". */
  headline: string
  /** Accent-coloured line under the headline (agent name, "for this week's full digest"). */
  subline?: string | null
  /** Plain secondary line (a phone number, "Presented by your AI management team"). */
  detail?: string | null
  /** Small bottom line. undefined → the brokerage name; null → no footer (and no EHO text — the composition renders its own mark elsewhere). */
  footer?: string | null
  /** "center" (default) stacks and centres everything; "start" is the left-aligned padded card. */
  align?: "center" | "start"
  logoHeight?: number
  fontFamily?: string
  qrCodeDataUrl?: string | null
  qrCaption?: string | null
  /** MLS-bound cut — suppresses the agent-branded QR badge (QrOutroBadge's own flag). */
  mlsClean?: boolean
  /** false hides the QR badge even when a data URL is supplied (a keepsake, a photo tour). */
  showQr?: boolean
  /** A caller-supplied background layer (PartnersMeetingReel's layered gradients); default is the flat primary colour. */
  background?: React.ReactNode
  /** Frames the card takes to fade in. Default 15. */
  fadeInFrames?: number
}


export const EndCard: React.FC<EndCardProps> = ({
  brand, headline, subline, detail, footer, align = "center", logoHeight = 72, fontFamily,
  qrCodeDataUrl, qrCaption, mlsClean, showQr = true, background, fadeInFrames = 15,
}) => {
  const frame = useCurrentFrame()
  const fade = Math.max(1, fadeInFrames)
  const opacity = interpolate(frame, [0, fade], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const rise = interpolate(frame, [0, fade + 6], [18, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const centered = align === "center"
  const showEho = brand.showEhoMark ?? true
  const footerText = footer === null ? null : (footer ?? brand.brokerageName ?? null)
  const font = fontFamily ?? "system-ui, -apple-system, sans-serif"

  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: font, color: "#fff" }}>
      {background}
      <AbsoluteFill
        style={{
          padding: 80,
          justifyContent: "center",
          alignItems: centered ? "center" : "flex-start",
          textAlign: centered ? "center" : "left",
          opacity,
        }}
      >
        <div style={{ translate: `0 ${rise}px`, maxWidth: centered ? 1400 : undefined }}>
          {brand.logoUrl && (
            <SafeImg src={brand.logoUrl} style={{ height: logoHeight, objectFit: "contain", marginBottom: 32, display: "block", marginLeft: centered ? "auto" : 0, marginRight: centered ? "auto" : 0 }} />
          )}
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, textShadow: centered ? "0 10px 44px rgba(0,0,0,0.35)" : undefined }}>
            {headline}
          </div>
          {centered && <div style={{ width: 90, height: 4, borderRadius: 2, backgroundColor: brand.accentColor, margin: "22px auto 0" }} />}
          {subline && (
            <div style={{ fontSize: 44, color: brand.accentColor, fontWeight: 600, marginTop: centered ? 22 : 32 }}>
              {subline}
            </div>
          )}
          {detail && (
            <div style={{ fontSize: 30, opacity: 0.85, marginTop: centered ? 18 : 8 }}>
              {detail}
            </div>
          )}
        </div>
      </AbsoluteFill>
      {footerText && (
        <div style={{
          position: "absolute", bottom: 26, left: 0, right: 0,
          textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5, color: "#fff",
        }}>
          {footerText}{showEho && " · Equal Housing Opportunity"}
        </div>
      )}
      {showQr && (
        <QrOutroBadge
          qrCodeDataUrl={qrCodeDataUrl}
          caption={qrCaption ?? "Scan to connect"}
          primaryColor={brand.primaryColor}
          accentColor={brand.accentColor}
          mlsClean={mlsClean}
        />
      )}
    </AbsoluteFill>
  )
}
