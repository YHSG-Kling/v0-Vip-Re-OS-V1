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
import { AbsoluteFill, Audio, useVideoConfig } from "remotion"
import { ListingPresentationSlide, type SlideKind } from "./ListingPresentationSlide"

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
    </AbsoluteFill>
  )
}
