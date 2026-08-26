/**
 * remotion/OpenHouseAnnounceReel.tsx
 *
 * Wave 39 — open house announcement reel. The 6×9 postcard variant
 * already exists for direct mail; this is the video format for
 * social + paid retarget. Date/time PROMINENT — that's the whole
 * point of an open-house announcement.
 *
 * Format choices:
 *   · 1080×1080 square — paid + organic
 *   · 12s @ 30fps — paid sweet spot
 *   · No D-ID required by default — event announcements work fine
 *     with text + photo + visual rhythm. When the brokerage wants
 *     to layer the agent's voice on top (TTS), the existing
 *     ElevenLabs path supplies the mp3.
 *   · The DATE / TIME / ADDRESS get the giant typography. Body
 *     copy stays minimal — the recipient should know "when, where"
 *     before the 4th frame.
 */
import React from "react"
import { Audio } from "@remotion/media"
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion"
import { ContextCueRow } from "./_BrollLayer"
import { QrOutroBadge } from "./components/QrOutroBadge"

export interface OpenHouseAnnounceReelProps {
  /** Property address line. */
  address:    string
  cityState:  string
  /** Date string — caller formats. "Saturday, Nov 22" / "This Saturday".
   *  Composition treats it as the HEADLINE. */
  dateLabel:  string
  /** Time string — "12:00 - 2:00 PM" / "Noon to 2". */
  timeLabel:  string
  /** 1-3 property photos in display order. The first one is the
   *  hero on the cover; the rest cycle in the body. */
  imageUrls:  string[]
  /** Optional short body line — 8-14 words. "Modern 3-bed with
   *  rooftop deck — RSVP not required." */
  bodyLine?:  string | null
  /** Optional CTA — "Add to calendar" / "Save the date".
   *  Defaults to "Save the date". */
  ctaLabel?:  string
  agentName:  string
  agentPhone?: string
  /** Optional voiceover MP3 (the agent's cloned voice reading the
   *  announcement). Cheap because it's a 10-second ElevenLabs job. */
  voiceoverUrl?: string
  /** Optional content-bank cues. */
  contextCues?: string[]
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — when absent the outro renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to RSVP". */
  qrCaption?:    string
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
const COVER  = 3 * FPS
const BODY   = 7 * FPS
const CTA    = 2 * FPS
const TOTAL  = COVER + BODY + CTA  // 360 frames = 12s

export const OpenHouseAnnounceReel: React.FC<OpenHouseAnnounceReelProps> = ({
  address, cityState, dateLabel, timeLabel, imageUrls, bodyLine,
  ctaLabel, agentName, agentPhone, voiceoverUrl, contextCues,
  qrCodeDataUrl, qrCaption, brand,
}) => {
  const frame    = useCurrentFrame()
  const showEho  = brand.showEhoMark ?? true
  const finalCta = ctaLabel ?? "Save the date"
  const heroImg  = imageUrls[0] ?? null
  const restImgs = imageUrls.slice(1, 4)
  const perPhoto = restImgs.length > 0 ? BODY / restImgs.length : BODY
  const cues     = contextCues ?? []

  return (
    <AbsoluteFill style={{
      backgroundColor: brand.primaryColor,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {voiceoverUrl && <Audio src={voiceoverUrl} />}

      {/* COVER — 0-3s. Date + Time as the visual headline. */}
      <Sequence from={0} durationInFrames={COVER}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 48, textAlign: "center",
        }}>
          {heroImg && (
            <AbsoluteFill>
              <Img src={heroImg} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              {/* Tint so the headline reads */}
              <AbsoluteFill style={{ backgroundColor: `${brand.primaryColor}D9` }} />
            </AbsoluteFill>
          )}
          <div style={{ position: "relative", textAlign: "center" }}>
            <div style={{
              display: "inline-block", padding: "10px 24px", borderRadius: 6,
              backgroundColor: brand.accentColor, color: brand.primaryColor,
              fontSize: 26, fontWeight: 900, letterSpacing: 6, textTransform: "uppercase",
              marginBottom: 36, opacity: interpolate(frame, [0, 14], [0, 1]),
            }}>
              Open House
            </div>
            <div style={{
              fontSize: 96, fontWeight: 900, color: "#fff", lineHeight: 0.95,
              marginBottom: 16, opacity: interpolate(frame, [10, 32], [0, 1]),
            }}>
              {dateLabel}
            </div>
            <div style={{
              fontSize: 48, color: brand.accentColor, fontWeight: 800,
              opacity: interpolate(frame, [20, 42], [0, 1]),
            }}>
              {timeLabel}
            </div>
          </div>
          {brand.logoUrl && (
            <div style={{ position: "absolute", top: 32, left: 32 }}>
              <Img src={brand.logoUrl} style={{
                height: 48, objectFit: "contain", opacity: 0.85,
              }} />
            </div>
          )}
        </AbsoluteFill>
      </Sequence>

      {/* BODY — 3-10s. Address + photos cycling + body line + cues. */}
      <Sequence from={COVER} durationInFrames={BODY}>
        <AbsoluteFill>
          {/* Background — cycling photos when supplied */}
          {restImgs.length > 0 ? (
            restImgs.map((url, idx) => (
              <Sequence key={idx} from={idx * perPhoto} durationInFrames={perPhoto}>
                <AbsoluteFill>
                  <Img src={url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  <AbsoluteFill style={{ backgroundColor: `${brand.primaryColor}B3` }} />
                </AbsoluteFill>
              </Sequence>
            ))
          ) : heroImg ? (
            <AbsoluteFill>
              <Img src={heroImg} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <AbsoluteFill style={{ backgroundColor: `${brand.primaryColor}B3` }} />
            </AbsoluteFill>
          ) : null}

          <AbsoluteFill style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            padding: 56, textAlign: "center",
          }}>
            <div style={{
              fontSize: 56, fontWeight: 800, color: "#fff", lineHeight: 1.05, marginBottom: 12,
            }}>
              {address}
            </div>
            <div style={{
              fontSize: 28, color: brand.accentColor, fontWeight: 700, letterSpacing: 3,
              marginBottom: 28,
            }}>
              {cityState}
            </div>
            {bodyLine && (
              <div style={{
                fontSize: 24, color: "#fff", opacity: 0.85, lineHeight: 1.4, maxWidth: 840,
              }}>
                {bodyLine}
              </div>
            )}
          </AbsoluteFill>
          <ContextCueRow cues={cues} accentColor={brand.accentColor} position="bottom" />
        </AbsoluteFill>
      </Sequence>

      {/* CTA — 10-12s. */}
      <Sequence from={COVER + BODY} durationInFrames={CTA}>
        <AbsoluteFill style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          padding: 64, textAlign: "center", backgroundColor: brand.primaryColor, color: "#fff",
        }}>
          <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.1, marginBottom: 24 }}>
            {finalCta}
          </div>
          <div style={{ fontSize: 32, color: brand.accentColor, fontWeight: 700 }}>{agentName}</div>
          {agentPhone && (
            <div style={{ fontSize: 24, color: "#fff", opacity: 0.85, marginTop: 12 }}>{agentPhone}</div>
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
          <QrOutroBadge
            qrCodeDataUrl={qrCodeDataUrl}
            caption={qrCaption ?? "Scan to RSVP"}
            primaryColor={brand.primaryColor}
            accentColor={brand.accentColor}
          />
        </AbsoluteFill>
      </Sequence>

      <Sequence from={TOTAL - 1} durationInFrames={1}>
        <AbsoluteFill />
      </Sequence>
    </AbsoluteFill>
  )
}
