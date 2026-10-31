/**
 * lib/buyer-search/conversational-search.ts — THE CONVERSATIONAL BUYER TURN (wave 147, lane 147C,
 * owner ruling 16, contract C10).
 *
 * Owner (2026-10-31): "Buyers find properties the way Deli (usedeli.com) does — natural language
 * and voice, explainable matching to the buyer's criteria — delivered INSIDE the existing Shopping
 * Agent / buyer search and portal; no second search system."
 *
 * NOT A SECOND SEARCH SYSTEM. Every piece this module composes already existed and stays the
 * survivor: the ONE NL parser (parse-buyer-criteria.ts → conversation-criteria.ts →
 * intent-parser.ts), the ONE criteria store (buyer-criteria.ts → property_preferences), the ONE
 * search engine (search-engine.ts searchPropertiesCore → our inventory + the authorized external
 * feeds), the behaviour learner's signals (saved_properties, written by lib/kernel/forms.ts
 * recordBuyerPropertyAction), the alert proposal rail (written-criteria-alert.ts), the showing
 * request (app/actions/showings.ts) and the manager bus (publishManagerSignal). What was MISSING,
 * and is built here as pure functions the portal actions call:
 *
 *   1. applyConversationTurn — a turn's parsed criteria merged onto the stored criteria with
 *      PER-FIELD PROVENANCE (said | inferred | default) and a change record per field whose
 *      reason quotes the buyer ("You said …"). Refinement semantics: a buyer's words outrank
 *      behaviour; "instead / only / just" replaces a list, otherwise a said list grows.
 *   2. learnFromBehaviour — saved / dismissed / toured homes become PROPOSED changes with a stated
 *      reason ("You saved 2 homes above your $600k limit"). A field the buyer SAID is never changed
 *      by behaviour: the change waits for the buyer to accept. A deal-breaker is never learned
 *      silently. A value the buyer rejected is never proposed again.
 *   3. shouldNotifyAgent — the human agent hears about MATERIAL changes and explicit asks (a tour,
 *      "talk to my agent"), not every keystroke; the bus also dedupes one open signal per contact.
 *   4. voiceTurnPlan — the spoken turn: at most three homes, one sentence each, unknowns said as
 *      unknowns, and exactly ONE question at the end (voice turn-taking: the buyer answers, then
 *      taps to talk again — the portal never listens unprompted).
 *   5. narrateFitExplanation — the optional model-written "why this home" in a neighbour's voice,
 *      grounded ONLY on the deterministic fit (explanation-generator.ts explainCriteriaFit),
 *      validated (no number the facts do not hold, no unknown restated as fact) and steering-
 *      checked (fair-housing.ts) because it is copy WE author. It falls back to the deterministic
 *      composeNeighbourlyExplanation, and the unknowns sentence is always code-authored.
 *
 * FAIR HOUSING: capture is not steering (conversation-criteria.ts header). Nothing here sanitizes
 * the buyer's stated criteria; the steering check runs on what WE say back.
 */
import {
  type ConversationCriteria,
  type LifestyleAsk,
  type LifestyleKind,
  type ClarifyingQuestion,
  AGE_RESTRICTED_LABEL,
} from "./conversation-criteria"
import {
  type BuyerCriteria,
  type CriteriaChangeDraft,
  type CriteriaChannel,
  type CriteriaField,
  type CriteriaChangeTrigger,
  type FieldProvenance,
  provenanceOf,
} from "./buyer-criteria"
import { composeNeighbourlyExplanation, numbersAreGrounded, restatesUnknown, type CriteriaFit } from "./explanation-generator"
import { scanFairHousing } from "./fair-housing"
import type { ParsedBuyerIntent } from "./intent-parser"

// ─── 0. The store → search glue (called by search-engine.ts searchPropertiesCore) ──

/**
 * PURE. The search intent with the buyer's STORED criteria filling what this query did not say
 * (the one store — a criterion said by email or on a call shapes the portal search too). The
 * query's own words win; the store only fills gaps.
 */
export function intentWithStoredCriteria(intent: ParsedBuyerIntent, criteria: BuyerCriteria | null | undefined): ParsedBuyerIntent {
  if (!criteria) return intent
  const out: ParsedBuyerIntent = { ...intent }
  if (out.maxPrice == null && out.minPrice == null) {
    if (criteria.maxPrice != null) out.maxPrice = criteria.maxPrice
    if (criteria.minPrice != null) out.minPrice = criteria.minPrice
  }
  if (out.minBeds == null && criteria.minBeds != null) out.minBeds = criteria.minBeds
  if (out.minBaths == null && criteria.minBaths != null) out.minBaths = criteria.minBaths
  if (!out.cities?.length && !out.zipCodes?.length) {
    if (criteria.cities.length) out.cities = [...criteria.cities]
    if (criteria.zipCodes.length) out.zipCodes = [...criteria.zipCodes]
  }
  if (!out.propertyTypes?.length && criteria.propertyTypes.length) out.propertyTypes = [...criteria.propertyTypes]
  if (!out.listingType && criteria.listingType === "rent") out.listingType = "rent"
  return out
}

/**
 * PURE. The criteria a search result is EXPLAINED against: the stored criteria (with provenance),
 * plus this query's own fields marked as said when the store does not have them yet.
 */
export function fitCriteriaFor(intent: ParsedBuyerIntent, criteria: BuyerCriteria | null | undefined): BuyerCriteria {
  const at = new Date().toISOString()
  const said = (value: unknown): FieldProvenance => ({ source: "said", value, evidence: intent.rawQuery.slice(0, 160), channel: null, at, reason: null })
  const base = cloneCriteria(criteria ?? null)
  const prov = base.provenance!
  if (base.maxPrice == null && intent.maxPrice != null) { base.maxPrice = intent.maxPrice; prov.maxPrice = said(intent.maxPrice) }
  if (base.minBeds == null && intent.minBeds != null) { base.minBeds = intent.minBeds; prov.minBeds = said(intent.minBeds) }
  if (base.minBaths == null && intent.minBaths != null) { base.minBaths = intent.minBaths; prov.minBaths = said(intent.minBaths) }
  if (!base.cities.length && intent.cities?.length) { base.cities = [...intent.cities]; prov.cities = said(intent.cities) }
  if (!base.zipCodes.length && intent.zipCodes?.length) { base.zipCodes = [...intent.zipCodes]; prov.zipCodes = said(intent.zipCodes) }
  if (!base.propertyTypes.length && intent.propertyTypes?.length) { base.propertyTypes = [...intent.propertyTypes]; prov.propertyTypes = said(intent.propertyTypes) }
  if (!base.mustHaveFeatures.length && intent.features?.length) { base.mustHaveFeatures = [...intent.features]; prov.mustHaveFeatures = said(intent.features) }
  return base
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** What one turn's parse hands the merge — the superset ParsedBuyerCriteria already returns. */
export interface TurnParse {
  criteria: ConversationCriteria
  evidence: string[]
  lifestyle: LifestyleAsk[]
  dealBreakers: string[]
  priority?: { up: LifestyleKind | null; down: LifestyleKind | null }
}

export interface TurnContext {
  text: string
  channel: CriteriaChannel
  at: string
  trigger: Extract<CriteriaChangeTrigger, "stated" | "corrected" | "feedback">
}

export function emptyCriteria(): BuyerCriteria {
  return {
    minPrice: null, maxPrice: null, minBeds: null, minBaths: null,
    cities: [], zipCodes: [], propertyTypes: [], mustHaveFeatures: [], dealBreakers: [],
    confidenceScore: null, listingType: null, lifestyle: [], provenance: {},
  }
}

function cloneCriteria(c: BuyerCriteria | null): BuyerCriteria {
  const b = c ?? emptyCriteria()
  return {
    ...b,
    cities: [...b.cities], zipCodes: [...b.zipCodes], propertyTypes: [...b.propertyTypes],
    mustHaveFeatures: [...b.mustHaveFeatures], dealBreakers: [...b.dealBreakers],
    lifestyle: [...(b.lifestyle ?? [])], provenance: { ...(b.provenance ?? {}) },
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}…` : s)
const union = (a: string[], b: string[]) => {
  const out = [...a]
  for (const v of b) if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v)
  return out
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString("en-US")}`
}

// ─── 1. The turn ─────────────────────────────────────────────────────────────

/**
 * PURE. Merge one turn onto the stored criteria. Every field the turn states becomes `said`
 * with the buyer's quote as evidence; every field that actually changed yields an `applied`
 * change draft the buyer can undo. Fields the turn does not mention are left exactly as they
 * were (with their provenance) — a turn never erases what it did not talk about.
 */
export function applyConversationTurn(
  current: BuyerCriteria | null,
  parsed: TurnParse,
  turn: TurnContext,
): { next: BuyerCriteria; changes: CriteriaChangeDraft[] } {
  const next = cloneCriteria(current)
  const changes: CriteriaChangeDraft[] = []
  const replaceLists = /\b(instead|only|just|rather than|switch to|no longer)\b/i.test(turn.text)
  const quoteFor = (needle: string | number | null): string => {
    const n = needle == null ? "" : String(needle).toLowerCase()
    const hit = n ? parsed.evidence.find((e) => e.toLowerCase().includes(n.replace(/000$/, ""))) : undefined
    return clip(hit ?? parsed.evidence[0] ?? turn.text.trim())
  }
  const said = (value: unknown, quote: string): FieldProvenance => ({
    source: "said", value, evidence: quote, channel: turn.channel, at: turn.at, reason: null,
  })
  const set = (field: CriteriaField, value: unknown, needle: string | number | null) => {
    const prev = (next as any)[field]
    const quote = quoteFor(needle)
    if (same(prev, value)) {
      // Same value, now confirmed in the buyer's own words: provenance upgrades to "said".
      if (provenanceOf(next, field) !== "said") next.provenance![field] = said(value, quote)
      return
    }
    ;(next as any)[field] = value
    next.provenance![field] = said(value, quote)
    changes.push({
      field, previous: prev ?? null, proposed: value, provenance: "said", trigger: turn.trigger,
      reason: turn.trigger === "corrected" ? "You changed this yourself" : `You said "${quote}"`,
      evidence: { quote, channel: turn.channel }, status: "applied", channel: turn.channel,
    })
  }
  const c = parsed.criteria

  if (c.maxPrice != null) set("maxPrice", c.maxPrice, c.maxPrice)
  if (c.minPrice != null) set("minPrice", c.minPrice, c.minPrice)
  if (next.minPrice != null && next.maxPrice != null && next.minPrice > next.maxPrice) {
    // "300-400" earlier, "under 250" now: the refinement wins (conversation-criteria.ts rule).
    set("minPrice", null, c.maxPrice ?? null)
  }
  if (c.minBeds != null) set("minBeds", c.minBeds, `${c.minBeds}`)
  if (c.minBaths != null) set("minBaths", c.minBaths, `${c.minBaths}`)
  if (c.listingType) set("listingType", c.listingType, c.listingType === "rent" ? "rent" : null)

  const listField = (field: "cities" | "zipCodes" | "propertyTypes", incoming: string[] | undefined) => {
    if (!incoming?.length) return
    const existing = (next as any)[field] as string[]
    // A buyer's words outrank behaviour: an inferred list is replaced, a said list grows
    // unless the buyer says "instead / only / just".
    const value = replaceLists || provenanceOf(next, field) !== "said" ? [...incoming] : union(existing, incoming)
    set(field, value, incoming[0])
  }
  listField("cities", c.cities)
  listField("zipCodes", c.zipCodes)
  listField("propertyTypes", c.propertyTypes)

  const features = [...(c.features ?? []), ...(c.ageRestrictedCommunity ? [AGE_RESTRICTED_LABEL] : [])]
  if (features.length) {
    const base = provenanceOf(next, "mustHaveFeatures") === "said" ? next.mustHaveFeatures : []
    set("mustHaveFeatures", union(base, features), features[0])
  }
  if (parsed.dealBreakers.length) {
    const base = provenanceOf(next, "dealBreakers") === "said" ? next.dealBreakers : []
    set("dealBreakers", union(base, parsed.dealBreakers), parsed.dealBreakers[0])
    // "no pool" now beats "a pool" said earlier — the latest statement is the buyer's wish.
    const keep = next.mustHaveFeatures.filter((f) => !parsed.dealBreakers.some((d) => f.toLowerCase().includes(d)))
    if (keep.length !== next.mustHaveFeatures.length) set("mustHaveFeatures", keep, parsed.dealBreakers[0])
  }

  if (parsed.lifestyle.length || parsed.priority?.up) {
    let life = provenanceOf(next, "lifestyle") === "said" ? [...(next.lifestyle ?? [])] : []
    for (const ask of parsed.lifestyle) {
      const at = life.findIndex((x) => x.kind === ask.kind && (x.kind !== "layout" || x.label === ask.label))
      if (at >= 0) life[at] = ask
      else life.push(ask)
    }
    if (parsed.priority?.up) {
      const up = parsed.priority.up, down = parsed.priority.down
      life = [...life.filter((a) => a.kind === up), ...life.filter((a) => a.kind !== up && a.kind !== down), ...life.filter((a) => a.kind === down)]
    }
    const before = next.lifestyle ?? []
    set("lifestyle", life, parsed.lifestyle[0]?.evidence ?? null)
    if (parsed.priority?.up && !same(before.map((a) => a.kind), life.map((a) => a.kind)) && changes.length && changes[changes.length - 1].field === "lifestyle") {
      changes[changes.length - 1].trigger = "priority_change"
    }
  }
  return { next, changes }
}

// ─── 2. Learning from behaviour ──────────────────────────────────────────────

export interface HomeSignal {
  kind: "saved" | "dismissed" | "toured"
  price: number | null
  city: string | null
  propertyType: string | null
  listingRef: string
}

export interface PriorDecision { field: string; proposed: unknown; status: string }

const roundUp5k = (n: number) => Math.ceil(n / 5000) * 5000

/**
 * PURE. Behaviour → change drafts, each with the reason the buyer reads. Needs ≥ 2 consistent
 * signals (one save is a whim, two is a pattern). A field the buyer SAID only ever receives a
 * PROPOSAL; an inferred/empty field may be APPLIED (still undoable). Deal-breakers are always
 * proposals. Open proposals and rejected values are never re-proposed.
 */
export function learnFromBehaviour(
  current: BuyerCriteria,
  history: HomeSignal[],
  opts: { channel: CriteriaChannel; prior?: PriorDecision[] },
): CriteriaChangeDraft[] {
  const out: CriteriaChangeDraft[] = []
  const prior = opts.prior ?? []
  const blocked = (field: CriteriaField, proposed: unknown) =>
    prior.some((p) => p.field === field && (p.status === "proposed" || p.status === "rejected") && same(p.proposed, proposed))
  const statusFor = (field: CriteriaField): "proposed" | "applied" => (provenanceOf(current, field) === "said" ? "proposed" : "applied")
  const liked = history.filter((h) => h.kind === "saved" || h.kind === "toured")

  if (current.maxPrice != null) {
    const above = liked.filter((h) => h.price != null && h.price > current.maxPrice!)
    if (above.length >= 2) {
      const top = Math.max(...above.map((h) => h.price!))
      const proposed = roundUp5k(top)
      if (!blocked("maxPrice", proposed)) {
        out.push({
          field: "maxPrice", previous: current.maxPrice, proposed, provenance: "inferred", trigger: "saved",
          reason: `You saved ${above.length} homes above your ${fmtMoney(current.maxPrice)} limit (up to ${fmtMoney(top)}) — raise your top number to ${fmtMoney(proposed)}?`,
          evidence: { listings: above.map((h) => h.listingRef).slice(0, 5) }, status: statusFor("maxPrice"), channel: opts.channel,
        })
      }
    }
  }

  const cityCounts = new Map<string, number>()
  for (const h of liked) if (h.city && !current.cities.some((c) => c.toLowerCase() === h.city!.toLowerCase())) cityCounts.set(h.city, (cityCounts.get(h.city) ?? 0) + 1)
  for (const [city, n] of cityCounts) {
    if (n < 2) continue
    const proposed = union(current.cities, [city])
    if (blocked("cities", proposed)) continue
    out.push({
      field: "cities", previous: current.cities, proposed, provenance: "inferred", trigger: "saved",
      reason: `You saved ${n} homes in ${city} — add ${city} to the areas I watch?`,
      evidence: { city, count: n }, status: statusFor("cities"), channel: opts.channel,
    })
  }

  const typeCounts = new Map<string, number>()
  for (const h of history) if (h.kind === "dismissed" && h.propertyType) typeCounts.set(h.propertyType, (typeCounts.get(h.propertyType) ?? 0) + 1)
  for (const [type, n] of typeCounts) {
    const label = type.replace(/_/g, " ")
    if (n < 2 || current.dealBreakers.includes(label)) continue
    if (provenanceOf(current, "propertyTypes") === "said" && current.propertyTypes.includes(type)) continue // they asked for it
    const proposed = union(current.dealBreakers, [label])
    if (blocked("dealBreakers", proposed)) continue
    out.push({
      field: "dealBreakers", previous: current.dealBreakers, proposed, provenance: "inferred", trigger: "dismissed",
      reason: `You passed on ${n} ${label}s — stop showing them?`,
      evidence: { propertyType: type, count: n }, status: "proposed", channel: opts.channel,
    })
  }
  return out
}

/** PURE. The criteria after the buyer ACCEPTS a change: the value becomes theirs ("said"). */
export function applyAcceptedChange(current: BuyerCriteria, change: { field: CriteriaField; proposed: unknown; reason: string }, at: string, channel: CriteriaChannel): BuyerCriteria {
  const next = cloneCriteria(current)
  ;(next as any)[change.field] = change.proposed
  next.provenance![change.field] = { source: "said", value: change.proposed, evidence: `Accepted: ${change.reason}`, channel, at, reason: change.reason }
  return next
}

/** PURE. The criteria after the buyer UNDOES an applied change: the previous value returns. */
export function revertChange(current: BuyerCriteria, change: { field: CriteriaField; previous: unknown; proposed: unknown }, at: string, channel: CriteriaChannel): BuyerCriteria {
  const next = cloneCriteria(current)
  if (!same((next as any)[change.field], change.proposed)) return next // already moved on — do not clobber a newer value
  const empty = Array.isArray(change.proposed) ? [] : null
  ;(next as any)[change.field] = change.previous ?? empty
  next.provenance![change.field] = { source: "said", value: change.previous ?? empty, evidence: "You undid the change", channel, at, reason: "undo" }
  return next
}

// ─── 3. Telling the human agent — without flooding them ──────────────────────

const MATERIAL_FIELDS: CriteriaField[] = ["minPrice", "maxPrice", "minBeds", "cities", "zipCodes", "listingType", "propertyTypes"]

/** PURE. Notify the buyer's agent only for a material said/accepted change or an explicit ask. */
export function shouldNotifyAgent(input: {
  changes: Array<Pick<CriteriaChangeDraft, "field" | "status" | "provenance">>
  requested?: "showing" | "agent" | null
}): { notify: boolean; reason: string } {
  if (input.requested === "showing") return { notify: true, reason: "the buyer asked for a showing" }
  if (input.requested === "agent") return { notify: true, reason: "the buyer asked to talk to their agent" }
  const material = input.changes.filter((c) => MATERIAL_FIELDS.includes(c.field) && c.status !== "proposed")
  if (material.length > 0) return { notify: true, reason: `the buyer changed ${[...new Set(material.map((m) => m.field))].join(", ")}` }
  return { notify: false, reason: input.changes.length ? "only non-material changes (lifestyle, features, or proposals still waiting on the buyer)" : "no criteria changed" }
}

// ─── 4. What the buyer sees / hears next ─────────────────────────────────────

export interface CriteriaChip { field: CriteriaField; label: string; provenance: "said" | "inferred" | "default" }

/** PURE. The editable criteria as chips, each labelled with its provenance. */
export function criteriaChips(c: BuyerCriteria): CriteriaChip[] {
  const chips: CriteriaChip[] = []
  const add = (field: CriteriaField, label: string | null) => {
    const p = provenanceOf(c, field)
    if (label && p) chips.push({ field, label, provenance: p })
  }
  add("listingType", c.listingType === "rent" ? "Renting" : c.listingType === "sale" ? "Buying" : "Buying (default)")
  if (c.minPrice != null && c.maxPrice != null) { add("minPrice", `From ${fmtMoney(c.minPrice)}`); add("maxPrice", `Up to ${fmtMoney(c.maxPrice)}`) }
  else { add("maxPrice", c.maxPrice != null ? `Up to ${fmtMoney(c.maxPrice)}` : null); add("minPrice", c.minPrice != null ? `From ${fmtMoney(c.minPrice)}` : null) }
  add("minBeds", c.minBeds != null ? `${c.minBeds}+ beds` : null)
  add("minBaths", c.minBaths != null ? `${c.minBaths}+ baths` : null)
  add("cities", c.cities.length ? c.cities.join(", ") : null)
  add("zipCodes", c.zipCodes.length ? c.zipCodes.join(", ") : null)
  add("propertyTypes", c.propertyTypes.length ? c.propertyTypes.map((t) => t.replace(/_/g, " ")).join(" / ") : null)
  add("mustHaveFeatures", c.mustHaveFeatures.length ? `Must have: ${c.mustHaveFeatures.join(", ")}` : null)
  add("dealBreakers", c.dealBreakers.length ? `Not: ${c.dealBreakers.join(", ")}` : null)
  add("lifestyle", (c.lifestyle ?? []).length ? (c.lifestyle ?? []).map((l) => l.label).join(" · ") : null)
  return chips
}

export interface NextExperience {
  key: "answer_question" | "save_alert" | "request_showing" | "ask_agent" | "compare_homes" | "analyze_any_home" | "widen_search"
  label: string
  why: string
}

/** PURE. The next-best experiences after a turn — each maps to a surface that already exists. */
export function nextBestExperiences(input: {
  resultsCount: number
  clarifications: ClarifyingQuestion[]
  criteria: BuyerCriteria
  savedCount?: number
}): NextExperience[] {
  const out: NextExperience[] = []
  if (input.clarifications.length) out.push({ key: "answer_question", label: input.clarifications[0].question, why: "answering it changes which homes come back" })
  if (input.resultsCount === 0) out.push({ key: "widen_search", label: "Widen the price or area a little", why: "nothing matches every ask right now" })
  if (input.resultsCount > 0) out.push({ key: "request_showing", label: "Ask your agent to set up a tour", why: "seeing it is the only way to judge the unknowns" })
  if ((input.savedCount ?? 0) >= 2) out.push({ key: "compare_homes", label: "Compare your saved homes side by side", why: "you have more than one in the running" })
  const enough = (input.criteria.cities.length || input.criteria.zipCodes.length) && (input.criteria.maxPrice != null || input.criteria.minBeds != null)
  if (enough) out.push({ key: "save_alert", label: "Keep watching for new matches", why: "new listings that fit reach you first; your agent approves the alert" })
  out.push({ key: "ask_agent", label: "Talk it through with your agent", why: "they know the neighborhoods and the listings behind the data" })
  return out.slice(0, 4)
}

// The voice turn-taking model lives in the client-safe ./voice-turn.ts (the portal composes what it
// SPEAKS without bundling a server import); re-exported here so the C10 surface reads as one.
export { voiceTurnPlan, spokenPrice } from "./voice-turn"

// ─── Corrections and learned (applied) changes ──────────────────────────────

/**
 * PURE. The buyer edits one field themselves — the value becomes `said` (trigger "corrected") and
 * the change is recorded so it can be undone like any other.
 */
export function applyCorrection(
  current: BuyerCriteria | null, field: CriteriaField, value: unknown, at: string, channel: CriteriaChannel,
): { next: BuyerCriteria; change: CriteriaChangeDraft | null } {
  const next = cloneCriteria(current)
  const prev = (next as any)[field]
  if (same(prev, value) && provenanceOf(next, field) === "said") return { next, change: null }
  ;(next as any)[field] = value
  next.provenance![field] = { source: "said", value, evidence: "Edited by the buyer", channel, at, reason: null }
  return {
    next,
    change: { field, previous: prev ?? null, proposed: value, provenance: "said", trigger: "corrected", reason: "You changed this yourself", evidence: { channel }, status: "applied", channel },
  }
}

/** PURE. Apply the learned drafts whose status is "applied" — provenance "inferred", reason kept. */
export function applyLearnedChanges(current: BuyerCriteria, drafts: CriteriaChangeDraft[], at: string): BuyerCriteria {
  const next = cloneCriteria(current)
  for (const d of drafts) {
    if (d.status !== "applied" || provenanceOf(next, d.field) === "said") continue // never over a said value
    ;(next as any)[d.field] = d.proposed
    next.provenance![d.field] = { source: "inferred", value: d.proposed, evidence: d.reason, channel: d.channel, at, reason: d.reason }
  }
  return next
}

// ─── 5. The narrated explanation (model-written, grounded, validated) ───────

/**
 * THE EXPLANATION PROMPT (wave 147C — preamble rule: prompt quality is a deliverable).
 * Role → business context → facts it may rely on → what it must not do → the decision it
 * owns → output contract → escalation. Its output is then validated in code; the unknowns
 * sentence is never model-authored.
 */
export const EXPLANATION_SYSTEM = [
  "ROLE: You are the buyer's home-search guide at a real-estate brokerage. You write the way a knowledgeable, unhurried neighbour who happens to know real estate talks: plain, warm, specific, never salesy.",
  "BUSINESS CONTEXT: A buyer asked why a home came up in their search. A deterministic matcher has already compared the listing's data with the buyer's criteria; you explain ITS verdict, you do not make your own. Your words appear in the buyer's client portal and their agent can read them.",
  "FACTS YOU MAY RELY ON: only the JSON block — the listing's own data points and the matcher's `matches` and `misses`. Each item says its source: `listing` is the listing's data feed; `listing_remarks` is the listing agent's own description, which you must attribute ('the listing says…'), never state as verified.",
  "YOU MUST NOT: invent or embellish any fact — condition, light, views, noise, commute, schools, neighbourhood character, who lives nearby, investment returns, 'move-in ready', 'won't last'. Do not mention anything the matcher could not answer; the application says those itself. Do not write a number that is not in the facts. Do not describe people, demographics, safety, schools, religion, or say a home suits any kind of household. No pressure or urgency language.",
  "THE DECISION YOU OWN: the order and the wording. Lead with what the buyer SAID they want (provenance `said`) before anything inferred, give the misses honestly in one sentence, and end with one low-pressure next step (a tour, a question for their agent, a comparison).",
  "OUTPUT CONTRACT: JSON { headline: at most 12 words, narrative: 2 to 4 sentences }. Second person. No emojis, no markdown, no exclamation marks.",
  "ESCALATION: if the facts are too thin to say anything true (no matches), say plainly that it only partly fits and suggest asking their agent. Never pad.",
].join("\n")

// The draft validators (numbersAreGrounded, restatesUnknown) live beside the fit they check, in
// ./explanation-generator.ts, and are imported above.

export interface NarratedExplanation {
  headline: string
  narrative: string
  /** Code-authored, always present when the fit has unknowns. */
  unknownsSentence: string | null
  via: "model" | "deterministic"
  /** Why the model text was not used (validation, steering check, spend not allowed, error). */
  note: string | null
  /** Fair-housing labels the steering check flagged on the model's draft; [] = nothing fired. */
  fairHousingFlagged: string[]
}

/**
 * Explain one home in a neighbour's voice. The model call books to the tenant (`brokerageId`
 * from the session) under the client-facing portal lane; with no tenant, or a draft that fails
 * validation or the steering check, the deterministic explanation is returned and the reason is
 * stated. Never throws.
 */
export async function narrateFitExplanation(input: {
  brokerageId: string | null
  userId?: string | null
  listingLabel: string
  fit: CriteriaFit
  facts: Record<string, unknown>
  allowModel?: boolean
}): Promise<NarratedExplanation> {
  const fallback = composeNeighbourlyExplanation(input.fit, input.listingLabel)
  const deterministic = (note: string | null, flagged: string[] = []): NarratedExplanation => ({ ...fallback, via: "deterministic", note, fairHousingFlagged: flagged })
  if (input.allowModel === false) return deterministic(null)
  if (!input.brokerageId) return deterministic("No tenant to book the AI spend against — the deterministic explanation is shown.")
  if (input.fit.matches.length === 0 && input.fit.misses.length === 0) return deterministic(null)

  const factsBlock = JSON.stringify({
    listing: input.listingLabel,
    listing_data: input.facts,
    matches: input.fit.matches.map((m) => ({ ask: m.ask, detail: m.detail, source: m.source, provenance: m.provenance })),
    misses: input.fit.misses.map((m) => ({ ask: m.ask, detail: m.detail, source: m.source, provenance: m.provenance })),
  })
  try {
    const { z } = await import("zod")
    const { generateObjectRouted } = await import("@/lib/ai/models")
    const { object } = await generateObjectRouted({
      // portal_message: "Client portal messages — relationship-critical, client-facing" (the
      // routed lane for copy shown to a client in their portal). A dedicated cheaper lane is
      // requested in the lane-147C notes (Outside-lane); until then this is the honest key.
      feature: "portal_message",
      brokerageId: input.brokerageId,
      userId: input.userId ?? null,
      system: EXPLANATION_SYSTEM,
      prompt: `Facts (JSON):\n${factsBlock}\n\nWrite the explanation.`,
      maxTokens: 300,
      temperature: 0.3,
      schema: z.object({ headline: z.string(), narrative: z.string() }),
    })
    const headline = String((object as { headline?: string }).headline ?? "").trim()
    const narrative = String((object as { narrative?: string }).narrative ?? "").trim()
    if (!headline || !narrative) return deterministic("The model returned an empty explanation.")
    const both = `${headline} ${narrative}`
    if (!numbersAreGrounded(both, factsBlock)) return deterministic("The model wrote a number the listing data does not hold — not shown.")
    const restated = restatesUnknown(both, input.fit)
    if (restated) return deterministic(`The model spoke to "${restated}", which the listing data cannot answer — not shown.`)
    // STEERING CHECK on copy WE author (the recommendation path, ruling 2 / brief rule 8).
    const scan = scanFairHousing(both)
    if (scan.flagged.length > 0) return deterministic("The steering check flagged the model's wording — the deterministic explanation is shown.", scan.flagged)
    return { headline, narrative, unknownsSentence: fallback.unknownsSentence, via: "model", note: null, fairHousingFlagged: [] }
  } catch (err) {
    return deterministic(`The model explanation was unavailable (${err instanceof Error ? err.message : "error"}).`)
  }
}
