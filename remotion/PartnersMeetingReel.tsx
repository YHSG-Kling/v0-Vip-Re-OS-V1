/**
 * remotion/PartnersMeetingReel.tsx
 *
 * THE PARTNERS' MEETING — the AI team's recap "show" (weekly week-in-business +
 * monthly board packet), hosted by the tenant's NAMED AI ASSISTANT (its photo
 * and name in the presenter PIP — the human is briefed BY their assistant, not
 * by a mirror of themselves) or the broker's D-ID avatar clip when one exists.
 * The differentiator no competitor ships: the AI management team presents the
 * period back to leadership — the plays it ran, the money booked, and (the
 * moat) the COMPLIANCE disposition.
 *
 * Horizontal 1920×1080 (desk/TV viewing). Cards are EARNED ONLY (the pure
 * builder emits a card only when the number > 0) — a quiet week is short and
 * honest. Design: layered brand-color gradients for depth, eased entrances
 * (interpolate + bezier, never CSS animation), tenant logo in every scene,
 * accent bar + progress dots, presenter nameplate under the PIP. Types are
 * declared INLINE so this composition never drags server deps into the bundle.
 */
import React from "react"
import { Video } from "@remotion/media"
import { AbsoluteFill, Sequence, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { CaptionLayer } from "./components/CaptionLayer"

type ReelCardKind = "team" | "finance" | "compliance"
interface ReelCard { value: string; label: string; sub?: string; kind: ReelCardKind }
interface Brand { primaryColor: string; accentColor: string; brokerageName: string; showEhoMark?: boolean; logoUrl?: string | null }

export interface PartnersMeetingReelProps {
  weekLabel: string
  cards: ReelCard[]
  oneAsk: string
  // TOMBSTONE (2026-09-03): `narration?: string | null` was declared here and
  // read by NOTHING in this file. The narration TEXT rides in input_props as
  // a CARRIER for the voiceover lane, which runs at queue time AFTER the row
  // is built and reads it from the queued props — lib/intelligence/
  // partners-meeting.ts (prepareReelVoiceover ← req.inputProps.narration),
  // lib/kernel/board-packet-reel.ts, lib/kernel/deal-room-reel.ts and
  // lib/video/listing-pitch-reel.ts — and lands as the snake-key
  // `voiceover_url` the coordinator muxes AFTER the render (m313 tpad). The
  // client-facing uses ALSO derive `captionsCues` from that same text
  // upstream (deal-room-reel.ts / listing-pitch-reel.ts → buildCaptionPlan),
  // which is the prop this composition actually renders (CaptionLayer below).
  // A `<CaptionLayer script={narration}>` fallback was considered and
  // REJECTED: the internal uses (partners_meeting_reel, board_packet_reel)
  // are REPORT_INTERNAL with `captions: false` in lib/video/finish-spec.ts,
  // and an in-composition fallback would have burned captions into exactly
  // those. This matches how the other narrated compositions are shaped —
  // ListingSectionReel and NewsletterDigestVideo declare only what they
  // render (voiceoverUrl → <Audio>), never the script text. The producer
  // type (lib/intelligence/partners-meeting-reel-props.ts) keeps `narration`
  // because THAT is the input_props shape; this interface is the component's.
  // test:remotion-setup §5 now refuses any declared-but-unread prop.
  agentName: string
  avatarVideoUrl: string | null
  agentPhotoUrl: string | null
  brand: Brand
  /** Tracked outro QR — finish-spec rule: CLIENT-FACING uses of this
   *  composition (pitch, deal room) carry it; internal reports skip it. */
  qrCodeDataUrl?: string | null
  qrCaption?: string
  /** WORD-SYNCED caption cues (built upstream from the real ElevenLabs
   *  alignment) — finish-spec: client-facing uses carry sound-off captions. */
  captionsCues?: Array<{ text: string; fromFrame: number; durationFrames: number }> | null
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

const EASE = Easing.bezier(0.16, 1, 0.3, 1)
const fadeUp = (frame: number, from: number, to: number) => ({
  opacity: interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE }),
  translate: `0 ${interpolate(frame, [from, to], [28, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE })}px`,
})

/** Layered depth: brand-color base, accent glow top-right, cool glow bottom-left,
 *  vignette. Static (renders identically every frame) — depth without noise. */
const SceneBackground: React.FC<{ brand: Brand; accent?: string }> = ({ brand, accent }) => (
  <AbsoluteFill>
    <AbsoluteFill style={{ backgroundColor: brand.primaryColor }} />
    <AbsoluteFill style={{ background: `radial-gradient(1200px 800px at 85% 8%, ${accent ?? brand.accentColor}26, transparent 65%)` }} />
    <AbsoluteFill style={{ background: `radial-gradient(1000px 700px at 8% 95%, #ffffff10, transparent 60%)` }} />
    <AbsoluteFill style={{ background: "radial-gradient(1800px 1200px at 50% 50%, transparent 55%, #00000045 100%)" }} />
  </AbsoluteFill>
)

/** Header on every scene: logo (when set) + show name + brokerage, accent rule. */
const SceneHeader: React.FC<{ brand: Brand; right?: React.ReactNode }> = ({ brand, right }) => (
  <>
    <div style={{ position: "absolute", top: 44, left: 64, right: 64, display: "flex", alignItems: "center", gap: 20 }}>
      {brand.logoUrl && <SafeImg src={brand.logoUrl} style={{ height: 44, objectFit: "contain" }} />}
      <div style={{ fontSize: 24, letterSpacing: 5, color: "#fff", opacity: 0.85, fontWeight: 700 }}>
        {brand.brokerageName.toUpperCase()}
      </div>
      <div style={{ fontSize: 20, letterSpacing: 4, color: "#fff", opacity: 0.45 }}>· PARTNERS&apos; MEETING</div>
      <div style={{ marginLeft: "auto" }}>{right}</div>
    </div>
    <div style={{ position: "absolute", top: 104, left: 64, width: 120, height: 4, borderRadius: 2, backgroundColor: brand.accentColor }} />
  </>
)

/** Presenter PIP: D-ID clip → assistant/agent photo → monogram, with a
 *  NAMEPLATE (the assistant's name) so the host is a character, not a circle. */
const AvatarPIP: React.FC<{ avatarVideoUrl: string | null; agentPhotoUrl: string | null; agentName: string; accentColor: string; primaryColor: string }> = ({
  avatarVideoUrl, agentPhotoUrl, agentName, accentColor, primaryColor,
}) => {
  const ring: React.CSSProperties = {
    width: 230, height: 230, borderRadius: 115, overflow: "hidden", backgroundColor: primaryColor,
    boxShadow: `0 0 0 5px ${accentColor}, 0 18px 40px rgba(0,0,0,0.35)`,
  }
  return (
    <div style={{ position: "absolute", bottom: 44, right: 56, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      {avatarVideoUrl ? (
        <div style={ring}><Video src={avatarVideoUrl} objectFit="cover" style={{ width: "100%", height: "100%" }} /></div>
      ) : agentPhotoUrl ? (
        <div style={ring}><SafeImg src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
      ) : (
        <div style={{ ...ring, backgroundColor: accentColor, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 92, color: primaryColor, fontWeight: 800 }}>
          {(agentName[0] ?? "T").toUpperCase()}
        </div>
      )}
      <div style={{
        padding: "8px 22px", borderRadius: 999, backgroundColor: "#00000055", border: `1px solid ${accentColor}66`,
        color: "#fff", fontSize: 22, fontWeight: 700, letterSpacing: 1, whiteSpace: "nowrap",
      }}>
        {agentName}
      </div>
    </div>
  )
}

const ProgressDots: React.FC<{ index: number; total: number; accent: string }> = ({ index, total, accent }) => (
  <div style={{ position: "absolute", bottom: 64, left: 64, display: "flex", gap: 12 }}>
    {Array.from({ length: total }, (_, i) => (
      <div key={i} style={{
        width: i === index ? 34 : 12, height: 12, borderRadius: 6,
        backgroundColor: i === index ? accent : "#ffffff3d",
      }} />
    ))}
  </div>
)

const CardScene: React.FC<{ card: ReelCard; index: number; total: number; brand: Brand }> = ({ card, index, total, brand }) => {
  const frame = useCurrentFrame()
  const accent = KIND_ACCENT[card.kind]
  return (
    <AbsoluteFill>
      <SceneBackground brand={brand} accent={accent} />
      <SceneHeader brand={brand} right={
        <span style={{ fontSize: 20, letterSpacing: 3, color: accent, fontWeight: 700 }}>{index + 1} / {total}</span>
      } />
      <AbsoluteFill style={{ padding: "150px 150px 120px", justifyContent: "center" }}>
        <div style={{
          display: "inline-block", alignSelf: "flex-start", padding: "9px 22px", borderRadius: 6,
          backgroundColor: accent, color: brand.primaryColor, fontSize: 23, fontWeight: 800, letterSpacing: 4,
          marginBottom: 34, ...fadeUp(frame, 0, 14),
        }}>
          {KIND_TAG[card.kind]}
        </div>
        <div style={{ display: "flex", alignItems: "stretch", gap: 40 }}>
          <div style={{ width: 10, borderRadius: 5, backgroundColor: accent, opacity: interpolate(frame, [2, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }} />
          <div>
            <div style={{ fontSize: 210, fontWeight: 900, lineHeight: 0.92, color: "#fff", textShadow: "0 10px 44px rgba(0,0,0,0.35)", ...fadeUp(frame, 4, 22) }}>
              {card.value}
            </div>
            <div style={{ fontSize: 44, letterSpacing: 6, color: "#ffffffe6", textTransform: "uppercase", marginTop: 18, ...fadeUp(frame, 10, 26) }}>
              {card.label}
            </div>
            {card.sub && (
              <div style={{ fontSize: 30, color: accent, marginTop: 20, fontWeight: 600, ...fadeUp(frame, 16, 32) }}>
                {card.sub}
              </div>
            )}
          </div>
        </div>
      </AbsoluteFill>
      <ProgressDots index={index} total={total} accent={accent} />
    </AbsoluteFill>
  )
}

const CoverScene: React.FC<{ brand: Brand; weekLabel: string; agentName: string }> = ({ brand, weekLabel, agentName }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <SceneBackground brand={brand} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 80, textAlign: "center" }}>
        {brand.logoUrl && <SafeImg src={brand.logoUrl} style={{ height: 96, objectFit: "contain", marginBottom: 44, ...fadeUp(frame, 0, 14) }} />}
        <div style={{
          display: "inline-block", padding: "12px 30px", borderRadius: 8, backgroundColor: brand.accentColor,
          color: brand.primaryColor, fontSize: 25, fontWeight: 800, letterSpacing: 6, textTransform: "uppercase",
          marginBottom: 36, ...fadeUp(frame, 4, 20),
        }}>
          Partners&apos; Meeting
        </div>
        <div style={{ fontSize: 100, fontWeight: 800, color: "#fff", lineHeight: 1.04, textShadow: "0 10px 44px rgba(0,0,0,0.35)", ...fadeUp(frame, 10, 28) }}>
          {brand.brokerageName}
        </div>
        <div style={{ fontSize: 40, color: "#fff", marginTop: 22, opacity: interpolate(frame, [16, 34], [0, 0.75], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
          {weekLabel}
        </div>
        <div style={{ fontSize: 27, color: brand.accentColor, marginTop: 30, fontWeight: 700, letterSpacing: 2, ...fadeUp(frame, 24, 40) }}>
          Hosted by {agentName} — your AI management team
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

const AskScene: React.FC<{ brand: Brand; oneAsk: string }> = ({ brand, oneAsk }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <SceneBackground brand={brand} />
      <SceneHeader brand={brand} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 80, textAlign: "center", color: "#fff" }}>
        <div style={{ fontSize: 28, letterSpacing: 6, color: brand.accentColor, fontWeight: 700, marginBottom: 28, ...fadeUp(frame, 0, 14) }}>THE ONE ASK</div>
        <div style={{ fontSize: 74, fontWeight: 800, lineHeight: 1.12, maxWidth: 1400, textShadow: "0 10px 44px rgba(0,0,0,0.3)", ...fadeUp(frame, 6, 24) }}>{oneAsk}</div>
        <div style={{ fontSize: 32, marginTop: 30, opacity: interpolate(frame, [18, 34], [0, 0.75], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
          Clear it and the team rolls into Monday at full speed.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

const OutroScene: React.FC<{ brand: Brand; showEho: boolean; qrCodeDataUrl?: string | null; qrCaption?: string }> = ({ brand, showEho, qrCodeDataUrl, qrCaption }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <SceneBackground brand={brand} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", color: "#fff", textAlign: "center" }}>
        <div>
          {brand.logoUrl && <SafeImg src={brand.logoUrl} style={{ height: 72, objectFit: "contain", marginBottom: 30, ...fadeUp(frame, 0, 12) }} />}
          <div style={{ fontSize: 44, fontWeight: 800, ...fadeUp(frame, 4, 18) }}>{brand.brokerageName}</div>
          <div style={{ width: 90, height: 4, borderRadius: 2, backgroundColor: brand.accentColor, margin: "22px auto 0" }} />
          <div style={{ fontSize: 23, opacity: 0.65, marginTop: 22 }}>
            Presented by your AI management team{showEho && " · Equal Housing Opportunity"}
          </div>
        </div>
      </AbsoluteFill>
      <QrOutroBadge
        qrCodeDataUrl={qrCodeDataUrl}
        caption={qrCaption ?? "Scan to connect"}
        primaryColor={brand.primaryColor}
        accentColor={brand.accentColor}
      />
    </AbsoluteFill>
  )
}

export const PartnersMeetingReel: React.FC<PartnersMeetingReelProps> = ({
  weekLabel, cards, oneAsk, agentName, avatarVideoUrl, agentPhotoUrl, brand, qrCodeDataUrl, qrCaption, captionsCues,
}) => {
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
        <CoverScene brand={brand} weekLabel={weekLabel} agentName={agentName} />
      </Sequence>

      {/* EARNED CARDS */}
      {cards.map((card, i) => (
        <Sequence key={i} from={COVER + per * i} durationInFrames={per}>
          <CardScene card={card} index={i} total={cards.length} brand={brand} />
        </Sequence>
      ))}

      {/* THE ONE ASK */}
      <Sequence from={COVER + cardTotal} durationInFrames={ASK}>
        <AskScene brand={brand} oneAsk={oneAsk} />
      </Sequence>

      {/* THE PRESENTER RIDES EVERY CARD — AS ONE CONTINUOUS TAKE.
          THE DEFECT (found 2026-09-05, lane BROLL, auditing remotion/ against
          .claude/skills/remotion-best-practices). `<AvatarPIP>` was mounted
          INSIDE each card's `<Sequence>` and again inside the ask's — cards.length
          + 1 separate mounts of the SAME `avatarVideoUrl`. A `<Video>` inside a
          `<Sequence>` starts at that sequence's frame 0, which is exactly right
          for one clip in one slot and exactly wrong here: the presenter RESTARTED
          at every card boundary, so the reel only ever showed the clip's first
          `per` frames and never reached the rest of the take — and, because
          `<Video>` from @remotion/media plays the media's audio, the D-ID clip's
          lip-synced narration RE-SPOKE its opening line once per card while the
          root-level `<CaptionLayer>` ran one continuous caption track over the
          top. The captions and the audio disagreed, and the render reported
          success — the same silent-wrong-thing shape as the B-roll freeze this
          lane closed (scripts/broll-slot-guard.ts).

          One mount over the whole presenter window [COVER, durationInFrames −
          OUTRO) gives the clip ONE clock, so it plays through. Placed after the
          card/ask sequences so the PIP still draws on top of them, and before
          the outro so the outro still draws on top of it. The window meets the
          outro exactly: COVER + cardTotal + ASK === durationInFrames − OUTRO.

          UNRESOLVED and NOT invented here: if the D-ID clip is SHORTER than this
          window it holds its final frame, the same class of defect the B-roll
          layer now bounds with a measured duration. Nothing in this composition's
          props carries the avatar clip's length, so there is no honest number to
          bound it with — see the report, not a guess. */}
      <Sequence from={COVER} durationInFrames={cardTotal + ASK}>
        <AvatarPIP avatarVideoUrl={avatarVideoUrl} agentPhotoUrl={agentPhotoUrl} agentName={agentName} accentColor={brand.accentColor} primaryColor={brand.primaryColor} />
      </Sequence>

      {/* OUTRO */}
      <Sequence from={durationInFrames - OUTRO} durationInFrames={OUTRO}>
        <OutroScene brand={brand} showEho={showEho} qrCodeDataUrl={qrCodeDataUrl} qrCaption={qrCaption} />
      </Sequence>

      {/* WORD-SYNCED CAPTIONS — whole-timeline overlay, muted-feed readable.
          Sits above the progress dots, clear of the presenter PIP. */}
      {captionsCues && captionsCues.length > 0 && (
        <CaptionLayer cues={captionsCues} accentColor={brand.accentColor} bottomPercent={84} />
      )}
    </AbsoluteFill>
  )
}
