/**
 * remotion/DoorHanger.tsx
 *
 * THE DOOR HANGER — the just-sold door-knock piece agents leave on every
 * door in the neighborhood (geo-farming's highest-converting print moment:
 * "your neighbor's home just sold" + a scan-to-value QR). Completes the
 * print family alongside postcards and the 8.5×11 flyer.
 *
 * Spec (standard door-hanger die):
 *   Trim size:       4.25" × 11"       = 1275 × 3300 px @ 300 DPI
 *   Bleed:           0.125" each side
 *   Bleed canvas:    4.5" × 11.25"     = 1350 × 3375 px @ 300 DPI ← rendered
 *   Knob hole:       2" Ø die-cut, center ~1.6" from trim top — rendered as
 *                    a dashed cut guide the print shop strips.
 *
 * Still composition (durationInFrames=1) — finish-spec rule: stills ARE the
 * deliverable. Props only — brand flows from resolveReelBrand, QR from
 * mintVideoQr; compositions never read the DB.
 */
import React from "react"
import { AbsoluteFill, Img } from "remotion"

export interface DoorHangerProps {
  /** "JUST SOLD" / "SOLD IN 9 DAYS" — the eyebrow above the address. */
  headline: string
  address: string
  cityState: string
  heroImageUrl: string | null
  /** The neighbor hook: "Curious what YOUR home is worth?" */
  hook: string
  agentName: string
  agentPhone: string
  agentPhotoUrl: string | null
  qrCodeDataUrl: string | null
  qrCaption: string
  brand: {
    primaryColor: string
    accentColor: string
    logoUrl: string | null
    brokerageName: string
    licenseLine: string | null
    showEhoMark: boolean
  }
}

const W = 1350, H = 3375
const SAFE = 96 // bleed + ~0.25" safe inset

export const DoorHanger: React.FC<DoorHangerProps> = ({
  headline, address, cityState, heroImageUrl, hook,
  agentName, agentPhone, agentPhotoUrl, qrCodeDataUrl, qrCaption, brand,
}) => {
  return (
    <AbsoluteFill style={{ width: W, height: H, backgroundColor: brand.primaryColor, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      {/* KNOB ZONE — dashed die-cut guide (Ø 600px ≈ 2"), stripped by the printer */}
      <div style={{
        position: "absolute", top: 180, left: W / 2 - 300, width: 600, height: 600,
        borderRadius: 300, backgroundColor: "#ffffff", border: "6px dashed #94a3b8",
      }} />
      {brand.logoUrl && (
        <div style={{ position: "absolute", top: 380, left: W / 2 - 110, width: 220, height: 220, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Img src={brand.logoUrl} style={{ maxWidth: 200, maxHeight: 200, objectFit: "contain" }} />
        </div>
      )}

      {/* HEADLINE */}
      <div style={{ position: "absolute", top: 880, left: SAFE, right: SAFE, textAlign: "center" }}>
        <div style={{
          display: "inline-block", padding: "20px 44px", backgroundColor: brand.accentColor,
          color: brand.primaryColor, fontSize: 58, fontWeight: 900, letterSpacing: 8, textTransform: "uppercase",
        }}>
          {headline}
        </div>
        <div style={{ color: "#ffffff", fontSize: 62, fontWeight: 800, marginTop: 36, lineHeight: 1.15 }}>{address}</div>
        <div style={{ color: "#ffffffcc", fontSize: 42, marginTop: 12 }}>{cityState}</div>
      </div>

      {/* HERO PHOTO */}
      <div style={{ position: "absolute", top: 1260, left: SAFE, right: SAFE, height: 820, overflow: "hidden", borderRadius: 18, backgroundColor: "#1e293b", border: `8px solid ${brand.accentColor}` }}>
        {heroImageUrl && <Img src={heroImageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </div>

      {/* THE NEIGHBOR HOOK + QR */}
      <div style={{ position: "absolute", top: 2170, left: SAFE, right: SAFE, textAlign: "center" }}>
        <div style={{ color: "#ffffff", fontSize: 56, fontWeight: 800, lineHeight: 1.25 }}>{hook}</div>
        {qrCodeDataUrl && (
          <div style={{ marginTop: 40, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ padding: 22, backgroundColor: "#ffffff", borderRadius: 16 }}>
              <Img src={qrCodeDataUrl} style={{ width: 330, height: 330 }} />
            </div>
            <div style={{ color: brand.accentColor, fontSize: 38, fontWeight: 700, marginTop: 18 }}>{qrCaption}</div>
          </div>
        )}
      </div>

      {/* AGENT BLOCK + compliance footer */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "#ffffff", borderTop: `10px solid ${brand.accentColor}`, padding: `44px ${SAFE}px ${SAFE - 20}px` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
          {agentPhotoUrl ? (
            <Img src={agentPhotoUrl} style={{ width: 170, height: 170, borderRadius: 85, objectFit: "cover", border: `6px solid ${brand.primaryColor}` }} />
          ) : (
            <div style={{ width: 170, height: 170, borderRadius: 85, backgroundColor: brand.primaryColor, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 72, fontWeight: 800 }}>
              {(agentName[0] ?? "A").toUpperCase()}
            </div>
          )}
          <div>
            <div style={{ fontSize: 52, fontWeight: 800, color: "#111827" }}>{agentName}</div>
            <div style={{ fontSize: 42, color: brand.primaryColor, fontWeight: 700, marginTop: 6 }}>{agentPhone}</div>
            <div style={{ fontSize: 34, color: "#6b7280", marginTop: 6 }}>{brand.brokerageName}</div>
          </div>
        </div>
        <div style={{ fontSize: 26, color: "#9ca3af", marginTop: 28, letterSpacing: 0.5 }}>
          {brand.showEhoMark && "Equal Housing Opportunity. "}
          {brand.licenseLine ?? ""} If your home is listed with another broker, this is not a solicitation.
        </div>
      </div>
    </AbsoluteFill>
  )
}
