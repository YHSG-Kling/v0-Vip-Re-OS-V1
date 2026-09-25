// lib/video/topic-video.ts
// ─────────────────────────────────────────────────────────────────────────────
// TOPIC POOL → VIDEO, BY RULE (wave 82, lane 82C). PURE — no I/O.
//
// OWNER (2026-09-25, verbatim): "videos should also be derived by the topic pool
// which should be autonomous. … on the card they can also pick from the topic
// pool."
//
// THE POOL ALREADY EXISTED — this file adds no second one. The ONE topic pool is
// content_topic_bank + content_topic_uses, read through
// lib/content-intel/topic-bank.ts pickTopics (freshness, local +15, geo +20,
// per-persona performance learning from content_asset_persona_performance, the
// 30-day office claim). It already fed podcasts, newsletters, blogs, farm mail,
// social captions and the ISA's 1:1 contact reels — but no BROADCAST video, and
// the Describe-a-video card could not see it. What is added here is the RULE
// that turns one pool topic into one described-video brief, so the ONE Director
// rail (commissionCustomVideo → pending_review) makes it:
//
//   · PERSONA  — the week's persona rotates through the four the pool already
//     scores for (lib/ai-isa/contact-reel-situation.ts personaTopicCategories —
//     the same category sets the contact reels use), so the tenant's feed speaks
//     to buyers, sellers, both and past clients in turn.
//   · SEASON   — seasonalCategories(month) lifts in-season topics
//     (pickTopics boostCategories, +8). Northern-hemisphere US rhythm (peachgum
//     2026-04 "Seasonal Real Estate Content Ideas by Month": winter = seller
//     nurturing + spring prep and financing; spring = listing season, curb
//     appeal; summer = relocation buyers, neighbourhoods; fall = market
//     education, prep-to-list, home care).
//   · TERRITORY — the brokerage's own city/state/zip is the pick's recipient
//     location (pickTopics' +20 geo boost) — territory-centric by construction.
//   · CADENCE  — each tenant gets its own weekday(s) derived from its id (load
//     spreads across the week; cost-down): two a week in the Mar–Aug peak, one
//     otherwise (peachgum: "posting frequency should match seasonal intensity").
//   · SHAPE    — the topic's categories choose an archetype chain; the FIRST
//     archetype whose needs the autonomous run can meet wins (the archetype
//     classifier validates the hint — lib/video/custom-video-archetypes.ts), and
//     every chain ends in education_explainer, which needs nothing but a voice.
//
// The script itself is written by the runner (lib/video/topic-video-runner.ts)
// compliance-first; nothing here calls a model.

import {
  CUSTOM_ARCHETYPE_REGISTRY, classifyCustomVideoBrief,
  type CustomVideoArchetype, type CustomVideoBrief,
} from "./custom-video-archetypes"
import { wordsForSeconds, type HostKind } from "./duration-model"
import type { BodyVisualAssets } from "./body-visual-model"
import { personaTopicCategories, type ContactReelPersona } from "@/lib/ai-isa/contact-reel-situation"

/** The persona rotation — exactly the personas the pool's per-persona scores are kept for. */
export const TOPIC_VIDEO_PERSONAS: readonly ContactReelPersona[] = ["buyer", "seller", "both", "lifetime"]

/** Plain-language audience for a persona (fair-housing safe: a SITUATION, never a people-group). */
export const PERSONA_AUDIENCE: Record<ContactReelPersona, string> = {
  buyer: "people thinking about buying a home",
  seller: "homeowners thinking about selling",
  both: "people planning a move — selling one home and buying the next",
  lifetime: "past clients and homeowners in the area",
}

/** ISO-week number (UTC) — the rotation clock. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

/** The week's persona: rotates weekly, offset per tenant so tenants are not in lock-step. */
export function personaForWeek(d: Date, brokerageId: string): ContactReelPersona {
  return TOPIC_VIDEO_PERSONAS[(isoWeek(d) + hash(brokerageId)) % TOPIC_VIDEO_PERSONAS.length]
}

export interface Season { season: "winter" | "spring" | "summer" | "fall"; categories: string[]; why: string }

/**
 * In-season categories, in the WRITERS' spelling (the content-intel scrapers
 * write finance / buyer_advice / seller_advice / market_education / neighborhood
 * / home_improvement / regulation). Month is 0-11 (Date#getUTCMonth).
 */
export function seasonalCategories(month: number): Season {
  const m = ((Math.floor(month) % 12) + 12) % 12
  if (m === 11 || m <= 1) return { season: "winter", categories: ["finance", "seller_advice", "buyer_advice"], why: "winter: seller nurturing + spring prep, financing plans" }
  if (m <= 4) return { season: "spring", categories: ["seller_advice", "home_improvement", "market_education"], why: "spring: listing season, curb appeal, pricing" }
  if (m <= 7) return { season: "summer", categories: ["buyer_advice", "neighborhood", "finance"], why: "summer: relocation buyers, neighbourhoods, school-calendar moves" }
  return { season: "fall", categories: ["market_education", "home_improvement", "seller_advice"], why: "fall: market education, prep-to-list, home care" }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/** The weekdays (0=Sun) a tenant's autonomous topic video runs: 2 in the Mar–Aug peak, 1 otherwise. */
export function topicVideoWeekdays(brokerageId: string, month: number): number[] {
  const first = hash(brokerageId) % 7
  const m = ((Math.floor(month) % 12) + 12) % 12
  const peak = m >= 2 && m <= 7
  return peak ? [first, (first + 3) % 7] : [first]
}

export function isTopicVideoDay(brokerageId: string, d: Date): boolean {
  return topicVideoWeekdays(brokerageId, d.getUTCMonth()).includes(d.getUTCDay())
}

// ── SHAPE: category → archetype chain → first whose needs are met ───────────

/** Category → preferred archetype chain. Every chain ENDS in education_explainer (needs nothing). */
export const TOPIC_ARCHETYPE_RULES: Array<{ categories: string[]; chain: CustomVideoArchetype[]; why: string }> = [
  { categories: ["market_education", "market_update"], chain: ["data_update", "education_explainer"], why: "numbers with a take — stat cards when the run has them, else the explainer" },
  { categories: ["neighborhood"], chain: ["photo_story", "education_explainer"], why: "a place is shown in photos when there are photos, else explained" },
  { categories: ["buyer_advice", "seller_advice", "finance", "home_improvement", "regulation", "competitor_intel"], chain: ["education_explainer"], why: "advice is one concept taught in three beats" },
]

export interface TopicLike {
  id: string
  topic_title: string
  value_angle: string | null
  categories: string[]
}

export interface TopicArchetypeChoice {
  archetype: CustomVideoArchetype
  why: string
  /** The chain members skipped because their needs were not met, with the reason. */
  skipped: Array<{ archetype: CustomVideoArchetype; reason: string }>
}

/** Pick the archetype for a topic given the assets on hand — the classifier validates each candidate. */
export function topicArchetypeFor(topic: TopicLike, host: HostKind, assets: BodyVisualAssets): TopicArchetypeChoice {
  const cats = topic.categories ?? []
  const rule = TOPIC_ARCHETYPE_RULES.find((r) => r.categories.some((c) => cats.includes(c)))
  const chain: CustomVideoArchetype[] = rule ? [...rule.chain] : ["education_explainer"]
  if (chain[chain.length - 1] !== "education_explainer") chain.push("education_explainer")
  const skipped: TopicArchetypeChoice["skipped"] = []
  for (const archetype of chain) {
    const verdict = classifyCustomVideoBrief({ audience: "", goal: topic.topic_title, host, assets, archetypeHint: archetype })
    if (verdict.ok) return { archetype, why: rule ? rule.why : "no category rule — the explainer is the safe shape", skipped }
    skipped.push({ archetype, reason: verdict.reason })
  }
  // The chain's last member needs nothing but a registered host; reaching here means the HOST cannot carry it.
  return { archetype: "education_explainer", why: `no chain member fits the ${host} host — refused downstream by the planner`, skipped }
}

/** The goal line a topic becomes — plain, value-first, never salesy. */
export function topicGoal(topic: TopicLike): string {
  const angle = (topic.value_angle ?? "").trim()
  return `Explain "${topic.topic_title.trim()}"${angle ? ` — ${angle}` : ""}`.slice(0, 600)
}

/** The narration word budget for the brief's target length on the host. */
export function topicScriptWords(targetSeconds: number, host: HostKind): number {
  return Math.max(30, wordsForSeconds(targetSeconds, host))
}

/** A described-video brief for a topic (content filled by the runner or the card). */
export function topicVideoBrief(args: {
  topic: TopicLike
  persona: ContactReelPersona
  host: HostKind
  assets: BodyVisualAssets
  content?: Record<string, unknown>
  lengthWishSeconds?: number | null
}): { brief: CustomVideoBrief; choice: TopicArchetypeChoice } {
  const choice = topicArchetypeFor(args.topic, args.host, args.assets)
  return {
    choice,
    brief: {
      audience: PERSONA_AUDIENCE[args.persona],
      goal: topicGoal(args.topic),
      host: args.host,
      lengthWishSeconds: args.lengthWishSeconds ?? null,
      assets: args.assets,
      archetypeHint: choice.archetype,
      content: args.content ?? {},
      listingId: null,
      targetChannel: "instagram",
    },
  }
}

/** The categories a persona's pick filters on — the SAME sets the contact reels use. */
export function topicCategoriesForPersona(persona: ContactReelPersona): string[] {
  return personaTopicCategories(persona)
}

/**
 * The script prompt — compliance-first (CLAUDE.md §5: fair housing in the WRITING
 * prompt, not only the scan). The runner wraps it in withSpokenScriptStandards and
 * prepends the tenant's compliance system blocks.
 */
export function topicScriptPrompt(args: { topic: TopicLike; persona: ContactReelPersona; words: number; archetype: CustomVideoArchetype }): string {
  const spec = CUSTOM_ARCHETYPE_REGISTRY[args.archetype]
  return [
    `Write a short spoken video script (about ${args.words} words) for a local real-estate agent.`,
    `Topic: ${args.topic.topic_title}${args.topic.value_angle ? ` — ${args.topic.value_angle}` : ""}.`,
    `Audience: ${PERSONA_AUDIENCE[args.persona]}.`,
    `Shape: ${args.archetype.replace(/_/g, " ")} — ${spec.why}`,
    "Structure: a one-line hook that names the viewer's situation; three short beats that teach one idea; one soft next step (a question they can ask the agent). Not salesy; no urgency; no guarantees.",
    "Never invent numbers, rates, prices or statistics — if a number matters, say where to find it. Never describe who lives somewhere or who a place is 'for'; describe the home and the process only (Fair Housing Act).",
    "Also return a 3-6 word on-screen title and three on-screen bullets of at most 6 words each.",
  ].join("\n")
}
