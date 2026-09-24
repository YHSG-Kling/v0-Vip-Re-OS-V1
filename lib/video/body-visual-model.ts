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
 * WAVE 80 (lane 80C, 2026-09-23, owner verbatim): "background visuals also
 * should be included in body plans. if the script is going to need visuals ai
 * agent plans this before sending." "stat cards are visuals." "I don't think
 * you are using broll properly and only certain type of video formats need
 * broll, do your research." "if there is any changes to the registry rule for
 * the purpose allowable autonomous ai can learn." → this module now carries
 *   · `stat_card` and `background` (and `client_footage` — the seller's or the
 *     client's OWN recording on screen, which is neither stock b-roll nor an
 *     AI avatar) in the closed vocabulary; every segment names its BACKGROUND;
 *   · a B-ROLL VERDICT per purpose (BROLL_VERDICTS) with the research behind
 *     it — b-roll is available to a segment ONLY where the verdict admits it;
 *   · ONE dispatch gate (gateVisualPlanForDispatch) every provider door runs
 *     BEFORE it spends: the director's two commission paths, the D-ID avatar
 *     track (lib/video/avatar-track-submit.ts), the outreach avatar dispatcher
 *     (lib/providers/dispatch.ts) and the memory-video render;
 *   · the purpose rules as DATA with a bounded override path
 *     (BodyVisualRuleOverride / checkRuleOverrideBounds / resolvePurposeRule)
 *     the learning loop may apply autonomously and a human may revert
 *     (lib/video/format-learning.ts proposes; lib/video/body-visual-rule-
 *     ledger.ts keeps the ledger and raises the manager signal).
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
 *               the BACKGROUNDS it may paint behind a card or a PiP, its B-ROLL
 *               verdict, the treatments it must never lose (`required`), and
 *               the avatar's share bounds with the research behind them;
 *   segments  → the fitted script is cut into the arc's segments (a producer
 *               may hand the segments directly — ProductPromoReel's hook /
 *               proofs / cta already are; the memory render hands one per
 *               chapter with its MEASURED frames); each segment's spoken words
 *               (or measured frames) are its weight; the body (from
 *               duration-model) is tiled by weight (weightedShotSlots);
 *   treatment → per segment, the FIRST preferred treatment that the purpose
 *               allows ∩ the composition can render (COMPOSITION_TREATMENTS) ∩
 *               the host permits (a voiceover/silent host NEVER gets an avatar
 *               treatment) ∩ the assets exist (no clips → no `broll`; and the
 *               purpose's b-roll VERDICT admits it); then the avatar share is
 *               pulled inside the purpose's bounds; a background is chosen for
 *               every segment that does not fill the frame itself;
 *   gate      → gateVisualPlanForDispatch refuses a missing plan, a segment
 *               with no asset behind it, a treatment the purpose does not
 *               allow, b-roll on a no-b-roll format, and an avatar on a
 *               voiceover host — BEFORE any provider is asked to render;
 *   derived   → b-roll windows, photo/screenshot/stat-card/footage slots, the
 *               caption window and the music duck are READ OFF the segment
 *               plan; intro/outro brand cards come from the registered bookends;
 *   render    → the plan rides input_props.bodyVisualPlan; a composition
 *               re-fits it to the duration it actually renders at
 *               (fitBodyVisualPlan) and mounts each treatment in its window;
 *   new type  → one row in COMPOSITION_TREATMENTS + COMPOSITION_BACKGROUNDS. A
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
 *   · WHICH FORMATS USE B-ROLL (wave 80C, the owner's ask): market updates —
 *     "Keep yourself camera-facing with supporting visuals like charts or
 *     B-roll footage", "quick cutaways or on-screen captions … break up
 *     extended talk-to-camera" (peachgum.ai 2026-04-22); RPR's own how-to
 *     exports the charts AS the b-roll and adds 5-7 s neighbourhood clips "to
 *     cover jump cuts" (blog.narrpr.com 2025-12-02). Neighbourhood guides are
 *     "montages with text overlays" and "drone-first tours with ground-level
 *     b-roll" (peachgum.ai 2026-04-19). Listing videos are the PROPERTY's own
 *     footage or its photos — "photo-to-video AI is now the dominant workflow"
 *     for 80 % of listings (bright-shot.com 2026) — and stock footage of a
 *     different house is misrepresentation; only "if the home is vacant or
 *     exterior-only, add neighborhood b-roll or floor plan overlays"
 *     (peachgum.ai 2026-04-22). Product demos are a "clean screen recording"
 *     (videoeditingcompany.com 2026-09-20). Agent-intro / personal-brand and
 *     client-update videos are talking head with the agent's OWN cutaways
 *     (bright-shot.com 2026 "agent intro"; medeo.app 2026-04-29). Testimonials
 *     are the client's words and face or the home (BAM 2025-06-11 closing-day
 *     reel; realiantphotography.com 2026-07). Legacy / memory films are the
 *     family's own voice over their own photos or an on-camera walk of the
 *     home (People/Yahoo 2026 — "could only be told in their own voices";
 *     lifestoryinterviews.biz "Home Sweet Memories": interview + up to 15
 *     scanned photos; kirkfrancismedia.com Legacy Project: guided on-camera
 *     conversation over photos). Data reels are stat cards: "animate the core
 *     metrics as a clean stat card … a trend arrow overlay" (allesplay.ai
 *     2026); "Only show visual data relevant to your current talking point",
 *     "simple, non-distracting visual data in the corner" (inboundrem.com).
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
 *     `background.color:false` for a TRANSPARENT result — "or false to use
 *     transparent background in-case of webm result format" (D-ID client SDK
 *     ClipConfig / clip.d.ts; docs.d-id.com create-express-avatar); Videos V4
 *     `background: ColorBackground | ExpressiveImageBackground |
 *     TransparentBackground` (docs.d-id.com createv4video); `result_format`
 *     enum mp4 | mov | webm (docs.d-id.com getclip). Remotion: `<Video>` from
 *     @remotion/media decodes a VP9 webm with alpha natively — "No
 *     `transparent` prop is needed when the video is decoded by
 *     @remotion/media" (remotion.dev/docs/videos/transparency);
 *     `<OffthreadVideo transparent>` extracts PNG frames (~40 % slower)
 *     (remotion.dev/docs/offthreadvideo). ElevenLabs v3: no SSML `<break>`;
 *     pauses by `[pause]`, ellipses and punctuation; character timestamps from
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
  COMPOSITION_DURATION_RULES, PURPOSE_DURATION_RULES, compositionBookends, planDurationForProps, spokenSecondsForWords,
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
  "property_photos", // listing / home photos with Ken Burns motion
  "screenshot",      // OS surfaces, dashboards, public property-page stills (Zestimate etc.)
  "kinetic_text",    // animated on-screen copy (bullets, quotes, headlines)
  "stat_card",       // ONE number with its label and delta — "stat cards are visuals" (owner, wave 80)
  "lower_third",     // a name/brokerage strap over any other treatment's frame
  "chart",           // CMA / comps / market animations
  "brand_card",      // intro / outro / logo tile
  "background",      // the ambient backdrop alone (brand gradient, blurred photo, subtle motion) — a beat with nothing but the voice
  "client_footage",  // the client's OWN recording on screen (a seller walking the home, a client testimonial clip) — never generated
] as const
export type BodyTreatment = (typeof BODY_TREATMENTS)[number]

export const AVATAR_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["full_avatar", "avatar_pip"])

/** Treatments that fill the frame themselves — no separate background is chosen for them. */
export const FULL_FRAME_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["full_avatar", "broll", "property_photos", "screenshot", "client_footage", "brand_card"])

/**
 * CONTENT treatments a PiP composition keeps the presenter floating OVER — a
 * stat card, a bullet, a chart, a still, a strap. On a composition that mounts
 * <AvatarPIP> across its panels (MarketUpdateReel's stat cards, the
 * explainer's bullets), a segment planned as `stat_card` still has the person
 * on screen in the corner; the presenter share counts it (segment.presenter
 * says so) and the stat card is the segment's VISUAL, as the owner ruled.
 */
export const PIP_OVERLAYABLE_TREATMENTS: ReadonlySet<BodyTreatment> = new Set<BodyTreatment>(["stat_card", "kinetic_text", "chart", "screenshot", "lower_third", "background"])

/** What is painted BEHIND a card, a PiP or on-screen copy (owner: "background visuals also should be included in body plans"). */
export const BACKGROUND_KINDS = [
  "solid_brand",    // the brand's primary colour, flat
  "brand_gradient", // a radial/linear brand gradient
  "blurred_photo",  // a blurred, darkened property/home photo
  "subtle_motion",  // slow drift / grain / Ken Burns on a still — motion without a subject
] as const
export type BackgroundKind = (typeof BACKGROUND_KINDS)[number]

/** The script's segment kinds — the arc every purpose is written in. */
export const SEGMENT_KINDS = ["hook", "beat", "proof", "cta"] as const
export type SegmentKind = (typeof SEGMENT_KINDS)[number]

/**
 * THE B-ROLL VERDICT per purpose — the research answer to "only certain type
 * of video formats need broll". Read by planBodyVisual (availability) and by
 * the dispatch gate (refusal); a learned override may never move a purpose
 * off `never`.
 */
export const BROLL_VERDICTS = [
  "needed",                       // the format is built on cutaway footage (neighbourhood montage, pre-MLS teaser)
  "optional",                     // cutaways may break up talk-to-camera; the format stands without them
  "own_media_only",               // cutaways must be the client's / the home's OWN media, never stock (brollSource "own")
  "fallback_when_photos_scarce",  // stock footage only when the home has fewer than BROLL_PHOTO_SCARCITY photos
  "never",                        // the format's visuals are something else (photos, screens, cards, the family's own words)
] as const
export type BrollVerdictKind = (typeof BROLL_VERDICTS)[number]

/** Fewer listing photos than this → a listing promo may fall back to stock cutaways (peachgum.ai 2026-04-22: vacant / exterior-only). */
export const BROLL_PHOTO_SCARCITY = 3

/** Treatments that need an ASSET before they can be chosen. */
const ASSET_BOUND: Record<BodyTreatment, "avatar" | "broll" | "photos" | "screenshots" | "chart" | "stats" | "footage" | null> = {
  full_avatar: "avatar", avatar_pip: "avatar", broll: "broll", property_photos: "photos",
  screenshot: "screenshots", chart: "chart", stat_card: "stats", client_footage: "footage",
  kinetic_text: null, lower_third: null, brand_card: null, background: null,
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

export interface BrollVerdict {
  verdict: BrollVerdictKind
  why: string
  sources: string[]
}

export interface PurposeBodyVisualRule {
  /** The segment order the script is written in. */
  arc: SegmentKind[]
  /** The closed set this purpose may show. */
  allowed: BodyTreatment[]
  /** Treatments a learned override may never take out of `prefer` — the purpose's reason to exist on screen. */
  required: BodyTreatment[]
  /** Ordered preference per segment kind; filtered at plan time by the
   *  composition, the host and the assets. */
  prefer: Record<SegmentKind, BodyTreatment[]>
  /** Ordered backgrounds this purpose may paint behind a non-full-frame segment. */
  backgrounds: BackgroundKind[]
  broll: BrollVerdict
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
const SRC_MARKET_BROLL = "peachgum.ai 2026-04-22: camera-facing with charts or B-roll; cutaways break up talk-to-camera. blog.narrpr.com 2025-12: charts exported AS b-roll, 5-7 s neighbourhood clips cover jump cuts"
const SRC_STAT_CARDS = "allesplay.ai 2026: one clean stat card with a trend arrow beside the voice. inboundrem.com: only the data for the current talking point"
const SRC_LISTING_OWN = "bright-shot.com 2026: photo-to-video is the dominant listing workflow; the reel is a re-edit of the property's own beats. peachgum.ai 2026-04-22: neighbourhood b-roll only when vacant / exterior-only"
const SRC_NEIGHBORHOOD = "peachgum.ai 2026-04-19: neighbourhood guides are montages with text overlays; drone-first with ground-level b-roll"
const SRC_MEMORY = "People/Yahoo 2026 (Lori Edwards, 56-year home): told in the family's own voices. lifestoryinterviews.biz Home Sweet Memories: guided interview + up to 15 scanned photos. kirkfrancismedia.com Legacy Project: on-camera conversation over photos"
const SRC_TESTIMONIAL = "nowbam.com 2025-06 closing-day / seller-in-the-video reels: the client's own moments, never stock. realiantphotography.com 2026-07: Heart & Home — the home carries the feeling"

const BROLL_NEVER = (why: string, sources: string[]): BrollVerdict => ({ verdict: "never", why, sources })

export const PURPOSE_BODY_VISUAL_RULES: Record<VideoPurpose, PurposeBodyVisualRule> = {
  welcome: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "broll", "lower_third", "kinetic_text", "background", "brand_card"],
    required: ["full_avatar"],
    prefer: { hook: ["full_avatar"], beat: ["full_avatar", "avatar_pip", "broll"], proof: ["avatar_pip", "broll"], cta: ["full_avatar", "brand_card"] },
    backgrounds: ["solid_brand", "subtle_motion", "brand_gradient"],
    broll: { verdict: "optional", why: "An agent-intro is a talking head; a cutaway may cover a cut or float the agent over footage for one beat, never replace the person.", sources: ["bright-shot.com 2026: the 60 s agent intro answers who / who for / why trust — on camera", SRC_MARKET_BROLL] },
    avatarShare: PERSONAL,
    why: "A first personal touch: the person IS the video. The hook and the ask are eye-to-lens; a middle beat may float over cutaway footage so the frame moves.",
    sources: [SRC_ONCAMERA, "clearrec.app 2026-05: look at the lens at the hook and the ask; PiP in between"],
  },
  seller_update: {
    arc: ["hook", "beat", "beat", "proof", "cta"],
    allowed: ["full_avatar", "avatar_pip", "broll", "property_photos", "stat_card", "chart", "lower_third", "kinetic_text", "background", "brand_card"],
    required: ["stat_card"],
    prefer: { hook: ["full_avatar"], beat: ["avatar_pip", "full_avatar", "property_photos", "broll"], proof: ["stat_card", "chart", "avatar_pip", "kinetic_text"], cta: ["full_avatar", "brand_card"] },
    backgrounds: ["blurred_photo", "solid_brand", "subtle_motion"],
    broll: { verdict: "own_media_only", why: "The weekly word to a listing client floats the agent over THAT home's own photos — the most personal cutaway there is; stock footage of another house behind a seller's update misrepresents.", sources: [SRC_LISTING_OWN, "lib/agents/seller-update-reel-producer.ts: the seller's OWN listing photos behind the floating avatar"] },
    avatarShare: { min: 0.5, max: 1, fullMax: 0.7 },
    why: "The weekly word to a listing client: the agent speaks, but showings and feedback are numbers the client should SEE — the proof beat is a stat card, the body beats float the agent over the home.",
    sources: [SRC_TALKING_HEAD, SRC_ONCAMERA, SRC_STAT_CARDS],
  },
  anniversary_equity: {
    arc: ["hook", "beat", "beat", "proof", "cta"],
    allowed: ["avatar_pip", "stat_card", "chart", "kinetic_text", "background", "brand_card"],
    required: ["stat_card"],
    prefer: { hook: ["avatar_pip", "stat_card", "kinetic_text"], beat: ["stat_card", "chart", "kinetic_text"], proof: ["stat_card", "chart", "kinetic_text"], cta: ["avatar_pip", "brand_card"] },
    backgrounds: ["solid_brand", "brand_gradient"],
    broll: BROLL_NEVER("The number is the star; a cutaway behind a dollar figure is noise.", [SRC_STAT_CARDS]),
    avatarShare: { min: 0.2, max: 1, fullMax: 0 },
    why: "The number is the star (EquityReportReel's stat cards + trend); the presenter rides in the corner so the estimate qualifier is spoken by a person, never full frame over a dollar figure.",
    sources: [SRC_OVERLAYS, "finish-spec.ts EquityReportReel: circle_pip, the avatar is OPTIONAL (m218)"],
  },
  listing_promo: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["property_photos", "broll", "stat_card", "kinetic_text", "background", "brand_card"],
    required: ["property_photos"],
    prefer: { hook: ["property_photos", "broll", "kinetic_text"], beat: ["property_photos", "broll", "kinetic_text"], proof: ["stat_card", "kinetic_text", "property_photos"], cta: ["kinetic_text", "brand_card"] },
    backgrounds: ["blurred_photo", "brand_gradient", "subtle_motion", "solid_brand"],
    broll: { verdict: "fallback_when_photos_scarce", why: `The house is the star and its own photos are the footage; stock cutaways are admitted only when the home has fewer than ${BROLL_PHOTO_SCARCITY} photos (a pre-MLS teaser, a vacant / exterior-only listing).`, sources: [SRC_LISTING_OWN] },
    avatarShare: NO_AVATAR,
    why: "OWNER RULE: the HOUSE is the star. Photos with the status sign under the cloned-voice narration; the facts card is a stat card and the CTA is on-screen copy. No talking head competes with the home.",
    sources: [SRC_STILLS, "finish-spec.ts MARKETING: presenter none"],
  },
  cma: {
    arc: ["beat", "beat", "beat", "beat"],
    allowed: ["chart", "stat_card", "kinetic_text", "background", "brand_card"],
    required: ["chart"],
    prefer: { hook: ["chart"], beat: ["chart", "stat_card", "kinetic_text"], proof: ["chart"], cta: ["brand_card", "kinetic_text"] },
    backgrounds: ["brand_gradient", "solid_brand"],
    broll: BROLL_NEVER("Four data slides the seller reads; there is nothing for footage to illustrate.", [SRC_STAT_CARDS]),
    avatarShare: NO_AVATAR,
    why: "Four data slides the seller reads at their own pace — a silent chart reel (finish-spec captions:false).",
    sources: ["lib/video/cma-reel-orchestrator.ts: holds charts, not narration"],
  },
  market_update: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["avatar_pip", "stat_card", "chart", "kinetic_text", "broll", "background", "brand_card"],
    required: ["stat_card"],
    prefer: { hook: ["avatar_pip", "stat_card", "kinetic_text"], beat: ["stat_card", "avatar_pip", "chart", "kinetic_text", "broll"], proof: ["stat_card", "chart", "kinetic_text"], cta: ["avatar_pip", "brand_card"] },
    backgrounds: ["solid_brand", "brand_gradient", "blurred_photo"],
    broll: { verdict: "optional", why: "Charts and stat cards are the b-roll of a market update; a neighbourhood clip may cover a cut behind the presenter.", sources: [SRC_MARKET_BROLL] },
    avatarShare: PIP_HOSTED,
    why: "OWNER RULE: explainers and market updates present with the CIRCLE avatar — the stats stay the star as stat cards, the person rides as a floating presenter.",
    sources: [SRC_TALKING_HEAD, SRC_STAT_CARDS, "finish-spec.ts MarketUpdateReel: circle_pip"],
  },
  explainer: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "kinetic_text", "stat_card", "chart", "screenshot", "broll", "background", "brand_card"],
    required: ["kinetic_text"],
    prefer: { hook: ["avatar_pip", "full_avatar", "kinetic_text"], beat: ["avatar_pip", "kinetic_text", "screenshot", "broll", "full_avatar"], proof: ["chart", "stat_card", "screenshot", "kinetic_text"], cta: ["avatar_pip", "full_avatar", "brand_card"] },
    backgrounds: ["solid_brand", "brand_gradient", "subtle_motion"],
    broll: { verdict: "optional", why: "Teaching content reads as text over footage; the bullet is the content and footage may sit behind it.", sources: [SRC_TALKING_HEAD] },
    avatarShare: PIP_HOSTED,
    why: "Teach one concept: the bullet or diagram is what the viewer reads while the presenter talks in the corner; a full-frame head past a third of the body is a lecture, not a reel. On a composition with no PiP (TeammateExplainerReel) the presenter carries the beats full frame — the full-frame cap is lifted to the presence cap there, by construction (planBodyVisual).",
    sources: [SRC_TALKING_HEAD, SRC_OVERLAYS],
  },
  lead_reel: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "kinetic_text", "screenshot", "background", "brand_card"],
    required: ["kinetic_text"],
    prefer: { hook: ["avatar_pip", "full_avatar"], beat: ["avatar_pip", "kinetic_text", "screenshot"], proof: ["kinetic_text", "screenshot"], cta: ["avatar_pip", "full_avatar", "brand_card"] },
    backgrounds: ["solid_brand", "brand_gradient"],
    broll: BROLL_NEVER("A 1:1 intro to one lead is eye-to-lens with their situation as bullets; stock footage makes it look like an ad.", ["clearrec.app 2026-05: look at the lens at the hook and the ask", SRC_ONCAMERA]),
    avatarShare: PIP_HOSTED,
    why: "A 1:1 intro to a qualified lead on the explainer composition: their situation as on-screen bullets, the agent present in the corner throughout.",
    sources: [SRC_ONCAMERA, "stackbd.com 2026 benchmark: first touch 30-45 s"],
  },
  product_demo: {
    arc: ["hook", "beat", "beat", "beat", "proof", "cta"],
    allowed: ["screenshot", "kinetic_text", "stat_card", "chart", "avatar_pip", "background", "brand_card"],
    required: ["screenshot"],
    prefer: { hook: ["screenshot", "kinetic_text"], beat: ["screenshot", "kinetic_text"], proof: ["screenshot", "stat_card", "chart", "kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    backgrounds: ["brand_gradient", "subtle_motion"],
    broll: BROLL_NEVER("A demo is a clean screen recording that starts at the moment of value; footage of anything else is the login page.", [SRC_DEMO, SRC_DEMO_PIP]),
    avatarShare: { min: 0, max: 0.3, fullMax: 0 },
    why: "Start at the moment of value: the OS surface itself (screenshot stills from lib/assets/screenshot-capture.ts) behind each beat; a marketing demo skips the webcam, a sales demo may add a small PiP.",
    sources: [SRC_DEMO, SRC_DEMO_PIP],
  },
  memory: {
    arc: ["beat"],
    allowed: ["client_footage", "property_photos", "kinetic_text", "background", "brand_card"],
    required: ["client_footage", "property_photos"],
    prefer: { hook: ["client_footage", "property_photos"], beat: ["client_footage", "property_photos", "kinetic_text"], proof: ["client_footage", "property_photos"], cta: ["brand_card"] },
    backgrounds: ["blurred_photo", "brand_gradient", "solid_brand"],
    broll: BROLL_NEVER("The family's own footage or their own photos under their own voice — stock footage in a memory film is somebody else's house.", [SRC_MEMORY]),
    avatarShare: NO_AVATAR,
    why: "OWNER (wave 80): either the seller ON SCREEN walking the home with the story (seller_walkthrough → client_footage), or the seller's uploaded AUDIO over the home's photos (seller_audio_photos → property_photos with Ken Burns, the words as captions). Nobody's face fronts somebody else's memory and no voice is cloned (lib/video/memory-video-gate.ts).",
    sources: [SRC_MEMORY, "lib/video/memory-video-gate.ts: never model-authored; finish-spec MemoryVideoReel presenter none"],
  },
  partners_meeting: {
    arc: ["hook", "beat", "beat", "proof", "cta"],
    allowed: ["stat_card", "chart", "kinetic_text", "background", "brand_card"],
    required: ["stat_card"],
    prefer: { hook: ["kinetic_text"], beat: ["stat_card", "chart", "kinetic_text"], proof: ["stat_card", "chart", "kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    backgrounds: ["brand_gradient", "solid_brand"],
    broll: BROLL_NEVER("An internal recap is earned cards and money booked; footage adds nothing a partner can read.", [SRC_STAT_CARDS]),
    avatarShare: NO_AVATAR,
    why: "The AI team's recap to the brokerage's own people: earned cards and the money booked are stat cards; the floating photo chip is chrome, not a presenter.",
    sources: ["finish-spec.ts REPORT_INTERNAL: circle_pip photo, no QR"],
  },
  geo_reel: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["full_avatar", "avatar_pip", "broll", "property_photos", "screenshot", "kinetic_text", "stat_card", "chart", "background", "brand_card", "client_footage"],
    required: [],
    prefer: { hook: ["property_photos", "broll", "kinetic_text"], beat: ["property_photos", "broll", "kinetic_text"], proof: ["stat_card", "chart", "kinetic_text"], cta: ["kinetic_text", "brand_card"] },
    backgrounds: ["solid_brand", "brand_gradient", "blurred_photo", "subtle_motion"],
    broll: { verdict: "optional", why: "A publication surface inherits the published reel's own plan and verdict.", sources: ["scripts/video-type-matrix-simulator.ts §surfaces"] },
    avatarShare: { min: 0, max: 1, fullMax: 0.85 },
    why: "A PUBLICATION SURFACE over finished reels of any purpose — it inherits the published reel's own plan; the allowed set is the union.",
    sources: ["scripts/video-type-matrix-simulator.ts §surfaces: geo reel is a surface, not a composition"],
  },
  newsletter: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["kinetic_text", "stat_card", "screenshot", "chart", "background", "brand_card"],
    required: ["kinetic_text"],
    prefer: { hook: ["kinetic_text"], beat: ["kinetic_text", "stat_card", "screenshot"], proof: ["stat_card", "chart", "kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    backgrounds: ["solid_brand", "brand_gradient"],
    broll: BROLL_NEVER("A digest's headlines are section cards over the brand backdrop; the market beat is a stat card.", [SRC_OVERLAYS, SRC_STAT_CARDS]),
    avatarShare: NO_AVATAR,
    why: "The digest's headlines are the content: three section cards on the brand backdrop, the market beat as a stat card.",
    sources: [SRC_OVERLAYS],
  },
  photo_walkthrough: {
    arc: ["hook", "beat", "beat", "beat", "cta"],
    allowed: ["property_photos", "kinetic_text", "background", "brand_card"],
    required: ["property_photos"],
    prefer: { hook: ["property_photos"], beat: ["property_photos"], proof: ["property_photos"], cta: ["brand_card", "kinetic_text"] },
    backgrounds: ["brand_gradient", "subtle_motion"],
    broll: BROLL_NEVER("The photos ARE the video; a cutaway would cover the very thing being toured.", [SRC_STILLS, "app/api/cron/poll-did-videos: b-roll never rides a walkthrough"]),
    avatarShare: NO_AVATAR,
    why: "The photos ARE the video (Ken Burns, 3-5 s per room); the narration tours them.",
    sources: [SRC_STILLS, "dunphy.typito.com 2026-07: 3-5 s per room"],
  },
  listing_presentation_section: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["avatar_pip", "kinetic_text", "stat_card", "chart", "screenshot", "background", "brand_card"],
    required: ["kinetic_text"],
    prefer: { hook: ["avatar_pip", "kinetic_text"], beat: ["avatar_pip", "kinetic_text", "stat_card", "chart", "screenshot"], proof: ["stat_card", "chart", "kinetic_text"], cta: ["avatar_pip", "kinetic_text"] },
    backgrounds: ["solid_brand"],
    broll: BROLL_NEVER("A narrated slide's copy is the content.", [SRC_OVERLAYS]),
    avatarShare: { min: 0.5, max: 1, fullMax: 0 },
    why: "A narrated slide: the slide's copy is the content, the presenter is the corner (owner rule: material stays the star).",
    sources: ["finish-spec.ts ListingPresentationSlide / BuyerConsultationSlide: circle_pip"],
  },
  testimonial: {
    arc: ["hook", "beat", "proof", "cta"],
    allowed: ["kinetic_text", "client_footage", "property_photos", "broll", "background", "brand_card"],
    required: ["kinetic_text"],
    prefer: { hook: ["kinetic_text"], beat: ["client_footage", "property_photos", "kinetic_text", "broll"], proof: ["kinetic_text"], cta: ["brand_card", "kinetic_text"] },
    backgrounds: ["solid_brand", "blurred_photo", "brand_gradient"],
    broll: { verdict: "own_media_only", why: "Social proof is the client's own moment — their words, their clip, their home; stock footage under a quote is an ad.", sources: [SRC_TESTIMONIAL, "ads-video skill: UGC-style testimonial — the quote is the frame"] },
    avatarShare: NO_AVATAR,
    why: "The client's words on screen, verbatim, as the proof; their own clip or the home behind the middle beat.",
    sources: [SRC_OVERLAYS, SRC_TESTIMONIAL],
  },
  neighborhood_spotlight: {
    arc: ["hook", "beat", "beat", "cta"],
    allowed: ["broll", "kinetic_text", "stat_card", "chart", "background", "brand_card"],
    required: ["broll"],
    prefer: { hook: ["broll", "kinetic_text"], beat: ["broll", "kinetic_text"], proof: ["stat_card", "chart", "kinetic_text"], cta: ["kinetic_text", "brand_card"] },
    backgrounds: ["subtle_motion", "solid_brand"],
    broll: { verdict: "needed", why: "A neighbourhood guide IS a montage — streets, parks, coffee — with text overlays; without footage there is no spotlight.", sources: [SRC_NEIGHBORHOOD, "finish-spec.ts NeighborhoodSpotlightReel: broll required"] },
    avatarShare: NO_AVATAR,
    why: "Lifestyle footage under two data highlights — discovery content for people who do not know the agent yet.",
    sources: [SRC_NEIGHBORHOOD, "finish-spec.ts NeighborhoodSpotlightReel: broll required"],
  },
  buyer_match: {
    arc: ["beat", "beat", "beat"],
    allowed: ["kinetic_text", "stat_card", "property_photos", "background", "brand_card"],
    required: ["kinetic_text"],
    prefer: { hook: ["kinetic_text"], beat: ["kinetic_text", "property_photos", "stat_card"], proof: ["stat_card", "kinetic_text"], cta: ["brand_card"] },
    backgrounds: ["solid_brand", "brand_gradient"],
    broll: BROLL_NEVER("Three listing tiles a budget buys — on-screen copy over the listings' own photos.", [SRC_LISTING_OWN]),
    avatarShare: NO_AVATAR,
    why: "Three listing tiles a monthly budget buys — on-screen copy, no narration.",
    sources: ["dunphy.typito.com 2026-07: listing-card motion 5-15 s"],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// § RULE OVERRIDES — the purpose rules as DATA the learning loop may adjust
// ─────────────────────────────────────────────────────────────────────────────
//
// OWNER (wave 80): "if there is any changes to the registry rule for the
// purpose allowable autonomous ai can learn." The rule table above is the
// expert default; a BodyVisualRuleOverride is one bounded change on top of it
// that lib/video/format-learning.ts may PROPOSE from real outcomes and
// lib/video/body-visual-rule-ledger.ts applies autonomously, logs, and can
// revert. THE BOUNDS are enforced HERE (checkRuleOverrideBounds), in the pure
// module, so neither the proposer nor the ledger can widen them:
//   · an override REORDERS a preference or picks a preferred background —
//     it never adds a treatment the purpose does not already allow;
//   · it never adds `broll` to a purpose whose verdict is `never`;
//   · it never puts an avatar treatment on a purpose with no presenter;
//   · it never removes a `required` treatment from the preference list
//     (reordering keeps every entry; nothing is dropped).

export interface BodyVisualRuleOverride {
  id: string
  purpose: VideoPurpose
  change:
    | { kind: "prefer_treatment"; segmentKind: SegmentKind; treatment: BodyTreatment }
    | { kind: "prefer_background"; background: BackgroundKind }
  why: string
  sample: number
  source: "autonomous" | "human"
  appliedAt: string
  revertedAt?: string | null
}

export type RuleOverrideBoundsVerdict = { ok: true } | { ok: false; reason: string }

/** PURE — is this override inside the bounds a learned change may move? */
export function checkRuleOverrideBounds(override: BodyVisualRuleOverride, base: PurposeBodyVisualRule | undefined = PURPOSE_BODY_VISUAL_RULES[override.purpose]): RuleOverrideBoundsVerdict {
  if (!base) return { ok: false, reason: `purpose "${override.purpose}" has no PURPOSE_BODY_VISUAL_RULES row` }
  const c = override.change
  if (c.kind === "prefer_treatment") {
    if (!(SEGMENT_KINDS as readonly string[]).includes(c.segmentKind)) return { ok: false, reason: `unknown segment kind "${c.segmentKind}"` }
    if (!(BODY_TREATMENTS as readonly string[]).includes(c.treatment)) return { ok: false, reason: `unknown treatment "${c.treatment}"` }
    if (!base.allowed.includes(c.treatment)) return { ok: false, reason: `${override.purpose} does not allow ${c.treatment} — a learned change may reorder, never widen the allowed set` }
    if (c.treatment === "broll" && base.broll.verdict === "never") return { ok: false, reason: `${override.purpose} is a no-b-roll format (verdict never) — b-roll cannot be learned into it` }
    if (AVATAR_TREATMENTS.has(c.treatment) && base.avatarShare.max <= 0) return { ok: false, reason: `${override.purpose} has no presenter (avatar share max 0) — an avatar treatment cannot be learned into it` }
    return { ok: true }
  }
  if (c.kind === "prefer_background") {
    if (!(BACKGROUND_KINDS as readonly string[]).includes(c.background)) return { ok: false, reason: `unknown background "${c.background}"` }
    if (!base.backgrounds.includes(c.background)) return { ok: false, reason: `${override.purpose} does not allow the ${c.background} background` }
    return { ok: true }
  }
  return { ok: false, reason: "unknown override kind" }
}

/** PURE — a single override applied to a rule (assumes the bounds hold). Reorders; never drops. */
function applyRuleOverride(rule: PurposeBodyVisualRule, o: BodyVisualRuleOverride): PurposeBodyVisualRule {
  const c = o.change
  if (c.kind === "prefer_treatment") {
    const cur = rule.prefer[c.segmentKind]
    const next = [c.treatment, ...cur.filter((t) => t !== c.treatment)]
    return { ...rule, prefer: { ...rule.prefer, [c.segmentKind]: next } }
  }
  return { ...rule, backgrounds: [c.background, ...rule.backgrounds.filter((b) => b !== c.background)] }
}

/**
 * PURE — the rule for a purpose with the LIVE overrides applied, in the order
 * they were applied. Reverted overrides and any that fail the bounds are
 * skipped (belt and braces: a ledger row cannot smuggle a change past the
 * bounds even if it was written by hand). Every `required` treatment of the
 * base rule is still present in every preference list it started in.
 */
export function resolvePurposeRule(purpose: VideoPurpose, overrides?: readonly BodyVisualRuleOverride[] | null): PurposeBodyVisualRule {
  const base = PURPOSE_BODY_VISUAL_RULES[purpose]
  if (!base || !overrides || overrides.length === 0) return base
  const live = overrides
    .filter((o) => o.purpose === purpose && !o.revertedAt && checkRuleOverrideBounds(o, base).ok)
    .sort((a, b) => (a.appliedAt < b.appliedAt ? -1 : a.appliedAt > b.appliedAt ? 1 : 0))
  return live.reduce((r, o) => applyRuleOverride(r, o), base)
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
  // Three STAT CARDS with deltas (StatCard) — stat cards, not a chart.
  MarketUpdateReel:      ["avatar_pip", "stat_card", "kinetic_text", "brand_card"],
  EquityReportReel:      ["avatar_pip", "stat_card", "kinetic_text", "chart", "brand_card"],
  AgentExplainerReel:    ["avatar_pip", "kinetic_text", "brand_card"],
  ExplainerAnimReel:     ["avatar_pip", "chart", "kinetic_text", "brand_card"],
  TeammateExplainerReel: ["full_avatar", "kinetic_text", "lower_third", "brand_card"],
  // ── Voiceover-hosted ──
  // Wave 80C: the seller's own recording (client_footage, seller_walkthrough)
  // or the home's photos under the seller's own audio (property_photos,
  // seller_audio_photos) — the words stay on screen as captions.
  MemoryVideoReel:           ["client_footage", "property_photos", "kinetic_text", "brand_card"],
  // The facts strip (price / beds / baths) is a stat card.
  JustListedReel:            ["property_photos", "stat_card", "kinetic_text", "brand_card"],
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
  PartnersMeetingReel:       ["stat_card", "kinetic_text", "brand_card"],
  ProductPromoReel:          ["screenshot", "kinetic_text", "chart", "brand_card"],
  ListingSectionReel:        ["avatar_pip", "kinetic_text", "brand_card"],
  // ── Fixed-body ──
  CMAReel:                   ["chart", "kinetic_text", "brand_card"],
  AffordabilitySnapshotReel: ["kinetic_text", "property_photos", "brand_card"],
  ListingPresentationSlide:  ["avatar_pip", "kinetic_text", "brand_card"],
  BuyerConsultationSlide:    ["avatar_pip", "kinetic_text", "brand_card"],
}

/**
 * The BACKGROUNDS each composition can paint behind a card / PiP / copy —
 * proven against BACKGROUND_MARKS in the stripped source the same way the
 * treatments are. Every composition paints at least one.
 */
export const COMPOSITION_BACKGROUNDS: Record<string, BackgroundKind[]> = {
  AgentTalkingHeadReel:      ["solid_brand", "subtle_motion"],
  // Wave 81C — the three PiP reels mount remotion/components/SegmentBackdrop.tsx
  // behind their panels and switch per segment (the mark is the mount).
  MarketUpdateReel:          ["solid_brand", "brand_gradient", "subtle_motion"],
  EquityReportReel:          ["solid_brand", "brand_gradient", "subtle_motion"],
  AgentExplainerReel:        ["solid_brand", "brand_gradient", "subtle_motion"],
  ExplainerAnimReel:         ["brand_gradient"],
  TeammateExplainerReel:     ["solid_brand"],
  MemoryVideoReel:           ["blurred_photo", "brand_gradient", "solid_brand"],
  JustListedReel:            ["brand_gradient", "solid_brand"],
  JustListedReelSquare:      ["brand_gradient", "subtle_motion", "solid_brand"],
  JustListedReelHorizontal:  ["solid_brand"],
  JustSoldReelSquare:        ["brand_gradient", "solid_brand"],
  ComingSoonReel:            ["blurred_photo", "subtle_motion", "solid_brand"],
  OpenHouseAnnounceReel:     ["solid_brand"],
  // The bottom gradient lives in the KenBurnsPhoto survivor (wave 80C); the reel's own paint is motion over a brand fill.
  PhotoWalkthroughReel:      ["subtle_motion", "solid_brand"],
  NeighborhoodSpotlightReel: ["subtle_motion", "solid_brand"],
  TestimonialReel:           ["solid_brand"],
  NewsletterDigestVideo:     ["solid_brand"],
  PartnersMeetingReel:       ["brand_gradient", "solid_brand"],
  ProductPromoReel:          ["brand_gradient", "subtle_motion"],
  ListingSectionReel:        ["solid_brand"],
  CMAReel:                   ["brand_gradient"],
  AffordabilitySnapshotReel: ["solid_brand"],
  ListingPresentationSlide:  ["solid_brand"],
  BuyerConsultationSlide:    ["solid_brand"],
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
  stat_card:       /StatCard|ReelCard|<Stat\b|stat\.value|fmtUsd\(|cards\.map/,
  lower_third:     /<LowerThird\b/,
  chart:           /\.\/charts\/|\/charts\/geometry|horizontalBars|[Dd]iagram|HandoffLane|CompsBar|PriceTrendLine|DaysOnMarketBars|AffordabilityDonut/,
  brand_card:      /<EndCard\b|<QrOutroBadge\b|logoUrl|brokerageName|ctaDomain/,
  background:      /gradient\(|blur\(|backgroundColor: brand(Colors)?\.primaryColor/,
  client_footage:  /clientFootageUrl|chapter\.videoUrl|sellerVideoUrl/,
}

/** The source mark that proves a composition can paint a background kind. */
/** A composition that mounts the ONE per-segment backdrop (wave 81C,
 *  remotion/components/SegmentBackdrop.tsx) can paint every kind the backdrop
 *  paints: a gradient and a slow drift always; a blurred photo only when it
 *  hands the backdrop a photo, so that mark stays the composition's own. */
export const BACKGROUND_MARKS: Record<BackgroundKind, RegExp> = {
  solid_brand:    /backgroundColor: brand(Colors)?\.primaryColor/,
  brand_gradient: /gradient\(|<SegmentBackdrop\b/,
  blurred_photo:  /blur\(/,
  subtle_motion:  /handheldDrift|filmGrain|kenBurns|KenBurns|<SegmentBackdrop\b/,
}

// ─────────────────────────────────────────────────────────────────────────────
// § SEGMENTS — the script cut into the purpose's arc
// ─────────────────────────────────────────────────────────────────────────────

export interface ScriptSegment {
  kind: SegmentKind
  text: string
  words: number
  /** A producer whose clips are MEASURED (the memory render's chapters) hands
   *  the frames; they weight the tiler instead of the words. */
  frames?: number
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
  /** Where the b-roll came from — the producer's own media (a listing's photos,
   *  the client's clip) or the stock library. Unknown reads as stock. */
  brollSource?: "own" | "stock" | null
  propertyPhotos: number
  screenshots: number
  /** Numbers staged as cards (stats[], cards[], a price / value / equity figure). */
  statCards?: number
  /** The client's own recordings (memory chapters with a video, a testimonial clip). */
  clientFootage?: number
  /** Chart data is staged (comps, trend, stats). Defaults to whether the
   *  composition can draw a chart at all. */
  chartData?: boolean
}

/** Read the asset inventory off staged input_props — the keys the producers
 *  already stage (brollClips, imageUrls/images/photos/photoUrls, screenshotUrls,
 *  stats/cards, chapters[].videoUrl, avatarVideoUrl) — plus what the caller
 *  knows is coming (an avatar clip the orchestrator will merge later). */
export function assetsFromProps(props: Record<string, unknown> | null | undefined, opts: { avatarClip?: boolean; compositionId?: string } = {}): BodyVisualAssets {
  const p = props ?? {}
  const arr = (k: string): number => (Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0)
  const screenshots = arr("screenshotUrls")
  // ProductPromoReel's imageUrls ARE screenshot stills (demoStillImageUrls);
  // every other composition's imageUrls/images are listing photos.
  const productImages = opts.compositionId === "ProductPromoReel" ? arr("imageUrls") : 0
  const photos = opts.compositionId === "ProductPromoReel" ? 0 : Math.max(arr("imageUrls"), arr("images"), arr("photos"), arr("photoUrls"))
  const chartKeys = ["comps", "compsSpec", "trend", "stats", "priceTrend", "daysOnMarket", "diagram", "medianPrice", "currentValue", "equity"]
  const statFigureKeys = ["price", "estimatedValue", "estimatedEquity", "appreciation", "medianPrice", "currentValue", "equity", "marketBeat"]
  const chapters = Array.isArray(p.chapters) ? (p.chapters as Array<Record<string, unknown>>) : []
  const footage = chapters.filter((c) => c && typeof c.videoUrl === "string" && (c.videoUrl as string).length > 0).length + arr("clientFootageUrls")
  const brollSource = p.brollSource === "own" ? "own" : p.brollSource === "stock" ? "stock" : null
  return {
    avatarClip: opts.avatarClip ?? (typeof p.avatarVideoUrl === "string" && p.avatarVideoUrl.length > 0),
    brollClips: arr("brollClips"),
    brollSource,
    propertyPhotos: photos,
    screenshots: screenshots + productImages,
    statCards: arr("stats") + arr("cards") + (statFigureKeys.some((k) => p[k] !== undefined && p[k] !== null) ? 1 : 0),
    clientFootage: footage,
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
  /** What is painted behind the treatment; "none" when the treatment fills the frame. */
  background: BackgroundKind | "none"
  /** Where the presenter is during this segment: filling the frame, floating in
   *  a corner over the content (an avatar_pip segment, or a content segment on
   *  a composition that keeps its PiP mounted), or off screen. */
  presenter: "full" | "pip" | "none"
  /** Composition-absolute frames. */
  from: number
  durationInFrames: number
  words: number
  text: string
  /** The preference chain that survived the filters — first is the pick. */
  candidates: BodyTreatment[]
  /** Index into the matching asset list (b-roll clip / photo / screenshot /
   *  stat card / footage clip) this segment starts on; the composition cycles from here. */
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
  /** The purpose's b-roll verdict this plan was cut under. */
  brollVerdict: BrollVerdictKind
  /** Derived windows — composition-absolute — the layers mount in. */
  brollWindows: AssemblySegment[]
  photoSlots: AssemblySegment[]
  screenshotSlots: AssemblySegment[]
  statCardSlots: AssemblySegment[]
  clientFootageSlots: AssemblySegment[]
  /** The narration window: captions visible, music ducked. */
  captionWindow: { from: number; to: number }
  musicDuck: { from: number; to: number }
  /** Ids of the rule overrides that shaped this plan (audit trail). */
  overrideIds: string[]
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
  /** Live learned overrides for this tenant (lib/video/body-visual-rule-ledger.ts). */
  overrides?: readonly BodyVisualRuleOverride[] | null
}

function r3(n: number): number { return Math.round(n * 1000) / 1000 }

/** PURE — may this purpose show b-roll with these assets? The verdict decides; a note says why not. */
export function brollAvailable(rule: PurposeBodyVisualRule, assets: BodyVisualAssets): { ok: boolean; why: string | null } {
  if (assets.brollClips <= 0) return { ok: false, why: null }
  switch (rule.broll.verdict) {
    case "never": return { ok: false, why: `b-roll is not a visual for this purpose (verdict never: ${rule.broll.why})` }
    case "own_media_only": return assets.brollSource === "own" ? { ok: true, why: null } : { ok: false, why: `only the client's / the home's own media may cut away here (verdict own_media_only) — the staged clips are ${assets.brollSource ?? "of unknown origin"}` }
    case "fallback_when_photos_scarce": return assets.propertyPhotos < BROLL_PHOTO_SCARCITY ? { ok: true, why: null } : { ok: false, why: `${assets.propertyPhotos} photos on hand (≥ ${BROLL_PHOTO_SCARCITY}) — the home's own photos are the footage; stock cutaways are the scarce-photo fallback only` }
    default: return { ok: true, why: null }
  }
}

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
  const paintable = COMPOSITION_BACKGROUNDS[compositionId] ?? []
  const purpose = args.purpose ?? duration.purpose
  if (!PURPOSE_BODY_VISUAL_RULES[purpose]) throw new Error(`body-visual-model: purpose "${purpose}" has no PURPOSE_BODY_VISUAL_RULES row`)
  const rule = resolvePurposeRule(purpose, args.overrides)
  const overrideIds = (args.overrides ?? []).filter((o) => o.purpose === purpose && !o.revertedAt && checkRuleOverrideBounds(o).ok).map((o) => o.id)
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
  // Measured frames weight the tiler when every segment carries them (the
  // memory render's chapters); otherwise the spoken words do.
  const measured = segs.every((s) => typeof s.frames === "number" && s.frames > 0)
  const slots = weightedShotSlots(bodyFrames, segs.map((s) => Math.max(1, measured ? (s.frames as number) : s.words)))

  // 2. Treatment per segment — preference ∩ allowed ∩ renderable ∩ host ∩ assets ∩ verdict.
  const assets: BodyVisualAssets = { chartData: renderable.includes("chart"), statCards: 0, clientFootage: 0, ...args.assets }
  const hostAllowsAvatar = host === "avatar" && assets.avatarClip
  const broll = brollAvailable(rule, assets)
  if (broll.why) notes.push(`${compositionId}: ${broll.why}`)
  const available = (tr: BodyTreatment): boolean => {
    const need = ASSET_BOUND[tr]
    if (need === "avatar") return hostAllowsAvatar
    if (need === "broll") return broll.ok
    if (need === "photos") return assets.propertyPhotos > 0
    if (need === "screenshots") return assets.screenshots > 0
    if (need === "chart") return assets.chartData !== false
    if (need === "stats") return (assets.statCards ?? 0) > 0
    if (need === "footage") return (assets.clientFootage ?? 0) > 0
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
  // The background for a non-full-frame segment: the purpose's first allowed
  // background the composition can paint (a blurred photo needs a photo).
  const backgroundFor = (tr: BodyTreatment): BackgroundKind | "none" => {
    if (FULL_FRAME_TREATMENTS.has(tr)) return "none"
    const pick = rule.backgrounds.find((b) => paintable.includes(b) && (b !== "blurred_photo" || assets.propertyPhotos > 0))
    return pick ?? (paintable[0] ?? "none")
  }
  const counters = { broll: 0, photos: 0, screenshots: 0, stats: 0, footage: 0 }
  // The presenter's place during a segment — see PIP_OVERLAYABLE_TREATMENTS.
  const pipMounted = hostAllowsAvatar && renderable.includes("avatar_pip")
  const presenterFor = (tr: BodyTreatment): BodyVisualSegment["presenter"] =>
    tr === "full_avatar" ? "full" : tr === "avatar_pip" ? "pip" : pipMounted && PIP_OVERLAYABLE_TREATMENTS.has(tr) ? "pip" : "none"
  const segments: BodyVisualSegment[] = segs.map((s, i) => {
    const candidates = chain(s.kind)
    if (candidates.length === 0) {
      throw new Error(`body-visual-model: ${compositionId}/${purpose} leaves a ${s.kind} segment with NO treatment — the purpose allows [${rule.allowed.join(", ")}], the composition renders [${renderable.join(", ")}]`)
    }
    return { index: i, kind: s.kind, treatment: candidates[0], background: backgroundFor(candidates[0]), presenter: presenterFor(candidates[0]), from: t.body.from + slots[i].from, durationInFrames: slots[i].durationInFrames, words: s.words, text: s.text, candidates, assetIndex: null }
  })

  // 3. Avatar share inside the purpose's bounds (avatar host only). A
  //    voiceover/silent host — or an avatar host whose clip is not coming (an
  //    optional twin not ready) — is judged against NO_AVATAR: the purpose's
  //    presence floor is a rule for the presenter, not a demand on a reel that
  //    has none. A composition that renders ONLY the full-frame presenter (no
  //    <AvatarPIP>) cannot honour a PiP-shaped full-frame cap, so its cap IS
  //    the presence cap: the talking head is that composition's design.
  //    PRESENCE counts every segment the presenter is on screen for — an
  //    avatar treatment, or content the composition keeps its PiP over.
  const share = () => {
    const pres = segments.filter((s) => presenterFor(s.treatment) !== "none").reduce((a, s) => a + s.durationInFrames, 0)
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
      if (presenterFor(s.treatment) === "none" && av) { s.treatment = av; notes.push(`${compositionId}: ${s.kind} #${s.index} brought back to ${av} (presence floor ${bounds.min}).`) }
    }
    // Too much presence → beats off the avatar entirely, longest first.
    for (const s of [...segments].filter((x) => x.kind === "beat").sort((a, b) => b.durationInFrames - a.durationInFrames)) {
      if (share().avatar <= bounds.max) break
      const off = s.candidates.find((c) => presenterFor(c) === "none")
      if (presenterFor(s.treatment) !== "none" && off) { s.treatment = off; notes.push(`${compositionId}: ${s.kind} #${s.index} cut away to ${off} (presence cap ${bounds.max}).`) }
    }
  }
  // 4. Backgrounds and the presenter follow the final treatment; asset indices —
  //    each cutaway / card segment starts on the next clip / photo / still / card / recording.
  for (const s of segments) {
    s.background = backgroundFor(s.treatment)
    s.presenter = presenterFor(s.treatment)
    if (s.treatment === "broll" || (s.treatment === "avatar_pip" && compositionId === "AgentTalkingHeadReel" && broll.ok)) { s.assetIndex = counters.broll % Math.max(1, assets.brollClips); counters.broll++ }
    else if (s.treatment === "avatar_pip") { s.assetIndex = null }
    else if (s.treatment === "property_photos") { s.assetIndex = counters.photos % Math.max(1, assets.propertyPhotos); counters.photos++ }
    else if (s.treatment === "screenshot") { s.assetIndex = counters.screenshots % Math.max(1, assets.screenshots); counters.screenshots++ }
    else if (s.treatment === "stat_card") { s.assetIndex = counters.stats % Math.max(1, assets.statCards ?? 1); counters.stats++ }
    else if (s.treatment === "client_footage") { s.assetIndex = counters.footage % Math.max(1, assets.clientFootage ?? 1); counters.footage++ }
  }
  const { avatar: avatarShare, full: fullAvatarShare } = share()
  const withinBounds = avatarShare >= bounds.min - 1e-9 && avatarShare <= bounds.max + 1e-9 && fullAvatarShare <= bounds.fullMax + 1e-9
  if (!withinBounds) notes.push(`${compositionId}: avatar share ${avatarShare} (full ${fullAvatarShare}) is outside the ${purpose} bounds [${bounds.min}, ${bounds.max}] / full ≤ ${bounds.fullMax} — the assets on hand could not close it (stage b-roll/photos or an avatar clip).`)
  if (host !== "avatar" && segments.some((s) => AVATAR_TREATMENTS.has(s.treatment))) {
    throw new Error(`body-visual-model: ${compositionId} is ${host}-hosted but a segment resolved to an avatar treatment`)
  }

  return {
    compositionId, purpose, host, fps: duration.fps, durationInFrames: t.totalFrames,
    intro: { ...t.intro, treatment: "brand_card" }, body: t.body, outro: { ...t.outro, treatment: "brand_card" },
    segments, avatarShare, fullAvatarShare, bounds, withinBounds, brollVerdict: rule.broll.verdict,
    ...derivedWindows(segments, compositionId, t.body),
    overrideIds,
    notes,
  }
}

/** Does this segment put FOOTAGE on screen — a cutaway, or the talking-head reel's floating card over footage? ONE predicate for the windows and the gate. PURE. */
export function segmentUsesBroll(s: Pick<BodyVisualSegment, "treatment" | "assetIndex">, compositionId: string): boolean {
  return s.treatment === "broll" || (s.treatment === "avatar_pip" && s.assetIndex !== null && compositionId === "AgentTalkingHeadReel")
}

/** The windows every consumer reads — derived from the segments, one place. */
function derivedWindows(segments: BodyVisualSegment[], compositionId: string, body: AssemblySegment) {
  const win = (pred: (s: BodyVisualSegment) => boolean): AssemblySegment[] => segments.filter(pred).map((s) => ({ from: s.from, durationInFrames: s.durationInFrames }))
  const bodyTo = body.from + body.durationInFrames
  return {
    brollWindows: win((s) => segmentUsesBroll(s, compositionId)),
    photoSlots: win((s) => s.treatment === "property_photos"),
    screenshotSlots: win((s) => s.treatment === "screenshot"),
    statCardSlots: win((s) => s.treatment === "stat_card"),
    clientFootageSlots: win((s) => s.treatment === "client_footage"),
    captionWindow: { from: body.from, to: bodyTo },
    musicDuck: { from: body.from, to: bodyTo },
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
  return {
    ...plan, durationInFrames: t.totalFrames,
    intro: { ...t.intro, treatment: "brand_card" }, body: t.body, outro: { ...t.outro, treatment: "brand_card" },
    segments,
    ...derivedWindows(segments, compositionId, t.body),
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

/**
 * The PANEL windows a PiP composition with N fixed panels (AgentExplainerReel's
 * three bullets, MarketUpdateReel's / EquityReportReel's three stats) cuts from
 * the plan — BODY-RELATIVE, tiling [0, bodyFrames) exactly: panel i opens on
 * the plan's i-th CONTENT segment (a beat or the proof — the equity reel's
 * third stat IS its proof); the first panel absorbs the hook before it, the
 * last absorbs any further content and the CTA after it. null when the plan
 * has fewer content segments than panels (the composition keeps its own
 * split). PURE.
 */
export function panelWindowsFromPlan(plan: BodyVisualPlan | null | undefined, bodyFrames: number, panelCount: number): AssemblySegment[] | null {
  if (!plan || panelCount <= 0 || !Number.isFinite(bodyFrames) || bodyFrames <= 0) return null
  const beats = plan.segments.filter((s) => s.kind === "beat" || s.kind === "proof")
  if (beats.length < panelCount) return null
  const rel = (f: number) => Math.max(0, Math.min(bodyFrames, f - plan.body.from))
  const bounds = [0, ...beats.slice(1, panelCount).map((b) => rel(b.from)), bodyFrames]
  const out: AssemblySegment[] = []
  for (let i = 0; i < panelCount; i++) {
    const from = Math.min(bounds[i], bounds[i + 1] - 1)
    const to = i === panelCount - 1 ? bodyFrames : bounds[i + 1]
    out.push({ from: Math.max(0, from), durationInFrames: Math.max(1, to - Math.max(0, from)) })
  }
  // Monotonic and exact: a plan whose beats collapsed into the same frame
  // still yields ≥1-frame panels; the last panel ends at the body's end.
  let cursor = 0
  for (const w of out) { w.from = cursor; w.durationInFrames = Math.max(1, w.durationInFrames); cursor += w.durationInFrames }
  const overshoot = cursor - bodyFrames
  if (overshoot > 0) out[out.length - 1].durationInFrames = Math.max(1, out[out.length - 1].durationInFrames - overshoot)
  else if (overshoot < 0) out[out.length - 1].durationInFrames -= overshoot
  return out
}

/** The segment on screen at a composition-absolute frame (null in the bookends). */
export function segmentAtFrame(plan: BodyVisualPlan, frame: number): BodyVisualSegment | null {
  return plan.segments.find((s) => frame >= s.from && frame < s.from + s.durationInFrames) ?? null
}

/**
 * PHOTO SLOTS INSIDE ONE SEGMENT — the photos assigned to a property_photos
 * segment tile its window through the ONE tiler (no hand timing). Photos are
 * spread across the plan's photo segments in order: the j-th photo segment
 * takes photos [⌊j·N/n⌋, ⌊(j+1)·N/n⌋), at least one, cycling when there are
 * fewer photos than segments. PURE.
 */
export function photoSlotsForSegment(plan: BodyVisualPlan, segmentIndex: number, totalPhotos: number): Array<AssemblySegment & { photoIndex: number }> {
  const photoSegs = plan.segments.filter((s) => s.treatment === "property_photos")
  const j = photoSegs.findIndex((s) => s.index === segmentIndex)
  const seg = plan.segments[segmentIndex]
  if (j < 0 || !seg || totalPhotos <= 0) return []
  const n = photoSegs.length
  let start = Math.floor((j * totalPhotos) / n), end = Math.floor(((j + 1) * totalPhotos) / n)
  if (end <= start) { start = j % totalPhotos; end = start + 1 }
  const indices = Array.from({ length: end - start }, (_, k) => (start + k) % totalPhotos)
  const slots = weightedShotSlots(seg.durationInFrames, indices.map(() => 1))
  return slots.map((s, k) => ({ from: seg.from + s.from, durationInFrames: s.durationInFrames, photoIndex: indices[k] }))
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE DISPATCH GATE — plan BEFORE send (owner: "if the script is going to
//   need visuals ai agent plans this before sending")
// ─────────────────────────────────────────────────────────────────────────────

export type VisualPlanGateResult = { ok: true } | { ok: false; reason: string; missing: string[] }

/**
 * gateVisualPlanForDispatch — PURE, THE one gate every provider door runs
 * before it spends (D-ID, ElevenLabs, a Remotion render row). It refuses:
 *   · no plan / an empty plan             — body_visual_plan_missing / _empty
 *   · a treatment with no asset behind it — asset_missing:<treatment>
 *   · a treatment the purpose disallows   — treatment_not_allowed:<treatment>
 *   · b-roll on a no-b-roll format        — broll_forbidden:<purpose>
 *   · non-own b-roll on an own-media-only format — broll_not_own_media
 *   · a background the purpose disallows  — background_not_allowed:<kind>
 *   · an avatar on a voiceover/silent host — avatar_on_<host>_host
 * The same overrides the plan was cut under must be passed, or a learned
 * preference reads as a violation of the base rule.
 */
export function gateVisualPlanForDispatch(plan: BodyVisualPlan | null | undefined, assets: BodyVisualAssets, opts: { overrides?: readonly BodyVisualRuleOverride[] | null } = {}): VisualPlanGateResult {
  const missing: string[] = []
  if (!plan) return { ok: false, reason: "body visual plan missing — the visuals must be planned before anything is sent to a provider (lib/video/body-visual-model.ts stageBodyVisualPlan)", missing: ["body_visual_plan_missing"] }
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) return { ok: false, reason: `${plan.compositionId}: the body visual plan has no segments`, missing: ["body_visual_plan_empty"] }
  const rule = PURPOSE_BODY_VISUAL_RULES[plan.purpose] ? resolvePurposeRule(plan.purpose, opts.overrides) : null
  if (!rule) return { ok: false, reason: `purpose "${plan.purpose}" has no PURPOSE_BODY_VISUAL_RULES row`, missing: ["purpose_rule_missing"] }
  const a: BodyVisualAssets = { statCards: 0, clientFootage: 0, ...assets }
  const has = (tr: BodyTreatment): boolean => {
    const need = ASSET_BOUND[tr]
    if (need === "avatar") return a.avatarClip
    if (need === "broll") return a.brollClips > 0
    if (need === "photos") return a.propertyPhotos > 0
    if (need === "screenshots") return a.screenshots > 0
    if (need === "chart") return a.chartData !== false
    if (need === "stats") return (a.statCards ?? 0) > 0
    if (need === "footage") return (a.clientFootage ?? 0) > 0
    return true
  }
  const seen = new Set<string>()
  const add = (m: string) => { if (!seen.has(m)) { seen.add(m); missing.push(m) } }
  for (const s of plan.segments) {
    if (!(BODY_TREATMENTS as readonly string[]).includes(s.treatment)) { add(`unknown_treatment:${s.treatment}`); continue }
    if (!has(s.treatment)) add(`asset_missing:${s.treatment}`)
    if (!rule.allowed.includes(s.treatment)) add(`treatment_not_allowed:${s.treatment}`)
    if (segmentUsesBroll(s, plan.compositionId)) {
      if (rule.broll.verdict === "never") add(`broll_forbidden:${plan.purpose}`)
      else if (rule.broll.verdict === "own_media_only" && a.brollSource !== "own") add("broll_not_own_media")
      else if (rule.broll.verdict === "fallback_when_photos_scarce" && a.propertyPhotos >= BROLL_PHOTO_SCARCITY) add("broll_not_scarce_fallback")
      if (a.brollClips <= 0) add("asset_missing:broll")
    }
    if (s.background && s.background !== "none" && !rule.backgrounds.includes(s.background)) add(`background_not_allowed:${s.background}`)
    if (AVATAR_TREATMENTS.has(s.treatment) && plan.host !== "avatar") add(`avatar_on_${plan.host}_host`)
  }
  if (missing.length > 0) return { ok: false, reason: `${plan.compositionId}/${plan.purpose}: the body visual plan cannot be dispatched — ${missing.join(", ")}`, missing }
  return { ok: true }
}

/** The marker id of a plan for a bare D-ID talking head with no Remotion composition (the outreach dispatcher). */
export const BARE_TALKING_HEAD = "bare_talking_head" as const

/**
 * The plan for a BARE talking head — lib/providers/dispatch.ts's outreach
 * avatar video, which has no composition: one full-frame presenter for the
 * whole spoken script, no bookends, no background. It exists so that door
 * runs the SAME gate as every other one instead of being exempt. PURE.
 */
export function bareTalkingHeadPlan(script: string | null | undefined, opts: { fps?: number; purpose?: VideoPurpose } = {}): BodyVisualPlan {
  const fps = Math.max(1, opts.fps ?? 30)
  const purpose = opts.purpose ?? "welcome"
  const words = spokenWords(script ?? "").length
  const frames = Math.max(1, Math.round(spokenSecondsForWords(Math.max(1, words), "avatar") * fps))
  const body = { from: 0, durationInFrames: frames }
  const segments: BodyVisualSegment[] = words > 0
    ? [{ index: 0, kind: "beat", treatment: "full_avatar", background: "none", presenter: "full", from: 0, durationInFrames: frames, words, text: (script ?? "").trim(), candidates: ["full_avatar"], assetIndex: null }]
    : []
  return {
    compositionId: BARE_TALKING_HEAD, purpose, host: "avatar", fps, durationInFrames: frames,
    intro: { from: 0, durationInFrames: 0, treatment: "brand_card" }, body, outro: { from: frames, durationInFrames: 0, treatment: "brand_card" },
    segments, avatarShare: segments.length ? 1 : 0, fullAvatarShare: segments.length ? 1 : 0, bounds: PURPOSE_BODY_VISUAL_RULES[purpose].avatarShare, withinBounds: true,
    brollVerdict: PURPOSE_BODY_VISUAL_RULES[purpose].broll.verdict,
    ...derivedWindows(segments, BARE_TALKING_HEAD, body),
    overrideIds: [], notes: segments.length ? [] : ["no spoken script — nothing to plan"],
  }
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
  overrides?: readonly BodyVisualRuleOverride[] | null
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
      overrides: args.overrides ?? null,
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

/** Does the plan put the presenter in a corner anywhere (the D-ID request should be a keyed/transparent clip)? PURE. */
export function planWantsKeyedPresenter(plan: BodyVisualPlan | null | undefined): boolean {
  return !!plan && plan.segments.some((s) => s.treatment === "avatar_pip")
}

/**
 * The audit stamp a producer writes beside the row (video_metadata.body_visual
 * on ai_video_projects; the usage ledger's metadata on the outreach dispatch):
 * what was on screen, under which verdict, shaped by which learned overrides.
 * lib/video/format-learning.ts reads it back as the learning dimension. PURE.
 */
export interface BodyVisualStamp {
  composition: string
  purpose: VideoPurpose
  treatments: BodyTreatment[]
  backgrounds: Array<BackgroundKind | "none">
  /** The first content beat's treatment — the cell the learner scores. */
  beat_treatment: BodyTreatment | null
  broll_verdict: BrollVerdictKind
  override_ids: string[]
}
export function bodyVisualStamp(plan: BodyVisualPlan): BodyVisualStamp {
  const beat = plan.segments.find((s) => s.kind === "beat") ?? plan.segments[0] ?? null
  return {
    composition: plan.compositionId, purpose: plan.purpose,
    treatments: plan.segments.map((s) => s.treatment), backgrounds: plan.segments.map((s) => s.background),
    beat_treatment: beat ? beat.treatment : null, broll_verdict: plan.brollVerdict, override_ids: plan.overrideIds,
  }
}
