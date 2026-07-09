/**
 * remotion/ListingFlyer.tsx
 *
 * THE LISTING FLYER — the 8.5×11 print piece agents hand out at open houses
 * and showings, closing the print family (postcards existed; the flyer the
 * QR system always anticipated as material kind `listing_flyer` did not).
 *
 * Spec (mirrors the postcard print conventions):
 *   Trim size:       8.5" × 11"        = 2550 × 3300 px @ 300 DPI
 *   Bleed:           0.125" each side
 *   Bleed canvas:    8.75" × 11.25"    = 2625 × 3375 px @ 300 DPI ← rendered
 *   Safe zone:       ~0.25" inset from trim
 *
 * Layout: full-bleed hero photo (top ~55%), price + address band on the
 * brand color, facts strip (beds/baths/sqft/type), highlights, agent block
 * (photo + name + phone) with the tracked QR ("scan to tour"), EHO +
 * license footer. Still composition (durationInFrames=1) — finish-spec
 * rule: stills ARE the deliverable (no bookends/music/thumbnail).
 *
 * Props only — compositions never read the DB; brand flows from
 * resolveReelBrand, facts from the listing row, QR from mintVideoQr.
 */
import React from "react"
import { AbsoluteFill, Img } from "remotion"

export interface ListingFlyerProps {
  address: string
  cityState: string
  price: string
  beds: string
  baths: string
  sqft: string
  propertyType: string
  /** 2–4 short selling points ("Chef's kitchen", "Half-acre lot"). */
  highlights: string[]
  heroImageUrl: string | null
  /** Secondary photos (up to 3) for the strip under the hero. */
  photoUrls: string[]
  agentName: string
  agentPhone: string
  agentPhotoUrl: string | null
  qrCodeDataUrl: string | null
  qrCaption: string
  /** Status eyebrow: JUST LISTED / OPEN HOUSE SATURDAY 1–3 / FOR SALE. */
  statusLine: string
  brand: {
    primaryColor: string
    accentColor: string
    logoUrl: string | null
    brokerageName: string
    licenseLine: string | null
    showEhoMark: boolean
  }
}

const W = 2625, H = 3375
const SAFE = 96 // ~0.25" + bleed compensation

export const ListingFlyer: React.FC<ListingFlyerProps> = ({
  address, cityState, price, beds, baths, sqft, propertyType, highlights,
  heroImageUrl, photoUrls, agentName, agentPhone, agentPhotoUrl,
  qrCodeDataUrl, qrCaption, statusLine, brand,
}) => {
  const facts = [
    beds && `${beds} BD`, baths && `${baths} BA`, sqft && `${sqft} SQFT`, propertyType,
  ].filter(Boolean) as string[]
  const strip = photoUrls.slice(0, 3)
  return (
    <AbsoluteFill style={{ width: W, height: H, backgroundColor: "#ffffff", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      {/* HERO — full-bleed photo with the status eyebrow */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1700, overflow: "hidden", backgroundColor: brand.primaryColor }}>
        {heroImageUrl && <Img src={heroImageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        <div style={{
          position: "absolute", top: SAFE + 40, left: SAFE + 40, padding: "26px 60px",
          backgroundColor: brand.accentColor, color: brand.primaryColor,
          fontSize: 64, fontWeight: 800, letterSpacing: 10, textTransform: "uppercase",
        }}>
          {statusLine}
        </div>
        {brand.logoUrl && (
          <div style={{ position: "absolute", top: SAFE + 40, right: SAFE + 40, padding: 28, backgroundColor: "#ffffffee", borderRadius: 16 }}>
            <Img src={brand.logoUrl} style={{ height: 110, objectFit: "contain" }} />
          </div>
        )}
      </div>

      {/* PRICE + ADDRESS band */}
      <div style={{ position: "absolute", top: 1700, left: 0, right: 0, backgroundColor: brand.primaryColor, color: "#fff", padding: `70px ${SAFE + 40}px` }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 40 }}>
          <div>
            <div style={{ fontSize: 120, fontWeight: 900, lineHeight: 1 }}>{address}</div>
            <div style={{ fontSize: 62, opacity: 0.85, marginTop: 18 }}>{cityState}</div>
          </div>
          <div style={{ fontSize: 140, fontWeight: 900, color: brand.accentColor, whiteSpace: "nowrap" }}>{price}</div>
        </div>
        {/* FACTS strip */}
        <div style={{ display: "flex", gap: 28, marginTop: 44 }}>
          {facts.map((f) => (
            <div key={f} style={{ padding: "18px 44px", border: `4px solid ${brand.accentColor}`, borderRadius: 12, fontSize: 52, fontWeight: 700, letterSpacing: 3 }}>
              {f}
            </div>
          ))}
        </div>
      </div>

      {/* PHOTO STRIP + HIGHLIGHTS */}
      <div style={{ position: "absolute", top: 2260, left: SAFE + 40, right: SAFE + 40 }}>
        {strip.length > 0 && (
          <div style={{ display: "flex", gap: 24, marginBottom: 44 }}>
            {strip.map((u, i) => (
              <div key={i} style={{ flex: 1, height: 380, overflow: "hidden", borderRadius: 14, backgroundColor: "#e5e7eb" }}>
                <Img src={u} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
          {highlights.slice(0, 4).map((h) => (
            <div key={h} style={{ fontSize: 50, color: "#111827", fontWeight: 600 }}>
              <span style={{ color: brand.accentColor, fontWeight: 900, marginRight: 16 }}>■</span>{h}
            </div>
          ))}
        </div>
      </div>

      {/* AGENT BLOCK + QR footer */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, borderTop: `10px solid ${brand.accentColor}`, backgroundColor: "#f8fafc", padding: `54px ${SAFE + 40}px ${SAFE + 20}px` }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 40 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
            {agentPhotoUrl ? (
              <Img src={agentPhotoUrl} style={{ width: 220, height: 220, borderRadius: 110, objectFit: "cover", border: `8px solid ${brand.primaryColor}` }} />
            ) : (
              <div style={{ width: 220, height: 220, borderRadius: 110, backgroundColor: brand.primaryColor, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 96, fontWeight: 800 }}>
                {(agentName[0] ?? "A").toUpperCase()}
              </div>
            )}
            <div>
              <div style={{ fontSize: 72, fontWeight: 800, color: "#111827" }}>{agentName}</div>
              <div style={{ fontSize: 54, color: brand.primaryColor, fontWeight: 700, marginTop: 8 }}>{agentPhone}</div>
              <div style={{ fontSize: 44, color: "#6b7280", marginTop: 8 }}>{brand.brokerageName}</div>
            </div>
          </div>
          {qrCodeDataUrl && (
            <div style={{ textAlign: "center" }}>
              <Img src={qrCodeDataUrl} style={{ width: 300, height: 300 }} />
              <div style={{ fontSize: 40, color: "#374151", fontWeight: 700, marginTop: 10 }}>{qrCaption}</div>
            </div>
          )}
        </div>
        <div style={{ fontSize: 32, color: "#9ca3af", marginTop: 36, letterSpacing: 1 }}>
          {brand.showEhoMark && "Equal Housing Opportunity. "}
          {brand.licenseLine ?? ""} Information deemed reliable but not guaranteed.
        </div>
      </div>
    </AbsoluteFill>
  )
}
