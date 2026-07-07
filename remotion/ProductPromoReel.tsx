/**
 * remotion/ProductPromoReel.tsx
 *
 * THE PLATFORM'S OWN PROMO — VIP Agents marketing ITSELF on the company's social
 * channels. A pure text-motion reel (no photos, no D-ID cost): hook → three proof
 * beats → CTA, driven entirely by props so the platform content engine
 * (lib/platform/product-content PRODUCT_ANGLES) supplies the same honest story the
 * text posts use — one source of truth, video-shaped. Works vertical (1080×1920,
 * registered) and square via props. Cheap render, brand-colored, no fabricated
 * stats baked in anywhere.
 *
 * Scene math @30fps: hook 0–90, proofs 90–330 (80 frames each), CTA 330–450 (15s).
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
  brand?: { primaryColor?: string; accentColor?: string }
}

const FadeUp: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay = 0 }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = spring({ frame: frame - delay, fps, config: { damping: 200 } })
  return (
    <div style={{ opacity: t, transform: `translateY(${interpolate(t, [0, 1], [40, 0])}px)` }}>
      {children}
    </div>
  )
}

export const ProductPromoReel: React.FC<ProductPromoReelProps> = ({ hook, proofs, cta, brand }) => {
  const primary = brand?.primaryColor ?? "#0F172A"
  const accent = brand?.accentColor ?? "#F59E0B"
  const frame = useCurrentFrame()
  const { width } = useVideoConfig()
  const pad = Math.round(width * 0.09)
  const base: React.CSSProperties = {
    backgroundColor: primary,
    color: "white",
    fontFamily: "Inter, Helvetica, Arial, sans-serif",
    padding: pad,
    justifyContent: "center",
  }
  const beats = (proofs ?? []).slice(0, 3)

  return (
    <AbsoluteFill style={base}>
      {/* subtle accent sweep so the frame never feels static */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${interpolate(frame, [0, 450], [20, 80])}% 15%, ${accent}22, transparent 60%)`,
        }}
      />
      <Sequence from={0} durationInFrames={90}>
        <AbsoluteFill style={{ ...base, alignItems: "flex-start" }}>
          <FadeUp>
            <div style={{ fontSize: width * 0.02 + 14, letterSpacing: 4, color: accent, fontWeight: 700 }}>VIP AGENTS</div>
            <div style={{ fontSize: width * 0.062, fontWeight: 800, lineHeight: 1.15, marginTop: 24 }}>{hook}</div>
          </FadeUp>
        </AbsoluteFill>
      </Sequence>
      {beats.map((p, i) => (
        <Sequence key={i} from={90 + i * 80} durationInFrames={80}>
          <AbsoluteFill style={{ ...base, alignItems: "flex-start" }}>
            <FadeUp>
              <div style={{ fontSize: width * 0.028, color: accent, fontWeight: 700 }}>{`0${i + 1}`}</div>
              <div style={{ fontSize: width * 0.05, fontWeight: 700, lineHeight: 1.25, marginTop: 16 }}>{p}</div>
            </FadeUp>
          </AbsoluteFill>
        </Sequence>
      ))}
      <Sequence from={330} durationInFrames={120}>
        <AbsoluteFill style={{ ...base, alignItems: "flex-start" }}>
          <FadeUp>
            <div style={{ fontSize: width * 0.055, fontWeight: 800, lineHeight: 1.2 }}>{cta}</div>
            <div
              style={{
                marginTop: 32, display: "inline-block", backgroundColor: accent, color: primary,
                fontWeight: 800, fontSize: width * 0.032, padding: "18px 36px", borderRadius: 14,
              }}
            >
              vipagents.ai/get-started
            </div>
          </FadeUp>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  )
}
