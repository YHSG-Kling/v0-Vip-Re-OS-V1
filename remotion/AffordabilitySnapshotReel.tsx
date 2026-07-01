/**
 * remotion/AffordabilitySnapshotReel.tsx
 *
 * Wave 39 — buyer-side reel. Most real-estate social is seller-side
 * (Just Listed / Just Sold / market updates). Buyers are
 * UNDER-SERVED with shareable content even though they're the bigger
 * lead pool. This composition fills the gap: a short, visual,
 * data-driven "here's what your budget buys in this market" reel
 * that the agent can post weekly with fresh examples + share with
 * a specific lead in DM.
 *
 * Format choices:
 *   · 1080×1080 square — paid + organic
 *   · 15s @ 30fps — 3 example listings × 4s each + intro/outro
 *   · Pure Remotion + content-bank pull. NO D-ID by default —
 *     the LISTINGS do the talking. Optional ElevenLabs voiceover
 *     for "this week in the market" framing.
 *
 * Composer flow (referenced in lib/marketing/affordability-snapshot
 * which lands separately):
 *   1. Pulls the agent's farm area MLS feed
 *   2. Filters to N listings around the target monthly payment
 *      (target_monthly_payment × 12 × 30 / interest_factor)
 *   3. Picks 3 with strongest hero photos
 *   4. Queues this Composition render with those 3 examples
 *
 * The "monthly payment" framing — instead of "$650K homes" — is the
 * conversion trick. First-time buyers think in monthly budget
 * (their rent + car payment + groceries math). Listing them
 * homes by sticker price feels intimidating; framing by monthly
 * payment makes the path feel reachable. This is the move no
 * competitor codifies into their content engine.
 */
import React from "react"
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion"
import { ContextCueRow } from "./_BrollLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"

export interface AffordabilityExample {
  /** Property address line — terse. */
  address:   string
  cityState: string
  /** Sticker price — e.g. "$485,000". */
  price:     string
  bedrooms:  string
  bathrooms: string
  /** Hero photo URL (exterior preferred). */
  photoUrl:  string | null
}

export interface AffordabilitySnapshotReelProps {
  /** The monthly-payment headline — "What $3,200/mo buys here".
   *  Composer formats based on the lead's stated budget. */
  monthlyHeadline: string
  /** Geographic context — "Brickell, FL" / "South Miami zip codes". */
  areaName:        string
  /** Period chip — "This week", "Today's market". */
  period:          string
  /** Exactly three examples. Format is shaped around three. */
  examples:        [AffordabilityExample, AffordabilityExample, AffordabilityExample]
  /** Optional small print on the rates assumption used to compute
   *  monthly payment — "Assuming 6.5% / 30yr / 20% down". Required
   *  by some state-marketing rules; the composition reserves a
   *  small line for it. */
  ratesAssumption?: string
  /** Closing CTA. */
  ctaLabel?:    string
  agentName:    string
  agentPhone?:  string
  voiceoverUrl?: string
  /** Tracked outro QR (lib/video/video-qr → mintVideoQr). Default-off: absent → no badge. */
  qrCodeDataUrl?: string | null
  qrCaption?:     string
  mlsClean?:      boolean
  contextCues?: string[]
  brand: {
    primaryColor:    string
    accentColor:     string
    logoUrl?:        string
    brokerageName:   string
    showEhoMark?:    boolean
    licenseLine?:    string
  }
}

const FPS    = 30
const COVER  = 3  * FPS
const PER    = 3  * FPS  // 3s per example × 3 = 9s
const CTA    = 3  * FPS
const TOTAL  = COVER + PER * 3 + CTA  // 450 frames = 15s

const ExampleCard: React.FC<{
  ex:            AffordabilityExample
  index:         number  // 1-based
  accentColor:   string
  primaryColor:  string
}> = ({ ex, index, accentColor, primaryColor }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ display: "flex", padding: 56, alignItems: "center" }}>
      {/* Index chip — pinned top */}
      <div style={{
        position: "absolute", top: 32, left: 32,
        padding: "6px 14px", borderRadius: 4,
        backgroundColor: accentColor, color: primaryColor,
        fontSize: 14, fontWeight: 900, letterSpacing: 4,
      }}>
        OPTION {index}
      </div>

      <div style={{ display: "flex", width: "100%", gap: 28, alignItems: "stretch" }}>
        {/* Photo */}
        <div style={{
          width: "55%", borderRadius: 16, overflow: "hidden",
          backgroundColor: "#E5E7EB",
          boxShadow: `0 16px 32px rgba(0,0,0,0.4)`,
          opacity: interpolate(frame, [0, 14], [0, 1]),
        }}>
          {ex.photoUrl ? (
            <Img src={ex.photoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{
              width: "100%", height: 540, display: "flex",
              alignItems: "center", justifyContent: "center",
              color: "#9CA3AF", fontSize: 22,
            }}>Photo</div>
          )}
        </div>

        {/* Facts column */}
        <div style={{
          width: "45%", display: "flex", flexDirection: "column",
          justifyContent: "center", color: "#fff",
          opacity: interpolate(frame, [10, 28], [0, 1]),
        }}>
          <div style={{
            fontSize: 80, fontWeight: 900, color: accentColor, lineHeight: 0.95, marginBottom: 12,
          }}>
            {ex.price}
          </div>
          <div style={{ fontSize: 26, opacity: 0.85, marginBottom: 28 }}>
            {ex.bedrooms} bd · {ex.bathrooms} ba
          </div>
          <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.2 }}>
            {ex.address}
          </div>
          <div style={{ fontSize: 22, opacity: 0.65, marginTop: 8 }}>
            {ex.cityState}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}

export const AffordabilitySnapshotReel: React.FC<AffordabilitySnapshotReelProps> = ({
  monthlyHeadline, areaName, period, examples, ratesAssumption,
  ctaLabel, agentName, agentPhone, voiceoverUrl, contextCues, brand,
  qrCodeDataUrl, qrCaption, mlsClean,
}) => {
  const frame     = useCurrentFrame()
  const showEho   = brand.showEhoMark ?? true
  const finalCta  = ctaLabel ?? "Want a real list?"
  const cues      = contextCues ?? []

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* COVER — 0-3s. Monthly headline. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center",
        }}>
          {brand.logoUrl && (
            <Img src={brand.logoUrl} style={{
              height: 56, objectFit: "contain", marginBottom: 32,
              opacity: interpolate(frame, [0, 12], [0, 1]),
            }} />
          )}
          <div style={{
            display: "inline-block", padding: "8px 20px", borderRadius: 4,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 18, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase",
            marginBottom: 24, opacity: interpolate(frame, [4, 18], [0, 1]),
          }}>
            What your budget actually buys
          </div>
          <div style={{
            fontSize: 88, fontWeight: 900, color: "#fff", lineHeight: 1.0,
            opacity: interpolate(frame, [12, 30], [0, 1]),
            maxWidth: 940,
          }}>
            {monthlyHeadline}
          </div>
          <div style={{
            fontSize: 28, color: "#fff", opacity: interpolate(frame, [22, 42], [0, 0.7]),
            marginTop: 16, letterSpacing: 3,
          }}>
            {areaName} · {period}
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* THREE EXAMPLES — each 3s */}
      {examples.map((ex, i) => (
        <Sequence key={i} from={COVER + i * PER} durationInFrames={PER}>
          <AbsoluteFill style={{ backgroundColor: brand.primaryColor }}>
            <ExampleCard ex={ex} index={i + 1} accentColor={brand.accentColor} primaryColor={brand.primaryColor} />
          </AbsoluteFill>
        </Sequence>
      ))}

      {/* CTA — last 3s. */}
      <Sequence from={COVER + PER * 3} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 60, fontWeight: 800, lineHeight: 1.1, marginBottom: 20 }}>
            {finalCta}
          </div>
          <div style={{ fontSize: 28, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
          {agentPhone && (
            <div style={{ fontSize: 22, color: "#fff", opacity: 0.85, marginTop: 10 }}>{agentPhone}</div>
          )}
          <ContextCueRow cues={cues} accentColor={brand.accentColor} position="bottom" />
          {ratesAssumption && (
            <div style={{
              position: "absolute", bottom: 64, left: 0, right: 0,
              fontSize: 12, color: "#fff", opacity: 0.55, letterSpacing: 1,
            }}>
              {ratesAssumption}
            </div>
          )}
          <div style={{
            position: "absolute", bottom: 24, left: 0, right: 0,
            textAlign: "center", fontSize: 14, opacity: 0.55, letterSpacing: 1, lineHeight: 1.5,
          }}>
            {brand.brokerageName}{showEho && " · Equal Housing Opportunity"}
            {brand.licenseLine && (
              <>
                <br/>
                {brand.licenseLine}
              </>
            )}
          </div>
          <QrOutroBadge qrCodeDataUrl={qrCodeDataUrl} caption={qrCaption ?? "Scan for your home value"}
            primaryColor={brand.primaryColor} accentColor={brand.accentColor} mlsClean={mlsClean} />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}
