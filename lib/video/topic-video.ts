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
//   · PERSONA  — each slot speaks to one CONTACT PERSONA: the situation
//     vocabulary contacts carry in contacts.contact_persona (CHECK in
//     scripts/check-vocabularies.ts; the code survivor is
//     lib/campaigns/contact-sources.ts CAMPAIGN_PERSONAS + normalizeContactPersona).
//     WAVE 83 (owner, verbatim): "in topic video, you made the persona contact
//     type instead of contact personas." — 82C rotated buyer/seller/both/lifetime,
//     which is the contacts.contact_type vocabulary (via contact-reel-situation's
//     ContactReelPersona). That was also a silent learning defect: the pool's
//     per-persona performance rows (content_asset_persona_performance.persona) are
//     written by the aggregator from contact.contact_persona, so a pick asked for
//     recipientPersona "buyer" could never match one. The rotation, the audience
//     line, the category set and the pick's recipientPersona are now all keyed by
//     the contact persona; the rotation walks the personas the TENANT'S OWN book
//     carries (most-held first), else every persona.
//   · SEASON   — seasonalCategories(month) lifts in-season topics
//     (pickTopics boostCategories, +8). Northern-hemisphere US rhythm (peachgum
//     2026-04 "Seasonal Real Estate Content Ideas by Month": winter = seller
//     nurturing + spring prep and financing; spring = listing season, curb
//     appeal; summer = relocation buyers, neighbourhoods; fall = market
//     education, prep-to-list, home care).
//   · TERRITORY — the brokerage's own city/state/zip is the pick's recipient
//     location (pickTopics' +20 geo boost) — territory-centric by construction.
//   · CADENCE  — WAVE 83 (owner, verbatim): "an agent needs to stay top of mind
//     for their market so one video a week, doesn't seem like enough." The
//     weekly count is a per-tenant setting (brokerage_settings.settings
//     .topic_video_cadence — jsonb, no CHECK, no migration) with a researched
//     default of THREE a week (+1 in the Mar–Aug peak): realtor.com 2025-07
//     "Instagram 3–5 posts per week … TikTok 3–7"; reel-e.ai 2026-02 "the minimum
//     viable frequency across platforms is 3 posts per week"; listingclip.com
//     2026-05 "three to four times per week is the floor … consistency matters
//     more than volume"; kristamashore.com 2026-06 "at minimum, 3 times per week".
//     The slots are spread evenly across the week from a tenant-derived offset
//     (load spreads across tenants; cost-down), at most one per day (the cron is
//     daily). Each slot is ASSIGNED its persona (autonomous-loops "uniqueness via
//     assignment"), and the office claim ledger keeps a topic from repeating.
//   · SHAPE    — the topic's categories choose an archetype chain; the FIRST
//     archetype whose needs the autonomous run can meet wins (the archetype
//     classifier validates the hint — lib/video/custom-video-archetypes.ts), and
//     every chain ends in the needs-free archetype THE HOST can carry:
//     education_explainer on a ready twin, voiceover_explainer (kinetic text under
//     the agent's voice) when no twin is ready — wave 83 closes 82C's gap.
//
// The script itself is written by the runner (lib/video/topic-video-runner.ts)
// compliance-first; nothing here calls a model.

import {
  CUSTOM_ARCHETYPE_REGISTRY, archetypeHosts, classifyCustomVideoBrief,
  type CustomVideoArchetype, type CustomVideoBrief,
} from "./custom-video-archetypes"
import { wordsForSeconds, type HostKind } from "./duration-model"
import type { BodyVisualAssets } from "./body-visual-model"
import { CAMPAIGN_PERSONAS, normalizeContactPersona, type CampaignPersona } from "../campaigns/contact-sources"

/** A topic video speaks to one CONTACT PERSONA (contacts.contact_persona) — every one but
 *  the catch-all `other`, which names no situation to speak to. */
export type TopicVideoPersona = Exclude<CampaignPersona, "other">

/** The persona roster — DERIVED from the contact-persona survivor, never restated. */
export const TOPIC_VIDEO_PERSONAS: readonly TopicVideoPersona[] =
  CAMPAIGN_PERSONAS.filter((p): p is TopicVideoPersona => p !== "other")

/**
 * Per persona: the plain-language AUDIENCE line (fair-housing safe — a SITUATION,
 * never a people-group: "senior" is spoken as a long-time homeowner's next move,
 * "divorce" as a shared home during a separation, "military" as a move on orders),
 * the topic CATEGORIES its pick filters on (the WRITERS' spelling — the
 * content-intel scrapers write finance / buyer_advice / seller_advice /
 * market_education / neighborhood / home_improvement / regulation), and the SIDE
 * the compliance scan reads it as.
 */
export const TOPIC_PERSONA_RULES: Record<TopicVideoPersona, { audience: string; categories: string[]; side: "buyer" | "seller" }> = {
  first_time:  { audience: "people buying their first home", categories: ["buyer_advice", "finance", "neighborhood"], side: "buyer" },
  relocated:   { audience: "people moving to the area from somewhere else", categories: ["neighborhood", "buyer_advice", "market_education"], side: "buyer" },
  luxury:      { audience: "buyers and sellers of high-end homes", categories: ["market_education", "neighborhood", "home_improvement"], side: "buyer" },
  fsbo:        { audience: "homeowners selling on their own, without an agent", categories: ["seller_advice", "regulation", "market_education"], side: "seller" },
  probate:     { audience: "people handling the sale of an inherited home or an estate property", categories: ["seller_advice", "regulation", "finance"], side: "seller" },
  upsize:      { audience: "homeowners who need more space than their current home has", categories: ["buyer_advice", "seller_advice", "finance"], side: "buyer" },
  downsize:    { audience: "homeowners moving to a smaller, easier-to-keep home", categories: ["seller_advice", "home_improvement", "finance"], side: "seller" },
  military:    { audience: "people moving on military orders or using a VA home loan", categories: ["buyer_advice", "finance", "neighborhood"], side: "buyer" },
  divorce:     { audience: "people deciding what to do with a shared home during a separation", categories: ["seller_advice", "finance", "regulation"], side: "seller" },
  senior:      { audience: "long-time homeowners planning their next move", categories: ["seller_advice", "home_improvement", "finance"], side: "seller" },
  expired:     { audience: "homeowners whose listing ended without a sale", categories: ["seller_advice", "market_education", "home_improvement"], side: "seller" },
  foreclosure: { audience: "homeowners behind on payments who want to know their options", categories: ["finance", "seller_advice", "regulation"], side: "seller" },
  investor:    { audience: "people buying property as an investment", categories: ["market_education", "finance", "regulation"], side: "buyer" },
}

/** Plain-language audience for a persona (fair-housing safe: a SITUATION, never a people-group). */
export const PERSONA_AUDIENCE: Record<TopicVideoPersona, string> = Object.fromEntries(
  TOPIC_VIDEO_PERSONAS.map((p) => [p, TOPIC_PERSONA_RULES[p].audience]),
) as Record<TopicVideoPersona, string>

/**
 * A raw contacts.contact_persona value → the topic persona, through the ONE
 * normaliser (drifted spellings like `first_time_buyer` map forward). A
 * contact_TYPE spelling (buyer / seller / both / lifetime_customer / sphere …)
 * names no situation and returns null — it is never read as a persona.
 */
export function topicPersonaOf(raw: string | null | undefined): TopicVideoPersona | null {
  const p = normalizeContactPersona(raw)
  return p && p !== "other" ? p : null
}

/**
 * The tenant's rotation: the personas its OWN book carries (contacts.contact_persona
 * values, normalised), most-held first, ties in roster order; a book with no
 * persona data rotates through every persona. Pure — the runner passes the column.
 */
export function personaRotation(rawPersonas: ReadonlyArray<string | null | undefined>): TopicVideoPersona[] {
  const counts = new Map<TopicVideoPersona, number>()
  for (const raw of rawPersonas) {
    const p = topicPersonaOf(raw)
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  if (counts.size === 0) return [...TOPIC_VIDEO_PERSONAS]
  return [...counts.keys()].sort((a, b) =>
    (counts.get(b)! - counts.get(a)!) || TOPIC_VIDEO_PERSONAS.indexOf(a) - TOPIC_VIDEO_PERSONAS.indexOf(b))
}

/** ISO-week number (UTC) — the rotation clock. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

/**
 * The persona a slot speaks to — ASSIGNED, never left to the picker: the week's
 * slots walk the rotation consecutively (offset per tenant so tenants are not in
 * lock-step), so a week with ≤ rotation.length slots never speaks to one persona
 * twice, and consecutive weeks carry on where the last one stopped.
 */
export function personaForSlot(d: Date, brokerageId: string, slotIndex: number, slotsPerWeek: number, rotation: readonly TopicVideoPersona[] = TOPIC_VIDEO_PERSONAS): TopicVideoPersona {
  const r = rotation.length > 0 ? rotation : TOPIC_VIDEO_PERSONAS
  const n = Math.max(1, Math.floor(slotsPerWeek))
  return r[(isoWeek(d) * n + Math.max(0, Math.floor(slotIndex)) + hash(brokerageId)) % r.length]
}

/** The persona a pool topic best speaks to (the most category overlap; ties in roster order) — the card's suggestion. */
export function personaForTopicCategories(categories: readonly string[], fallback: TopicVideoPersona): TopicVideoPersona {
  let best: TopicVideoPersona | null = null
  let bestHits = 0
  for (const p of TOPIC_VIDEO_PERSONAS) {
    const hits = TOPIC_PERSONA_RULES[p].categories.filter((c) => categories.includes(c)).length
    if (hits > bestHits) { best = p; bestHits = hits }
  }
  return best ?? fallback
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

// ── CADENCE — per tenant, researched default, bounded ────────────────────────

/** The brokerage_settings.settings key the tenant's cadence lives under (jsonb, no CHECK). */
export const TOPIC_VIDEO_CADENCE_KEY = "topic_video_cadence"

export interface TopicVideoCadence {
  /** Autonomous topic videos per week, off-peak. */
  perWeek: number
  /** +1 a week in the Mar–Aug listing/relocation peak (never above MAX). */
  seasonalLift: boolean
  /** The tenant switched the autonomous topic videos off. */
  enabled: boolean
}

/**
 * THE DEFAULT — three a week (the consensus floor for staying visible on
 * short-form; sources in the header), four in the peak. Bounds: at least one
 * (the 82C baseline), at most seven (one a day — the runner rides a DAILY cron;
 * more than one a day needs a second tick, not a bigger number).
 */
export const TOPIC_VIDEO_CADENCE_DEFAULT: TopicVideoCadence = { perWeek: 3, seasonalLift: true, enabled: true }
export const TOPIC_VIDEO_CADENCE_MIN = 1
export const TOPIC_VIDEO_CADENCE_MAX = 7

/** Read whatever is stored (possibly nothing, possibly hand-edited junk) into a bounded cadence. */
export function resolveTopicVideoCadence(raw: unknown): TopicVideoCadence {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const n = typeof r.perWeek === "number" && Number.isFinite(r.perWeek) ? Math.round(r.perWeek) : TOPIC_VIDEO_CADENCE_DEFAULT.perWeek
  return {
    perWeek: Math.min(TOPIC_VIDEO_CADENCE_MAX, Math.max(TOPIC_VIDEO_CADENCE_MIN, n)),
    seasonalLift: typeof r.seasonalLift === "boolean" ? r.seasonalLift : TOPIC_VIDEO_CADENCE_DEFAULT.seasonalLift,
    enabled: typeof r.enabled === "boolean" ? r.enabled : TOPIC_VIDEO_CADENCE_DEFAULT.enabled,
  }
}

function isPeakMonth(month: number): boolean {
  const m = ((Math.floor(month) % 12) + 12) % 12
  return m >= 2 && m <= 7
}

/** Videos this week for a cadence in a month (0 when switched off). */
export function topicVideosPerWeek(cadence: TopicVideoCadence, month: number): number {
  if (!cadence.enabled) return 0
  const lift = cadence.seasonalLift && isPeakMonth(month) ? 1 : 0
  return Math.min(TOPIC_VIDEO_CADENCE_MAX, cadence.perWeek + lift)
}

/**
 * The weekdays (0=Sun) a tenant's topic videos run: `perWeek` slots spread as
 * evenly as the week allows from a tenant-derived first day, one per day at most.
 */
export function topicVideoWeekdays(brokerageId: string, month: number, cadence: TopicVideoCadence = TOPIC_VIDEO_CADENCE_DEFAULT): number[] {
  const n = topicVideosPerWeek(cadence, month)
  const first = hash(brokerageId) % 7
  const days: number[] = []
  for (let i = 0; i < n; i++) days.push((first + Math.floor((i * 7) / n)) % 7)
  return days
}

/** Today's slot index in the tenant's week, or -1 when today is not one of its days. */
export function topicVideoSlotToday(brokerageId: string, d: Date, cadence: TopicVideoCadence = TOPIC_VIDEO_CADENCE_DEFAULT): number {
  return topicVideoWeekdays(brokerageId, d.getUTCMonth(), cadence).indexOf(d.getUTCDay())
}

export function isTopicVideoDay(brokerageId: string, d: Date, cadence: TopicVideoCadence = TOPIC_VIDEO_CADENCE_DEFAULT): boolean {
  return topicVideoSlotToday(brokerageId, d, cadence) >= 0
}

// ── SHAPE: category → archetype chain → first whose needs are met ───────────

/**
 * The needs-free archetypes a chain may END in, in preference order. Which one a
 * run ends in is DERIVED from the host (archetypeHosts — the composition
 * registry): education_explainer rides the avatar (owner rule: explainers present
 * with the circle avatar); voiceover_explainer rides the agent's voice alone.
 */
const TOPIC_TERMINAL_ARCHETYPES: readonly CustomVideoArchetype[] = ["education_explainer", "voiceover_explainer"]

/** The needs-free archetype the host can carry, or null when no registered composition carries one on it. */
export function terminalArchetypeFor(host: HostKind): CustomVideoArchetype | null {
  return TOPIC_TERMINAL_ARCHETYPES.find((a) => Object.keys(CUSTOM_ARCHETYPE_REGISTRY[a].needs).length === 0 && archetypeHosts(a).includes(host)) ?? null
}

/** Category → preferred archetype chain. Every chain ENDS in education_explainer (needs nothing); a run swaps it for the host's terminal. */
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
  // The chain's needs-free end is the one THIS host can carry (derived).
  const terminal = terminalArchetypeFor(host)
  if (terminal && terminal !== "education_explainer") chain.splice(chain.length - 1, 1, terminal)
  const skipped: TopicArchetypeChoice["skipped"] = []
  for (const archetype of chain) {
    const verdict = classifyCustomVideoBrief({ audience: "", goal: topic.topic_title, host, assets, archetypeHint: archetype })
    if (verdict.ok) return { archetype, why: rule ? rule.why : "no category rule — the explainer is the safe shape", skipped }
    skipped.push({ archetype, reason: verdict.reason })
  }
  // The chain's last member needs nothing but a registered host; reaching here means the HOST cannot carry it.
  return { archetype: terminal ?? "education_explainer", why: `no chain member fits the ${host} host — refused downstream by the planner`, skipped }
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
  persona: TopicVideoPersona
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

/** The categories a persona's pick filters on (writer spellings — test:topic-pool-video §vocab). */
export function topicCategoriesForPersona(persona: TopicVideoPersona): string[] {
  return [...TOPIC_PERSONA_RULES[persona].categories]
}

/** The side the compliance scan and postcheck read a persona as. */
export function topicPersonaSide(persona: TopicVideoPersona): "buyer" | "seller" {
  return TOPIC_PERSONA_RULES[persona].side
}

/** What the model returns for a topic script (the runner's schema mirrors it). */
interface TopicScriptCopy { script: string; title: string; hook: string; bullets: string[] }

/**
 * The composition content for a topic video — keyed by the PLANNED composition,
 * because the voiceover explainer rides NewsletterDigestVideo's content contract
 * (subject / marketBeat / sectionTitles are required there) with its labels
 * re-worded for a topic (the defaults read "this week's digest"). Every other
 * composition takes the script, title and bullets as the described-video rail does.
 */
export function topicVideoContent(compositionId: string, copy: TopicScriptCopy): Record<string, unknown> {
  const base = { captionScript: copy.script, caption: copy.script, title: copy.title, bullets: copy.bullets }
  if (compositionId !== "NewsletterDigestVideo") return base
  return {
    ...base,
    subject: copy.title,
    marketBeat: copy.hook,
    sectionTitles: copy.bullets.slice(0, 3),
    beatLabel: "Worth knowing",
    sectionsLabel: "Three things to know",
    endHeadline: "Have a question?",
    endSubline: "Ask me — happy to walk you through it",
  }
}

/**
 * The script prompt — compliance-first (CLAUDE.md §5: fair housing in the WRITING
 * prompt, not only the scan). The runner wraps it in withSpokenScriptStandards and
 * prepends the tenant's compliance system blocks.
 */
export function topicScriptPrompt(args: { topic: TopicLike; persona: TopicVideoPersona; words: number; archetype: CustomVideoArchetype }): string {
  const spec = CUSTOM_ARCHETYPE_REGISTRY[args.archetype]
  return [
    `Write a short spoken video script (about ${args.words} words) for a local real-estate agent.`,
    `Topic: ${args.topic.topic_title}${args.topic.value_angle ? ` — ${args.topic.value_angle}` : ""}.`,
    `Audience: ${PERSONA_AUDIENCE[args.persona]}. Speak to the SITUATION, never to a group of people.`,
    `Shape: ${args.archetype.replace(/_/g, " ")} — ${spec.why}`,
    "Structure: a one-line hook that names the viewer's situation; three short beats that teach one idea; one soft next step (a question they can ask the agent). Not salesy; no urgency; no guarantees.",
    "Never invent numbers, rates, prices or statistics — if a number matters, say where to find it. Never describe who lives somewhere or who a place is 'for'; describe the home and the process only (Fair Housing Act).",
    "Also return a 3-6 word on-screen title, a one-line on-screen hook of at most 12 words, and three on-screen bullets of at most 6 words each.",
  ].join("\n")
}
