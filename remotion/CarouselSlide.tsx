/**
 * remotion/CarouselSlide.tsx
 *
 * THE SOCIAL CAROUSEL SLIDE — one crisp 1080×1350 (4:5 Instagram portrait)
 * still per swipe. Carousels are Instagram's highest-saved format for real
 * estate, and the OS only shipped single images + video until now: the
 * producer renders N of these (hook → value/photo/stat → CTA), the sweep
 * assembles the finished PNGs into one social_posts row (media_urls, ordered),
 * and the existing approval gate + publisher carry it out.
 *
 * Rendered TEXT stays word-perfect (Remotion, not diffusion) — AI writes the
 * copy, the composition owns the design. Rich by design, never plain:
 * layered brand-color washes, rotated accent geometry, duotone photo
 * treatment, oversized display type, slide-position dots, swipe cue, logo
 * chip, EHO/license microfooter on the closing slide.
 *
 * Props only — brand flows from resolveReelBrand, copy from the gated AI
 * copy rail; compositions never read the DB.
 */
import React from "react"
import { AbsoluteFill, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"

export type CarouselSlideRole = "hook" | "value" | "photo" | "stat" | "cta"

export interface CarouselSlideProps {
  role: CarouselSlideRole
  /** 0-based position + total, drives the dots + swipe cue. */
  slideIndex: number
  slideCount: number
  /** Small eyebrow ("JUST LISTED · NAPLES FL"). */
  kicker: string
  /** The big line. */
  title: string
  /** Supporting copy (value/cta slides). */
  body: string
  /** Full-bleed duotone photo (photo/hook slides). */
  photoUrl: string | null
  /** Stat slides: the huge number + its label. */
  statValue: string
  statLabel: string
  agentName: string
  agentPhotoUrl: string | null
  /** "@jordanavery · Harbor & Main" handle line on the CTA slide. */
  handleLine: string
  brand: {
    primaryColor: string
    accentColor: string
    logoUrl: string | null
    brokerageName: string
    licenseLine: string | null
    showEhoMark: boolean
  }
}

// TOMBSTONE (2026-09-03): `const W = 1080, H = 1350` used to sit here — a
// second copy of the geometry Root.tsx registers and
// lib/remotion/composition-geometry.ts mirrors. Three copies of one number
// is the §6 defect; the canvas now reads its own size from useVideoConfig(),
// and test:remotion-setup §5 refuses a composition file that re-declares its
// registered width or height as a literal.

export const CarouselSlide: React.FC<CarouselSlideProps> = ({
  role, slideIndex, slideCount, kicker, title, body, photoUrl,
  statValue, statLabel, agentName, agentPhotoUrl, handleLine, brand,
}) => {
  const { width: W, height: H } = useVideoConfig()
  const isLast = slideIndex >= slideCount - 1
  const dark = brand.primaryColor
  const accent = brand.accentColor

  return (
    <AbsoluteFill style={{ width: W, height: H, backgroundColor: dark, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", overflow: "hidden" }}>
      {/* LAYER 1 — brand wash: two soft radial glows so the field never reads flat */}
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 90% at 15% 0%, ${accent}26 0%, transparent 55%), radial-gradient(110% 80% at 100% 100%, ${accent}1f 0%, transparent 50%)` }} />
      {/* LAYER 2 — rotated accent geometry */}
      <div style={{ position: "absolute", top: -180, right: -180, width: 460, height: 460, border: `3px solid ${accent}55`, rotate: "18deg" }} />
      <div style={{ position: "absolute", bottom: -220, left: -140, width: 420, height: 420, backgroundColor: `${accent}12`, rotate: "-12deg" }} />

      {/* PHOTO field (photo + hook slides): full-bleed with a duotone press */}
      {photoUrl && (role === "photo" || role === "hook") && (
        <>
          <SafeImg src={photoUrl} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${dark}55 0%, ${dark}e8 78%, ${dark} 100%)` }} />
        </>
      )}

      {/* LOGO CHIP */}
      {brand.logoUrl && (
        <div style={{ position: "absolute", top: 54, left: 54, padding: "14px 20px", backgroundColor: "#ffffffea", borderRadius: 14 }}>
          <SafeImg src={brand.logoUrl} style={{ height: 52, objectFit: "contain" }} />
        </div>
      )}

      {/* CONTENT */}
      <div style={{ position: "absolute", left: 72, right: 72, bottom: 170, display: "flex", flexDirection: "column", gap: 26 }}>
        {kicker && (
          <div style={{ alignSelf: "flex-start", padding: "12px 26px", backgroundColor: accent, color: dark, fontSize: 30, fontWeight: 800, letterSpacing: 5, textTransform: "uppercase" }}>
            {kicker}
          </div>
        )}
        {role === "stat" ? (
          <>
            <div style={{ fontSize: 210, fontWeight: 900, lineHeight: 0.95, color: accent, letterSpacing: -6 }}>{statValue}</div>
            <div style={{ fontSize: 52, fontWeight: 700, color: "#ffffff", lineHeight: 1.15 }}>{statLabel}</div>
          </>
        ) : (
          <div style={{ fontSize: role === "hook" ? 88 : 72, fontWeight: 900, lineHeight: 1.04, color: "#ffffff", letterSpacing: -1.5, textWrap: "balance" as never }}>
            {title}
          </div>
        )}
        {body && role !== "stat" && (
          <div style={{ fontSize: 40, lineHeight: 1.35, color: "#ffffffd9", maxWidth: 880 }}>{body}</div>
        )}
        {/* CTA slide carries the human */}
        {role === "cta" && (
          <div style={{ display: "flex", alignItems: "center", gap: 26, marginTop: 12 }}>
            {agentPhotoUrl ? (
              <SafeImg src={agentPhotoUrl} style={{ width: 120, height: 120, borderRadius: 60, objectFit: "cover", border: `5px solid ${accent}` }} />
            ) : (
              <div style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: accent, color: dark, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 54, fontWeight: 900 }}>
                {(agentName[0] ?? "A").toUpperCase()}
              </div>
            )}
            <div>
              <div style={{ fontSize: 44, fontWeight: 800, color: "#fff" }}>{agentName}</div>
              <div style={{ fontSize: 32, color: `${accent}`, fontWeight: 700, marginTop: 4 }}>{handleLine}</div>
            </div>
          </div>
        )}
      </div>

      {/* FOOTER RAIL — dots + swipe cue / compliance microline */}
      <div style={{ position: "absolute", left: 72, right: 72, bottom: 64, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 14 }}>
          {Array.from({ length: Math.max(1, slideCount) }).map((_, i) => (
            <div key={i} style={{
              width: i === slideIndex ? 44 : 14, height: 14, borderRadius: 7,
              backgroundColor: i === slideIndex ? accent : "#ffffff59",
            }} />
          ))}
        </div>
        {isLast ? (
          <div style={{ fontSize: 22, color: "#ffffff8c", maxWidth: 620, textAlign: "right", lineHeight: 1.3 }}>
            {brand.showEhoMark && "Equal Housing Opportunity. "}{brand.licenseLine ?? ""} {brand.brokerageName}
          </div>
        ) : (
          <div style={{ fontSize: 30, fontWeight: 700, color: accent, letterSpacing: 2 }}>SWIPE →</div>
        )}
      </div>
    </AbsoluteFill>
  )
}
