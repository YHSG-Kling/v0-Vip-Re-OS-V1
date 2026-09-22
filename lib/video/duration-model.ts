/**
 * lib/video/duration-model.ts
 *
 * THE PURPOSE-DRIVEN DURATION MODEL — the ONE place a video's length comes
 * from (§6). OWNER RULING (wave 78, 2026-09-22, verbatim): "you hardcoded the
 * length of the video body for each video, what happens with any new videos
 * and not sure if that is the best practice because the video needs to be
 * long enough to achieve the reason for making the video."
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * Every composition under remotion/ carried a hand-written body length
 * (`const BODY = 10 * FPS`, `STAT = 4 * FPS`, a FRAMES table) that summed to a
 * fixed `durationInFrames` in Root.tsx, and lib/video/narration-window.ts
 * mirrored six of those bodies in a second hand table (NARRATION_WINDOW_FRAMES).
 * The SCRIPT was then cut to fit the frames: a welcome video got 8 speakable
 * seconds / 20 words because AgentTalkingHeadReel's author once typed 10s.
 * A new composition inherited nothing — it needed a new literal, a new table
 * row and a new proof pin, and nothing said what its length was FOR.
 *
 * ── THE RULE NOW ────────────────────────────────────────────────────────────
 *   purpose  → a target RANGE (min / ideal / max seconds of BODY, i.e. the
 *              narration window between the brand bookends) with the research
 *              behind it (PURPOSE_DURATION_RULES);
 *   host     → a words-per-minute PACE (voiceover vs avatar);
 *   window   → purpose × pace × the existing NARRATION_HEADROOM = the WORD
 *              BUDGET the writer targets (purposeWordWindow / purposeBudgetFor);
 *   script   → the writer targets the ideal, is held to [min, max] (over max is
 *              trimmed at a sentence boundary by fitNarrationToBudget; under
 *              min is a REPORTED shortfall the directive asks the writer to
 *              close — never silence);
 *   body     → COMPUTED from the fitted narration's seconds (measured from the
 *              ElevenLabs alignment or D-ID's own duration when we have it,
 *              estimated at the host pace otherwise) — planCompositionDuration;
 *   duration → bookends + body, capped by the composition's REGISTERED
 *              duration_frames (composition-geometry.ts is now the CAP and
 *              aspect source, never the body length) and by the provider caps;
 *   Remotion → `calculateMetadata` on every narration-driven <Composition>
 *              (remotion/Root.tsx → durationMetadata) reads the staged props and
 *              returns that durationInFrames; the component derives its body
 *              from useVideoConfig().durationInFrames through the ONE split
 *              helper (lib/video/assembly-timeline.ts computeAssemblyTimeline),
 *              so b-roll windows, ken-burns slots, PIP windows, caption
 *              visibility and the music duck all follow the computed body.
 *   new type → a row in COMPOSITION_DURATION_RULES (purpose + host + bookends).
 *              scripts/video-duration-model-guard.ts fails when a registered
 *              moving composition has no row, so nothing ships unsized.
 *
 * ── RESEARCH (Exa web_search_exa, 2026-09-22) ───────────────────────────────
 * Real-estate surfaces (dunphy.typito.com "How long should a real estate
 * video be? By surface and by moment", 2026-07-15; peachgum.ai "Real Estate
 * Video Length: The Sweet Spot For Every Platform", 2026-04-22; reel-e.ai
 * "Real Estate Video Length", 2026-03-09; listingclip.com "Real Estate Video
 * Marketing for TikTok, Instagram Reels & YouTube Shorts in 2026", 2026-05-07;
 * blog.kristamashore.com 2026-06-04):
 *   · Social scroll (Reels/TikTok/Shorts): 15–30 s holds completion on Reels
 *     ("longer than 30 seconds and completion rate drops sharply"); TikTok's
 *     real-estate sweet spot 30–60 s, "videos over 90 seconds see steep
 *     drop-off"; new-listing tease 15–20 s; open-house reminder 20–30 s; paid
 *     ads under 15 s.
 *   · Email follow-up to a buyer list: 30–60 s ("lean-in but not fully
 *     committed"); photo-based videos under 45 s social, under 2 min on a
 *     listing page; 8–15 photos ≈ 30–60 s.
 *   · Listing-page / full tour: 60–90 s ("3–5 seconds per room"); 1–2 min for
 *     a standard walkthrough; 3–7 min only for premium listings.
 *   · Market update: "here's what the market looked like this week in 45
 *     seconds" performs consistently; short-form market stats 30–90 s.
 * Personal 1:1 video (sendspark.com "Personalized Video Email" 2026-07-06 and
 * "Video Length Guide for B2B Sales Teams" 2026-04-15; stackbd.com "Video
 * Prospecting ROI: 2026 Benchmark Report", 50,000 videos, 2026-03-01;
 * rimodreamlabs.ai "How Long Should a Product Demo Video Be? 2026 Data",
 * 2026-05-05; blings.io personalized-video statistics 2026-04-12):
 *   · First-touch / welcome: 30–45 s optimal, under 60 acceptable, "above 90
 *     seconds watch-through drops sharply" (Stack BD: a 50 % watch-rate drop
 *     past 90 s; HubSpot 2024: attention peaks at 30–60 s).
 *   · Check-in / update to an existing client: ~60 s; post-conversation
 *     follow-up 60–90 s; "casual updates 45 seconds to 2 minutes".
 *   · Onboarding / welcome to a customer: 60–90 s, under 2 min (70–85 %
 *     completion under 2 min; 60 % gone by the 2-minute mark).
 *   · Explainer: 60–90 s (53 % retention under 90 s; whatastory.agency
 *     2026-07-22: 74 % retention through the 60-second mark when kept under
 *     90 s).
 *   · Product demo: 60–90 s outcome-led cut for cold/homepage; 2–4 min only
 *     mid-funnel; "60 % of viewers drop off after the two-minute mark".
 *   · Testimonial: 1–2 min B2B decision stage; social 15–30 s.
 *   · Internal recap for a captive team: employees "are paid to watch" — up to
 *     ~5 min single-topic, but engagement drops sharply past 2 min.
 * Avatar delivery pace (geratools.com "AI Avatar & Lip-Sync Spec Builder",
 * 2026-06-05: "spoken pace averages about 130–150 words per minute for clear
 * delivery… natural (around 135 wpm)"; "keep clips under roughly 90 seconds —
 * attention drops fast on talking-heads").
 * Provider caps (d-id.com/faqs: "the video length is limited to 5 min" for
 * Studio and API; D-ID Videos V4 OpenAPI: text script 3–40,000 characters;
 * lib/video/reel-voiceover.ts: the ElevenLabs synthesis cap of 2,400
 * characters, now VOICEOVER_MAX_SCRIPT_CHARS below).
 *
 * PURE. No I/O, no React, no Remotion, no "@/" alias (remotion/Root.tsx and
 * the compositions import this into the Remotion webpack bundle, which
 * resolves no alias — every import here is RELATIVE, like script-structure.ts).
 */
import { COMPOSITION_GEOMETRY, compositionSeconds, geometryFor, type RegisteredGeometry } from "../remotion/composition-geometry"
import { computeAssemblyTimeline } from "./assembly-timeline"
import {
  NARRATION_HEADROOM, WORDS_PER_MINUTE, spokenWords, type NarrationBudget,
} from "./script-structure"
import { memoryVideoDurationFrames, type MemoryVideoTimelineProps } from "./memory-video-composition"

// ─────────────────────────────────────────────────────────────────────────────
// § PURPOSES — the reason a video exists, and how long that reason takes
// ─────────────────────────────────────────────────────────────────────────────

/** The owner's own list (wave 77 matrix) plus the compositions it did not
 *  name. ONE spelling per purpose (§6). */
export type VideoPurpose =
  | "welcome"
  | "anniversary_equity"
  | "listing_promo"
  | "cma"
  | "market_update"
  | "seller_update"
  | "explainer"
  | "product_demo"
  | "memory"
  | "partners_meeting"
  | "lead_reel"
  | "geo_reel"
  | "newsletter"
  | "photo_walkthrough"
  | "listing_presentation_section"
  | "testimonial"
  | "neighborhood_spotlight"
  | "buyer_match"

export type HostKind = "voiceover" | "avatar" | "silent"

export interface PurposeDurationRule {
  /** Seconds of BODY (the narration window between the bookends). */
  minSeconds: number
  idealSeconds: number
  maxSeconds: number
  /** What the length is FOR — the reason a viewer keeps watching. */
  why: string
  /** The research the range rests on (see the header). */
  sources: string[]
}

export const PURPOSE_DURATION_RULES: Record<VideoPurpose, PurposeDurationRule> = {
  welcome: {
    minSeconds: 20, idealSeconds: 35, maxSeconds: 60,
    why: "A first personal touch after assignment: greet by name, one specific thing about their situation, one next step. Cold-video attention peaks at 30-45 s and halves past 90 s.",
    sources: ["sendspark.com/resources/personalized-video-email (2026-07): first touch under 45 s, 30-45 optimal", "stackbd.com 2026 benchmark (50k videos): 30-45 s sweet spot, 50% watch-rate drop past 90 s"],
  },
  anniversary_equity: {
    minSeconds: 25, idealSeconds: 40, maxSeconds: 75,
    why: "A past client's yearly equity update: the number, what it means, the estimate qualifier, one invitation. A check-in to an existing relationship earns about a minute.",
    sources: ["sendspark.com video-length guide (2026-04): customer check-in ~60 s, post-conversation follow-up 60-90 s", "blings.io 2026: personalized data video holds 54% completion in email"],
  },
  listing_promo: {
    minSeconds: 12, idealSeconds: 20, maxSeconds: 45,
    why: "A just-listed / just-sold / open-house / coming-soon scroll-stopper: hook, the house, the fact, the CTA. Reels completion drops sharply past 30 s; TikTok tolerates 30-60.",
    sources: ["dunphy.typito.com (2026-07): social scroll 15-30 s, new-listing tease 15-20 s, open-house reminder 20-30 s", "listingclip.com (2026-05): TikTok real-estate sweet spot 30-60 s, steep drop-off past 90 s", "reel-e.ai (2026-03): 30-60 s standard showcase, paid ads under 15 s"],
  },
  cma: {
    minSeconds: 15, idealSeconds: 20, maxSeconds: 60,
    why: "Four data slides (trend, comps, days on market, monthly cost) a seller reads at their own pace; a silent chart reel, sized by its slides, not by narration.",
    sources: ["dunphy.typito.com (2026-07): email follow-up 30-60 s", "peachgum.ai (2026-04): 30-60 s for engagement, 1-3 min highlights on listing pages"],
  },
  market_update: {
    minSeconds: 20, idealSeconds: 40, maxSeconds: 75,
    why: "Three stats with the agent's take: what moved, why it matters to this reader, what to do. 'The market this week in 45 seconds' is the format that gets reshared.",
    sources: ["listingclip.com (2026-05): quick market-update takes in 45 s perform consistently", "blog.kristamashore.com (2026-06): short-form market stats 30-90 s"],
  },
  seller_update: {
    minSeconds: 25, idealSeconds: 45, maxSeconds: 90,
    why: "The weekly word to a listing client: showings, feedback, what changes next week. An update to someone already in a relationship earns 45 s to a minute and a half.",
    sources: ["sendspark.com video-length guide (2026-04): casual updates 45 s-2 min; 60-90 s once the relationship exists", "rimodreamlabs.ai (2026-05): post-call follow-up 60-90 s"],
  },
  explainer: {
    minSeconds: 30, idealSeconds: 60, maxSeconds: 90,
    why: "Teach one concept with three beats and a next step. 60-90 s holds the argument; talking-head attention falls off past ~90 s.",
    sources: ["sendspark.com (2026-04): explainers 60-90 s, 53% retention under 90 s", "whatastory.agency (2026-07): 74% retention through the 60-s mark when under 90 s", "geratools.com (2026-06): keep talking-head clips under ~90 s"],
  },
  product_demo: {
    minSeconds: 45, idealSeconds: 75, maxSeconds: 120,
    why: "The platform's own promo: problem, the AI team, one result, CTA. 60-90 s outcome-led for a cold viewer; 60% drop off after two minutes.",
    sources: ["rimodreamlabs.ai (2026-05): 60-90 s cut for homepage/cold outreach; 2-4 min only mid-funnel", "sendspark.com (2026-04): demos 2-5 min but 60% drop-off after the 2-minute mark"],
  },
  memory: {
    // Voiceover host (lane 78D's MemoryVideoReel — no avatar, so D-ID's 5-min
    // single-render limit does not bind): the story is as long as the seller
    // dictated it. 1200 s IS lib/video/memory-video-composition.ts
    // MEMORY_VIDEO_MAX_SECONDS (one number, two readers — the matrix proof
    // asserts they agree).
    minSeconds: 60, idealSeconds: 150, maxSeconds: 1200,
    why: "A seller-dictated family history of the home: as long as the story is, on the voiceover host (no avatar clip cap). Never model-authored (lib/video/memory-video-gate.ts).",
    sources: ["d-id.com/faqs: output video length limited to 5 min", "sendspark.com onboarding guide (2026-08): 2-5-8 rule — a single story holds to ~5 min"],
  },
  partners_meeting: {
    minSeconds: 30, idealSeconds: 60, maxSeconds: 120,
    why: "The AI team's weekly recap to the brokerage's own people: earned cards, the money booked, the compliance disposition, one ask. A captive audience, but engagement still falls sharply past two minutes.",
    sources: ["sendspark.com onboarding guide (2026-08): employees are a captive audience; ~5 min single topic", "sendspark.com (2026-04): 60% of viewers drop off after the 2-minute mark"],
  },
  lead_reel: {
    minSeconds: 20, idealSeconds: 35, maxSeconds: 60,
    why: "A 1:1 intro embedded in the first email to a qualified lead: their situation, one useful thing, the next step. First-touch rules apply.",
    sources: ["stackbd.com 2026 benchmark: 30-45 s, under 60 s", "sendspark.com (2026-07): first touch under 45 s"],
  },
  geo_reel: {
    minSeconds: 12, idealSeconds: 30, maxSeconds: 120,
    why: "A PUBLICATION SURFACE over finished reels of any purpose (app/api/cron/geo-reel-autopublish) — it inherits the published reel's own rule; this range is the union of what it may publish.",
    sources: ["scripts/video-type-matrix-simulator.ts §surfaces: geo reel is a surface, not a composition"],
  },
  newsletter: {
    minSeconds: 20, idealSeconds: 35, maxSeconds: 60,
    why: "The digest's market beat and three section headlines, spoken: a 30-60 s email video the reader opens lean-in.",
    sources: ["dunphy.typito.com (2026-07): email follow-up 30-60 s", "reel-e.ai (2026-03): email video 30-60 s with the length in the subject line"],
  },
  photo_walkthrough: {
    minSeconds: 20, idealSeconds: 40, maxSeconds: 90,
    why: "A Ken Burns tour of the listing photos with narrated tour beats: 8-15 photos at 3-5 s each. Under 45 s for social, up to 90 s on a listing page.",
    sources: ["peachgum.ai (2026-04): photo-based videos under 45 s social, under 2 min on listing pages", "dunphy.typito.com (2026-07): full tour 60-90 s, 3-5 s per room", "reel-e.ai (2026-03): 8-15 photos ≈ 30-60 s"],
  },
  listing_presentation_section: {
    minSeconds: 15, idealSeconds: 30, maxSeconds: 45,
    why: "One section of a 5-12 section narrated listing presentation the seller opted into: a paragraph per section keeps the whole walkthrough inside the 2-5 min a proposal earns.",
    sources: ["sendspark.com (2026-04): proposal walkthroughs 2-5 min", "remotion/Root.tsx ListingSectionReel note: 30 s buys the 4-5 sentence paragraph the brief asks for"],
  },
  testimonial: {
    minSeconds: 15, idealSeconds: 30, maxSeconds: 60,
    why: "A client's words with the agent's reaction: social proof reads in 15-30 s on a feed, up to a minute when it carries the full quote.",
    sources: ["sendspark.com (2026-04): testimonials 1-2 min at the decision stage", "dunphy.typito.com (2026-07): social scroll 15-30 s"],
  },
  neighborhood_spotlight: {
    minSeconds: 15, idealSeconds: 30, maxSeconds: 60,
    why: "Lifestyle b-roll under two data highlights and the agent's tagline: discovery content for people who do not know the agent yet.",
    sources: ["blog.kristamashore.com (2026-06): neighborhood highlights 30-90 s short-form", "listingclip.com (2026-05): TikTok 30-60 s"],
  },
  buyer_match: {
    minSeconds: 9, idealSeconds: 9, maxSeconds: 30,
    why: "Three real listings a monthly budget buys this week: on-screen copy, no narration; sized by its three example tiles.",
    sources: ["dunphy.typito.com (2026-07): listing-card motion 5-15 s; social 15-30 s"],
  },
}

// TOMBSTONE (wave 78 integration, CLAUDE.md §1.3): `purposeRule(purpose)` was a
// one-line accessor over PURPOSE_DURATION_RULES that nothing called — every
// reader (this module, scripts/video-duration-model-guard.ts,
// scripts/video-type-matrix-simulator.ts) indexes the table directly. The
// survivor is PURPOSE_DURATION_RULES above; nothing was lost.

// ─────────────────────────────────────────────────────────────────────────────
// § PACE — words per minute by host kind, and the provider caps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spoken pace per host. `voiceover` IS script-structure.ts's WORDS_PER_MINUTE
 * (150 — the one narration pace this repo has always used; never a second
 * literal). `avatar` is the "natural" on-camera register the avatar research
 * converges on (geratools.com 2026: 130-150 wpm for clear lip-synced
 * delivery, "natural" ≈ 135) — a talking head that races at narration pace
 * reads as a machine, which is the realism tell lib/video/realism-profile.ts
 * exists to remove. `silent` speaks nothing; it reports the voiceover pace so
 * an estimate never divides by zero.
 */
export const AVATAR_WORDS_PER_MINUTE = 135

export function hostWordsPerMinute(host: HostKind): number {
  return host === "avatar" ? AVATAR_WORDS_PER_MINUTE : WORDS_PER_MINUTE
}

/** Words a host speaks in `seconds` at its pace. */
export function wordsForSeconds(seconds: number, host: HostKind): number {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  return Math.round((s / 60) * hostWordsPerMinute(host))
}

/** Seconds a host takes to speak `words` at its pace (3 decimals). */
export function spokenSecondsForWords(words: number, host: HostKind): number {
  const w = Number.isFinite(words) && words > 0 ? words : 0
  return Number(((w / hostWordsPerMinute(host)) * 60).toFixed(3))
}

/** d-id.com/faqs: "the video length is limited to 5 min" (Studio and API). */
export const DID_MAX_CLIP_SECONDS = 300

/**
 * The ElevenLabs synthesis cap. TOMBSTONE: this was `MAX_SCRIPT_CHARS` in
 * lib/video/reel-voiceover.ts (module-private, line 77 before the move); it
 * moved here because the WORD budget must know the CHARACTER cap the
 * synthesis will apply, and reel-voiceover imports it back — one number, two
 * readers (§6).
 */
export const VOICEOVER_MAX_SCRIPT_CHARS = 2400

/** English prose averages ~4.7 letters per word; with the space, 6 characters
 *  per word is the conservative figure that keeps a word budget under the
 *  character cap. */
export const AVERAGE_CHARS_PER_WORD = 6

/** The longest narration a host's PROVIDER can carry, in seconds — the
 *  character cap spoken at the host's pace, and D-ID's clip limit for an
 *  avatar. A purpose max above this is unreachable and is clamped to it. */
export function providerMaxSpokenSeconds(host: HostKind): number {
  const charCapSeconds = spokenSecondsForWords(Math.floor(VOICEOVER_MAX_SCRIPT_CHARS / AVERAGE_CHARS_PER_WORD), host)
  return host === "avatar" ? Math.min(DID_MAX_CLIP_SECONDS, charCapSeconds) : charCapSeconds
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE COMPOSITION REGISTRY — purpose, host and BOOKENDS per composition
// ─────────────────────────────────────────────────────────────────────────────

export interface CompositionDurationSpec {
  /** The composition's default purpose. A producer may pass its own purpose
   *  to the planner when the same composition serves more than one. */
  purpose: VideoPurpose
  /** Other purposes producers stage on this composition; the registered cap
   *  covers the largest of them. */
  alsoServes?: VideoPurpose[]
  host: HostKind
  /** Brand chrome before the body (cover/intro tile), in frames. Design
   *  constants of the composition — the BODY is what is computed. */
  introFrames: number
  /** Brand chrome after the body (outro/CTA tile), in frames. */
  outroFrames: number
  /**
   * `narration` — the body is computed from the narration (the rule).
   * `fixed` — the composition has nothing to derive a body from (a silent
   *   chart reel sized by its slides, or a slide COMPONENT whose wrapper sizes
   *   it) and renders at its registered duration. Every `fixed` row says why.
   */
  bodyMode: "narration" | "fixed"
  /** The body is STITCHED from several synthesis clips (each under the
   *  provider's single-clip cap), so the purpose max is not bounded by one
   *  clip — lane 78D's MemoryVideoReel splits chapters on sentence
   *  boundaries (lib/video/memory-video-render.ts splitForSynthesis). */
  multiClip?: true
  /** A composition whose length is computed by its OWN pure planner from its
   *  props (chapter clips, cover, outro) instead of the generic
   *  purpose/word-budget plan. durationMetadata() defers to it, so Root.tsx
   *  still mounts the ONE calculateMetadata for every narration composition. */
  durationFromProps?: (props: Record<string, unknown>, fps: number) => number
  note?: string
}

export const COMPOSITION_DURATION_RULES: Record<string, CompositionDurationSpec> = {
  // ── Avatar-hosted ──
  AgentTalkingHeadReel:  { purpose: "welcome", alsoServes: ["seller_update"], host: "avatar", introFrames: 60, outroFrames: 60, bodyMode: "narration" },
  MarketUpdateReel:      { purpose: "market_update", host: "avatar", introFrames: 60, outroFrames: 60, bodyMode: "narration" },
  EquityReportReel:      { purpose: "anniversary_equity", host: "avatar", introFrames: 60, outroFrames: 120, bodyMode: "narration" },
  AgentExplainerReel:    { purpose: "explainer", alsoServes: ["lead_reel"], host: "avatar", introFrames: 90, outroFrames: 90, bodyMode: "narration" },
  ExplainerAnimReel:     { purpose: "explainer", host: "avatar", introFrames: 90, outroFrames: 90, bodyMode: "narration" },
  TeammateExplainerReel: { purpose: "explainer", host: "avatar", introFrames: 75, outroFrames: 90, bodyMode: "narration" },
  // ── Voiceover-hosted ──
  MemoryVideoReel:           { purpose: "memory", host: "voiceover", introFrames: 0, outroFrames: 0, bodyMode: "narration", multiClip: true, durationFromProps: (props, fps) => memoryVideoDurationFrames(props as unknown as MemoryVideoTimelineProps, fps) },
  JustListedReel:            { purpose: "listing_promo", host: "voiceover", introFrames: 60, outroFrames: 90, bodyMode: "narration" },
  JustListedReelSquare:      { purpose: "listing_promo", host: "voiceover", introFrames: 60, outroFrames: 60, bodyMode: "narration" },
  JustListedReelHorizontal:  { purpose: "listing_promo", host: "voiceover", introFrames: 90, outroFrames: 90, bodyMode: "narration" },
  JustSoldReelSquare:        { purpose: "listing_promo", host: "voiceover", introFrames: 60, outroFrames: 60, bodyMode: "narration" },
  ComingSoonReel:            { purpose: "listing_promo", host: "voiceover", introFrames: 90, outroFrames: 60, bodyMode: "narration" },
  OpenHouseAnnounceReel:     { purpose: "listing_promo", host: "voiceover", introFrames: 90, outroFrames: 60, bodyMode: "narration" },
  PhotoWalkthroughReel:      { purpose: "photo_walkthrough", host: "voiceover", introFrames: 60, outroFrames: 90, bodyMode: "narration" },
  NeighborhoodSpotlightReel: { purpose: "neighborhood_spotlight", host: "voiceover", introFrames: 90, outroFrames: 60, bodyMode: "narration" },
  TestimonialReel:           { purpose: "testimonial", host: "voiceover", introFrames: 60, outroFrames: 60, bodyMode: "narration" },
  NewsletterDigestVideo:     { purpose: "newsletter", host: "voiceover", introFrames: 60, outroFrames: 90, bodyMode: "narration" },
  PartnersMeetingReel:       { purpose: "partners_meeting", host: "voiceover", introFrames: 75, outroFrames: 45, bodyMode: "narration" },
  ProductPromoReel:          { purpose: "product_demo", host: "voiceover", introFrames: 0, outroFrames: 120, bodyMode: "narration", note: "the hook shot is narrated, so it is part of the body; only the CTA tile is chrome" },
  ListingSectionReel:        { purpose: "listing_presentation_section", host: "voiceover", introFrames: 0, outroFrames: 0, bodyMode: "narration", note: "a single continuous slide — no chrome tiles of its own" },
  // ── Fixed — nothing to derive a body from (published exclusions) ──
  CMAReel:                   { purpose: "cma", host: "silent", introFrames: 90, outroFrames: 30, bodyMode: "fixed", note: "silent chart reel: four 150-frame slides size it (finish-spec captions:false)" },
  AffordabilitySnapshotReel: { purpose: "buyer_match", host: "silent", introFrames: 90, outroFrames: 90, bodyMode: "fixed", note: "on-screen copy, no generated script: three 90-frame example tiles size it" },
  ListingPresentationSlide:  { purpose: "listing_presentation_section", host: "avatar", introFrames: 0, outroFrames: 0, bodyMode: "fixed", note: "a slide COMPONENT reused inside ListingSectionReel; the wrapper is sized, the slide is not" },
  BuyerConsultationSlide:    { purpose: "listing_presentation_section", host: "avatar", introFrames: 0, outroFrames: 0, bodyMode: "fixed", note: "lib/buyer-consultation/consultation-render.ts pins the PIP window to the registered frames" },
}

export function compositionDurationSpec(compositionId: string): CompositionDurationSpec | null {
  return COMPOSITION_DURATION_RULES[compositionId] ?? null
}

/**
 * The bookend frames a composition's source reads its COVER/OUTRO from — so the
 * composition and the planner agree by construction rather than by a mirror.
 * An unregistered id gets no chrome (the whole duration is body): a component
 * must still render, and a missing row is what the proof fails on.
 */
export function compositionBookends(compositionId: string): { introFrames: number; outroFrames: number } {
  const spec = COMPOSITION_DURATION_RULES[compositionId]
  return spec ? { introFrames: spec.introFrames, outroFrames: spec.outroFrames } : { introFrames: 0, outroFrames: 0 }
}

/** Every purpose a composition is registered to serve, default first. */
export function compositionPurposes(compositionId: string): VideoPurpose[] {
  const spec = COMPOSITION_DURATION_RULES[compositionId]
  return spec ? [spec.purpose, ...(spec.alsoServes ?? [])] : []
}

/**
 * The CAP the registry must carry for a composition: bookends + the longest
 * purpose max it serves, at the registered fps. composition-geometry.ts's
 * duration_frames (and the live remotion_compositions row, m658) must be at
 * least this, or the purpose can never be achieved on this composition.
 */
export function requiredCapFrames(compositionId: string, fps = 30): number | null {
  const spec = COMPOSITION_DURATION_RULES[compositionId]
  if (!spec) return null
  if (spec.bodyMode === "fixed") return geometryFor(compositionId)?.duration_frames ?? null
  const maxSeconds = Math.max(...compositionPurposes(compositionId).map((p) => PURPOSE_DURATION_RULES[p].maxSeconds))
  return spec.introFrames + Math.round(maxSeconds * fps) + spec.outroFrames
}

/** Registered MOVING compositions (duration_frames > 1) — the set every
 *  registry-derived proof walks. Stills have no body to size. */
export function movingCompositionIds(): string[] {
  return Object.entries(COMPOSITION_GEOMETRY).filter(([, g]) => g.duration_frames > 1).map(([id]) => id)
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE WORD WINDOW — what the writer targets
// ─────────────────────────────────────────────────────────────────────────────

export interface WordWindow {
  purpose: VideoPurpose
  host: HostKind
  /** Body seconds the purpose asks for, after the composition cap and the
   *  provider cap have been applied to the max. */
  minSeconds: number
  idealSeconds: number
  maxSeconds: number
  /** The narration may claim (1 - NARRATION_HEADROOM) of the body — the same
   *  headroom every whole-composition budget already leaves. */
  headroom: number
  minWords: number
  idealWords: number
  maxWords: number
  /** Body seconds the registered geometry can hold (null when unregistered). */
  capBodySeconds: number | null
  providerCapSeconds: number
  /** True when the composition's registered cap is shorter than the purpose's
   *  max — the purpose cannot be fully achieved on this composition. */
  cappedByGeometry: boolean
}

/** Body seconds a registered composition can hold between its bookends. */
export function capBodySeconds(compositionId: string): number | null {
  const geo = geometryFor(compositionId)
  const spec = COMPOSITION_DURATION_RULES[compositionId]
  if (!geo || !spec) return null
  const t = computeAssemblyTimeline({ durationInFrames: geo.duration_frames, introFrames: spec.introFrames, outroFrames: spec.outroFrames })
  return t.body.durationInFrames / Math.max(1, geo.fps)
}

export function purposeWordWindow(purpose: VideoPurpose, host: HostKind, opts: { capBodySeconds?: number | null } = {}): WordWindow {
  const rule = PURPOSE_DURATION_RULES[purpose]
  const providerCap = providerMaxSpokenSeconds(host)
  const cap = typeof opts.capBodySeconds === "number" && Number.isFinite(opts.capBodySeconds) ? opts.capBodySeconds : null
  const maxSeconds = Math.min(rule.maxSeconds, providerCap, cap ?? Infinity)
  const idealSeconds = Math.min(rule.idealSeconds, maxSeconds)
  const minSeconds = Math.min(rule.minSeconds, idealSeconds)
  const speak = (s: number) => wordsForSeconds(s * (1 - NARRATION_HEADROOM), host)
  return {
    purpose, host, minSeconds, idealSeconds, maxSeconds, headroom: NARRATION_HEADROOM,
    minWords: speak(minSeconds), idealWords: speak(idealSeconds), maxWords: speak(maxSeconds),
    capBodySeconds: cap, providerCapSeconds: providerCap,
    cappedByGeometry: cap !== null && cap < rule.maxSeconds,
  }
}

/** A NarrationBudget that ALSO carries the purpose floor — the shape every
 *  producer already fits against, so nothing downstream changes. */
export interface PurposeNarrationBudget extends NarrationBudget {
  purpose: VideoPurpose
  host: HostKind
  minWords: number
  idealWords: number
  window: WordWindow
}

/**
 * THE writer's budget for a composition: the purpose max (∩ geometry cap ∩
 * provider cap) at the host's pace with the standard headroom. Replaces
 * `narrationBudget(id, compositionSeconds(geo))` and the old window table for
 * every narration-driven composition; a `fixed`-body composition (nothing to
 * derive) still gets its whole registered runtime, byte-for-byte the prior
 * behaviour. An unregistered id yields maxWords 0 — "cannot carry narration",
 * never "no limit" (script-structure.ts's contract).
 */
export function purposeBudgetFor(compositionId: string, opts: { purpose?: VideoPurpose | null } = {}): PurposeNarrationBudget {
  const spec = COMPOSITION_DURATION_RULES[compositionId]
  const geo = geometryFor(compositionId)
  const purpose = opts.purpose ?? spec?.purpose ?? "explainer"
  const host: HostKind = spec?.host ?? "voiceover"
  const cap = spec?.bodyMode === "fixed" && geo ? compositionSeconds(geo) : capBodySeconds(compositionId)
  const window = purposeWordWindow(purpose, host, { capBodySeconds: geo && spec ? cap : 0 })
  const budgetSeconds = Number((window.maxSeconds * (1 - window.headroom)).toFixed(3))
  return {
    compositionId,
    compositionSeconds: geo && spec ? window.maxSeconds : 0,
    budgetSeconds: geo && spec ? budgetSeconds : 0,
    maxWords: geo && spec ? window.maxWords : 0,
    headroom: window.headroom,
    purpose, host,
    minWords: geo && spec ? window.minWords : 0,
    idealWords: geo && spec ? window.idealWords : 0,
    window,
  }
}

// The FLOOR half of the length directive lives beside the ceiling half:
// script-structure.ts narrationLengthDirective reads `minWords` /
// `idealWords` / `purpose` off the budget when they are present (this
// module's PurposeNarrationBudget) and asks the writer for at least the floor.
// A script under the floor is extended by the WRITER, never by silence — the
// planner below never pads a body past its narration.

// ─────────────────────────────────────────────────────────────────────────────
// § THE PLAN — body and duration COMPUTED from the narration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seconds a MEASURED narration leaves after its last word: D-ID's own
 * pad_audio settle (0.3 s, lib/video/realism-profile.ts DID_TALK_REALISM_CONFIG)
 * plus a beat so the last caption cue is readable before the outro tile.
 */
export const NARRATION_SETTLE_SECONDS = 0.5

export type SpokenSecondsSource = "measured" | "estimated"

/**
 * The body a narration needs. An ESTIMATE (words at the host pace) gets the
 * standard headroom — body = seconds / (1 - NARRATION_HEADROOM), so the
 * narration claims 80 % of the body exactly as every existing budget assumes
 * and a read up to 25 % slower than average still lands inside. A MEASURED
 * length (ElevenLabs alignment, D-ID `duration`) is exact and gets only the
 * settle. ONE formula for both directions of the same arithmetic.
 */
export function bodySecondsForNarration(spokenSeconds: number, source: SpokenSecondsSource): number {
  const s = Number.isFinite(spokenSeconds) && spokenSeconds > 0 ? spokenSeconds : 0
  if (s === 0) return 0
  return source === "measured"
    ? Number((s + NARRATION_SETTLE_SECONDS).toFixed(3))
    : Number((s / (1 - NARRATION_HEADROOM)).toFixed(3))
}

export interface DurationPlan {
  compositionId: string
  purpose: VideoPurpose
  host: HostKind
  bodyMode: "narration" | "fixed"
  fps: number
  introFrames: number
  bodyFrames: number
  outroFrames: number
  /** intro + body + outro. What calculateMetadata returns. */
  durationInFrames: number
  /** [from, to) frames the narration plays in — the window the captions,
   *  b-roll, PIP and duck all derive from. */
  narrationWindow: { from: number; to: number }
  /** The narration seconds the plan was built from (null: nothing staged —
   *  the purpose ideal was used). */
  spokenSeconds: number | null
  spokenSecondsSource: SpokenSecondsSource | null
  /** Body seconds before the cap clamp. */
  requestedBodySeconds: number
  bodySeconds: number
  capFrames: number
  clampedToCap: boolean
  belowPurposeMin: boolean
  abovePurposeMax: boolean
  notes: string[]
}

export interface PlanArgs {
  compositionId: string
  /** The fitted narration's length. Measured beats estimated. */
  spokenSeconds?: number | null
  spokenSecondsSource?: SpokenSecondsSource | null
  /** Used to ESTIMATE when no seconds are known. */
  wordCount?: number | null
  /** Override the composition's default purpose (a producer that stages a
   *  seller_update on AgentTalkingHeadReel). */
  purpose?: VideoPurpose | null
  /** A live remotion_compositions row when the caller holds one; the mirror
   *  otherwise. */
  geometry?: RegisteredGeometry | null
  /**
   * Hold the body at the purpose MINIMUM when the narration is shorter. OFF
   * by default — a fitted SCRIPT that comes back short is the WRITER's to
   * extend (narrationLengthDirective carries the floor) and the body tracks
   * the narration, never silence. ON for a reel whose only text is an
   * ON-SCREEN line (a Director reel captioning its tagline or stat strip —
   * see narrationLengthFromProps "copy"): that line is not a narration, and
   * the stat cards / quote / highlights still need the dwell the purpose
   * exists for.
   */
  floorToPurposeMin?: boolean
}

/**
 * planCompositionDuration — PURE. THE computation Root.tsx, the coordinator
 * and every proof share.
 *
 *   body = bodySecondsForNarration(spokenSeconds) — or the purpose IDEAL when
 *          nothing is staged (an older render row, Studio defaultProps)
 *   body ∈ [1 frame, cap − intro − outro]; never padded past the narration
 *   duration = intro + body + outro ≤ registered duration_frames
 *
 * A `fixed`-body composition returns its registered frames. An unregistered
 * id returns 1 frame and says so — a render must not silently get a guess.
 */
export function planCompositionDuration(args: PlanArgs): DurationPlan {
  const spec = COMPOSITION_DURATION_RULES[args.compositionId]
  const geo = args.geometry ?? geometryFor(args.compositionId)
  const notes: string[] = []
  const fps = Math.max(1, Number(geo?.fps) || 30)
  if (!spec || !geo) {
    notes.push(`${args.compositionId} has no duration rule/geometry — nothing can be planned for it (register it in COMPOSITION_DURATION_RULES and composition-geometry).`)
    return {
      compositionId: args.compositionId, purpose: "explainer", host: "voiceover", bodyMode: "narration", fps,
      introFrames: 0, bodyFrames: 1, outroFrames: 0, durationInFrames: 1, narrationWindow: { from: 0, to: 1 },
      spokenSeconds: null, spokenSecondsSource: null, requestedBodySeconds: 0, bodySeconds: 1 / fps,
      capFrames: 1, clampedToCap: false, belowPurposeMin: false, abovePurposeMax: false, notes,
    }
  }
  const purpose = args.purpose ?? spec.purpose
  const rule = PURPOSE_DURATION_RULES[purpose]
  const capFrames = geo.duration_frames

  if (spec.bodyMode === "fixed") {
    const t = computeAssemblyTimeline({ durationInFrames: capFrames, introFrames: spec.introFrames, outroFrames: spec.outroFrames })
    notes.push(`${args.compositionId} is a fixed-body composition (${spec.note ?? "no narration to derive from"}); renders at its registered ${capFrames} frames.`)
    return {
      compositionId: args.compositionId, purpose, host: spec.host, bodyMode: "fixed", fps,
      introFrames: t.intro.durationInFrames, bodyFrames: t.body.durationInFrames, outroFrames: t.outro.durationInFrames,
      durationInFrames: t.totalFrames, narrationWindow: { from: t.body.from, to: t.body.from + t.body.durationInFrames },
      spokenSeconds: null, spokenSecondsSource: null,
      requestedBodySeconds: t.body.durationInFrames / fps, bodySeconds: t.body.durationInFrames / fps,
      capFrames, clampedToCap: false, belowPurposeMin: false, abovePurposeMax: false, notes,
    }
  }

  // The narration seconds the body is derived from.
  let spokenSeconds: number | null = null
  let source: SpokenSecondsSource | null = null
  if (typeof args.spokenSeconds === "number" && Number.isFinite(args.spokenSeconds) && args.spokenSeconds > 0) {
    spokenSeconds = args.spokenSeconds
    source = args.spokenSecondsSource ?? "estimated"
  } else if (typeof args.wordCount === "number" && Number.isFinite(args.wordCount) && args.wordCount > 0) {
    spokenSeconds = spokenSecondsForWords(args.wordCount, spec.host)
    source = "estimated"
  }

  let requestedBodySeconds: number
  if (spokenSeconds !== null && source !== null) {
    requestedBodySeconds = bodySecondsForNarration(spokenSeconds, source)
    if (args.floorToPurposeMin && requestedBodySeconds < rule.minSeconds) {
      notes.push(`${args.compositionId}: the on-screen copy reads in ${requestedBodySeconds}s; the ${purpose} minimum of ${rule.minSeconds}s holds the body so the visuals get their dwell (floorToPurposeMin).`)
      requestedBodySeconds = rule.minSeconds
    }
  } else {
    requestedBodySeconds = rule.idealSeconds
    notes.push(`${args.compositionId}: no narration length staged — body set to the ${purpose} ideal (${rule.idealSeconds}s), not the ${capFrames}-frame cap.`)
  }

  const maxBodyFrames = Math.max(1, capFrames - spec.introFrames - spec.outroFrames)
  const requestedBodyFrames = Math.max(1, Math.round(requestedBodySeconds * fps))
  const clampedToCap = requestedBodyFrames > maxBodyFrames
  if (clampedToCap) {
    notes.push(`${args.compositionId}: a ${requestedBodySeconds}s body exceeds the registered cap (${maxBodyFrames / fps}s of body in ${capFrames} frames) — clamped; the narration past it will be cut. Raise the cap (composition-geometry + remotion_compositions) or shorten the script.`)
  }
  const bodyFrames = Math.min(requestedBodyFrames, maxBodyFrames)
  const t = computeAssemblyTimeline({
    durationInFrames: spec.introFrames + bodyFrames + spec.outroFrames,
    introFrames: spec.introFrames, outroFrames: spec.outroFrames,
  })
  const bodySeconds = t.body.durationInFrames / fps
  const belowPurposeMin = spokenSeconds !== null && bodySeconds < rule.minSeconds
  const abovePurposeMax = bodySeconds > rule.maxSeconds
  if (belowPurposeMin) notes.push(`${args.compositionId}: the narration fills ${bodySeconds}s of body, under the ${purpose} minimum of ${rule.minSeconds}s — the writer's floor (purposeFloorDirective) is what closes this; the body is never padded with silence.`)
  if (abovePurposeMax) notes.push(`${args.compositionId}: ${bodySeconds}s of body is past the ${purpose} maximum of ${rule.maxSeconds}s — fitNarrationToBudget should have trimmed the script at a sentence boundary.`)

  return {
    compositionId: args.compositionId, purpose, host: spec.host, bodyMode: "narration", fps,
    introFrames: t.intro.durationInFrames, bodyFrames: t.body.durationInFrames, outroFrames: t.outro.durationInFrames,
    durationInFrames: t.totalFrames,
    narrationWindow: { from: t.body.from, to: t.body.from + t.body.durationInFrames },
    spokenSeconds, spokenSecondsSource: source, requestedBodySeconds, bodySeconds,
    capFrames, clampedToCap, belowPurposeMin, abovePurposeMax, notes,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § PROPS — how the plan travels to the render
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two input_props keys a producer stages so calculateMetadata can size
 * the composition: the fitted narration's seconds and whether they were
 * measured. Additive — a row without them renders at the purpose ideal (or,
 * for an avatar row, at D-ID's own measured `avatarDurationSeconds`, which
 * the orchestrator already stages), never at the cap.
 */
export interface SpokenSecondsProps {
  spokenSeconds: number
  spokenSecondsSource: SpokenSecondsSource
}

/** Build the two props from what a producer has: a synthesized voiceover's
 *  measured length when the primitive returned one, else the fitted script's
 *  word count at the host pace. Empty when there is nothing to stage. */
export function spokenSecondsProps(
  args: { measuredSeconds?: number | null; narration?: string | null; compositionId: string },
): Partial<SpokenSecondsProps> {
  if (typeof args.measuredSeconds === "number" && Number.isFinite(args.measuredSeconds) && args.measuredSeconds > 0) {
    return { spokenSeconds: Number(args.measuredSeconds.toFixed(3)), spokenSecondsSource: "measured" }
  }
  const words = spokenWords(args.narration).length
  if (words === 0) return {}
  const host = COMPOSITION_DURATION_RULES[args.compositionId]?.host ?? "voiceover"
  return { spokenSeconds: spokenSecondsForWords(words, host), spokenSecondsSource: "estimated" }
}

/**
 * Read the narration length out of a render's props, in order of trust:
 *   1. spokenSeconds (+ source)          — staged by the producer
 *   2. avatarDurationSeconds             — D-ID's own measurement (orchestrator)
 *   3. captionsCues                      — the last cue's end frame is where the
 *                                          voice stops (word-accurate when the
 *                                          plan came from alignment)
 *   4. captionScript / narrationScript   — the fitted script's word count
 * Nothing → null (the planner uses the purpose ideal).
 */
export function narrationLengthFromProps(
  compositionId: string,
  props: Record<string, unknown> | null | undefined,
): { spokenSeconds: number; source: SpokenSecondsSource; from: "staged" | "avatar" | "cues" | "copy" } | null {
  if (!props) return null
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)
  const staged = num(props.spokenSeconds)
  if (staged !== null) return { spokenSeconds: staged, source: props.spokenSecondsSource === "measured" ? "measured" : "estimated", from: "staged" }
  const avatar = num(props.avatarDurationSeconds)
  if (avatar !== null) return { spokenSeconds: avatar, source: "measured", from: "avatar" }
  const cues = props.captionsCues
  if (Array.isArray(cues) && cues.length > 0) {
    const fps = Math.max(1, geometryFor(compositionId)?.fps ?? 30)
    const from = compositionBookends(compositionId).introFrames
    let end = 0
    for (const c of cues as Array<{ fromFrame?: unknown; durationFrames?: unknown }>) {
      const f = num(c?.fromFrame) ?? 0, d = num(c?.durationFrames) ?? 0
      end = Math.max(end, f + d)
    }
    // Cues are composition-absolute (planned against the window and re-anchored
    // by the intro) — subtract the intro so this is the narration's own length.
    if (end > from) return { spokenSeconds: Number(((end - from) / fps).toFixed(3)), source: "measured", from: "cues" }
  }
  const host = COMPOSITION_DURATION_RULES[compositionId]?.host ?? "voiceover"
  // narrationScript / narration are FITTED scripts a producer staged (the
  // section reel, the report shows); captionScript may be the same script OR
  // a Director reel's on-screen line (a tagline, a stat strip) — the latter
  // is "copy", which the planner floors at the purpose minimum.
  for (const key of ["narrationScript", "narration"]) {
    const text = props[key]
    if (typeof text === "string") {
      const words = spokenWords(text).length
      if (words > 0) return { spokenSeconds: spokenSecondsForWords(words, host), source: "estimated", from: "staged" }
    }
  }
  const caption = props.captionScript
  if (typeof caption === "string") {
    const words = spokenWords(caption).length
    if (words > 0) return { spokenSeconds: spokenSecondsForWords(words, host), source: "estimated", from: "copy" }
  }
  return null
}

/** The plan for a render, from its staged props. */
export function planDurationForProps(
  compositionId: string,
  props: Record<string, unknown> | null | undefined,
  opts: { geometry?: RegisteredGeometry | null; purpose?: VideoPurpose | null } = {},
): DurationPlan {
  const length = narrationLengthFromProps(compositionId, props)
  const purpose = opts.purpose ?? ((props?.videoPurpose as VideoPurpose | undefined) && PURPOSE_DURATION_RULES[props!.videoPurpose as VideoPurpose] ? (props!.videoPurpose as VideoPurpose) : null)
  return planCompositionDuration({
    compositionId,
    spokenSeconds: length?.spokenSeconds ?? null,
    spokenSecondsSource: length?.source ?? null,
    purpose,
    geometry: opts.geometry ?? null,
    floorToPurposeMin: length?.from === "copy",
  })
}

/**
 * The seconds a render will ACTUALLY be — what the coordinator hands the
 * narration pad and the music fade in place of compositionSeconds(row). The
 * row is the cap; the props say how much of it this render uses.
 */
export function renderedCompositionSeconds(
  composition: { composition_id: string } & RegisteredGeometry,
  props: Record<string, unknown> | null | undefined,
): number {
  const plan = planDurationForProps(composition.composition_id, props, { geometry: composition })
  return plan.durationInFrames / Math.max(1, plan.fps)
}

/**
 * The `calculateMetadata` for a <Composition> in remotion/Root.tsx. Typed
 * structurally (Remotion's CalculateMetadataFunction accepts a function that
 * reads only `props`) so this module stays free of the remotion package.
 */
export function durationMetadata(compositionId: string) {
  const own = COMPOSITION_DURATION_RULES[compositionId]?.durationFromProps
  return ({ props }: { props: Record<string, unknown> }): { durationInFrames: number } => ({
    durationInFrames: own
      ? own(props, geometryFor(compositionId)?.fps ?? 30)
      : planDurationForProps(compositionId, props).durationInFrames,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE WINDOW — derived, never a table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The composition-absolute [from, to) frames the narration plays in, for a
 * composition rendering at `durationInFrames`: after the intro, before the
 * outro. TOMBSTONE: lib/video/narration-window.ts NARRATION_WINDOW_FRAMES
 * (lane 77D) was a hand table of six such windows at the fixed registered
 * duration; this is the same fact derived from the bookends and whatever
 * duration the render actually has.
 */
export function narrationWindowFrames(compositionId: string, durationInFrames: number): { from: number; to: number } {
  const { introFrames, outroFrames } = compositionBookends(compositionId)
  const t = computeAssemblyTimeline({ durationInFrames, introFrames, outroFrames })
  return { from: t.body.from, to: t.body.from + t.body.durationInFrames }
}
