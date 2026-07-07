/**
 * remotion/ProductPromoReel.tsx
 *
 * THE PLATFORM'S OWN PROMO — the reel IS the product demo: its visuals echo the
 * OS itself. A command-center grid backdrop, a MANAGER-HANDOFF animation (a pulse
 * traveling between named AI-manager nodes — the bus, visualized), staggered word
 * reveals, and a capability ticker. Fully brand-driven: the app NAME, tagline,
 * colors and CTA domain all come from platform settings via props (the name is
 * still being decided — nothing hardcoded). Text-motion only: no photos, no D-ID
 * cost. 15s @30fps; vertical or square via composition size.
 *
 * Scene math @30fps: hook 0–90 · beats 90–330 (80f each, each with a handoff
 * pulse) · CTA 330–450.
 */
import React from "react"
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion"

export interface ProductPromoReelProps {
  hook: string
  proofs: string[]
  cta: string
  brand?: { primaryColor?: string; accentColor?: string; name?: string; tagline?: string }
  ctaDomain?: string
}

/** Staggered word-by-word reveal — the "system thinking out loud" feel. */
const WordReveal: React.FC<{ text: string; size: number; weight?: number; delay?: number; color?: string }> = ({ text, size, weight = 800, delay = 0, color = "white" }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const words = text.split(" ")
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.28em", fontSize: size, fontWeight: weight, lineHeight: 1.18, color }}>
      {words.map((w, i) => {
        const t = spring({ frame: frame - delay - i * 3, fps, config: { damping: 200 } })
        return (
          <span key={i} style={{ opacity: t, transform: `translateY(${interpolate(t, [0, 1], [26, 0])}px)`, display: "inline-block" }}>
            {w}
          </span>
        )
      })}
    </div>
  )
}

/** The bus, visualized: a pulse hands work between named AI-manager nodes. */
const HandoffLane: React.FC<{ from: string; to: string; accent: string; width: number }> = ({ from, to, accent, width }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const appear = spring({ frame: frame - 8, fps, config: { damping: 200 } })
  const travel = interpolate(frame, [20, 62], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const arrived = travel >= 99
  const node: React.CSSProperties = {
    padding: `${width * 0.012}px ${width * 0.024}px`, borderRadius: 999,
    border: `2px solid ${accent}55`, fontSize: width * 0.02, fontWeight: 700, color: "white",
    background: "#ffffff10", whiteSpace: "nowrap",
  }
  return (
    <div style={{ opacity: appear, display: "flex", alignItems: "center", gap: width * 0.018, marginTop: width * 0.05 }}>
      <div style={{ ...node, borderColor: accent }}>{from}</div>
      <div style={{ position: "relative", flex: 1, height: 3, background: "#ffffff22", borderRadius: 2 }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: 3, width: `${travel}%`, background: accent, borderRadius: 2 }} />
        <div style={{
          position: "absolute", top: -7, left: `calc(${travel}% - 8px)`, width: 16, height: 16, borderRadius: 999,
          background: accent, boxShadow: `0 0 ${width * 0.02}px ${accent}`,
        }} />
      </div>
      <div style={{ ...node, borderColor: arrived ? accent : "#ffffff33", background: arrived ? `${accent}22` : "#ffffff10" }}>
        {to} {arrived ? "✓" : ""}
      </div>
    </div>
  )
}

const HANDOFFS: Array<[string, string]> = [
  ["Listing Concierge", "Asset Manager"],
  ["Asset Manager", "Campaign Orchestrator"],
  ["Campaign Orchestrator", "Ads Manager"],
]

const CAPABILITIES = ["Leads", "Deals", "Video", "Social", "Recruiting", "Vendors", "Compliance", "Reporting"]

const CapabilityChip: React.FC<{ label: string; index: number; accent: string; width: number; height: number }> = ({ label, index, accent, width, height }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = spring({ frame: frame - 20 - index * 4, fps, config: { damping: 200 } })
  return (
    <span style={{ opacity: t, transform: `scale(${0.8 + 0.2 * t})`, border: `1.5px solid ${accent}66`, color: "#ffffffcc", borderRadius: 999, padding: `${height * 0.006}px ${width * 0.02}px`, fontSize: width * 0.018, fontWeight: 600 }}>
      {label}
    </span>
  )
}

export const ProductPromoReel: React.FC<ProductPromoReelProps> = ({ hook, proofs, cta, brand, ctaDomain }) => {
  const primary = brand?.primaryColor ?? "#0F172A"
  const accent = brand?.accentColor ?? "#F59E0B"
  const name = (brand?.name ?? "VIP Agents").toUpperCase()
  const tagline = brand?.tagline ?? "The AI team that runs the whole business"
  const domain = ctaDomain ?? "vipagents.ai/get-started"
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const pad = Math.round(width * 0.09)
  const base: React.CSSProperties = {
    backgroundColor: primary, color: "white",
    fontFamily: "Inter, Helvetica, Arial, sans-serif", padding: pad, justifyContent: "center",
  }
  const beats = (proofs ?? []).slice(0, 3)
  const grid = Math.round(width / 14)
  // Scene fills stay TRANSPARENT so the command-center grid + brand eyebrow show through.
  const scene: React.CSSProperties = { ...base, backgroundColor: "transparent" }

  return (
    <AbsoluteFill style={base}>
      {/* command-center grid backdrop, slowly drifting — the OS texture */}
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(#ffffff08 1px, transparent 1px), linear-gradient(90deg, #ffffff08 1px, transparent 1px)`,
          backgroundSize: `${grid}px ${grid}px`,
          backgroundPosition: `0px ${-(frame * 0.35) % grid}px`,
        }}
      />
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${interpolate(frame, [0, 450], [15, 85])}% 12%, ${accent}26, transparent 55%)` }} />

      {/* persistent brand eyebrow + live-status dot */}
      <div style={{ position: "absolute", top: pad, left: pad, right: pad, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 12, height: 12, borderRadius: 999, background: accent, opacity: 0.5 + 0.5 * Math.sin(frame / 6) }} />
        <span style={{ fontSize: width * 0.022, letterSpacing: 5, fontWeight: 800, color: accent }}>{name}</span>
        <span style={{ fontSize: width * 0.016, color: "#ffffff88", marginLeft: "auto" }}>COMMAND CENTER · LIVE</span>
      </div>

      <Sequence from={0} durationInFrames={90}>
        <AbsoluteFill style={{ ...scene, alignItems: "flex-start" }}>
          <WordReveal text={hook} size={width * 0.06} />
          <div style={{ marginTop: 24, opacity: interpolate(frame, [40, 70], [0, 1], { extrapolateRight: "clamp" }), fontSize: width * 0.024, color: "#ffffffaa" }}>
            {tagline}
          </div>
        </AbsoluteFill>
      </Sequence>

      {beats.map((p, i) => (
        <Sequence key={i} from={90 + i * 80} durationInFrames={80}>
          <AbsoluteFill style={{ ...scene, alignItems: "flex-start" }}>
            <div style={{ fontSize: width * 0.026, color: accent, fontWeight: 800 }}>{`0${i + 1}`}</div>
            <div style={{ marginTop: 14 }}>
              <WordReveal text={p} size={width * 0.042} weight={700} />
            </div>
            <HandoffLane from={HANDOFFS[i][0]} to={HANDOFFS[i][1]} accent={accent} width={width} />
          </AbsoluteFill>
        </Sequence>
      ))}

      <Sequence from={330} durationInFrames={120}>
        <AbsoluteFill style={{ ...scene, alignItems: "flex-start" }}>
          <WordReveal text={cta} size={width * 0.052} />
          <div style={{ marginTop: 30, display: "inline-block", backgroundColor: accent, color: primary, fontWeight: 800, fontSize: width * 0.03, padding: "18px 36px", borderRadius: 14 }}>
            {domain}
          </div>
          {/* capability ticker — the whole-business breadth, chip by chip */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 34, maxWidth: width - pad * 2 }}>
            {CAPABILITIES.map((c, i) => (
              <CapabilityChip key={c} label={c} index={i} accent={accent} width={width} height={height} />
            ))}
          </div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  )
}
