// lib/video/finish-spec.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE VIDEO FINISH SPEC — the owner's rule made canonical: ONE definition of
// which video category gets which stitching, so every producer, the render
// coordinator, and the registry agree by CONSTRUCTION instead of by memory.
//
//   presenter:  did_talking_head — the person IS the video (D-ID avatar track)
//               circle_pip       — a floating presenter (photo or D-ID clip)
//                                  over cards/content (the report-show pattern)
//               none             — content carries itself (photo/chart reels)
//   bookends:   branded stock intro/outro stitched by the coordinator
//   broll:      cutaway footage behind/between presenter moments
//   music:      licensed bed, mixed UNDER any narration (mood-pickable)
//   qr:         tracked outro QR (scan → listing / booking / portal)
//   thumbnail:  branded VideoCoverThumb companion (share/OG card)
//   captions:   sound-off caption strip (feeds autoplay muted)
//
// RULES OF THUMB the spec encodes:
//   · Client-facing marketing → the works (bookends, music, QR, thumbnail).
//   · Avatar-led personal video → talking head + optional b-roll; music ducks.
//   · Internal report shows → circle PIP + music, NO QR (the audience is
//     already inside the app; a scan target would be noise).
//   · Client-facing report shows (pitch, deal room) → PIP + QR.
//   · Stills (thumbnails/postcards/lead cards) → none of it; they ARE the card.
//   · Selfie/asset-source media (twin studio) is NOT a deliverable — no finish.
//
// The reel simulator asserts the live registry's supports_bookends /
// thumbnail_composition_id flags MATCH this spec — drift fails CI.

export type PresenterStyle = "did_talking_head" | "circle_pip" | "none"

export interface VideoFinish {
  presenter: PresenterStyle
  bookends: boolean
  broll: "required" | "optional" | "none"
  music: boolean
  qr: boolean
  thumbnail: boolean
  captions: boolean
}

const MARKETING: VideoFinish = { presenter: "none", bookends: true, broll: "required", music: true, qr: true, thumbnail: true, captions: true }
const CHART_REEL: VideoFinish = { presenter: "none", bookends: true, broll: "optional", music: true, qr: true, thumbnail: true, captions: true }
const AVATAR_LED: VideoFinish = { presenter: "did_talking_head", bookends: true, broll: "optional", music: true, qr: true, thumbnail: true, captions: true }
const REPORT_INTERNAL: VideoFinish = { presenter: "circle_pip", bookends: true, broll: "none", music: true, qr: false, thumbnail: true, captions: false }
const REPORT_CLIENT: VideoFinish = { presenter: "circle_pip", bookends: true, broll: "none", music: true, qr: true, thumbnail: true, captions: true }
const STILL: VideoFinish = { presenter: "none", bookends: false, broll: "none", music: false, qr: false, thumbnail: false, captions: false }

/** Per-composition finish. PartnersMeetingReel hosts FOUR uses — the reel-use
 *  overrides below refine it; the composition default is the client posture. */
export const VIDEO_FINISH_SPEC: Record<string, VideoFinish> = {
  // ── Listing marketing (the works) — OWNER RULE: the HOUSE is the star.
  // Photos of the property with the status sign (JUST LISTED / SOLD / OPEN
  // HOUSE banner) carried by the agent's cloned-voice narration — no talking
  // head competing with the home. ──
  JustListedReel: MARKETING,
  JustListedReelSquare: MARKETING,
  JustListedReelHorizontal: { ...MARKETING, broll: "optional" },
  JustSoldReelSquare: MARKETING,
  ComingSoonReel: MARKETING,
  OpenHouseAnnounceReel: MARKETING,
  PhotoWalkthroughReel: { ...MARKETING, broll: "none" }, // the photos ARE the video
  TestimonialReel: { ...CHART_REEL, broll: "optional" },
  NeighborhoodSpotlightReel: { ...MARKETING, broll: "required" },
  // ── Chart/data reels ──
  CMAReel: CHART_REEL,
  // OWNER RULE: explainers/market updates present with the CIRCLE avatar —
  // the person rides as a floating presenter; the content stays the star.
  MarketUpdateReel: { ...AVATAR_LED, presenter: "circle_pip", broll: "optional" },
  AffordabilitySnapshotReel: CHART_REEL,
  EquityReportReel: { ...CHART_REEL, qr: true }, // anniversary QR
  ExplainerAnimReel: { ...CHART_REEL, broll: "none" }, // the animation IS the visual
  // ── Avatar-led personal video. The talking head is for PERSONAL messages
  // (the agent speaking TO one person); explainers + narrated slide decks use
  // the CIRCLE avatar so the material stays the star (owner rule). ──
  AgentTalkingHeadReel: AVATAR_LED,
  // Round 34 teammate explainer: the composition carries its OWN brand frames
  // (intro card, lower-third, outro CTA + QR baked in) — no stock bookends, no
  // coordinator QR pass; music stays off so nothing fights the avatar's voice.
  TeammateExplainerReel: { ...AVATAR_LED, bookends: false, broll: "none", music: false, qr: false },
  AgentExplainerReel: { ...AVATAR_LED, presenter: "circle_pip" },
  ListingPresentationSlide: { ...AVATAR_LED, presenter: "circle_pip", broll: "none", music: false }, // music fights the voice
  BuyerConsultationSlide: { ...AVATAR_LED, presenter: "circle_pip", broll: "none", music: false },
  ListingSectionReel: { ...CHART_REEL, broll: "none" },
  // ── Report shows (PartnersMeetingReel serves 4 uses; see REEL_USE_FINISH) ──
  PartnersMeetingReel: REPORT_INTERNAL,
  // ── Other ──
  NewsletterDigestVideo: { ...MARKETING, broll: "optional" },
  ProductPromoReel: { ...MARKETING, broll: "optional", qr: true },
  // ── Stills — they ARE the deliverable ──
  ListingFlyer: STILL, // 8.5x11 print — the flyer IS the deliverable
  DoorHanger: STILL, // 4.25x11 print — the door-knock piece IS the deliverable
  CarouselSlide: STILL, // one swipe of a social carousel — the set IS the deliverable
  VideoCoverThumb: STILL,
  NewsletterDigestThumb: STILL,
  LeadMagnetCard: STILL,
  PostcardFront4x6: STILL,
  PostcardBack4x6: STILL,
  PostcardFront6x9: STILL,
  PostcardBack6x9: STILL,
}

/** The PartnersMeetingReel family by USE (entity_type on the render row):
 *  internal reports skip the QR; client-facing ones carry it. */
export const REEL_USE_FINISH: Record<string, VideoFinish> = {
  partners_meeting_reel: REPORT_INTERNAL,
  board_packet_reel: REPORT_INTERNAL,
  listing_pitch_reel: REPORT_CLIENT,
  deal_room_reel: REPORT_CLIENT,
}

const SAFE_DEFAULT: VideoFinish = { presenter: "none", bookends: true, broll: "none", music: true, qr: false, thumbnail: true, captions: false }

/** Never undefined: composition spec, refined by reel use when provided. */
export function finishForVideo(compositionId: string, entityType?: string | null): VideoFinish {
  if (entityType && REEL_USE_FINISH[entityType]) return REEL_USE_FINISH[entityType]
  return VIDEO_FINISH_SPEC[compositionId] ?? SAFE_DEFAULT
}
