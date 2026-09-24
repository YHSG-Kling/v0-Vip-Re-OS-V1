// lib/video/custom-video-archetypes.ts
// ─────────────────────────────────────────────────────────────────────────────
// ANY TYPE OF VIDEO, PROOF-BACKED (wave 81, lane 81C).
//
// OWNER (2026-09-24, verbatim): "make sure user can create any type of video
// to use with real estate not just the ones we listed."
//
// The Director's SituationKind list is the OWNER's list (new listing, just
// sold, open house, market update, …). The field makes far more than that —
// agent intros, buyer guides, recruiting pitches, vendor spotlights, event
// recaps, holiday greetings, FAQ answers, day-in-the-life, street interviews,
// "what $500K buys", relocation guides, seller-prep checklists (Exa 2026-09-24:
// luxurypresence.com 2026-03 "11 formats"; propphy.com 2026-05 "101 ideas";
// buildingbetteragents.com "52+ videos"; dunphy.typito.com 2026-07 "8 formats
// that map to listing moments"; jupitrr.com 2026-05 "7 formats"). Nobody can
// enumerate them, and a hand table per type is exactly what the owner said
// NOT to build.
//
// THE RULE INSTEAD: every real-estate video is one of a SMALL CLOSED SET OF
// ARCHETYPES — the shape of what is on screen and who carries it — and each
// archetype derives its duration band and its body-visual rule FROM an
// existing purpose in lib/video/duration-model.ts / body-visual-model.ts. A
// described video is CLASSIFIED into an archetype by rule (host, assets on
// hand, the goal's cue words); the archetype names the base purpose; the
// purpose's registered rules do the rest. Nothing here is a second duration
// table or a second treatment table. A description that maps to no archetype
// FAILS LOUDLY with the reason — never a silent default.
//
// The seven archetypes, and the research each rests on:
//   talking_head_message — a person speaking to camera (agent intro, holiday
//     greeting, recruiting pitch, thank-you, seller prep tip). luxurypresence
//     2026-03: "speak directly to the camera … under 90 seconds"; dunphy
//     2026-07: agent intro "30 seconds of who you are … on camera".
//   photo_story         — stills carry the story (a home, an event recap, a
//     before/after, a neighbourhood in photos). bright-shot.com 2026: photo-
//     to-video is the dominant workflow; dunphy: six of eight formats from
//     photos.
//   screen_demo         — the product / a dashboard / a portal on screen
//     (a how-to for a client portal, a tool walkthrough, a vendor's software).
//     ngram.com 2026-04 / demopolish 2026-05: start at the moment of value.
//   data_update         — numbers with a take (market update, "what $500K
//     buys", rate moment, quarterly recap). listingclip 2026-05: "the market
//     this week in 45 s"; allesplay 2026: one stat card per screen.
//   testimonial_story   — a client's own words / clip as proof (buyer or
//     seller story, vendor review, closing-day moment). nowbam.com 2025-06;
//     jupitrr 2026-05: "their words, not your pitch".
//   event_promo         — an invitation with a date/place (open house, seminar,
//     client appreciation event, first-time-buyer workshop, charity drive).
//     dunphy 2026-07: the open-house reminder shape, "see you Saturday".
//   education_explainer — teach one concept in three beats (buyer guide,
//     closing costs, FAQ, myth vs fact, relocation guide). sendspark 2026-04:
//     explainers 60-90 s; whatastory 2026-07: 74 % retention under 90 s.
//
// PURE. No I/O.

import {
  COMPOSITION_DURATION_RULES, PURPOSE_DURATION_RULES,
  type HostKind, type PurposeDurationRule, type VideoPurpose,
} from "./duration-model"
import {
  resolvePurposeRule, type BodyVisualAssets, type BodyVisualRuleOverride, type PurposeBodyVisualRule,
} from "./body-visual-model"
import { finishForVideo } from "./finish-spec"
import { cutsForComposition, type RenderCut } from "./render-cut"

export const CUSTOM_VIDEO_ARCHETYPES = [
  "talking_head_message",
  "photo_story",
  "screen_demo",
  "data_update",
  "testimonial_story",
  "event_promo",
  "education_explainer",
] as const
export type CustomVideoArchetype = (typeof CUSTOM_VIDEO_ARCHETYPES)[number]

/** ai_video_projects.video_type CHECK values (scripts/check-vocabularies.ts) —
 *  the archetype names the storable type; no new CHECK literal is invented. */
export type ArchetypeVideoType = "agent_intro" | "listing_tour" | "education" | "market_update" | "testimonial" | "social_reel"

export interface ArchetypeAssetNeeds {
  /** At least this many listing/home/event photos. */
  photos?: number
  screenshots?: number
  statCards?: number
  clientFootage?: number
  chartData?: boolean
}

export interface CustomVideoArchetypeSpec {
  id: CustomVideoArchetype
  /** The purpose whose duration band and body-visual rule this archetype INHERITS. */
  basePurpose: VideoPurpose
  /** Assets the shape cannot exist without (checked against the brief). */
  needs: ArchetypeAssetNeeds
  /** Goal / audience cue words (lower-case stems) that point at this shape. */
  cues: string[]
  videoType: ArchetypeVideoType
  why: string
  sources: string[]
}

export const CUSTOM_ARCHETYPE_REGISTRY: Record<CustomVideoArchetype, CustomVideoArchetypeSpec> = {
  talking_head_message: {
    id: "talking_head_message", basePurpose: "welcome", needs: {},
    cues: ["intro", "introduce", "hello", "welcome", "greeting", "holiday", "thank", "recruit", "join our", "join my", "message", "announce", "personal", "who i am", "about me", "team", "congrat", "birthday", "anniversary", "check in", "check-in", "reminder", "tip"],
    videoType: "agent_intro",
    why: "A person speaking to the lens carries it; the welcome purpose's band (20-60 s) and rule (full avatar at the hook and the ask) are the first-touch shape every intro, greeting and pitch shares.",
    sources: ["luxurypresence.com 2026-03: agent intro under 90 s, direct to camera", "dunphy.typito.com 2026-07: agent introduction, 30 s on camera", "bright-shot.com 2026: who / who for / why trust"],
  },
  photo_story: {
    id: "photo_story", basePurpose: "photo_walkthrough", needs: { photos: 3 },
    cues: ["photo", "photos", "tour", "walkthrough", "walk-through", "before and after", "before/after", "renovation", "staging", "recap", "gallery", "showcase", "highlight", "property", "listing", "home", "house", "rental", "unit", "lot", "land", "new construction", "model home"],
    videoType: "listing_tour",
    why: "Stills with motion ARE the video; the photo-walkthrough band (20-90 s at 3-5 s a photo) and rule (photos, never cutaways) fit any photo-carried story, not only a listing.",
    sources: ["bright-shot.com 2026: photo-to-video is the dominant workflow", "dunphy.typito.com 2026-07: six of eight formats from photos, 3-5 s per room"],
  },
  screen_demo: {
    id: "screen_demo", basePurpose: "product_demo", needs: { screenshots: 1 },
    cues: ["demo", "how to use", "how-to", "tutorial", "portal", "dashboard", "app", "software", "tool", "screen", "walkthrough of the", "log in", "login", "sign up", "feature", "platform"],
    videoType: "education",
    why: "The screen is the subject; the product-demo band (45-120 s) and rule (screenshots behind every beat, a small PiP at most) hold for a client-portal how-to as well as the platform's own promo.",
    sources: ["ngram.com 2026-04 + demopolish.com 2026-05: start at the moment of value", "videoeditingcompany.com 2026-09: marketing demos skip the webcam"],
  },
  data_update: {
    id: "data_update", basePurpose: "market_update", needs: { statCards: 1 },
    cues: ["market", "update", "stats", "statistics", "numbers", "median", "price", "prices", "rate", "rates", "inventory", "days on market", "quarter", "monthly", "weekly", "recap", "report", "what $", "buys", "trend", "forecast", "comparison", "compare"],
    videoType: "market_update",
    why: "Numbers with a take: the market-update band (20-75 s) and rule (stat cards as the visual, presenter in the corner) fit any data-led piece — a rate moment, a quarterly recap, 'what $500K buys'.",
    sources: ["listingclip.com 2026-05: the market this week in 45 s", "allesplay.ai 2026: one stat card with a trend arrow per screen"],
  },
  testimonial_story: {
    id: "testimonial_story", basePurpose: "testimonial", needs: { clientFootage: 1 },
    cues: ["testimonial", "review", "client story", "success story", "case study", "closing day", "what clients say", "in their words", "five star", "5-star", "referral", "thank you from", "vendor spotlight", "partner spotlight"],
    videoType: "testimonial",
    why: "Proof in the client's own moment: the testimonial band (15-60 s) and rule (their words on screen, their own clip, never stock) hold for a buyer story, a vendor spotlight or a closing-day reel.",
    sources: ["nowbam.com 2025-06: closing-day / seller-in-the-video reels", "jupitrr.com 2026-05: their words, not your pitch"],
  },
  event_promo: {
    id: "event_promo", basePurpose: "listing_promo", needs: { photos: 1 },
    cues: ["event", "open house", "seminar", "workshop", "webinar", "appreciation", "party", "fundraiser", "charity", "drive", "invite", "invitation", "rsvp", "join us", "this weekend", "this saturday", "this sunday", "save the date", "launch", "grand opening"],
    videoType: "social_reel",
    why: "An invitation with a date and a place: the listing-promo band (12-45 s, a scroll-stopper) and rule (photos with the fact card and the on-screen CTA) is the open-house-reminder shape every event promo shares.",
    sources: ["dunphy.typito.com 2026-07: the open house reminder — 'see you Saturday', 20-30 s", "reel-e.ai 2026-03: paid ads under 15 s, teasers 15-20 s"],
  },
  education_explainer: {
    id: "education_explainer", basePurpose: "explainer", needs: {},
    cues: ["explain", "explainer", "guide", "how does", "what is", "what are", "faq", "question", "questions", "myth", "mistake", "mistakes", "checklist", "steps", "process", "closing cost", "inspection", "pre-approval", "preapproval", "escrow", "relocat", "moving to", "living in", "first-time", "first time", "buyer", "seller", "investor", "downsiz", "hoa", "insurance", "tax"],
    videoType: "education",
    why: "Teach one concept in three beats: the explainer band (30-90 s) and rule (the bullet is the content, the presenter in the corner) fit a buyer guide, an FAQ answer, a myth-vs-fact, a relocation guide.",
    sources: ["sendspark.com 2026-04: explainers 60-90 s", "whatastory.agency 2026-07: 74 % retention through 60 s when under 90 s", "luxurypresence.com 2026-03: FAQ videos — one question per video"],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE BRIEF — what a person (or an agent) describes
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomVideoBrief {
  /** Who it is for, in the describer's words ("first-time buyers in Naples", "agents I want to recruit"). */
  audience: string
  /** What it should do ("invite them to our Saturday seminar", "explain closing costs"). */
  goal: string
  /** Who carries it. */
  host: HostKind
  /** A wished length in seconds — clamped INTO the derived purpose band, never outside it. */
  lengthWishSeconds?: number | null
  /** The assets on hand — what the archetype needs is checked against these. */
  assets: BodyVisualAssets
  /** An explicit archetype when the describer (or a manager) already knows the shape. Still validated. */
  archetypeHint?: CustomVideoArchetype | null
  /** Facts / script / on-screen copy the composition's content contract will be checked against. */
  content?: Record<string, unknown>
  /** A listing the video is about (photo_story / event_promo may cut an MLS version). */
  listingId?: string | null
}

export type ArchetypeClassification =
  | { ok: true; archetype: CustomVideoArchetype; reason: string; ranked: Array<{ archetype: CustomVideoArchetype; score: number }> }
  | { ok: false; reason: string; ranked: Array<{ archetype: CustomVideoArchetype; score: number; unmet: string[] }> }

/** DERIVED, never typed: the hosts an archetype can be carried by are the
 *  hosts of the narration compositions registered for its base purpose. */
export function archetypeHosts(id: CustomVideoArchetype): HostKind[] {
  const purpose = CUSTOM_ARCHETYPE_REGISTRY[id].basePurpose
  const hosts = new Set<HostKind>()
  for (const spec of Object.values(COMPOSITION_DURATION_RULES)) {
    if (spec.bodyMode === "narration" && (spec.purpose === purpose || (spec.alsoServes ?? []).includes(purpose))) hosts.add(spec.host)
  }
  return Array.from(hosts)
}

function unmetNeeds(spec: CustomVideoArchetypeSpec, brief: CustomVideoBrief): string[] {
  const a = brief.assets
  const out: string[] = []
  const hosts = archetypeHosts(spec.id)
  if (!hosts.includes(brief.host)) out.push(`host ${brief.host} (needs ${hosts.join(" or ")})`)
  if (spec.needs.photos && a.propertyPhotos < spec.needs.photos) out.push(`${spec.needs.photos}+ photos (have ${a.propertyPhotos})`)
  if (spec.needs.screenshots && a.screenshots < spec.needs.screenshots) out.push(`${spec.needs.screenshots}+ screenshots (have ${a.screenshots})`)
  if (spec.needs.statCards && (a.statCards ?? 0) < spec.needs.statCards) out.push(`${spec.needs.statCards}+ stat cards (have ${a.statCards ?? 0})`)
  if (spec.needs.clientFootage && (a.clientFootage ?? 0) < spec.needs.clientFootage) out.push(`the client's own clip (have ${a.clientFootage ?? 0})`)
  if (spec.needs.chartData && !a.chartData) out.push("chart data")
  if (brief.host === "avatar" && !a.avatarClip) out.push("an avatar clip (the agent's twin is not ready)")
  return out
}

function cueScore(spec: CustomVideoArchetypeSpec, text: string): number {
  let n = 0
  for (const cue of spec.cues) if (text.includes(cue)) n += 1
  return n
}

/**
 * CLASSIFY BY RULE. Score = cue hits in the goal + audience text. An explicit
 * hint wins when its needs are met. Otherwise the highest-scoring archetype
 * whose needs are met wins; ties break toward the archetype with the more
 * specific asset need (photos / screenshots / footage / stats over none),
 * which is the shape the assets on hand already chose. Zero cue hits and no
 * hint → no archetype: the description did not say what shape it is.
 */
export function classifyCustomVideoBrief(brief: CustomVideoBrief): ArchetypeClassification {
  const text = `${brief.goal ?? ""} ${brief.audience ?? ""}`.toLowerCase()
  const ranked = CUSTOM_VIDEO_ARCHETYPES.map((id) => {
    const spec = CUSTOM_ARCHETYPE_REGISTRY[id]
    return { archetype: id, score: cueScore(spec, text), unmet: unmetNeeds(spec, brief), specificity: Object.keys(spec.needs).length }
  })
  if (brief.archetypeHint) {
    const hinted = ranked.find((r) => r.archetype === brief.archetypeHint)
    if (!hinted) return { ok: false, reason: `archetype "${String(brief.archetypeHint)}" is not one of ${CUSTOM_VIDEO_ARCHETYPES.join(", ")}`, ranked }
    if (hinted.unmet.length) return { ok: false, reason: `archetype ${hinted.archetype} was named but its needs are not met: ${hinted.unmet.join("; ")}`, ranked }
    return { ok: true, archetype: hinted.archetype, reason: `named by the brief (${CUSTOM_ARCHETYPE_REGISTRY[hinted.archetype].why})`, ranked }
  }
  const eligible = ranked.filter((r) => r.score > 0 && r.unmet.length === 0)
    .sort((a, b) => b.score - a.score || b.specificity - a.specificity || CUSTOM_VIDEO_ARCHETYPES.indexOf(a.archetype) - CUSTOM_VIDEO_ARCHETYPES.indexOf(b.archetype))
  if (eligible.length === 0) {
    const cued = ranked.filter((r) => r.score > 0)
    const reason = cued.length === 0
      ? `the description names no video shape — say what is on screen (a person, photos, a screen, numbers, a client's clip, an event invitation, a concept to explain); archetypes: ${CUSTOM_VIDEO_ARCHETYPES.join(", ")}`
      : `the description points at ${cued.map((r) => r.archetype).join(" / ")} but the needs are not met — ${cued.map((r) => `${r.archetype}: ${r.unmet.join("; ")}`).join(" | ")}`
    return { ok: false, reason, ranked }
  }
  const top = eligible[0]
  return { ok: true, archetype: top.archetype, reason: `${top.score} cue${top.score === 1 ? "" : "s"} matched and every need is met (${CUSTOM_ARCHETYPE_REGISTRY[top.archetype].why})`, ranked }
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE PLAN — purpose band, body-visual rule, composition, all DERIVED
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomVideoPlan {
  archetype: CustomVideoArchetype
  purpose: VideoPurpose
  host: HostKind
  compositionId: string
  /** The purpose's band, with the wished length clamped inside it. */
  band: PurposeDurationRule & { targetSeconds: number; clampedFrom: number | null }
  rule: PurposeBodyVisualRule
  videoType: ArchetypeVideoType
  cuts: RenderCut[]
  /** The facts / copy the brief supplied for the composition's content contract. */
  content: Record<string, unknown>
  reason: string
  /** A stable key so the same brief commissions once. */
  key: string
}

export type CustomVideoPlanResult = { ok: true; plan: CustomVideoPlan } | { ok: false; reason: string }

/** DERIVED: the compositions registered to serve a purpose on a host, narration-bodied, in registry order. */
export function compositionsForPurposeAndHost(purpose: VideoPurpose, host: HostKind): string[] {
  return Object.entries(COMPOSITION_DURATION_RULES)
    .filter(([, spec]) => spec.bodyMode === "narration" && spec.host === host && (spec.purpose === purpose || (spec.alsoServes ?? []).includes(purpose)))
    .map(([id]) => id)
}

/** The wished length clamped INTO the purpose band (the rule), defaulting to the band's ideal. */
export function clampLengthWish(rule: PurposeDurationRule, wish: number | null | undefined): { targetSeconds: number; clampedFrom: number | null } {
  if (!Number.isFinite(wish as number) || (wish as number) <= 0) return { targetSeconds: rule.idealSeconds, clampedFrom: null }
  const w = wish as number
  const clamped = Math.min(rule.maxSeconds, Math.max(rule.minSeconds, w))
  return { targetSeconds: clamped, clampedFrom: clamped === w ? null : w }
}

function briefKey(brief: CustomVideoBrief, archetype: CustomVideoArchetype): string {
  const raw = `${archetype}|${brief.host}|${brief.goal.trim().toLowerCase()}|${brief.audience.trim().toLowerCase()}|${brief.listingId ?? ""}`
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0
  return `custom:${archetype}:${h.toString(16)}`
}

/**
 * PLAN A DESCRIBED VIDEO. Classify → base purpose → band (wish clamped in) →
 * body-visual rule (live overrides honoured) → the FIRST composition the
 * registry lists for that purpose on that host (the ads cut is always
 * rendered; the MLS cut when the composition has one and a listing is named).
 * Every refusal names what was missing.
 */
export function planCustomVideo(brief: CustomVideoBrief, opts: { overrides?: readonly BodyVisualRuleOverride[] | null } = {}): CustomVideoPlanResult {
  if (!brief || typeof brief.goal !== "string" || brief.goal.trim().length < 3) return { ok: false, reason: "describe the video: the goal is empty" }
  if (!["voiceover", "avatar", "silent"].includes(brief.host)) return { ok: false, reason: `host must be voiceover, avatar or silent (got ${String(brief.host)})` }
  const cls = classifyCustomVideoBrief(brief)
  if (!cls.ok) return { ok: false, reason: `no archetype: ${cls.reason}` }
  const spec = CUSTOM_ARCHETYPE_REGISTRY[cls.archetype]
  const purpose = spec.basePurpose
  const durationRule = PURPOSE_DURATION_RULES[purpose]
  const compositions = compositionsForPurposeAndHost(purpose, brief.host)
  if (compositions.length === 0) return { ok: false, reason: `archetype ${cls.archetype} derives purpose ${purpose}, but no registered composition serves ${purpose} on the ${brief.host} host (lib/video/duration-model.ts COMPOSITION_DURATION_RULES)` }
  const compositionId = compositions[0]
  const rule = resolvePurposeRule(purpose, opts.overrides ?? null)
  const clamp = clampLengthWish(durationRule, brief.lengthWishSeconds)
  const cuts = brief.listingId ? cutsForComposition(compositionId) : ["ads" as RenderCut]
  return {
    ok: true,
    plan: {
      archetype: cls.archetype, purpose, host: brief.host, compositionId,
      band: { ...durationRule, ...clamp },
      rule, videoType: spec.videoType, cuts,
      content: brief.content ?? {},
      reason: `${cls.reason}; purpose ${purpose} (${durationRule.minSeconds}-${durationRule.maxSeconds} s, target ${clamp.targetSeconds} s${clamp.clampedFrom ? `, wish ${clamp.clampedFrom} s clamped` : ""}); composition ${compositionId} (${finishForVideo(compositionId).presenter} presenter)`,
      key: briefKey(brief, cls.archetype),
    },
  }
}
