/**
 * remotion/PostcardFront6x9.tsx
 *
 * Wave 36 — branded 6×9 postcard FRONT for Lob fulfillment.
 *
 * Lob spec:
 *   Trim:    6"  × 9"           = 1800 × 2700 px @ 300 DPI
 *   Bleed:   6.25" × 9.25"      = 1875 × 2775 px @ 300 DPI  ← we render here
 *   Safe:    0.1875" inset
 *
 * The 6×9 is Lob's premium postcard tier (~$1.10/piece vs ~$0.78 for
 * 4×6) — used for HIGH-VALUE sends where the extra canvas earns its
 * cost: listing promos (just_listed / just_sold / open_house), luxury
 * persona pieces, anniversary/lifetime-customer reach-outs. The
 * orchestrator picks 6×9 over 4×6 based on copyCtx.persona +
 * pieceUse (luxury → 6×9 by default; farm_mail → 4×6).
 *
 * Layout uses the extra height to show a PROPERTY PHOTO as the visual
 * hero (~55% of the canvas). Postcard 4×6 reserves visual real estate
 * for the headline; 6×9 reserves it for the photo because at 6×9
 * sizes a photo HAS impact, where at 4×6 it just looks small.
 *
 * Branding sourced via resolveBrokerageBrandContext, copy via
 * draftPostcardCopy. Same pipeline as the 4×6 — different layout.
 */
import React from "react"
import { AbsoluteFill, Img } from "remotion"
import { SafeImg } from "./components/SafeImg"

export interface PostcardFront6x9Props {
  headline: string
  body:     string
  cta:      string
  /** Optional status badge — "JUST LISTED", "JUST SOLD", "OPEN HOUSE",
   *  "PRICE IMPROVED", etc. Null = no badge. The only writer is
   *  lib/direct-mail/listing-lifecycle-mail-reactor.ts EVENT_DEFAULTS, which
   *  takes the price wording from lib/listings/price-improvement-label.ts —
   *  this card is PRINTED for a consumer, so it never says "reduced". */
  statusBadge:   string | null
  /** Property hero photo URL. When provided, becomes the top ~55% of
   *  the canvas. When null, falls back to a brand-color gradient. */
  propertyPhotoUrl: string | null
  qrCodeDataUrl: string | null
  brand: {
    primaryColor:     string
    accentColor:      string
    logoUrl:          string | null
    brokerageName:    string
    websiteWordmark:  string | null
    phone:            string | null
    licenseLine:      string | null
    shortDisclosure:  string
  }
}

const SAFE_INSET = 70

export const PostcardFront6x9: React.FC<PostcardFront6x9Props> = ({
  headline, body, cta, statusBadge, propertyPhotoUrl, qrCodeDataUrl, brand,
}) => {
  const photoHeight = 1530  // ~55% of 2775

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      color: "#fff",
    }}>
      {/* Hero — property photo (or gradient placeholder) */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: photoHeight,
        overflow: "hidden",
      }}>
        {propertyPhotoUrl ? (
          <SafeImg src={propertyPhotoUrl} style={{
            width: "100%", height: "100%", objectFit: "cover",
          }} />
        ) : (
          <div style={{
            width: "100%", height: "100%",
            background: `linear-gradient(135deg, ${brand.primaryColor} 0%, ${brand.accentColor} 100%)`,
          }} />
        )}
        {/* Photo darken-gradient bottom for headline contrast */}
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0, height: 280,
          background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%)",
        }} />
        {/* Status badge top-left of photo */}
        {statusBadge && (
          <div style={{
            position: "absolute", top: 60, left: 60,
            backgroundColor: brand.accentColor,
            color: brand.primaryColor,
            padding: "16px 32px",
            fontSize: 36, fontWeight: 800,
            letterSpacing: 2, textTransform: "uppercase",
            borderRadius: 8,
          }}>{statusBadge}</div>
        )}
        {/* Brokerage chip top-right of photo */}
        <div style={{
          position: "absolute", top: 60, right: 60,
          display: "flex", alignItems: "center", gap: 16,
          backgroundColor: "rgba(0,0,0,0.55)",
          padding: "12px 20px", borderRadius: 8,
        }}>
          {brand.logoUrl && (
            <SafeImg src={brand.logoUrl} style={{ height: 44, width: "auto", objectFit: "contain" }} />
          )}
          <div style={{ fontSize: 24, fontWeight: 700 }}>{brand.brokerageName}</div>
        </div>
      </div>

      {/* Accent rule between photo + content */}
      <div style={{
        position: "absolute", top: photoHeight, left: 0, right: 0, height: 12,
        backgroundColor: brand.accentColor,
      }} />

      {/* Content panel below photo */}
      <div style={{
        position: "absolute",
        top: photoHeight + 60,
        left: SAFE_INSET,
        right: SAFE_INSET + 420,  // QR column reserved on the right
        bottom: SAFE_INSET + 180,  // footer reserved at bottom
      }}>
        <div style={{
          fontSize: 96, fontWeight: 800, lineHeight: 1.05,
          letterSpacing: -2, marginBottom: 32,
        }}>
          {headline}
        </div>
        <div style={{ fontSize: 36, lineHeight: 1.45, color: "rgba(255,255,255,0.92)", marginBottom: 40 }}>
          {body}
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 16,
          padding: "24px 44px",
          backgroundColor: brand.accentColor,
          color: brand.primaryColor,
          fontSize: 38, fontWeight: 700, borderRadius: 999,
        }}>
          {cta}
          <span style={{ fontSize: 32, lineHeight: 1 }}>→</span>
        </div>
      </div>

      {/* QR panel — right column under the photo */}
      <div style={{
        position: "absolute",
        right: SAFE_INSET, top: photoHeight + 60,
        width: 380, height: 380,
        backgroundColor: "#fff",
        borderRadius: 18,
        padding: 20,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {qrCodeDataUrl && (
          <Img src={qrCodeDataUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        )}
      </div>
      <div style={{
        position: "absolute",
        right: SAFE_INSET, top: photoHeight + 460,
        width: 380,
        textAlign: "center",
        fontSize: 26, fontWeight: 600, opacity: 0.85,
      }}>
        Scan with your camera
      </div>

      {/* Footer */}
      <div style={{
        position: "absolute",
        bottom: SAFE_INSET, left: SAFE_INSET, right: SAFE_INSET,
        borderTop: `2px solid ${brand.accentColor}`,
        paddingTop: 20,
        display: "flex", justifyContent: "space-between", alignItems: "flex-end",
        fontSize: 20, lineHeight: 1.35, color: "rgba(255,255,255,0.78)",
      }}>
        <div style={{ flex: 1, paddingRight: 20 }}>
          {brand.licenseLine && <div>{brand.licenseLine}</div>}
          <div style={{ marginTop: 6 }}>{brand.shortDisclosure}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {brand.websiteWordmark && <div style={{ fontSize: 26, fontWeight: 600 }}>{brand.websiteWordmark}</div>}
          {brand.phone && <div style={{ marginTop: 4 }}>{brand.phone}</div>}
        </div>
      </div>
    </AbsoluteFill>
  )
}
