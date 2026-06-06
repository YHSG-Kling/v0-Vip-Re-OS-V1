/**
 * remotion/PostcardBack6x9.tsx
 *
 * Wave 36 — 6×9 postcard BACK (1875×2775 px bleed canvas).
 *
 * Same Lob indicia keep-out as the 4×6 back: right ~52% reserved for
 * Lob's address overlay + postage + barcode. We render in the left
 * ~48% plus a brand strip at the top.
 *
 * 6×9 backs get MORE message panel space than 4×6 backs, so the body
 * can be 2-3 paragraphs (40-80 words) instead of one. The signoff
 * block also gets room for a quote from the agent.
 */
import React from "react"
import { AbsoluteFill, Img } from "remotion"

export interface PostcardBack6x9Props {
  body:    string
  /** Optional pull quote — appears above the body in italics. */
  pullQuote: string | null
  signoff: string | null
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

const SAFE_INSET = 70

export const PostcardBack6x9: React.FC<PostcardBack6x9Props> = ({
  body, pullQuote, signoff, agentPhotoUrl, agentName, brand,
}) => {
  const messagePanelRight = 1875 - Math.floor(1875 * 0.52)  // ~900px

  return (
    <AbsoluteFill style={{
      backgroundColor: "#fff",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      color: brand.primaryColor,
    }}>
      {/* Brand strip top */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 140,
        backgroundColor: brand.primaryColor,
        display: "flex", alignItems: "center",
        paddingLeft: SAFE_INSET, paddingRight: SAFE_INSET,
        color: "#fff",
      }}>
        {brand.logoUrl ? (
          <Img src={brand.logoUrl} style={{ height: 80, width: "auto", objectFit: "contain", marginRight: 24 }} />
        ) : (
          <div style={{
            width: 72, height: 72, borderRadius: 12, marginRight: 24,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 40, fontWeight: 800,
          }}>{brand.brokerageName[0]?.toUpperCase() ?? "B"}</div>
        )}
        <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 0.5 }}>
          {brand.brokerageName}
        </div>
      </div>

      <div style={{
        position: "absolute", top: 140, left: 0, right: 0, height: 8,
        backgroundColor: brand.accentColor,
      }} />

      {/* Pull quote */}
      {pullQuote && (
        <div style={{
          position: "absolute",
          top: 220, left: SAFE_INSET, width: messagePanelRight - SAFE_INSET,
          fontStyle: "italic", fontSize: 32, lineHeight: 1.4,
          color: brand.primaryColor,
          borderLeft: `5px solid ${brand.accentColor}`,
          paddingLeft: 24,
        }}>
          &ldquo;{pullQuote}&rdquo;
        </div>
      )}

      {/* Body */}
      <div style={{
        position: "absolute",
        top: pullQuote ? 420 : 220,
        left: SAFE_INSET,
        width: messagePanelRight - SAFE_INSET,
        fontSize: 30, lineHeight: 1.6, color: "#333",
      }}>
        {body}
      </div>

      {/* Agent signature block */}
      <div style={{
        position: "absolute",
        bottom: SAFE_INSET + 120, left: SAFE_INSET,
        width: messagePanelRight - SAFE_INSET,
        display: "flex", alignItems: "center", gap: 22,
      }}>
        {agentPhotoUrl ? (
          <Img src={agentPhotoUrl} style={{
            width: 120, height: 120, objectFit: "cover", borderRadius: 60,
            border: `4px solid ${brand.accentColor}`,
          }} />
        ) : (
          <div style={{
            width: 120, height: 120, borderRadius: 60,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 52, fontWeight: 700,
            border: `4px solid ${brand.primaryColor}`,
          }}>{(agentName?.[0] ?? brand.brokerageName[0] ?? "A").toUpperCase()}</div>
        )}
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: brand.primaryColor }}>
            {signoff ?? `— ${brand.brokerageName}`}
          </div>
          {agentName && (
            <div style={{ fontSize: 22, color: "#555", marginTop: 4 }}>{agentName}</div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        position: "absolute",
        bottom: SAFE_INSET, left: SAFE_INSET,
        width: messagePanelRight - SAFE_INSET,
        borderTop: `1px solid ${brand.accentColor}`,
        paddingTop: 14,
        fontSize: 16, lineHeight: 1.35, color: "#666",
      }}>
        {brand.licenseLine && <div>{brand.licenseLine}</div>}
        <div style={{ marginTop: 4 }}>{brand.shortDisclosure}</div>
        {(brand.websiteWordmark || brand.phone) && (
          <div style={{ marginTop: 6, color: brand.primaryColor, fontWeight: 600 }}>
            {[brand.websiteWordmark, brand.phone].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
    </AbsoluteFill>
  )
}
