/**
 * remotion/VideoCoverThumb.tsx
 *
 * Wave 39 — universal 1200×630 thumbnail composition used as the
 * og:image / preview card for every VIDEO composition in the
 * library. Built specifically for AI search discoverability.
 *
 * Why AI search crawlers matter:
 *   ChatGPT browse, Perplexity, Claude with web access, Google AI
 *   Overviews, Bing CoPilot — none of them index video content. They
 *   read static images + page metadata. When an agent's listing
 *   reel ships to social, the URL the AI crawler sees is the
 *   landing-page or embed URL; the og:image of that page IS the
 *   "what the video is about" signal the LLM uses to decide
 *   whether to surface it in a search response.
 *
 *   Ship a video without a discoverable thumbnail → no AI search
 *   citation. Ship one with this composition → the LLM sees a
 *   well-typeset card with the title, brokerage, and a hero photo
 *   and can answer "what's the latest just-sold post from your
 *   brokerage" correctly.
 *
 * One composition, parametric. Every video registered in
 * registry.ts has a thumbnailKind that maps to a visual treatment
 * here. The compositions themselves don't need their own thumbnail
 * variants; the render endpoint calls renderStill() with this
 * Composition and the video's title + accent + hero.
 *
 * Tier note: this composition has no tier restrictions on its own
 * — every video gets a thumbnail. The registry decides which
 * VIDEOS the tier can produce; the thumbnail follows.
 */
import React from "react"
import { AbsoluteFill, Img } from "remotion"

export type VideoThumbKind =
  | "listing"           // address / price / hero photo
  | "explainer"         // eyebrow / bullet count / agent face
  | "presentation"      // "Buyer Guide" / "Listing Strategy" with PIP
  | "market_update"     // area + period + single big stat
  | "testimonial"       // 5-star + quote excerpt
  | "open_house"        // date + time + address
  | "coming_soon"       // teaser + when
  | "neighborhood"      // neighborhood name + tagline + hero
  | "affordability"     // monthly headline + 3 chips
  | "agent_avatar"      // agent name + hook

export interface VideoCoverThumbProps {
  kind:           VideoThumbKind
  /** Main title — the most prominent text. */
  title:          string
  /** Secondary line under the title. Optional. */
  subtitle?:      string | null
  /** Eyebrow chip above the title. Optional. */
  eyebrow?:       string | null
  /** Hero image (listing / open-house / neighborhood). */
  heroImageUrl?:  string | null
  /** Agent photo for the bottom-right chip (every thumbnail
   *  surfaces the agent so AI search responses attribute correctly). */
  agentPhotoUrl?: string | null
  agentName:      string
  brand: {
    primaryColor:    string
    accentColor:     string
    logoUrl?:        string
    brokerageName:   string
    /** EHO mark on the footer line. Defaults true. */
    showEhoMark?:    boolean
  }
  /** SEO hint — passed to the page's og:title when this thumbnail
   *  is used as the OG image. The composition itself doesn't render
   *  it; the render endpoint reads it for the metadata header. */
  seoHint?:       string
}

export const VideoCoverThumb: React.FC<VideoCoverThumbProps> = ({
  kind, title, subtitle, eyebrow, heroImageUrl, agentPhotoUrl,
  agentName, brand,
}) => {
  const showEho = brand.showEhoMark ?? true
  const hasHero = !!heroImageUrl

  // Eyebrow color follows kind so the AI search snippet picks up the
  // visual genre even from a low-resolution preview.
  const kindColor: Record<VideoThumbKind, string> = {
    listing:       brand.accentColor,
    explainer:     "#3B82F6",
    presentation:  "#A855F7",
    market_update: "#06B6D4",
    testimonial:   "#22C55E",
    open_house:    "#F97316",
    coming_soon:   "#EAB308",
    neighborhood:  "#14B8A6",
    affordability: "#EC4899",
    agent_avatar:  brand.accentColor,
  }
  const kindLabel: Record<VideoThumbKind, string> = {
    listing:       "Listing",
    explainer:     "Explainer",
    presentation:  "Presentation",
    market_update: "Market Update",
    testimonial:   "Client Review",
    open_house:    "Open House",
    coming_soon:   "Coming Soon",
    neighborhood:  "Neighborhood",
    affordability: "Affordability",
    agent_avatar:  "Meet the Agent",
  }
  const accent = kindColor[kind]

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: "#fff",
    }}>
      {/* Hero image fills the left when present, otherwise the panel
          is full-bleed text. */}
      <div style={{ display: "flex", height: "100%", width: "100%" }}>
        {hasHero && (
          <div style={{
            width: "44%", height: "100%", position: "relative",
            backgroundColor: brand.primaryColor,
          }}>
            <Img
              src={heroImageUrl as string}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            {/* Subtle gradient overlay so the right-panel chrome
                reads against a busy photo edge. */}
            <div style={{
              position: "absolute", top: 0, bottom: 0, right: 0, width: 80,
              background: `linear-gradient(to right, transparent, ${brand.primaryColor})`,
            }} />
          </div>
        )}

        {/* Text panel — right side (or full width when no hero) */}
        <div style={{
          width: hasHero ? "56%" : "100%",
          padding: "44px 48px 36px 48px",
          display: "flex", flexDirection: "column", justifyContent: "space-between",
        }}>
          <div>
            {/* Brand row */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 28,
            }}>
              {brand.logoUrl ? (
                <Img src={brand.logoUrl} style={{ height: 34, objectFit: "contain" }} />
              ) : (
                <div style={{ fontSize: 14, letterSpacing: 4, textTransform: "uppercase", opacity: 0.7 }}>
                  {brand.brokerageName}
                </div>
              )}
              <div style={{
                padding: "4px 12px", borderRadius: 4,
                backgroundColor: accent, color: brand.primaryColor,
                fontSize: 12, fontWeight: 800, letterSpacing: 3, textTransform: "uppercase",
              }}>
                {kindLabel[kind]}
              </div>
            </div>

            {eyebrow && (
              <div style={{
                fontSize: 14, letterSpacing: 5, textTransform: "uppercase",
                color: accent, fontWeight: 700, marginBottom: 16,
              }}>
                {eyebrow}
              </div>
            )}

            <div style={{
              fontSize: hasHero ? 44 : 56,
              fontWeight: 800, lineHeight: 1.05,
              marginBottom: 16,
            }}>
              {title}
            </div>

            {subtitle && (
              <div style={{
                fontSize: hasHero ? 18 : 22,
                opacity: 0.82, lineHeight: 1.4,
                maxWidth: hasHero ? "100%" : 720,
              }}>
                {subtitle}
              </div>
            )}
          </div>

          {/* Agent chip + footer */}
          <div>
            <div style={{
              display: "flex", alignItems: "center", gap: 14,
              marginBottom: 16,
            }}>
              {agentPhotoUrl ? (
                <Img src={agentPhotoUrl} style={{
                  width: 48, height: 48, borderRadius: 24, objectFit: "cover",
                  boxShadow: `0 0 0 3px ${accent}`,
                }} />
              ) : (
                <div style={{
                  width: 48, height: 48, borderRadius: 24,
                  backgroundColor: accent, color: brand.primaryColor,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 22, fontWeight: 800,
                  boxShadow: `0 0 0 3px ${accent}33`,
                }}>{(agentName[0] ?? "A").toUpperCase()}</div>
              )}
              <div>
                <div style={{ fontSize: 11, letterSpacing: 2, opacity: 0.6, textTransform: "uppercase" }}>
                  Your agent
                </div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{agentName}</div>
              </div>
            </div>
            <div style={{
              fontSize: 11, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5,
            }}>
              {brand.brokerageName}
              {showEho && " · Equal Housing Opportunity"}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}
