/**
 * remotion/NewsletterDigestThumb.tsx
 *
 * Wave 22a — static (1-frame) Remotion composition for the per-persona
 * inbox-preview thumbnail. Rendered via @remotion/renderer's renderStill()
 * call from the newsletter video post-pass.
 *
 * Why this exists:
 * Gmail and Apple Mail increasingly show video thumbnails directly in the
 * inbox listing. The weekly newsletter video today shows as a black box
 * until the recipient clicks. With this thumbnail, each persona sees an
 * agent-photo + persona-tailored hook line BEFORE they open the email —
 * that decides the open in 3 seconds.
 *
 * Shape: 1200×630 Open-Graph card ratio. Email clients sample this aspect
 * for both inbox preview AND when the email is shared (Slack / Teams / iOS
 * Messages) — getting the OG ratio right is double-duty.
 *
 * The composition is deterministic + pure render — no animations, no
 * timeline. Remotion still treats it as a Composition with durationInFrames=1
 * because renderStill needs a registered composition to anchor on.
 */
import React from "react"
import { AbsoluteFill, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"

export interface NewsletterDigestThumbProps {
  agentName:     string
  agentPhotoUrl: string | null
  /** The persona hook line — 8-15 words, no protected-class language,
   *  compliance-gated upstream before this composition is fed. */
  personaHook:   string
  /** Issue subject — shows small under the persona hook so the recipient
   *  knows it's a newsletter preview, not a standalone post. */
  subject:       string
  brand: {
    primaryColor:  string
    accentColor:   string
    logoUrl?:      string
    brokerageName: string
  }
}

export const NewsletterDigestThumb: React.FC<NewsletterDigestThumbProps> = ({
  agentName, agentPhotoUrl, personaHook, subject, brand,
}) => {
  // The photo pane is a square the full height of the card. It used to be
  // `width: 630, height: 630` — the registered height typed out by hand, so a
  // re-registration would have overflowed or letterboxed it in silence
  // (test:remotion-setup §5 now refuses that literal). Read the geometry.
  const { height } = useVideoConfig()
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ display: "flex", height: "100%", width: "100%", alignItems: "stretch" }}>
        {/* Left — agent photo, 1:1 square */}
        <div style={{
          width: height, height, position: "relative",
          backgroundColor: brand.accentColor, flexShrink: 0,
        }}>
          {agentPhotoUrl ? (
            <SafeImg src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{
              width: "100%", height: "100%", display: "flex",
              alignItems: "center", justifyContent: "center",
              fontSize: 160, color: brand.primaryColor, fontWeight: 700,
            }}>{(agentName[0] ?? "A").toUpperCase()}</div>
          )}
          {/* Brand chip overlay bottom-left */}
          <div style={{
            position: "absolute", bottom: 24, left: 24,
            backgroundColor: "rgba(0,0,0,0.55)", color: "#fff",
            padding: "8px 16px", borderRadius: 6, fontSize: 22, fontWeight: 500,
          }}>
            {brand.brokerageName}
          </div>
        </div>

        {/* Right — text panel */}
        <div style={{
          flex: 1, padding: "56px 64px 56px 56px",
          display: "flex", flexDirection: "column", justifyContent: "space-between",
          color: "#fff",
        }}>
          <div>
            <div style={{ fontSize: 18, opacity: 0.65, letterSpacing: 4, textTransform: "uppercase", marginBottom: 20 }}>
              This week
            </div>
            <div style={{ fontSize: 46, fontWeight: 700, lineHeight: 1.15, marginBottom: 24 }}>
              {personaHook}
            </div>
            <div style={{ fontSize: 22, opacity: 0.85, lineHeight: 1.4 }}>
              {subject}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{
              width: 14, height: 14, borderRadius: 7,
              backgroundColor: brand.accentColor,
            }} />
            <div style={{ fontSize: 22, fontWeight: 600 }}>{agentName}</div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}
