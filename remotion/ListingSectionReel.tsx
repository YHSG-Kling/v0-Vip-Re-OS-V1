/**
 * remotion/ListingSectionReel.tsx
 *
 * Wave 39 — renders ONE pre-listing presentation section as a branded,
 * narratable animated slide video (the non-CMA sections of the seller drip:
 * intro / credibility / marketing / process / closing). The CMA/market section
 * uses CMAReel (data charts); every other section uses this.
 *
 * Reuses ListingPresentationSlide for the visual + avatar PIP, and plays the
 * optional ElevenLabs narration / D-ID avatar slice the section was rendered
 * with. avatarVideoUrl is wired in by the D-ID → Remotion handoff
 * (provider_metadata.target_composition_id = 'ListingSectionReel'); when absent
 * it falls back to the agent's photo. 1920×1080.
 */
import React from "react"
import { Audio } from "@remotion/media"
import { AbsoluteFill, useVideoConfig } from "remotion"
import { ListingPresentationSlide, type SlideKind } from "./ListingPresentationSlide"
import { QrOutroBadge } from "./components/QrOutroBadge"
import { CaptionLayer } from "./components/CaptionLayer"
import type { CaptionCue } from "../lib/video/caption-plan"

const SECTION_KIND: Record<string, SlideKind> = {
  intro:       "title",
  credibility: "title",
  marketing:   "title",
  process:     "title",
  closing:     "closing",
}

export interface ListingSectionReelProps {
  sectionKey:     string
  title:          string
  bullets:        string[]
  agentName:      string
  agentPhotoUrl?: string | null
  avatarVideoUrl?: string | null
  voiceoverUrl?:  string | null
  slideNumber?:   number
  totalSlides?:   number
  /** Tracked outro QR PNG data URL (lib/video/video-qr.ts). Optional +
   *  default-off — only shown on the CLOSING section so it reads as an
   *  outro. When absent the section renders exactly as before. */
  qrCodeDataUrl?: string | null
  /** Caption under the outro QR, e.g. "Scan to start". */
  qrCaption?:     string
  /** SOUND-OFF CAPTIONS (additive + default-off, wave 61). Precomputed word-accurate
   *  cues built upstream from REAL alignment — preferred. See CaptionLayer.
   *  section-render.ts stages captionScript from the SAME narration.script that
   *  becomes the avatar/voice-clone narration below (§6 — one narration, not two). */
  captionsCues?:  CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — the raw narration script text; CaptionLayer
   *  estimates timing in-composition when no cues are supplied. Absent → no captions. */
  captionScript?: string | null
  brand: {
    primaryColor:  string
    accentColor:   string
    surfaceColor?: string
    logoUrl?:      string
    brokerageName: string
    licenseLine?:  string
    showEhoMark?:  boolean
  }
}

export const ListingSectionReel: React.FC<ListingSectionReelProps> = (props) => {
  const { durationInFrames } = useVideoConfig()
  const kind = SECTION_KIND[props.sectionKey] ?? "title"
  // Only the closing section reads as an outro — that's where the QR belongs.
  const isOutroSection = kind === "closing"
  return (
    <AbsoluteFill>
      {props.voiceoverUrl ? <Audio src={props.voiceoverUrl} /> : null}
      <ListingPresentationSlide
        kind={kind}
        slideNumber={props.slideNumber ?? 1}
        totalSlides={props.totalSlides ?? 1}
        title={props.title}
        body={props.bullets}
        heroImageUrl={null}
        avatarVideoUrl={props.avatarVideoUrl ?? null}
        avatarStartFrame={0}
        avatarEndFrame={durationInFrames}
        agentPhotoUrl={props.agentPhotoUrl ?? null}
        agentName={props.agentName}
        brand={props.brand}
      />
      {isOutroSection && (
        <QrOutroBadge
          qrCodeDataUrl={props.qrCodeDataUrl}
          caption={props.qrCaption ?? "Scan to start"}
          primaryColor={props.brand.primaryColor}
          accentColor={props.brand.accentColor}
        />
      )}
      {/* NO CAPTION OVER THE CLOSING SECTION'S QR (wave 61, mirrors JustListedReel.tsx) —
          every non-closing section narrates for its full duration with no late
          branding reveal, so the caption runs the whole section there. */}
      {!isOutroSection && (
        <CaptionLayer
          cues={props.captionsCues}
          script={props.captionScript}
          accentColor={props.brand.accentColor}
        />
      )}
    </AbsoluteFill>
  )
}
