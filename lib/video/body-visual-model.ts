/**
 * lib/video/body-visual-model.ts
 *
 * THE BODY-VISUAL MODEL — what is ON THE SCREEN while the video plays (§6, one
 * place). OWNER RULING (wave 79, lane 79C, 2026-09-23, verbatim): "we and the
 * code discusses videos in regards to avatar/voiceover/lengths/music/broll/pip,
 * etc but nowhere do we discuss what to use in the body if not a full avatar,
 * in regards to what is being displayed on the video screen for the person to
 * see and watch."
 *
 * ── WHAT ALREADY EXISTED (reused, never rebuilt) ────────────────────────────
 *   · lib/video/duration-model.ts — the PURPOSE (PURPOSE_DURATION_RULES), the
 *     HOST (voiceover/avatar/silent) and the BODY LENGTH per composition
 *     (COMPOSITION_DURATION_RULES + planCompositionDuration). This module
 *     EXTENDS it: the body it computes is what the segments below are cut from.
 *   · lib/video/finish-spec.ts — the FINISH per composition (presenter style,
 *     bookends, b-roll required/optional, music, QR, captions). The finish says
 *     whether a reel HAS b-roll; this module says WHEN it is on screen.
 *   · lib/video/assembly-timeline.ts — the ONE intro/body/outro split and the
 *     ONE tiler (weightedShotSlots — evenShotSlots is its all-1 case).
 *   · lib/video/broll-plan.ts / remotion/_BrollLayer.tsx — b-roll clip math;
 *     lib/video/ken-burns-plan.ts — photo motion; lib/video/caption-plan.ts —
 *     the caption window; remotion/components/AvatarPIP.tsx, LowerThird.tsx,
 *     EndCard.tsx — the renderable treatments; lib/assets/screenshot-capture.ts
 *     — the screenshot stills (OS surfaces, public property pages) that the
 *     `screenshot` treatment shows.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *   purpose   → a BODY-VISUAL rule (PURPOSE_BODY_VISUAL_RULES): the script ARC
 *               it is written in (hook / beats / proof / cta), the CLOSED set of
 *               treatments it allows, an ORDERED preference per segment kind,
 *               and the avatar's share bounds (presence min/max, full-frame max)
 *               with the research behind them;
 *   segments  → the fitted script is cut into the arc's segments (a producer
 *               may hand the segments directly — ProductPromoReel's hook /
 *               proofs / cta already are); each segment's spoken words are its
 *               weight; the body (from duration-model) is tiled by weight
 *               (weightedShotSlots), so nothing is hand-timed;
 *   treatment → per segment, the FIRST preferred treatment that the purpose
 *               allows ∩ the composition can render (COMPOSITION_TREATMENTS) ∩
 *               the host permits (a voiceover/silent host NEVER gets an avatar
 *               treatment — every beat must resolve to a non-avatar screen) ∩
 *               the assets exist (no b-roll clips → no `broll`); then the
 *               avatar share is pulled inside the purpose's bounds;
 *   derived   → b-roll windows, photo/screenshot slots, the caption window and
 *               the music duck are READ OFF the segment plan; intro/outro
 *               brand cards come from the composition's registered bookends;
 *   render    → the plan rides input_props.bodyVisualPlan; a composition
 *               re-fits it to the duration it actually renders at
 *               (fitBodyVisualPlan) and mounts each treatment in its window;
 *   new type  → one row in COMPOSITION_TREATMENTS (+ its duration rule). A
 *               composition without a row FAILS LOUDLY (planBodyVisual throws),
 *               and scripts/body-visual-model-guard.ts fails when any duration
 *               rule row lacks one.
 *
 * ── RESEARCH (Exa web_search_exa, 2026-09-23; skills: remotion-best-practices
 *    → remotion-markup sequencing/transitions/calculate-metadata, ads-video,
 *    social-media-manager:video-script, real-estate-real-estate-marketing) ────
 *   · Talking head vs cutaway: "Quick talking-head over b-roll" is the price-
 *     update shape; "educational content with text overlays over footage" is
 *     what TikTok viewers read (reel-e.ai 2026-02-15). "One benefit per room,
 *     walk-and-talk segments prevent stiffness"; music-led needs on-screen
 *     text, voiceover gives clarity, agent on camera builds trust — "many top
 *     teams use both" (storimaticstudio.com 2026-01-27). Personal brand
 *     content is "the one category where filming yourself beats any generated
 *     alternative"; listing video is narration over stills, ~3 s per still
 *     (shhots.ai 2026-08-17). "Text overlays and branding: helpful when used
 *     sparingly" (agentpulse.ai 2026-04-26). Over-editing loses; "simple cuts,
 *     stable shots" (portlandproductionservices.com 2026-04-24).
 *   · Product demo structure: hook 5 s → setup 10 s → core moves 60-90 s →
 *     payoff 10 s → CTA 5 s (demopolish.com 2026-05-11); problem 20 s → before
 *     state 15 s → transformation 60-90 s → results + CTA 15 s (ngram.com
 *     2026-04-16); "start at the moment of value, not the login page"; "for
 *     marketing demos most teams skip the webcam — a clean screen recording
 *     with professional narration performs better"; PiP "adds a human element
 *     for sales and onboarding" (videoeditingcompany.com 2026-09-20); investor
 *     demo: PiP small bottom-right, look at the lens at the hook and the ask
 *     (clearrec.app 2026-05-26). Text overlays under 6 words, below the focal
 *     action; 40-60 % of LinkedIn/email video plays muted.
 *   · Provider facts: D-ID Express (scenes) `is_greenscreen` on the avatar and
 *     `background.color:false` for a TRANSPARENT webm result (docs.d-id.com
 *     create-scene / create-express-avatar); Videos V4 `background:
 *     ColorBackground | ExpressiveImageBackground | TransparentBackground`
 *     (docs.d-id.com createv4video) — so a PiP can be keyed rather than a
 *     ring-cropped rectangle. ElevenLabs v3: no SSML `<break>`; pauses by
 *     `[pause]`, ellipses and punctuation; character timestamps from
 *     /v1/text-to-speech/{voice}/with-timestamps (elevenlabs.io docs, 2026).
 *   · Safe areas: keep key text ≥ 80 px from the sides and ≥ 100 px from top
 *     and bottom at 1080 wide (remotion-create/video-layout.md); Reels/TikTok
 *     "bottom 20 % covered by UI" (ads-video skill), "keep text away from UI
 *     areas (bottom and sides)" (storimaticstudio.com).
 *
 * PURE. No I/O, no React, no Remotion, no "@/" alias — remotion/** imports
 * this into the Remotion webpack bundle (relative imports only, like
 * duration-model.ts).
 */
import { computeAssemblyTimeline, weightedShotSlots, type AssemblySegment } from "./assembly-timeline"
import {
  COMPOSITION_DURATION_RULES, PURPOSE_DURATION_RULES, compositionBookends, planDurationForProps,
  type DurationPlan, type HostKind, type VideoPurpose,
} from "./duration-model"
import { spokenSentences, spokenWords } from "./script-structure"

// ─────────────────────────────────────────────────────────────────────────────
// § VOCABULARY — closed, one spelling each (§6)
// ─────────────────────────────────────────────────────────────────────────────

/** What the viewer is looking at during a segment of the BODY. */
export const BODY_TREATMENTS = [
  "full_avatar",     // the presenter fills the frame (the personal message)
  "avatar_pip",      // the presenter in a corner over content (b-roll, cards, slides, screens)
  "broll",           // stock / uploaded cutaway footage, presenter off screen
  "property_photos", // listing photos with Ken Burns motion
  "screenshot",      // OS surfaces, dashboards, public property-page stills (Zestimate etc.)
  "kinetic_text",    // animated on-screen copy (bullets, stat cards, quotes)
  "lower_third",     // a name/brokerage strap over any other treatment's frame
  "chart",           // CMA / comps / market animations
  "brand_card",      // intro / outro / logo tile
] as const
export type BodyTreatment = (typeof BODY_TREATMENTS)[number]

export const AVATAR_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["full_avatar", "avatar_pip"])

/** The script's segment kinds — the arc every purpose is written in. */
export const SEGMENT_KINDS = ["hook", "beat", "proof", "cta"] as const
export type SegmentKind = (typeof SEGMENT_KINDS)[number]

/** Treatments that need an ASSET before they can be chosen. */
const ASSET_BOUND: Record<BodyTreatment, "avatar" | "broll" | "photos" | "screenshots" | "chart" | null> = {
  full_avatar: "avatar", avatar_pip: "avatar", broll: "broll", property_photos: "photos",
  screenshot: "screenshots", chart: "chart", kinetic_text: null, lower_third: null, brand_card: null,
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE PURPOSE RULES — what each purpose may show, and what it prefers
// ─────────────────────────────────────────────────────────────────────────────

export interface AvatarShareBounds {
  /** Share of BODY frames the presenter is on screen at all (full or PiP). */
  min: number
  max: number
  /** Share of BODY frames the presenter may FILL the frame — a talking head
   *  past this reads as a monologue and loses the scroll. */
  fullMax: number
}

export interface PurposeBodyVisualRule {
  /** The segment order the script is written in. */
  arc: SegmentKind[]
  /** The closed set this purpose may show. */
  allowed: BodyTreatment[]
  /** Ordered preference per segment kind; filtered at plan time by the
   *  composition, the host and the assets. */
  prefer: Record<SegmentKind, BodyTreatment[]>
  avatarShare: AvatarShareBounds
  why: string
  sources: string[]
}

const NO_AVATAR: AvatarShareBounds = { min: 0, max: 0, fullMax: 0 }
const PIP_HOSTED: AvatarShareBounds = { min: 0.5, max: 1, fullMax: 0.35 }
const PERSONAL: AvatarShareBounds = { min: 0.6, max: 1, fullMax: 0.85 }

const SRC_TALKING_HEAD = "reel-e.ai 2026-02: talking head over b-roll for updates; text overlays over footage for teaching"
const SRC_STILLS = "shhots.ai 2026-08: listing video = narration over the stills, ~3 s each, captions burned in"
const SRC_ONCAMERA = "storimaticstudio.com 2026-01: agent on camera for trust, voiceover for clarity, music-led needs on-screen text"
const SRC_DEMO = "ngram.com 2026-04 + demopolish.com 2026-05: hook → setup → core moves → payoff → CTA; start at the moment of value"
const SRC_DEMO_PIP = "videoeditingcompany.com 2026-09: marketing demos skip the webcam; PiP for sales/onboarding rapport"
const SRC_OVERLAYS = "agentpulse.ai 2026-04: text overlays and branding sparingly; portlandproductionservices.com 2026-04: simple cuts win"

export const PURPOSE_BODY_VISUAL_RULES: Record<VideoPurpose, PurposeBodyVisualRule> = {
  welcome: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "broll", "lower_third", "kinetic_text", "brand_card"],
    prefer: { hook: ["full_avatar"], beat: ["full_avatar", "avatar_pip", "broll"], proof: ["avatar_pip", "broll"], cta: ["full_avatar", "brand_card"] },
    avatarShare: PERSONAL,
    why: "A first personal touch: the person IS the video. The hook and the ask are eye-to-lens; a middle beat may float over cutaway footage so the frame moves.",
    sources: [SRC_ONCAMERA, "clearrec.app 2026-05: look at the lens at the hook and the ask; PiP in between"],
  },
  seller_update: {
    arc: ["hook", "beat", "beat", "proof", "cta"],
    allowed: ["full_avatar", "avatar_pip", "broll", "property_photos", "chart", "lower_third", "kinetic_text", "brand_card"],
    prefer: { hook: ["full_avatar"], beat: ["avatar_pip", "full_avatar", "property_photos", "broll"], proof: ["chart", "avatar_pip", "kinetic_text"], cta: ["full_avatar", "brand_card"] },
    avatarShare: { min: 0.5, max: 1, fullMax: 0.7 },
    why: "The weekly word to a listing client: the agent speaks, but showings and feedback are numbers the client should SEE — the proof beat is a chart or a card, the body beats float the agent over the home.",
    sources: [SRC_TALKING_HEAD, SRC_ONCAMERA],
  },
  anniversary_equity: {
    arc: ["hook", "beat", "beat", "proof", "cta"],
    allowed: ["avatar_pip", "chart", "kinetic_text", "brand_card"],
    prefer: { hook: ["avatar_pip", "kinetic_text"], beat: ["chart", "kinetic_text"], proof: ["chart", "kinetic_text"], cta: ["avatar_pip", "brand_card"] },
    avatarShare: { min: 0.2, max: 1, fullMax: 0 },
    why: "The number is the star (EquityReportReel's stat cards + trend); the presenter rides in the corner so the estimate qualifier is spoken by a person, never full frame over a dollar figure.",
    sources: [SRC_OVERLAYS, "finish-spec.ts EquityReportReel: circle_pip, the avatar is OPTIONAL (m218)"],
  },
  listing_promo: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["property_photos", "broll", "kinetic_text", "brand_card"],
    prefer: { hook: ["property_photos", "broll", "kinetic_text"], beat: ["property_photos", "broll", "kinetic_text"], proof: ["kinetic_text", "property_photos"], cta: ["kinetic_text", "brand_card"] },
    avatarShare: NO_AVATAR,
    why: "OWNER RULE: the HOUSE is the star. Photos with the status sign under the cloned-voice narration; the facts card and the CTA are on-screen copy. No talking head competes with the home.",
    sources: [SRC_STILLS, "finish-spec.ts MARKETING: presenter none"],
  },
  cma: {
    arc: ["beat", "beat", "beat", "beat"],
    allowed: ["chart", "kinetic_text", "brand_card"],
    prefer: { hook: ["chart"], beat: ["chart", "kinetic_text"], proof: ["chart"], cta: ["brand_card", "kinetic_text"] },
    avatarShare: NO_AVATAR,
    why: "Four data slides the seller reads at their own pace — a silent chart reel (finish-spec captions:false).",
    sources: ["lib/video/cma-reel-orchestrator.ts: holds charts, not narration"],
  },
  market_update: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["avatar_pip", "chart", "kinetic_text", "broll", "brand_card"],
    prefer: { hook: ["avatar_pip", "kinetic_text"], beat: ["avatar_pip", "chart", "kinetic_text", "broll"], proof: ["chart", "kinetic_text"], cta: ["avatar_pip", "brand_card"] },
    avatarShare: PIP_HOSTED,
    why: "OWNER RULE: explainers and market updates present with the CIRCLE avatar — the stats stay the star, the person rides as a floating presenter.",
    sources: [SRC_TALKING_HEAD, "finish-spec.ts MarketUpdateReel: circle_pip"],
  },
  explainer: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "kinetic_text", "chart", "screenshot", "broll", "brand_card"],
    prefer: { hook: ["avatar_pip", "full_avatar", "kinetic_text"], beat: ["avatar_pip", "kinetic_text", "screenshot", "broll", "full_avatar"], proof: ["chart", "screenshot", "kinetic_text"], cta: ["avatar_pip", "full_avatar", "brand_card"] },
    avatarShare: PIP_HOSTED,
    why: "Teach one concept: the bullet or diagram is what the viewer reads while the presenter talks in the corner; a full-frame head past a third of the body is a lecture, not a reel. On a composition with no PiP (TeammateExplainerReel) the presenter carries the beats full frame — the full-frame cap is lifted to the presence cap there, by construction (planBodyVisual).",
    sources: [SRC_TALKING_HEAD, SRC_OVERLAYS],
  },
  lead_reel: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "kinetic_text", "screenshot", "broll", "brand_card"],
    prefer: { hook: ["avatar_pip", "full_avatar"], beat: ["avatar_pip", "kinetic_text", "screenshot", "broll"], proof: ["kinetic_text", "screenshot"], cta: ["avatar_pip", "full_avatar", "brand_card"] },
    avatarShare: PIP_HOSTED,
    why: "A 1:1 intro to a qualified lead on the explainer composition: their situation as on-screen bullets, the agent present in the corner throughout.",
    sources: [SRC_ONCAMERA, "stackbd.com 2026 benchmark: first touch 30-45 s"],
  },
  product_demo: {
    arc: ["hook", "beat", "beat", "beat", "proof", "cta"],
    allowed: ["screenshot", "kinetic_text", "chart", "avatar_pip", "brand_card"],
    prefer: { hook: ["screenshot", "kinetic_text"], beat: ["screenshot", "kinetic_text"], proof: ["screenshot", "chart", "kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    avatarShare: { min: 0, max: 0.3, fullMax: 0 },
    why: "Start at the moment of value: the OS surface itself (screenshot stills from lib/assets/screenshot-capture.ts) behind each beat; a marketing demo skips the webcam, a sales demo may add a small PiP.",
    sources: [SRC_DEMO, SRC_DEMO_PIP],
  },
  memory: {
    arc: ["beat"],
    allowed: ["property_photos", "kinetic_text", "brand_card"],
    prefer: { hook: ["property_photos"], beat: ["property_photos", "kinetic_text"], proof: ["property_photos"], cta: ["brand_card"] },
    avatarShare: NO_AVATAR,
    why: "The family's photos under the seller's own words (verbatim on screen, memory-video-composition.ts) — nobody's face fronts somebody else's memory.",
    sources: ["lib/video/memory-video-gate.ts: never model-authored; finish-spec MemoryVideoReel presenter none"],
  },
  partners_meeting: {
    arc: ["hook", "beat", "beat", "proof", "cta"],
    allowed: ["chart", "kinetic_text", "brand_card"],
    prefer: { hook: ["kinetic_text"], beat: ["chart", "kinetic_text"], proof: ["chart", "kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    avatarShare: NO_AVATAR,
    why: "The AI team's recap to the brokerage's own people: earned cards and the money booked are charts and cards; the floating photo chip is chrome, not a presenter.",
    sources: ["finish-spec.ts REPORT_INTERNAL: circle_pip photo, no QR"],
  },
  geo_reel: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "broll", "property_photos", "screenshot", "kinetic_text", "chart", "brand_card"],
    prefer: { hook: ["property_photos", "broll", "kinetic_text"], beat: ["property_photos", "broll", "kinetic_text"], proof: ["chart", "kinetic_text"], cta: ["kinetic_text", "brand_card"] },
    avatarShare: { min: 0, max: 1, fullMax: 0.85 },
    why: "A PUBLICATION SURFACE over finished reels of any purpose — it inherits the published reel's own plan; the allowed set is the union.",
    sources: ["scripts/video-type-matrix-simulator.ts §surfaces: geo reel is a surface, not a composition"],
  },
  newsletter: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["kinetic_text", "broll", "screenshot", "chart", "brand_card"],
    prefer: { hook: ["kinetic_text", "broll"], beat: ["kinetic_text", "broll", "screenshot"], proof: ["chart", "kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    avatarShare: NO_AVATAR,
    why: "The digest's headlines are the content: three section cards, cutaway footage behind when the library has it.",
    sources: [SRC_OVERLAYS],
  },
  photo_walkthrough: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["property_photos", "kinetic_text", "brand_card"],
    prefer: { hook: ["property_photos"], beat: ["property_photos"], proof: ["property_photos"], cta: ["brand_card", "kinetic_text"] },
    avatarShare: NO_AVATAR,
    why: "The photos ARE the video (Ken Burns, 3-5 s per room); the narration tours them.",
    sources: [SRC_STILLS, "dunphy.typito.com 2026-07: 3-5 s per room"],
  },
  listing_presentation_section: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["avatar_pip", "kinetic_text", "chart", "screenshot", "brand_card"],
    prefer: { hook: ["avatar_pip", "kinetic_text"], beat: ["avatar_pip", "kinetic_text", "chart", "screenshot"], proof: ["chart", "kinetic_text"], cta: ["avatar_pip", "kinetic_text"] },
    avatarShare: { min: 0.5, max: 1, fullMax: 0 },
    why: "A narrated slide: the slide's copy is the content, the presenter is the corner (owner rule: material stays the star).",
    sources: ["finish-spec.ts ListingPresentationSlide / BuyerConsultationSlide: circle_pip"],
  },
  testimonial: {
    arc: ["hook", "beat", "proof", "cta"],
    allowed: ["kinetic_text", "property_photos", "broll", "brand_card"],
    prefer: { hook: ["kinetic_text"], beat: ["kinetic_text", "property_photos", "broll"], proof: ["kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    avatarShare: NO_AVATAR,
    why: "The client's words on screen, verbatim, as the proof; the home or lifestyle footage behind the middle beat.",
    sources: [SRC_OVERLAYS, "ads-video skill: UGC-style testimonial — the quote is the frame"],
  },
  neighborhood_spotlight: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["broll", "kinetic_text", "chart", "brand_card"],
    prefer: { hook: ["broll", "kinetic_text"], beat: ["broll", "kinetic_text"], proof: ["chart", "kinetic_text"], cta: ["kinetic_text", "brand_card"] },
    avatarShare: NO_AVATAR,
    why: "Lifestyle footage under two data highlights — discovery content for people who do not know the agent yet.",
    sources: ["finish-spec.ts NeighborhoodSpotlightReel: broll required"],
  },
  buyer_match: {
    arc: ["beat", "beat", "beat"],
    allowed: ["kinetic_text", "property_photos", "brand_card"],
    prefer: { hook: ["kinetic_text"], beat: ["kinetic_text", "property_photos"], proof: ["kinetic_text"], cta: ["brand_card"] },
    avatarShare: NO_AVATAR,
    why: "Three listing tiles a monthly budget buys — on-screen copy, no narration.",
    sources: ["dunphy.typito.com 2026-07: listing-card motion 5-15 s"],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE COMPOSITION REGISTRY — what each composition can RENDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The treatments each registered composition's source can put on screen. The
 * proof (scripts/body-visual-model-guard.ts) reads the stripped source and
 * checks every claimed treatment against its render mark (TREATMENT_MARKS), so
 * a row cannot promise what the component cannot draw. A NEW composition adds
 * one row here; a missing row makes planBodyVisual THROW.
 */
export const COMPOSITION_TREATMENTS: Record<string, BodyTreatment[]> = {
  // ── Avatar-hosted ──
  AgentTalkingHeadReel:  ["full_avatar", "avatar_pip", "broll", "lower_third", "kinetic_text", "brand_card"],
  // Three STAT CARDS with deltas (StatCard) — kinetic text, not a chart.
  MarketUpdateReel:      ["avatar_pip", "kinetic_text", "brand_card"],
  EquityReportReel:      ["avatar_pip", "kinetic_text", "chart", "brand_card"],
  AgentExplainerReel:    ["avatar_pip", "kinetic_text", "brand_card"],
  ExplainerAnimReel:     ["avatar_pip", "chart", "kinetic_text", "brand_card"],
  TeammateExplainerReel: ["full_avatar", "kinetic_text", "lower_third", "brand_card"],
  // ── Voiceover-hosted ──
  // The seller's words, verbatim, ARE the visual (memory-video-composition.ts);
  // the chapter carries no photo slot yet — an open item, not a claimed one.
  MemoryVideoReel:           ["kinetic_text", "brand_card"],
  JustListedReel:            ["property_photos", "kinetic_text", "brand_card"],
  JustListedReelSquare:      ["property_photos", "kinetic_text", "brand_card"],
  JustListedReelHorizontal:  ["property_photos", "kinetic_text", "brand_card"],
  JustSoldReelSquare:        ["property_photos", "kinetic_text", "brand_card"],
  ComingSoonReel:            ["broll", "property_photos", "kinetic_text", "brand_card"],
  OpenHouseAnnounceReel:     ["property_photos", "kinetic_text", "brand_card"],
  PhotoWalkthroughReel:      ["property_photos", "kinetic_text", "brand_card"],
  NeighborhoodSpotlightReel: ["broll", "kinetic_text", "brand_card"],
  TestimonialReel:           ["kinetic_text", "brand_card"],
  NewsletterDigestVideo:     ["kinetic_text", "brand_card"],
  // Earned cards and the money booked are STAT CARDS (ReelCard), not charts.
  PartnersMeetingReel:       ["kinetic_text", "brand_card"],
  ProductPromoReel:          ["screenshot", "kinetic_text", "chart", "brand_card"],
  ListingSectionReel:        ["avatar_pip", "kinetic_text", "brand_card"],
  // ── Fixed-body ──
  CMAReel:                   ["chart", "kinetic_text", "brand_card"],
  AffordabilitySnapshotReel: ["kinetic_text", "property_photos", "brand_card"],
  ListingPresentationSlide:  ["avatar_pip", "kinetic_text", "brand_card"],
  BuyerConsultationSlide:    ["avatar_pip", "kinetic_text", "brand_card"],
}

/**
 * The source mark that proves a composition can render a treatment — what
 * the proof greps the STRIPPED source for (plus the source of any sibling
 * composition it MOUNTS — ListingSectionReel renders through
 * ListingPresentationSlide). `property_photos` and `screenshot` share the
 * image-slot marks: the source cannot tell a listing photo from a Zestimate
 * still — the PLAN carries the asset's origin (published blind spot).
 * `avatar_pip` is either the shared <AvatarPIP> ring or a composition that
 * switches its own presenter box on the plan's `avatar_pip` treatment
 * (AgentTalkingHeadReel's floating card over footage).
 */
export const TREATMENT_MARKS: Record<BodyTreatment, RegExp> = {
  full_avatar:     /<Video[\s\S]{0,120}?src=\{avatarVideoUrl\}|src=\{avatarVideoUrl\}/,
  avatar_pip:      /<AvatarPIP\b|"avatar_pip"/,
  broll:           /<BrollLayer\b/,
  property_photos: /kenBurnsPlan|PropertyImages|imageUrls|photoUrl|heroImageUrl|imageUrl\b|KenBurns/,
  screenshot:      /kenBurnsPlan|PropertyImages|imageUrls|photoUrl|heroImageUrl|imageUrl\b|KenBurns|screenshotUrls/,
  kinetic_text:    /interpolate\(|spring\(/,
  lower_third:     /<LowerThird\b/,
  chart:           /\.\/charts\/|\/charts\/geometry|horizontalBars|[Dd]iagram|HandoffLane|CompsBar|PriceTrendLine|DaysOnMarketBars|AffordabilityDonut/,
  brand_card:      /<EndCard\b|<QrOutroBadge\b|logoUrl|brokerageName|ctaDomain/,
}

// ─────────────────────────────────────────────────────────────────────────────
// § SEGMENTS — the script cut into the purpose's arc
// ─────────────────────────────────────────────────────────────────────────────

export interface ScriptSegment {
  kind: SegmentKind
  text: string
  words: number
}

/**
 * Cut a fitted narration into the purpose's arc: the first sentence is the
 * hook, the last the CTA, the sentence before the CTA the proof (when the arc
 * has one), and the beats share the middle evenly. Fewer sentences than arc
 * slots collapse the arc in order (hook first, then cta, then proof, then
 * beats) — a one-sentence script is one hook. Deterministic; empty → [].
 */
export function segmentScript(script: string | null | undefined, arc: SegmentKind[]): ScriptSegment[] {
  const sentences = spokenSentences(script)
  if (sentences.length === 0) return []
  const mk = (kind: SegmentKind, parts: string[]): ScriptSegment => {
    const text = parts.join(" ")
    return { kind, text, words: spokenWords(text).length }
  }
  const hasHook = arc.includes("hook"), hasCta = arc.includes("cta"), hasProof = arc.includes("proof")
  const beatCount = Math.max(0, arc.filter((k) => k === "beat").length)
  let rest = sentences.slice()
  const hook = hasHook && rest.length > 0 ? [rest.shift() as string] : []
  const cta = hasCta && rest.length > 0 ? [rest.pop() as string] : []
  const proof = hasProof && rest.length > 0 ? [rest.pop() as string] : []
  const out: ScriptSegment[] = []
  if (hook.length) out.push(mk("hook", hook))
  if (beatCount > 0 && rest.length > 0) {
    const n = Math.min(beatCount, rest.length)
    for (let i = 0; i < n; i++) {
      const from = Math.round((i * rest.length) / n), to = Math.round(((i + 1) * rest.length) / n)
      out.push(mk("beat", rest.slice(from, to)))
    }
  } else if (rest.length > 0) {
    // An arc with no beat slot (a single-beat memory chapter, a pure hook/cta)
    // still speaks these sentences — they ride as one beat rather than vanish.
    out.push(mk("beat", rest))
  }
  if (proof.length) out.push(mk("proof", proof))
  if (cta.length) out.push(mk("cta", cta))
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// § ASSETS — what the producer actually has
// ─────────────────────────────────────────────────────────────────────────────

export interface BodyVisualAssets {
  /** An avatar clip is (or will be) rendered for this video. */
  avatarClip: boolean
  brollClips: number
  propertyPhotos: number
  screenshots: number
  /** Chart data is staged (comps, trend, stats). Defaults to whether the
   *  composition can draw a chart at all. */
  chartData?: boolean
}

/** Read the asset inventory off staged input_props — the keys the producers
 *  already stage (brollClips, imageUrls/images/photos, screenshotUrls,
 *  avatarVideoUrl) — plus what the caller knows is coming (an avatar clip the
 *  orchestrator will merge later). */
export function assetsFromProps(props: Record<string, unknown> | null | undefined, opts: { avatarClip?: boolean; compositionId?: string } = {}): BodyVisualAssets {
  const p = props ?? {}
  const arr = (k: string): number => (Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0)
  const screenshots = arr("screenshotUrls")
  // ProductPromoReel's imageUrls ARE screenshot stills (demoStillImageUrls);
  // every other composition's imageUrls/images are listing photos.
  const productImages = opts.compositionId === "ProductPromoReel" ? arr("imageUrls") : 0
  const photos = opts.compositionId === "ProductPromoReel" ? 0 : Math.max(arr("imageUrls"), arr("images"), arr("photos"), arr("photoUrls"))
  const chartKeys = ["comps", "compsSpec", "trend", "stats", "priceTrend", "daysOnMarket", "diagram", "medianPrice", "currentValue", "equity"]
  return {
    avatarClip: opts.avatarClip ?? (typeof p.avatarVideoUrl === "string" && p.avatarVideoUrl.length > 0),
    brollClips: arr("brollClips"),
    propertyPhotos: photos,
    screenshots: screenshots + productImages,
    chartData: chartKeys.some((k) => p[k] !== undefined && p[k] !== null),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE PLAN
// ─────────────────────────────────────────────────────────────────────────────

export interface BodyVisualSegment {
  index: number
  kind: SegmentKind
  treatment: BodyTreatment
  /** Composition-absolute frames. */
  from: number
  durationInFrames: number
  words: number
  text: string
  /** The preference chain that survived the filters — first is the pick. */
  candidates: BodyTreatment[]
  /** Index into the matching asset list (b-roll clip / photo / screenshot)
   *  this segment starts on; the composition cycles from here. */
  assetIndex: number | null
}

export interface BodyVisualPlan {
  compositionId: string
  purpose: VideoPurpose
  host: HostKind
  fps: number
  durationInFrames: number
  intro: AssemblySegment & { treatment: "brand_card" }
  body: AssemblySegment
  outro: AssemblySegment & { treatment: "brand_card" }
  segments: BodyVisualSegment[]
  /** Share of BODY frames the presenter is on screen (full or PiP). */
  avatarShare: number
  fullAvatarShare: number
  bounds: AvatarShareBounds
  withinBounds: boolean
  /** Derived windows — composition-absolute — the layers mount in. */
  brollWindows: AssemblySegment[]
  photoSlots: AssemblySegment[]
  screenshotSlots: AssemblySegment[]
  /** The narration window: captions visible, music ducked. */
  captionWindow: { from: number; to: number }
  musicDuck: { from: number; to: number }
  notes: string[]
}

export interface PlanBodyVisualArgs {
  compositionId: string
  /** The duration plan (lib/video/duration-model.ts) — the body the segments
   *  are cut from. */
  duration: DurationPlan
  /** Pre-cut segments (a producer that already has hook / beats / cta), or
   *  the script to cut. Segments win when both are given. */
  segments?: ScriptSegment[] | null
  script?: string | null
  assets: BodyVisualAssets
  purpose?: VideoPurpose | null
}

function r3(n: number): number { return Math.round(n * 1000) / 1000 }

/**
 * planBodyVisual — PURE. THE computation the director stages and every proof
 * shares. Throws for a composition with no COMPOSITION_TREATMENTS row (a new
 * type must be registered — nothing renders unplanned).
 */
export function planBodyVisual(args: PlanBodyVisualArgs): BodyVisualPlan {
  const { compositionId, duration } = args
  const renderable = COMPOSITION_TREATMENTS[compositionId]
  if (!renderable) {
    throw new Error(`body-visual-model: ${compositionId} has no COMPOSITION_TREATMENTS row — register what it can render before it is planned (lib/video/body-visual-model.ts)`)
  }
  const purpose = args.purpose ?? duration.purpose
  const rule = PURPOSE_BODY_VISUAL_RULES[purpose]
  if (!rule) throw new Error(`body-visual-model: purpose "${purpose}" has no PURPOSE_BODY_VISUAL_RULES row`)
  const host = duration.host
  const notes: string[] = []
  const t = computeAssemblyTimeline({ durationInFrames: duration.durationInFrames, introFrames: duration.introFrames, outroFrames: duration.outroFrames })
  const bodyFrames = t.body.durationInFrames

  // 1. Segments — the producer's own, else the script cut to the arc, else the
  //    arc itself with equal weights (nothing staged: the visuals still tile).
  let segs: ScriptSegment[] = (args.segments ?? []).filter((s) => s && SEGMENT_KINDS.includes(s.kind))
  if (segs.length === 0) segs = segmentScript(args.script, rule.arc)
  if (segs.length === 0) {
    segs = rule.arc.map((kind) => ({ kind, text: "", words: 1 }))
    notes.push(`${compositionId}: no narration staged — the ${purpose} arc (${rule.arc.join("/")}) tiles the body evenly.`)
  }
  const slots = weightedShotSlots(bodyFrames, segs.map((s) => Math.max(1, s.words)))

  // 2. Treatment per segment — preference ∩ allowed ∩ renderable ∩ host ∩ assets.
  const assets = { chartData: renderable.includes("chart"), ...args.assets }
  const hostAllowsAvatar = host === "avatar" && assets.avatarClip
  const available = (tr: BodyTreatment): boolean => {
    const need = ASSET_BOUND[tr]
    if (need === "avatar") return hostAllowsAvatar
    if (need === "broll") return assets.brollClips > 0
    if (need === "photos") return assets.propertyPhotos > 0
    if (need === "screenshots") return assets.screenshots > 0
    if (need === "chart") return assets.chartData !== false
    return true
  }
  const chain = (kind: SegmentKind): BodyTreatment[] => {
    const preferred = rule.prefer[kind].filter((tr) => rule.allowed.includes(tr) && renderable.includes(tr) && available(tr))
    // The universal fallbacks — every composition animates copy and carries
    // a brand tile — so no beat is ever left without a screen.
    for (const fb of ["kinetic_text", "brand_card"] as BodyTreatment[]) {
      if (!preferred.includes(fb) && rule.allowed.includes(fb) && renderable.includes(fb)) preferred.push(fb)
    }
    return preferred
  }
  const counters = { broll: 0, photos: 0, screenshots: 0 }
  const segments: BodyVisualSegment[] = segs.map((s, i) => {
    const candidates = chain(s.kind)
    if (candidates.length === 0) {
      throw new Error(`body-visual-model: ${compositionId}/${purpose} leaves a ${s.kind} segment with NO treatment — the purpose allows [${rule.allowed.join(", ")}], the composition renders [${renderable.join(", ")}]`)
    }
    return { index: i, kind: s.kind, treatment: candidates[0], from: t.body.from + slots[i].from, durationInFrames: slots[i].durationInFrames, words: s.words, text: s.text, candidates, assetIndex: null }
  })

  // 3. Avatar share inside the purpose's bounds (avatar host only). A
  //    voiceover/silent host — or an avatar host whose clip is not coming (an
  //    optional twin not ready) — is judged against NO_AVATAR: the purpose's
  //    presence floor is a rule for the presenter, not a demand on a reel that
  //    has none. A composition that renders ONLY the full-frame presenter (no
  //    <AvatarPIP>) cannot honour a PiP-shaped full-frame cap, so its cap IS
  //    the presence cap: the talking head is that composition's design.
  const share = () => {
    const pres = segments.filter((s) => AVATAR_TREATMENTS.has(s.treatment)).reduce((a, s) => a + s.durationInFrames, 0)
    const full = segments.filter((s) => s.treatment === "full_avatar").reduce((a, s) => a + s.durationInFrames, 0)
    return { avatar: r3(pres / Math.max(1, bodyFrames)), full: r3(full / Math.max(1, bodyFrames)) }
  }
  const fullOnly = renderable.includes("full_avatar") && !renderable.includes("avatar_pip")
  const bounds: AvatarShareBounds = !hostAllowsAvatar
    ? NO_AVATAR
    : fullOnly ? { ...rule.avatarShare, fullMax: Math.max(rule.avatarShare.fullMax, rule.avatarShare.max) } : rule.avatarShare
  if (host === "avatar" && !assets.avatarClip) notes.push(`${compositionId}: avatar-hosted but no avatar clip is coming — planned as a no-presenter reel (photo/monogram fallback in the composition).`)
  if (hostAllowsAvatar) {
    // Too much full frame → move body beats (never the hook/cta) to their next
    // non-full candidate, longest first, until the full-frame cap holds.
    for (const s of [...segments].filter((x) => x.kind === "beat" || x.kind === "proof").sort((a, b) => b.durationInFrames - a.durationInFrames)) {
      if (share().full <= bounds.fullMax) break
      const next = s.candidates.find((c) => c !== "full_avatar")
      if (s.treatment === "full_avatar" && next) { s.treatment = next; notes.push(`${compositionId}: ${s.kind} #${s.index} moved off full frame to ${next} (full-frame cap ${bounds.fullMax}).`) }
    }
    // Too little presence → bring segments back to an avatar treatment, hook
    // and cta first (eye-to-lens at the open and the ask), then beats.
    const order = [...segments].sort((a, b) => (a.kind === "hook" || a.kind === "cta" ? -1 : 0) - (b.kind === "hook" || b.kind === "cta" ? -1 : 0))
    for (const s of order) {
      if (share().avatar >= bounds.min) break
      const av = s.candidates.find((c) => AVATAR_TREATMENTS.has(c) && (c !== "full_avatar" || share().full + s.durationInFrames / bodyFrames <= bounds.fullMax))
      if (!AVATAR_TREATMENTS.has(s.treatment) && av) { s.treatment = av; notes.push(`${compositionId}: ${s.kind} #${s.index} brought back to ${av} (presence floor ${bounds.min}).`) }
    }
    // Too much presence → beats off the avatar entirely, longest first.
    for (const s of [...segments].filter((x) => x.kind === "beat").sort((a, b) => b.durationInFrames - a.durationInFrames)) {
      if (share().avatar <= bounds.max) break
      const off = s.candidates.find((c) => !AVATAR_TREATMENTS.has(c))
      if (AVATAR_TREATMENTS.has(s.treatment) && off) { s.treatment = off; notes.push(`${compositionId}: ${s.kind} #${s.index} cut away to ${off} (presence cap ${bounds.max}).`) }
    }
  }
  // 4. Asset indices — each cutaway segment starts on the next clip/photo/still.
  for (const s of segments) {
    if (s.treatment === "broll" || (s.treatment === "avatar_pip" && compositionId === "AgentTalkingHeadReel" && assets.brollClips > 0)) { s.assetIndex = counters.broll % Math.max(1, assets.brollClips); counters.broll++ }
    else if (s.treatment === "property_photos") { s.assetIndex = counters.photos % Math.max(1, assets.propertyPhotos); counters.photos++ }
    else if (s.treatment === "screenshot") { s.assetIndex = counters.screenshots % Math.max(1, assets.screenshots); counters.screenshots++ }
  }
  const { avatar: avatarShare, full: fullAvatarShare } = share()
  const withinBounds = avatarShare >= bounds.min - 1e-9 && avatarShare <= bounds.max + 1e-9 && fullAvatarShare <= bounds.fullMax + 1e-9
  if (!withinBounds) notes.push(`${compositionId}: avatar share ${avatarShare} (full ${fullAvatarShare}) is outside the ${purpose} bounds [${bounds.min}, ${bounds.max}] / full ≤ ${bounds.fullMax} — the assets on hand could not close it (stage b-roll/photos or an avatar clip).`)
  if (host !== "avatar" && segments.some((s) => AVATAR_TREATMENTS.has(s.treatment))) {
    throw new Error(`body-visual-model: ${compositionId} is ${host}-hosted but a segment resolved to an avatar treatment`)
  }

  const win = (pred: (s: BodyVisualSegment) => boolean): AssemblySegment[] => segments.filter(pred).map((s) => ({ from: s.from, durationInFrames: s.durationInFrames }))
  const bodyTo = t.body.from + bodyFrames
  return {
    compositionId, purpose, host, fps: duration.fps, durationInFrames: t.totalFrames,
    intro: { ...t.intro, treatment: "brand_card" }, body: t.body, outro: { ...t.outro, treatment: "brand_card" },
    segments, avatarShare, fullAvatarShare, bounds, withinBounds,
    brollWindows: win((s) => s.treatment === "broll" || (s.treatment === "avatar_pip" && s.assetIndex !== null && compositionId === "AgentTalkingHeadReel")),
    photoSlots: win((s) => s.treatment === "property_photos"),
    screenshotSlots: win((s) => s.treatment === "screenshot"),
    captionWindow: { from: t.body.from, to: bodyTo },
    musicDuck: { from: t.body.from, to: bodyTo },
    notes,
  }
}

/**
 * Re-fit a staged plan to the duration a composition ACTUALLY renders at
 * (useVideoConfig().durationInFrames) — the plan was cut on an estimate, the
 * render may be sized on D-ID's measurement. Segment weights are their staged
 * frames; bookends come from the ONE registry; treatments are kept. A plan
 * from another composition is refused (null) so a prop pasted across
 * compositions never drives the wrong layout.
 */
export function fitBodyVisualPlan(plan: BodyVisualPlan | null | undefined, compositionId: string, durationInFrames: number): BodyVisualPlan | null {
  if (!plan || plan.compositionId !== compositionId || !Array.isArray(plan.segments) || plan.segments.length === 0) return null
  const { introFrames, outroFrames } = compositionBookends(compositionId)
  const t = computeAssemblyTimeline({ durationInFrames, introFrames, outroFrames })
  if (plan.durationInFrames === t.totalFrames && plan.body.from === t.body.from && plan.body.durationInFrames === t.body.durationInFrames) return plan
  const slots = weightedShotSlots(t.body.durationInFrames, plan.segments.map((s) => Math.max(1, s.durationInFrames)))
  const segments = plan.segments.map((s, i) => ({ ...s, from: t.body.from + slots[i].from, durationInFrames: slots[i].durationInFrames }))
  const win = (pred: (s: BodyVisualSegment) => boolean): AssemblySegment[] => segments.filter(pred).map((s) => ({ from: s.from, durationInFrames: s.durationInFrames }))
  const bodyTo = t.body.from + t.body.durationInFrames
  return {
    ...plan, durationInFrames: t.totalFrames,
    intro: { ...t.intro, treatment: "brand_card" }, body: t.body, outro: { ...t.outro, treatment: "brand_card" },
    segments,
    brollWindows: win((s) => s.treatment === "broll" || (s.treatment === "avatar_pip" && s.assetIndex !== null && compositionId === "AgentTalkingHeadReel")),
    photoSlots: win((s) => s.treatment === "property_photos"),
    screenshotSlots: win((s) => s.treatment === "screenshot"),
    captionWindow: { from: t.body.from, to: bodyTo },
    musicDuck: { from: t.body.from, to: bodyTo },
  }
}

/**
 * The SCENE windows a composition that scripts its own hook + beats (the
 * product promo) cuts from the plan — BODY-RELATIVE frames: the hook from the
 * body's first frame through the hook segment, each beat its segment, the
 * LAST beat extended to the body's end so the spoken CTA lands on the CTA
 * tile. null when the plan has no hook or fewer beats than the composition
 * has text for (the composition then keeps its own even split). PURE.
 */
export function sceneWindowsFromPlan(plan: BodyVisualPlan | null | undefined, bodyFrames: number, beatCount: number): { hook: AssemblySegment; beats: AssemblySegment[] } | null {
  if (!plan || beatCount <= 0) return null
  const hook = plan.segments.find((s) => s.kind === "hook")
  const beats = plan.segments.filter((s) => s.kind === "beat")
  if (!hook || beats.length < beatCount) return null
  const rel = (f: number) => f - plan.body.from
  const hookWin = { from: 0, durationInFrames: Math.max(1, rel(hook.from) + hook.durationInFrames) }
  const beatWins = beats.slice(0, beatCount).map((b, i) => ({
    from: rel(b.from),
    durationInFrames: Math.max(1, i === beatCount - 1 ? bodyFrames - rel(b.from) : b.durationInFrames),
  }))
  return { hook: hookWin, beats: beatWins }
}

/** The segment on screen at a composition-absolute frame (null in the bookends). */
export function segmentAtFrame(plan: BodyVisualPlan, frame: number): BodyVisualSegment | null {
  return plan.segments.find((s) => frame >= s.from && frame < s.from + s.durationInFrames) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// § STAGING — how the plan travels to the render
// ─────────────────────────────────────────────────────────────────────────────

export interface StageBodyVisualArgs {
  compositionId: string
  /** The staged input_props (content + chrome) — the duration plan and the
   *  asset inventory are read off them, exactly as Root.tsx's calculateMetadata
   *  will read the duration. */
  props: Record<string, unknown>
  /** Whether an avatar clip is requested for this render (the orchestrator
   *  merges the URL later; the plan must know now). */
  avatarClip?: boolean
  purpose?: VideoPurpose | null
  /** The narration to cut; defaults to the props' narrationScript / narration
   *  / captionScript (the same keys duration-model reads). */
  script?: string | null
  segments?: ScriptSegment[] | null
}

export type StageBodyVisualResult = { ok: true; plan: BodyVisualPlan } | { ok: false; reason: string }

/** The director's seam: one call, the plan or the reason it cannot exist. */
export function stageBodyVisualPlan(args: StageBodyVisualArgs): StageBodyVisualResult {
  try {
    const props = args.props ?? {}
    const purpose = args.purpose ?? ((props.videoPurpose as VideoPurpose | undefined) && PURPOSE_DURATION_RULES[props.videoPurpose as VideoPurpose] ? (props.videoPurpose as VideoPurpose) : null)
    const duration = planDurationForProps(args.compositionId, props, { purpose })
    if (!COMPOSITION_DURATION_RULES[args.compositionId]) return { ok: false, reason: `${args.compositionId} has no duration rule — nothing to cut a body from` }
    const script = args.script ?? (["narrationScript", "narration", "captionScript"].map((k) => props[k]).find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? null)
    const plan = planBodyVisual({
      compositionId: args.compositionId, duration, purpose,
      segments: args.segments ?? null, script,
      assets: assetsFromProps(props, { avatarClip: args.avatarClip, compositionId: args.compositionId }),
    })
    return { ok: true, plan }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § PiP GEOMETRY — safe areas derived from the frame, never a typed corner
// ─────────────────────────────────────────────────────────────────────────────

export interface SafeInsets { top: number; bottom: number; left: number; right: number }

/**
 * The UI-safe insets for a frame. Vertical (9:16) feeds cover the top ~14 %
 * (username / audio strip) and the bottom ~22 % (caption, actions, progress);
 * horizontal and square frames keep the Remotion layout guidance (≥ 80 px
 * sides / ≥ 100 px top-bottom at 1080 wide, expressed as shares so a 4K frame
 * scales). Sources: ads-video skill ("bottom 20 % covered by UI"),
 * remotion-create/video-layout.md, storimaticstudio.com 2026-01.
 */
export function safeInsets(width: number, height: number): SafeInsets {
  const w = Math.max(1, width), h = Math.max(1, height)
  const vertical = h > w
  return vertical
    ? { top: Math.round(h * 0.14), bottom: Math.round(h * 0.22), left: Math.round(w * 0.06), right: Math.round(w * 0.06) }
    : { top: Math.round(h * 0.09), bottom: Math.round(h * 0.09), left: Math.round(w * 0.05), right: Math.round(w * 0.05) }
}

export type PipCorner = "top-right" | "top-left" | "bottom-right" | "bottom-left"

/** The CSS offsets that put a PiP of `size` px in `corner`, inside the safe
 *  insets, never off the frame. */
export function pipCornerStyle(width: number, height: number, corner: PipCorner, size: number): Partial<Record<"top" | "bottom" | "left" | "right", number>> {
  const s = safeInsets(width, height)
  const clampV = (inset: number) => Math.max(0, Math.min(inset, Math.max(0, height - size)))
  const clampH = (inset: number) => Math.max(0, Math.min(inset, Math.max(0, width - size)))
  switch (corner) {
    case "top-left":     return { top: clampV(s.top), left: clampH(s.left) }
    case "bottom-right": return { bottom: clampV(s.bottom), right: clampH(s.right) }
    case "bottom-left":  return { bottom: clampV(s.bottom), left: clampH(s.left) }
    default:             return { top: clampV(s.top), right: clampH(s.right) }
  }
}

/** True when a box at these offsets sits wholly inside the frame's safe area. */
export function insideSafeArea(width: number, height: number, box: { top?: number; bottom?: number; left?: number; right?: number; width: number; height: number }): boolean {
  const s = safeInsets(width, height)
  const top = box.top ?? (height - (box.bottom ?? 0) - box.height)
  const left = box.left ?? (width - (box.right ?? 0) - box.width)
  return top >= s.top && left >= s.left && top + box.height <= height - s.bottom && left + box.width <= width - s.right
}
