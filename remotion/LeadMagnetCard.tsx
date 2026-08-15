/**
 * remotion/LeadMagnetCard.tsx
 *
 * Wave 39 — 1200×630 Open-Graph card composition for paid lead-magnet
 * ads. Used by the future W40 ad creator for placements where the
 * visual IS the offer:
 *
 *   · Facebook lead-form ads — the OG ratio is the canvas
 *   · LinkedIn Sponsored Content — 1.91:1 ratio matches
 *   · Twitter Cards / X Cards — same
 *   · Email-share fallback when the same campaign drops to SMTP
 *
 * Composition shape:
 *   ┌────────────────────────────────────────────────┐
 *   │  HERO IMAGE (right 50%)   │  HEADLINE          │
 *   │                           │  SUBHEAD           │
 *   │                           │  CTA BADGE         │
 *   │                           │  brand chip + EHO  │
 *   └────────────────────────────────────────────────┘
 *
 * Hero image position is chosen so the headline never collides with
 * a face or a focal point. When the brokerage has no hero image
 * available, the left/right split collapses to a centered text card
 * — still on-brand, still ad-eligible.
 *
 * Compliance: copy fields are passed in pre-gated (every preset that
 * fires this comp has compliance_event_id stamped at save). The
 * Equal Housing Opportunity mark renders by default; pass
 * brand.showEhoMark=false ONLY when the ad context legitimately
 * doesn't need it (e.g. an agent-recruitment ad rather than a
 * property-marketing ad).
 *
 * Single frame: this is a static composition. Remotion's
 * renderStill() outputs the PNG.
 */
import React from "react"
import { AbsoluteFill, Img } from "remotion"

export interface LeadMagnetCardProps {
  /** Top hook — short eyebrow label (e.g. "FREE GUIDE"). 2-4 words. */
  eyebrow:   string
  /** Primary headline — 4-9 words, the offer in plain English. */
  headline:  string
  /** Subheadline — 8-16 words, the qualifier or social proof. */
  subhead:   string
  /** The button-style CTA text — 2-4 words. */
  ctaLabel:  string
  /** Optional hero image URL (right half). When null, the layout
   *  collapses to a centered text card on the brand background. */
  heroImageUrl: string | null
  brand: {
    primaryColor:    string
    accentColor:     string
    logoUrl?:        string
    brokerageName:   string
    /** EHO mark visibility — defaults true. Set false only when the
     *  ad isn't a property-marketing ad. */
    showEhoMark?:    boolean
    /** State + license number string when applicable (most states
     *  require disclosure on paid real-estate ads). */
    licenseLine?:    string
  }
}

export const LeadMagnetCard: React.FC<LeadMagnetCardProps> = ({
  eyebrow, headline, subhead, ctaLabel, heroImageUrl, brand,
}) => {
  const showEho = brand.showEhoMark ?? true
  const hasHero = !!heroImageUrl

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ display: "flex", height: "100%", width: "100%" }}>
        {/* TEXT PANEL — left, ~58% with hero / 100% without */}
        <div style={{
          width:   hasHero ? "58%" : "100%",
          padding: "56px 56px 48px 64px",
          color:   "#fff",
          display: "flex", flexDirection: "column", justifyContent: "space-between",
        }}>
          <div>
            {brand.logoUrl ? (
              <Img src={brand.logoUrl} style={{ height: 44, objectFit: "contain", marginBottom: 24 }} />
            ) : (
              <div style={{
                fontSize: 16, letterSpacing: 4, textTransform: "uppercase",
                color: "#fff", opacity: 0.7, marginBottom: 24,
              }}>{brand.brokerageName}</div>
            )}
            <div style={{
              display: "inline-block", padding: "6px 14px", borderRadius: 4,
              backgroundColor: brand.accentColor, color: brand.primaryColor,
              fontSize: 14, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase",
              marginBottom: 24,
            }}>
              {eyebrow}
            </div>
            <div style={{
              fontSize:    hasHero ? 52 : 64,
              fontWeight:  800, lineHeight: 1.05,
              marginBottom: 20,
            }}>
              {headline}
            </div>
            <div style={{
              fontSize:   hasHero ? 22 : 26,
              opacity:    0.82,
              lineHeight: 1.4,
              maxWidth:   hasHero ? "100%" : "85%",
            }}>
              {subhead}
            </div>
          </div>

          {/* Bottom row — CTA button + brand chip + EHO + license */}
          <div>
            <div style={{
              display: "inline-block",
              padding: "14px 28px",
              backgroundColor: brand.accentColor,
              color: brand.primaryColor,
              borderRadius: 6,
              fontSize: 22,
              fontWeight: 700,
              marginBottom: 20,
            }}>
              {ctaLabel}  →
            </div>
            <div style={{
              fontSize: 14, opacity: 0.6, lineHeight: 1.4,
            }}>
              {brand.brokerageName}
              {showEho && " · Equal Housing Opportunity"}
              {brand.licenseLine && (
                <>
                  <br/>
                  {brand.licenseLine}
                </>
              )}
            </div>
          </div>
        </div>

        {/* HERO PANEL — right ~42% */}
        {hasHero && (
          <div style={{
            width: "42%", height: "100%", position: "relative",
            backgroundColor: brand.accentColor,
          }}>
            <Img
              src={heroImageUrl as string}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            {/* Subtle inner border so the image edge reads as
                intentional instead of cropped */}
            <div style={{
              position: "absolute", top: 0, bottom: 0, left: 0, width: 4,
              backgroundColor: brand.primaryColor,
            }} />
          </div>
        )}
      </div>
    </AbsoluteFill>
  )
}
