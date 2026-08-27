/**
 * remotion/EquityReportReel.tsx
 *
 * The ANNIVERSARY EQUITY REEL — the video face of lib/kernel/anniversary-equity.ts.
 *
 * On a past client's yearly closing anniversary, the Sphere Manager already pushes
 * a portal value card + one gated agent note with the REAL equity story (estimated
 * current value vs what they paid, and equity when the original loan is on file —
 * otherwise appreciation-only and the copy SAYS so). When the agent has a voice +
 * avatar profile configured, this composition is the optional personalized reel
 * that rides the same numbers.
 *
 * Format choices (mirrors MarketUpdateReel so the library reads consistently):
 *   · 1080×1080 (square) — Meta/IG feed + portal embed.
 *   · 18s @ 30fps = 540 frames: cover (2s) + value stat (4s) + appreciation stat
 *     (4s) + equity-OR-appreciation-only stat (4s) + outro (4s).
 *   · Each stat is the SAME shape as MarketUpdateReel's StatCard: huge number,
 *     label, supporting delta chip. Visual consistency makes the format scannable.
 *   · Optional avatar PIP top-right (D-ID + ElevenLabs render — NEVER HeyGen),
 *     exactly the AvatarPIP pattern MarketUpdateReel uses. Falls back to the
 *     agent photo, then an initial monogram.
 *   · The appreciation magnitude gets a deterministic SVG bar (lib/charts/geometry
 *     horizontalBars) — purchase basis vs estimated value — so the growth reads
 *     visually, not just as a number. No hand-rolled geometry.
 *   · Outro carries the tracked QrOutroBadge (mintVideoQr kind "anniversary" →
 *     destination_type anniversary_video → the portal equity card).
 *
 * HONESTY (the same non-negotiables the play enforces — kept consistent on-screen):
 *   · Every figure is labeled an "estimate" and the reel says "not an appraisal".
 *   · When estimatedEquity is null the equity stat NEVER invents a number — it
 *     renders the honest "appreciation only — no loan details on file" treatment.
 *   · No financial-advice language, no protected-class / Fair-Housing-unsafe copy.
 *
 * Remotion best-practices: useCurrentFrame/interpolate only, Sequence bookends,
 * <Img>/<Video> from "remotion", deterministic — NO CSS transitions / Tailwind
 * animation. The pure formatters + the equity-mode decision are exported so the
 * simulator can assert the prop contract without a render context.
 */
import React from "react"
import { Video } from "@remotion/media"
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion"
import { horizontalBars } from "../lib/charts/geometry"
import { ordinal } from "../lib/format/ordinal"
import { QrOutroBadge } from "./components/QrOutroBadge"

export interface EquityReportReelBrand {
  primaryColor:   string
  accentColor:    string
  /** Positive-appreciation color — defaults to a calm green. */
  upColor?:       string
  /** Negative-appreciation color — soft red (honesty over flattery). */
  downColor?:     string
  logoUrl?:       string
  brokerageName?: string
  showEhoMark?:   boolean
}

export interface EquityReportReelProps {
  agentName:      string
  agentPhotoUrl?: string | null
  /** D-ID + ElevenLabs narration for the whole reel. Null → photo/monogram PIP. */
  avatarVideoUrl?: string | null
  brandColors:    EquityReportReelBrand
  /** The past client's home — shown on the cover. Falls back to "your home". */
  address?:       string | null
  /** REAL estimated current value (from computeEquityLine's source). */
  estimatedValue: number
  /** What they paid — the basis (computeEquityLine basisPrice). */
  purchasePrice:  number
  /** est. value − basis. Can be negative — the reel renders it honestly. */
  appreciation:   number
  /** appreciation / basis × 100. */
  appreciationPct: number
  /** est. value − est. remaining balance; NULL → appreciation-only mode. */
  estimatedEquity: number | null
  /** The anniversary number (whole years since closing). */
  yearsHeld:      number
  /** Tracked outro QR PNG data URL (mintVideoQr kind "anniversary"). Optional. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR. Defaults to "Scan for your equity update". */
  qrCaption?:     string
}

const FPS    = 30
const COVER  = 2 * FPS
const STAT   = 4 * FPS
const OUTRO  = 4 * FPS
const TOTAL  = COVER + STAT * 3 + OUTRO  // 540 frames = 18s

/** USD with no cents — the same Intl shape the play's copy uses. */
export function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n)
}

/** Signed percent, 1 decimal — "+20%", "-10%". */
function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : ""
  return `${sign}${n}%`
}

// TOMBSTONE (§6 ordinal consolidation): a private `ordinal(n)` lived here,
// byte-identical to the copy in lib/kernel/anniversary-equity.ts. Survivor:
// lib/format/ordinal.ts:32 `ordinal` — a pure leaf (zero imports), so pulling
// it into the Remotion bundle adds nothing server-side.

/**
 * PURE — which equity treatment the reel renders. Exported so the simulator can
 * assert the null-equity appreciation-only branch without a Remotion context.
 * estimatedEquity null → "appreciation_only" (NEVER a fabricated equity number).
 */
export function equityDisplayMode(
  estimatedEquity: number | null,
): "value_minus_balance" | "appreciation_only" {
  return estimatedEquity == null ? "appreciation_only" : "value_minus_balance"
}

const StatCard: React.FC<{
  value:    string
  label:    string
  delta?:   string
  deltaColor?: string
  accentColor: string
  note?:    string
}> = ({ value, label, delta, deltaColor, accentColor, note }) => {
  const frame = useCurrentFrame()
  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      justifyContent: "center", alignItems: "flex-start", padding: "0 88px",
    }}>
      <div style={{
        display: "inline-block", padding: "6px 16px", borderRadius: 4,
        backgroundColor: accentColor, color: "#0F172A",
        fontSize: 18, fontWeight: 700, letterSpacing: 4, marginBottom: 24,
        opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      }}>
        {label}
      </div>

      <div style={{
        fontSize: 152, fontWeight: 900, lineHeight: 0.95, color: "#fff",
        opacity: interpolate(frame, [6, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        marginBottom: 18,
      }}>
        {value}
      </div>

      {delta && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 12,
          padding: "10px 20px", borderRadius: 8,
          backgroundColor: `${deltaColor ?? accentColor}33`,
          color: deltaColor ?? accentColor, fontSize: 28, fontWeight: 700,
          opacity: interpolate(frame, [18, 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}>
          {delta}
        </div>
      )}

      {note && (
        <div style={{
          marginTop: 24, maxWidth: 760, color: "#fff", opacity: 0.7,
          fontSize: 24, lineHeight: 1.3,
        }}>
          {note}
        </div>
      )}
    </div>
  )
}

/** Deterministic SVG basis→value bars (lib/charts/geometry). Purchase basis vs
 *  estimated value, the longer track = current value. Grows in over ~24 frames. */
const AppreciationBars: React.FC<{
  purchasePrice: number
  estimatedValue: number
  upColor: string
  accentColor: string
}> = ({ purchasePrice, estimatedValue, upColor, accentColor }) => {
  const frame = useCurrentFrame()
  const W = 760, H = 180
  const domainMax = Math.max(purchasePrice, estimatedValue, 1)
  const bars = horizontalBars([purchasePrice, estimatedValue], { width: W, height: H, padY: 16, gap: 0.4 }, { min: 0, max: domainMax })
  const grow = interpolate(frame, [4, 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const fills = [accentColor, upColor]
  const labels = ["YOU PAID", "EST. VALUE"]
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {bars.map((b, i) => (
        <g key={i}>
          <rect x={0} y={b.y} width={Math.max(2, b.w * grow)} height={b.h} rx={6} fill={fills[i]} />
          <text x={12} y={b.y + b.h / 2 + 6} fontSize={20} fontWeight={700} fill="#0F172A" fontFamily="system-ui">
            {labels[i]}
          </text>
        </g>
      ))}
    </svg>
  )
}

const AvatarPIP: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl:  string | null
  agentName:      string
  startFrame:     number
  endFrame:       number
  accentColor:    string
  primaryColor:   string
}> = ({ avatarVideoUrl, agentPhotoUrl, agentName, startFrame, endFrame, accentColor, primaryColor }) => {
  const ring: React.CSSProperties = {
    position: "absolute", top: 32, right: 32,
    width: 200, height: 200, borderRadius: 100,
    boxShadow: `0 0 0 4px ${accentColor}, 0 18px 36px rgba(0,0,0,0.25)`,
    overflow: "hidden", backgroundColor: primaryColor,
  }
  if (avatarVideoUrl) {
    return (
      <div style={ring}>
        <Video src={avatarVideoUrl} objectFit="cover" trimBefore={startFrame} trimAfter={endFrame}
          style={{ width: "100%", height: "100%" }} />
      </div>
    )
  }
  if (agentPhotoUrl) {
    return (
      <div style={ring}>
        <Img src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    )
  }
  return (
    <div style={{
      ...ring, backgroundColor: accentColor,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 80, color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}

const SceneChip: React.FC<{ label: string; accentColor: string }> = ({ label, accentColor }) => (
  <div style={{
    position: "absolute", top: 32, left: 32,
    padding: "8px 16px", borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.55)", color: "#fff",
    fontSize: 16, fontWeight: 600, letterSpacing: 2,
  }}>
    <span style={{ color: accentColor }}>●</span>{" "}{label}
  </div>
)

export const EquityReportReel: React.FC<EquityReportReelProps> = ({
  agentName, agentPhotoUrl, avatarVideoUrl, brandColors,
  address, estimatedValue, purchasePrice, appreciation, appreciationPct,
  estimatedEquity, yearsHeld, qrCodeDataUrl, qrCaption,
}) => {
  const frame     = useCurrentFrame()
  const upColor   = brandColors.upColor   ?? "#22C55E"
  const downColor = brandColors.downColor ?? "#EF4444"
  const showEho   = brandColors.showEhoMark ?? true
  const gained    = appreciation >= 0
  const apprColor = gained ? upColor : downColor
  const home      = address?.trim() ? address.trim() : "your home"
  const mode      = equityDisplayMode(estimatedEquity)
  const chip      = `${ordinal(yearsHeld)} HOME ANNIVERSARY · ESTIMATE`

  const pipFor = (start: number) => ({
    avatarVideoUrl: avatarVideoUrl ?? null,
    agentPhotoUrl:  agentPhotoUrl ?? null,
    agentName,
    startFrame: start,
    endFrame:   start + STAT,
    accentColor: brandColors.accentColor,
    primaryColor: brandColors.primaryColor,
  })

  return (
    <AbsoluteFill style={{
      backgroundColor: brandColors.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* COVER — 0-2s */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {brandColors.logoUrl && (
            <Img src={brandColors.logoUrl} style={{
              height: 64, objectFit: "contain", marginBottom: 36,
              opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }} />
          )}
          <div style={{
            display: "inline-block", padding: "10px 24px", borderRadius: 6,
            backgroundColor: brandColors.accentColor, color: brandColors.primaryColor,
            fontSize: 18, fontWeight: 700, letterSpacing: 5, textTransform: "uppercase",
            marginBottom: 28, opacity: interpolate(frame, [6, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            Annual equity update
          </div>
          <div style={{
            fontSize: 64, fontWeight: 800, color: "#fff", lineHeight: 1.05,
            opacity: interpolate(frame, [12, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            Happy {ordinal(yearsHeld)} home anniversary
          </div>
          <div style={{
            fontSize: 30, color: "#fff", marginTop: 16,
            opacity: interpolate(frame, [18, 36], [0, 0.7], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}>
            {home}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* STAT 1 — estimated current value + the basis bars. 2-6s */}
      <Sequence from={COVER} durationInFrames={STAT}>
        <AbsoluteFill style={{ backgroundColor: brandColors.primaryColor }}>
          <SceneChip label={chip} accentColor={brandColors.accentColor} />
          <AvatarPIP {...pipFor(COVER)} />
          <div style={{
            height: "100%", display: "flex", flexDirection: "column",
            justifyContent: "center", alignItems: "flex-start", padding: "0 88px",
          }}>
            <div style={{
              display: "inline-block", padding: "6px 16px", borderRadius: 4,
              backgroundColor: brandColors.accentColor, color: "#0F172A",
              fontSize: 18, fontWeight: 700, letterSpacing: 4, marginBottom: 24,
            }}>
              ESTIMATED CURRENT VALUE
            </div>
            <div style={{ fontSize: 152, fontWeight: 900, lineHeight: 0.95, color: "#fff", marginBottom: 28 }}>
              {fmtUsd(estimatedValue)}
            </div>
            <AppreciationBars
              purchasePrice={purchasePrice}
              estimatedValue={estimatedValue}
              upColor={upColor}
              accentColor={brandColors.accentColor}
            />
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* STAT 2 — appreciation since purchase (honest about negative). 6-10s */}
      <Sequence from={COVER + STAT} durationInFrames={STAT}>
        <AbsoluteFill style={{ backgroundColor: brandColors.primaryColor }}>
          <SceneChip label={chip} accentColor={brandColors.accentColor} />
          <AvatarPIP {...pipFor(COVER + STAT)} />
          <StatCard
            label={gained ? "ESTIMATED VALUE GROWTH" : "ESTIMATED VALUE CHANGE"}
            value={fmtUsd(appreciation)}
            delta={`${fmtPct(appreciationPct)} vs the ${fmtUsd(purchasePrice)} you paid`}
            deltaColor={apprColor}
            accentColor={brandColors.accentColor}
            note="An estimate, not an appraisal. Markets move both ways."
          />
        </AbsoluteFill>
      </Sequence>

      {/* STAT 3 — equity OR the honest appreciation-only treatment. 10-14s */}
      <Sequence from={COVER + STAT * 2} durationInFrames={STAT}>
        <AbsoluteFill style={{ backgroundColor: brandColors.primaryColor }}>
          <SceneChip label={chip} accentColor={brandColors.accentColor} />
          <AvatarPIP {...pipFor(COVER + STAT * 2)} />
          {mode === "value_minus_balance" && estimatedEquity != null ? (
            <StatCard
              label="ESTIMATED EQUITY"
              value={fmtUsd(estimatedEquity)}
              delta="Est. value − est. remaining loan balance"
              deltaColor={upColor}
              accentColor={brandColors.accentColor}
              note="An estimate based on your original loan amount — not an appraisal, not financial advice."
            />
          ) : (
            <StatCard
              label="APPRECIATION ONLY"
              value={fmtUsd(appreciation)}
              accentColor={brandColors.accentColor}
              note="We don't have your loan details on file, so this update shows estimated value growth only — not your loan balance or true equity. An estimate, not an appraisal."
            />
          )}
        </AbsoluteFill>
      </Sequence>

      {/* OUTRO — agent + EHO + tracked QR. 14-18s */}
      <Sequence from={COVER + STAT * 3} durationInFrames={OUTRO}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brandColors.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1.1, marginBottom: 24 }}>
            Want a precise picture? Let&apos;s talk.
          </div>
          <div style={{ fontSize: 36, color: brandColors.accentColor, fontWeight: 700 }}>{agentName}</div>
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0,
            textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1,
          }}>
            Estimates only · not an appraisal{brandColors.brokerageName ? ` · ${brandColors.brokerageName}` : ""}
            {showEho && " · Equal Housing Opportunity"}
          </div>
          <QrOutroBadge
            qrCodeDataUrl={qrCodeDataUrl}
            caption={qrCaption ?? "Scan for your equity update"}
            primaryColor={brandColors.primaryColor}
            accentColor={brandColors.accentColor}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Duration anchor — guarantees the renderer knows the full length. */}
      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}
