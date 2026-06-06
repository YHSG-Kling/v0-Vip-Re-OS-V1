/**
 * remotion/PostcardBack4x6.tsx
 *
 * Wave 36 — 4×6 postcard BACK (1275×1875 px bleed canvas).
 *
 * Lob postcards reserve the right ~50% of the back for the indicia
 * (postage), barcode, and recipient address — anything in that zone
 * is covered. We only render in the left ~50% (the "message panel")
 * plus a thin top brand strip that survives the address-block overlay.
 *
 * Layout:
 *   - Brand strip across the top (8% of height) — color band + logo
 *   - Message panel left 48%: body copy + agent signature
 *   - Indicia zone right 52%: LEFT EMPTY for Lob to overlay address
 *
 * Branding sourced same as the front via resolveBrokerageBrandContext;
 * copy sourced via draftPostcardCopy (the SAME body string used on
 * the front, so the two sides feel coherent, not disjointed).
 */
import React from "react"
import { AbsoluteFill, Img } from "remotion"

export interface PostcardBack4x6Props {
  /** Same body as the front piece — coherence between sides. */
  body:    string
  /** Agent signature line (e.g. "— Sarah Chen"). Null = brokerage name. */
  signoff: string | null
  /** Agent photo URL — small headshot above the signoff. Null = initials. */
  agentPhotoUrl: string | null
  agentName: string | null
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

const SAFE_INSET = 56

export const PostcardBack4x6: React.FC<PostcardBack4x6Props> = ({
  body, signoff, agentPhotoUrl, agentName, brand,
}) => {
  // Indicia keep-out: right 52% of the canvas is reserved for Lob's
  // address block + barcode. Everything renders in the left 48%.
  const messagePanelRight = 1275 - Math.floor(1275 * 0.52)  // ~612px

  return (
    <AbsoluteFill style={{
      backgroundColor: "#fff",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      color: brand.primaryColor,
    }}>
      {/* Brand strip top */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 110,
        backgroundColor: brand.primaryColor,
        display: "flex", alignItems: "center", paddingLeft: SAFE_INSET, paddingRight: SAFE_INSET,
        color: "#fff",
      }}>
        {brand.logoUrl ? (
          <Img src={brand.logoUrl} style={{ height: 64, width: "auto", objectFit: "contain", marginRight: 18 }} />
        ) : (
          <div style={{
            width: 56, height: 56, borderRadius: 10, marginRight: 18,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 32, fontWeight: 800,
          }}>{brand.brokerageName[0]?.toUpperCase() ?? "B"}</div>
        )}
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 0.5 }}>
          {brand.brokerageName}
        </div>
      </div>

      {/* Accent rule under brand strip */}
      <div style={{
        position: "absolute", top: 110, left: 0, right: 0, height: 6,
        backgroundColor: brand.accentColor,
      }} />

      {/* Message panel — left half only */}
      <div style={{
        position: "absolute",
        top: 170, left: SAFE_INSET, width: messagePanelRight - SAFE_INSET,
        fontSize: 28, lineHeight: 1.55, color: "#333",
      }}>
        {body}
      </div>

      {/* Agent signature block — bottom-left of message panel */}
      <div style={{
        position: "absolute",
        bottom: SAFE_INSET + 80, left: SAFE_INSET,
        width: messagePanelRight - SAFE_INSET,
        display: "flex", alignItems: "center", gap: 18,
      }}>
        {agentPhotoUrl ? (
          <Img src={agentPhotoUrl} style={{
            width: 90, height: 90, objectFit: "cover", borderRadius: 45,
            border: `3px solid ${brand.accentColor}`,
          }} />
        ) : (
          <div style={{
            width: 90, height: 90, borderRadius: 45,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 38, fontWeight: 700,
            border: `3px solid ${brand.primaryColor}`,
          }}>{(agentName?.[0] ?? brand.brokerageName[0] ?? "A").toUpperCase()}</div>
        )}
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: brand.primaryColor }}>
            {signoff ?? `— ${brand.brokerageName}`}
          </div>
          {agentName && (
            <div style={{ fontSize: 18, color: "#555", marginTop: 2 }}>{agentName}</div>
          )}
        </div>
      </div>

      {/* Footer micro-row — license + disclosure, full width below indicia */}
      <div style={{
        position: "absolute",
        bottom: SAFE_INSET, left: SAFE_INSET, width: messagePanelRight - SAFE_INSET,
        borderTop: `1px solid ${brand.accentColor}`,
        paddingTop: 12,
        fontSize: 14, lineHeight: 1.35, color: "#666",
      }}>
        {brand.licenseLine && <div>{brand.licenseLine}</div>}
        <div style={{ marginTop: 4 }}>{brand.shortDisclosure}</div>
        {(brand.websiteWordmark || brand.phone) && (
          <div style={{ marginTop: 4, color: brand.primaryColor, fontWeight: 600 }}>
            {[brand.websiteWordmark, brand.phone].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
    </AbsoluteFill>
  )
}
