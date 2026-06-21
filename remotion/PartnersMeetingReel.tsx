/**
 * remotion/PartnersMeetingReel.tsx
 *
 * THE PARTNERS' MEETING — the AI team's weekly recap "show", narrated by the broker's D-ID avatar in
 * their ElevenLabs-cloned voice. The differentiator no competitor ships: the AI management team
 * presents the week back to the broker — the plays it ran, the deadlines it saved, the money booked,
 * and (the moat) the COMPLIANCE disposition: every outbound message pre-flighted, Fair-Housing &
 * consent cleared, nothing shipped over an unreviewed objection.
 *
 * Horizontal 1920×1080 (desk/TV viewing for leadership). Cards are EARNED ONLY (the pure builder
 * lib/intelligence/partners-meeting-reel-props.ts emits a card only when the number > 0), so a quiet
 * week is short and honest. Types are declared INLINE (no import of the server-coupled props module)
 * so this composition never drags server deps into the Remotion client bundle.
 */
import React from "react"
import { AbsoluteFill, Img, Sequence, Video, interpolate, useCurrentFrame, useVideoConfig } from "remotion"

type ReelCardKind = "team" | "finance" | "compliance"
interface ReelCard { value: string; label: string; sub?: string; kind: ReelCardKind }
interface Brand { primaryColor: string; accentColor: string; brokerageName: string; showEhoMark?: boolean; logoUrl?: string | null }

export interface PartnersMeetingReelProps {
  weekLabel: string
  cards: ReelCard[]
  oneAsk: string
  narration?: string | null
  agentName: string
  avatarVideoUrl: string | null
  agentPhotoUrl: string | null
  brand: Brand
}

const KIND_ACCENT: Record<ReelCardKind, string> = {
  team: "#F59E0B",
  finance: "#34D399",   // green — money
  compliance: "#22D3EE", // cyan — the Compliance Officer's identity color
}
const KIND_TAG: Record<ReelCardKind, string> = {
  team: "THE TEAM",
  finance: "FINANCE MANAGER",
  compliance: "COMPLIANCE OFFICER",
}

const AvatarPIP: React.FC<{ avatarVideoUrl: string | null; agentPhotoUrl: string | null; agentName: string; accentColor: string; primaryColor: string }> = ({
  avatarVideoUrl, agentPhotoUrl, agentName, accentColor, primaryColor,
}) => {
  const ring: React.CSSProperties = {
    position: "absolute", bottom: 40, right: 40, width: 220, height: 220, borderRadius: 110,
    boxShadow: `0 0 0 5px ${accentColor}, 0 18px 40px rgba(0,0,0,0.35)`, overflow: "hidden", backgroundColor: primaryColor,
  }
  if (avatarVideoUrl) return <div style={ring}><Video src={avatarVideoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
  if (agentPhotoUrl) return <div style={ring}><Img src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
  return (
    <div style={{ ...ring, backgroundColor: accentColor, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 88, color: primaryColor, fontWeight: 800 }}>
      {(agentName[0] ?? "T").toUpperCase()}
    </div>
  )
}

const CardScene: React.FC<{ card: ReelCard; index: number; total: number; brand: Brand }> = ({ card, index, total, brand }) => {
  const frame = useCurrentFrame()
  const accent = KIND_ACCENT[card.kind]
  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, padding: "120px 140px", justifyContent: "center" }}>
      <div style={{ position: "absolute", top: 48, left: 64, fontSize: 22, letterSpacing: 4, color: "#fff", opacity: 0.5 }}>
        PARTNERS&apos; MEETING · {brand.brokerageName.toUpperCase()}
      </div>
      <div style={{ position: "absolute", top: 48, right: 64, fontSize: 20, letterSpacing: 3, color: accent, fontWeight: 700 }}>
        {index + 1} / {total}
      </div>
      <div style={{
        display: "inline-block", alignSelf: "flex-start", padding: "8px 20px", borderRadius: 6,
        backgroundColor: accent, color: brand.primaryColor, fontSize: 22, fontWeight: 800, letterSpacing: 4,
        marginBottom: 28, opacity: interpolate(frame, [0, 12], [0, 1]),
      }}>
        {KIND_TAG[card.kind]}
      </div>
      <div style={{ fontSize: 220, fontWeight: 900, lineHeight: 0.9, color: "#fff", opacity: interpolate(frame, [4, 22], [0, 1]) }}>
        {card.value}
      </div>
      <div style={{ fontSize: 44, letterSpacing: 6, color: "#fff", opacity: 0.85, textTransform: "uppercase", marginTop: 16 }}>
        {card.label}
      </div>
      {card.sub && (
        <div style={{ fontSize: 30, color: accent, marginTop: 20, opacity: interpolate(frame, [16, 32], [0, 1]) }}>
          {card.sub}
        </div>
      )}
    </AbsoluteFill>
  )
}

export const PartnersMeetingReel: React.FC<PartnersMeetingReelProps> = ({
  weekLabel, cards, oneAsk, agentName, avatarVideoUrl, agentPhotoUrl, brand,
}) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const showEho = brand.showEhoMark ?? true

  const COVER = 2.5 * fps
  const ASK = 3 * fps
  const OUTRO = 1.5 * fps
  const cardTotal = Math.max(1, durationInFrames - COVER - ASK - OUTRO)
  const per = cards.length > 0 ? Math.floor(cardTotal / cards.length) : cardTotal

  return (
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* COVER */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 80, textAlign: "center" }}>
          {brand.logoUrl && <Img src={brand.logoUrl} style={{ height: 72, objectFit: "contain", marginBottom: 40, opacity: interpolate(frame, [0, 12], [0, 1]) }} />}
          <div style={{
            display: "inline-block", padding: "12px 28px", borderRadius: 8, backgroundColor: brand.accentColor,
            color: brand.primaryColor, fontSize: 24, fontWeight: 800, letterSpacing: 6, textTransform: "uppercase",
            marginBottom: 32, opacity: interpolate(frame, [4, 20], [0, 1]),
          }}>
            Partners&apos; Meeting
          </div>
          <div style={{ fontSize: 96, fontWeight: 800, color: "#fff", lineHeight: 1.05, opacity: interpolate(frame, [10, 28], [0, 1]) }}>
            Your AI team&apos;s week
          </div>
          <div style={{ fontSize: 40, color: "#fff", opacity: interpolate(frame, [16, 34], [0, 0.7]), marginTop: 20 }}>
            {weekLabel}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* EARNED CARDS */}
      {cards.map((card, i) => (
        <Sequence key={i} from={COVER + per * i} durationInFrames={per}>
          <CardScene card={card} index={i} total={cards.length} brand={brand} />
          <AvatarPIP avatarVideoUrl={avatarVideoUrl} agentPhotoUrl={agentPhotoUrl} agentName={agentName} accentColor={brand.accentColor} primaryColor={brand.primaryColor} />
        </Sequence>
      ))}

      {/* THE ONE ASK */}
      <Sequence from={COVER + cardTotal} durationInFrames={ASK}>
        <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 80, textAlign: "center", color: "#fff" }}>
          <div style={{ fontSize: 28, letterSpacing: 6, color: brand.accentColor, fontWeight: 700, marginBottom: 24 }}>THE ONE ASK</div>
          <div style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.1, maxWidth: 1400 }}>{oneAsk}</div>
          <div style={{ fontSize: 32, opacity: 0.7, marginTop: 28 }}>Clear it and the team rolls into Monday at full speed.</div>
        </AbsoluteFill>
      </Sequence>

      {/* OUTRO */}
      <Sequence from={durationInFrames - OUTRO} durationInFrames={OUTRO}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 40, fontWeight: 700 }}>{brand.brokerageName}</div>
            <div style={{ fontSize: 22, opacity: 0.6, marginTop: 12 }}>
              Presented by your AI management team{showEho && " · Equal Housing Opportunity"}
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  )
}
