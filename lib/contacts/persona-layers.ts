// lib/contacts/persona-layers.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE FIVE-LAYER PERSONA MODEL, ITS EXPERT PROMPT AND ITS MARKETING FIREWALL (wave 148, lane 148C — owner ruling 1, 2026-11-01).
//
// OWNER, verbatim: "the read of protected or prohibited can be used to determine the person's persona so users can create ads and
// posts, etc. around that persona." And (2026-11-03, wave 149 — lane 149A, the reversal): "Every persona is allowed and this
// can't change." A persona describes the person's SITUATION (first_time, relocated, luxury, fsbo, probate, upsize, downsize,
// military, divorce, senior, expired, foreclosure, investor …) so the OS can speak to their pain points and help.
// TOMBSTONE (149A): wave 148C made the marketing persona "needs-based only — never a protected characteristic" (the four
// situation personas senior / probate / divorce / military could never be the campaign persona, and the field-token
// classifier screened every word of messaging). REMOVED with no survivor — the restriction was the defect. The marketing
// persona may name ANY situation persona. What stays, because it is the law on WORDING: every word of messaging passes the
// copy scans (lib/compliance-rules/fair-housing-patterns.ts + the proxy-term screen in lib/compliance-rules/audience-compliance.ts)
// and no Layer-1 research VALUE is ever echoed. Five layers stay SEPARATE:
//
//   1 research_attributes   — the original provider / research attributes (protected included). READ through the purpose-gated
//                             reader (lib/enrichment/protected-research-store.ts, purpose persona_derivation). They may shape the
//                             CUSTOMER-SERVICE profile (how we help); they never become a need, a persona label, an audience or a
//                             word of marketing copy, and their VALUES are never persisted on the persona row (names + classes only).
//   2 stated_needs          — what the person (or staff, recording the person) SAID: buyer criteria with "said" provenance
//                             (lib/buyer-search/buyer-criteria.ts), a confirmed intent (customer-360 basis person_stated / staff_entered).
//   3 behavioural_evidence  — what the person DID on our surfaces: portal / search / tours / forms (customer-360 engagement), the
//                             decayed behaviour score, a first-party action intent.
//   4 inferred_interests    — what a provider or our own computation SUGGESTS, each with a confidence (provider append, platform
//                             derived, inferred criteria) — append is not intent (customer-360's rule).
//   5 marketing_persona     — the situation persona + its needs, built ONLY from layers 2–4, its WORDING screened by the copy scans
//                             below; the one layer an ad, a post or a custom audience reads.
//
// INVENT NOTHING THE RECORDS HOLD (requirement 5). Every evidence item points at its canonical source (table.column / provider /
// the customer-360 slice); the service profile's channel, language, time and accessibility come from the contact's own columns
// (preferred_channel, preferred_language, preferred_contact_time, accessibility_preferences) — never re-derived by a model.
//
// AI EXPLAINS, DETERMINISTIC SERVICES GATE. The model studies the layers and proposes a service profile and a persona; every
// proposal is validated here: needs from the ONE vocabulary (MARKETING_NEEDS), each citing evidence of layers 2–4 that exists, the
// confidence capped by that evidence, every word screened by the copy scans — the fair-housing copy patterns
// (fair-housing-patterns.ts) and the proxy-term screen (lib/compliance-rules/audience-compliance.ts) — and no research VALUE may
// surface in any text. A refused element is DROPPED and recorded — the persona never fails open. With no model (or a
// refused answer) the deterministic floor below is the persona.
//
// PURE. No database, no client, no network, no server-only import — so scripts/persona-compliance-guard.ts drives every rule on
// fixtures, and the I/O half (persona-builder.ts) cannot grow a rule this half does not hold.

import { audienceProxyHits } from "@/lib/compliance-rules/audience-compliance"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { isCampaignPersona, normalizeContactPersona, type CampaignPersona } from "@/lib/campaigns/contact-sources"
import type { Customer360 } from "@/lib/enrichment/customer-360"
import type { BuyerCriteria } from "@/lib/buyer-search/buyer-criteria"

/** The five layers, in order — recorded on every derivation (persona-builder.ts derivation.layers) so a reader knows the shape. */
export const PERSONA_LAYERS = ["research_attributes", "stated_needs", "behavioural_evidence", "inferred_interests", "marketing_persona"] as const
type EvidenceLayer = "stated_needs" | "behavioural_evidence" | "inferred_interests"

/** Bump when the prompt or the output contract changes — stored on every derivation. */
export const PERSONA_PROMPT_VERSION = "persona-derivation:v2 (wave 149A — every persona allowed)"
/** A marketing persona reaches an audience (contacts.contact_persona, persona_segment) only at or above this confidence. */
export const AUDIENCE_MIN_CONFIDENCE = 0.6

// ─── THE ONE NEEDS VOCABULARY ───────────────────────────────────────────────────────────────────────────────────────────────

export type MarketingNeed =
  | "relocation_research" | "first_home_guidance" | "investor_interest" | "downsizing" | "more_space" | "luxury_property"
  | "selling_on_own" | "relisting_after_expired" | "distressed_property_options" | "home_value_curiosity" | "equity_planning"
  | "expressed_criteria" | "acreage_and_land" | "new_construction"
  // wave 149 (lane 149A, owner ruling 2026-11-03): the four situation personas wave 148 kept out of marketing.
  | "estate_property_sale" | "military_relocation" | "separation_home_decisions" | "later_life_housing"

interface NeedSpec {
  label: string
  /** The canonical situation persona this need selects in a persona_segment audience — ANY canonical persona (owner ruling
   *  2026-11-03, "every persona is allowed"; asserted canonical at load). null = the need shapes copy and content but selects no
   *  persona audience. */
  campaignPersona: CampaignPersona | null
  angles: readonly string[]
  educationTopics: readonly string[]
  hooks: Readonly<Record<"facebook" | "instagram" | "linkedin" | "tiktok", string>>
}

/**
 * THE needs a marketing persona may carry. A need describes the person's SITUATION — what they are trying to DO or LEARN, or the
 * PROPERTY they want — so the copy can speak to their pain points. Every key, label, angle, topic and hook is screened at module
 * load by the same copy scans the AI's answers pass (a vocabulary that could not pass its own gate would be a second, unchecked spelling — CLAUDE.md §6).
 */
export const MARKETING_NEEDS: Readonly<Record<MarketingNeed, NeedSpec>> = Object.freeze({
  relocation_research: {
    label: "Relocation research", campaignPersona: "relocated",
    angles: ["A neighbourhood-by-neighbourhood guide for someone new to the area", "Commute, amenity and cost-of-living questions answered from real data"],
    educationTopics: ["Comparing neighbourhoods from a distance", "Virtual tours and buying before you arrive"],
    hooks: { facebook: "Moving here soon? What would you want to know first?", instagram: "New to town? Here is how to compare neighbourhoods before you land.", linkedin: "Relocating for a role? The questions to ask before you choose where to live.", tiktok: "POV: you have to pick a neighbourhood in a city you have never lived in." },
  },
  first_home_guidance: {
    label: "First-home guidance", campaignPersona: "first_time",
    angles: ["What a first purchase really costs, step by step", "From pre-approval to keys without the guesswork"],
    educationTopics: ["Pre-approval explained", "Down-payment assistance programs overview", "What happens at closing"],
    hooks: { facebook: "Thinking about owning instead of renting? What is the one thing holding you back?", instagram: "Your first home, step by step: what nobody explains up front.", linkedin: "The first-purchase questions people are too polite to ask.", tiktok: "Things I wish someone told me before buying my first home." },
  },
  investor_interest: {
    label: "Investor interest", campaignPersona: "investor",
    angles: ["Cash-flow math on local rentals, shown openly", "Where the numbers work this quarter"],
    educationTopics: ["Rental cash-flow basics", "Reading a cap rate", "1031 exchange overview"],
    hooks: { facebook: "Running numbers on a rental? Here is how this market pencils out.", instagram: "The rental math, one property at a time.", linkedin: "A practical read on local rental yields this quarter.", tiktok: "Does this rental actually cash-flow? Let's do the math." },
  },
  downsizing: {
    label: "Downsizing", campaignPersona: "downsize",
    angles: ["Less house, less upkeep, more freedom", "Timing the sale of a long-held home and the next purchase"],
    educationTopics: ["Selling and buying at the same time", "Low-maintenance home features to look for"],
    hooks: { facebook: "Ready for less upkeep? What would your next home need to have?", instagram: "Smaller footprint, bigger life: what to look for.", linkedin: "Unlocking equity from a long-held home: the sequence that works.", tiktok: "How to sell the big house and buy the right-sized one without two moves." },
  },
  more_space: {
    label: "More space", campaignPersona: "upsize",
    angles: ["Room to grow into: what more space really costs here", "Bedrooms, offices and storage, compared honestly"],
    educationTopics: ["Buying before selling: bridge options", "Measuring usable space in a listing"],
    hooks: { facebook: "Running out of room? What would the next home need?", instagram: "More room, same budget? Here is what that buys here.", linkedin: "Home-office space is a real criterion now: how to shop for it.", tiktok: "We needed more space. Here is what that actually cost." },
  },
  luxury_property: {
    label: "Luxury property interest", campaignPersona: "luxury",
    angles: ["Architecture, finishes and views, presented in detail", "Private showings on your schedule"],
    educationTopics: ["Valuing custom homes", "Jumbo financing overview"],
    hooks: { facebook: "A closer look at the architecture of this market's standout homes.", instagram: "The details that make a home exceptional.", linkedin: "What drives value at the top of this market.", tiktok: "A walk-through of the finishes that matter." },
  },
  selling_on_own: {
    label: "Selling on their own", campaignPersona: "fsbo",
    angles: ["The paperwork and pricing questions owners ask most", "What a professional adds, shown plainly"],
    educationTopics: ["Pricing with comparable sales", "Disclosures sellers must know"],
    hooks: { facebook: "Selling it yourself? Here are the questions that trip owners up.", instagram: "Pricing your home with real comparable sales.", linkedin: "A plain-language checklist for owners selling directly.", tiktok: "Selling by owner? Watch this before you list." },
  },
  relisting_after_expired: {
    label: "Relisting after an expired listing", campaignPersona: "expired",
    angles: ["Why listings stall, and what changes the outcome", "A fresh pricing and presentation plan"],
    educationTopics: ["Reading days-on-market", "Presentation that earns showings"],
    hooks: { facebook: "Listing expired? Here is what usually changes the result.", instagram: "A fresh start for a home that did not sell.", linkedin: "Why good homes sit, and the fix.", tiktok: "My listing expired. Here is what we changed." },
  },
  distressed_property_options: {
    label: "Options for a distressed property", campaignPersona: "foreclosure",
    angles: ["Every option laid out, calmly and confidentially", "Timelines and choices explained without pressure"],
    educationTopics: ["Options before a foreclosure sale", "How a short sale works"],
    hooks: { facebook: "Behind on a property? Your options, explained confidentially.", instagram: "Choices you may not know you have.", linkedin: "A clear guide to the options available to owners under pressure.", tiktok: "You have more options than you think. Here they are." },
  },
  home_value_curiosity: {
    label: "Home value curiosity", campaignPersona: null,
    angles: ["What homes like yours sell for this month, from real sales", "What moves value on your street"],
    educationTopics: ["How a valuation is built", "Improvements that pay back"],
    hooks: { facebook: "Curious what homes like yours sell for right now?", instagram: "Your home's value, explained with real sales.", linkedin: "What is really moving home values this quarter.", tiktok: "What would my house sell for? Here is how to find out properly." },
  },
  equity_planning: {
    label: "Equity planning", campaignPersona: null,
    angles: ["Putting your home equity to work, options compared", "Refinance, renovate or move: the trade-offs"],
    educationTopics: ["Home equity basics", "Refinance timing"],
    hooks: { facebook: "Sitting on equity? Here are the options people weigh.", instagram: "What your equity could do for you.", linkedin: "Home equity as a planning tool: a balanced look.", tiktok: "I had equity and no plan. Here is how I thought it through." },
  },
  expressed_criteria: {
    label: "Expressed search criteria", campaignPersona: null,
    angles: ["New homes that match exactly what you asked for", "Price, place and features, matched from your own words"],
    educationTopics: ["Writing a search that finds the right home", "Touring efficiently"],
    hooks: { facebook: "New this week in the areas you have been watching.", instagram: "Just listed: matches for what you told us matters.", linkedin: "A short list that fits the brief.", tiktok: "Found three homes that match the list. Let's tour." },
  },
  acreage_and_land: {
    label: "Acreage and land", campaignPersona: null,
    angles: ["Lot size, usable land and zoning, laid out", "Room to breathe: acreage near town"],
    educationTopics: ["Reading a survey and lot lines", "Zoning and land-use basics"],
    hooks: { facebook: "Looking for land? Here is what to check before you fall in love.", instagram: "Acreage, explained: usable land vs total land.", linkedin: "Due diligence on rural parcels: a practical list.", tiktok: "We bought acreage. Here is what we checked first." },
  },
  new_construction: {
    label: "New construction", campaignPersona: null,
    angles: ["Builder incentives and upgrades, compared openly", "What to inspect on a brand-new home"],
    educationTopics: ["Builder contracts explained", "New-build inspections"],
    hooks: { facebook: "Considering a new build? The questions to ask the builder.", instagram: "Brand new homes: incentives and upgrades compared.", linkedin: "Evaluating builder incentives with clear eyes.", tiktok: "Touring a new build: what I look at first." },
  },
  // ── wave 149 (lane 149A, owner ruling 2026-11-03): the four situation personas, each written to its pain points. The wording is
  // invitational ("if you are …"), never a presumption about one person, and passes the same copy scans as every other need.
  estate_property_sale: {
    label: "Selling an estate or inherited property", campaignPersona: "probate",
    angles: ["What the probate sale process involves, step by step, at a gentle pace", "Preparing, valuing and selling a home you are responsible for as an executor or heir"],
    educationTopics: ["How a probate property sale works", "Court confirmation and timelines explained", "Clearing out and preparing an estate home"],
    hooks: { facebook: "Handling a loved one's home? Here is how the probate sale process usually works.", instagram: "An estate home, step by step: valuing, preparing and selling without rushing.", linkedin: "A practical guide for executors responsible for selling real property.", tiktok: "Executor of an estate with a house to sell? Start here." },
  },
  military_relocation: {
    label: "Military relocation and VA financing", campaignPersona: "military",
    angles: ["PCS orders and a short timeline: buying, selling or renting out from a distance", "VA loan benefits explained plainly, from eligibility to closing"],
    educationTopics: ["Using a VA home loan", "Buying or selling on a PCS timeline", "Keeping the home as a rental after a move"],
    hooks: { facebook: "Got PCS orders? What would make this move easier on you?", instagram: "Moving on orders: how to buy before you arrive.", linkedin: "VA financing and PCS timing: a clear, practical guide.", tiktok: "New orders, new duty station. Here is how the house part works." },
  },
  separation_home_decisions: {
    label: "Home decisions during a separation", campaignPersona: "divorce",
    angles: ["Keep, buy out or sell: the options for a shared home laid out calmly", "A neutral, confidential valuation both parties can rely on"],
    educationTopics: ["Valuing a shared home fairly", "Buy-out versus sale: the trade-offs", "Starting over with the next home"],
    hooks: { facebook: "Working out what happens to the house? Your options, explained without pressure.", instagram: "A shared home, a clear plan: keep, buy out or sell.", linkedin: "A neutral guide to valuing and selling a jointly owned home.", tiktok: "What happens to the house? Here are the three usual paths." },
  },
  later_life_housing: {
    label: "Later-life housing options", campaignPersona: "senior",
    angles: ["Single-level living, low upkeep and staying close to what matters", "Aging in place or moving: the costs and choices compared honestly"],
    educationTopics: ["Features that make a home easier to live in for years", "Reverse mortgage for purchase (HECM) overview", "Verified age-qualified communities explained"],
    hooks: { facebook: "Thinking about the home that will suit you for the next twenty years? What matters most?", instagram: "Single-level, low-upkeep homes worth a look.", linkedin: "Aging in place versus moving: a balanced look at the numbers.", tiktok: "Stay or move? How I would think about the next home." },
  },
})

const NEED_KEYS = Object.keys(MARKETING_NEEDS) as MarketingNeed[]
const isMarketingNeed = (v: unknown): v is MarketingNeed => typeof v === "string" && (NEED_KEYS as string[]).includes(v)

// TOMBSTONE (wave 149, lane 149A — owner ruling 2026-11-03): `PROTECTED_CHARACTERISTIC_CAMPAIGN_PERSONAS` stood here — the four
// situation personas a derived persona could never carry and a derived-persona audience refused. The marketing lane no longer
// asks the question ("every persona is allowed"). SURVIVOR for the one place a protected persona still matters — a housing
// audience that SUPPRESSES people — is `EXCLUSION_INELIGIBLE_PERSONAS` (lib/ads/audience-persona-basis.ts), computed by the same
// classifier.

/** Maps a stored canonical situation persona onto the need it expresses — every canonical persona but `other` has one since wave
 *  149 (owner ruling 2026-11-03); the 148C rule "a protected situation may shape service, never a marketing need" is reversed. */
const NEED_FOR_PERSONA: Readonly<Partial<Record<CampaignPersona, MarketingNeed>>> = Object.freeze(
  Object.fromEntries(NEED_KEYS.filter((k) => MARKETING_NEEDS[k].campaignPersona).map((k) => [MARKETING_NEEDS[k].campaignPersona as CampaignPersona, k])),
)

// ─── THE FIREWALL ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE. Why this marketing / persisted text may not stand, or null. The copy scans (fair-housing copy patterns + proxy terms)
 *  + the research-value leak check. */
function textViolation(text: string, researchValues: readonly string[] = []): string | null {
  const t = String(text ?? "")
  if (!t.trim()) return null
  // The REASON never echoes the refused text or its term: the text may carry a research value (a modeled religion is also a proxy
  // word), and a refusal record is persisted on the persona row (derivation.firewall) — it names the SCREEN and the CLASS only.
  // TOMBSTONE (wave 149, lane 149A): the FIELD-token classifier (protected-class-signals.ts protectedClassReasonFor) screened copy
  // here and refused every situation word ("probate", "military", "divorce", "senior", "veteran") — so copy could not name the
  // situation the owner's personas exist to speak to. It is a classifier of provider FIELD NAMES, not a copy scan; the survivors
  // that judge WORDING are the two screens below (lib/compliance-rules/**), which catch "ideal for retirees", "no children",
  // "walk to church", demographic and proxy wording.
  const hits = audienceProxyHits(t)
  if (hits.length > 0) return `audience proxy for ${hits[0].proxyFor.replace(/_/g, " ")} (lib/compliance-rules/audience-compliance.ts) — describe the need or the property instead`
  const fh = detectFairHousingViolations(t)
  if (fh.length > 0) return `fair-housing phrase "${fh[0].phrase}" (${fh[0].reference}) — use: ${fh[0].fix}`
  const lower = ` ${t.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `
  for (const v of researchValues) {
    const w = String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    if (w.length >= 3 && lower.includes(` ${w} `)) return "a research-layer VALUE appears in the text (research attributes shape service, never words)"
  }
  return null
}

// The vocabulary must pass its own gate (fail closed AT LOAD — a needs table that carried a proxy would ship it everywhere).
for (const k of NEED_KEYS) {
  const spec = MARKETING_NEEDS[k]
  const bad = [k, spec.label, ...spec.angles, ...spec.educationTopics, ...Object.values(spec.hooks)].map((s) => [s, textViolation(s)] as const).find(([, v]) => v)
  if (bad) throw new Error(`[persona-layers] MARKETING_NEEDS.${k} fails its own firewall ("${bad[0]}": ${bad[1]})`)
  if (spec.campaignPersona && !isCampaignPersona(spec.campaignPersona)) throw new Error(`[persona-layers] MARKETING_NEEDS.${k} maps to a non-canonical persona (${spec.campaignPersona})`)
}

// ─── EVIDENCE ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PersonaEvidence {
  id: string
  layer: EvidenceLayer
  /** Canonical source: `table.column`, `customer360.<slice>`, `provider:<name>`. */
  source: string
  summary: string
  /** The need this evidence supports, when it supports one (null = context only). */
  supports: MarketingNeed | null
  confidence: number
  observedAt: string | null
}

/** Layer 1 — a research attribute. `value` lives in MEMORY for the study only; the persisted form drops it (researchLayerRef). */
export interface ResearchAttribute {
  id: string
  field: string
  protectedClass: string | null
  basis: string | null
  dataRights: string
  value: unknown
}

export interface PersonaSources {
  view: Customer360 | null
  criteria: BuyerCriteria | null
  research: ResearchAttribute[]
  /** The contact_persona value THIS module wrote last time — never read back as evidence (it is our own output). */
  ownPriorPersona?: string | null
  /** Facts the enrichment pipeline handed over (property / tenure facts only — the protected facts arrive via `research`). */
  hints?: { homeOwnerStatus?: string | null; contactType?: string | null }
}

const STATED_BASES = new Set(["person_stated", "staff_entered"])
const BASE_CONF: Readonly<Record<EvidenceLayer, number>> = { stated_needs: 0.9, behavioural_evidence: 0.7, inferred_interests: 0.45 }
/** customer-360 intent playbooks → the need they express. `household` and `life_event` map to NOTHING: household composition is a
 *  familial-status proxy, and a life event is never named or marketed to (ruling 17). */
const NEED_FOR_PLAYBOOK: Readonly<Record<string, MarketingNeed | null>> = { moving: "relocation_research", sale: "home_value_curiosity", purchase: "expressed_criteria", refinance: "equity_planning", equity: "equity_planning", household: null, life_event: null }
const NEED_FOR_FEATURE: ReadonlyArray<[RegExp, MarketingNeed]> = [[/\bacre|\bland\b|\blot size/i, "acreage_and_land"], [/new construction|new build|builder/i, "new_construction"], [/\brental|cash flow|duplex|multi.?family|investment/i, "investor_interest"]]
/** The buyer's LITERAL words (criteria provenance `evidence`, source "said") → the need they state. Only needs-based cues: the
 *  words may mention anything, the need recorded is what they are trying to DO — the summary never quotes the words. */
const NEED_FOR_STATED_WORDS: ReadonlyArray<[RegExp, MarketingNeed]> = [
  [/relocat|moving (to|here)|transferr?(ed|ing)|new job|job (in|offer)/i, "relocation_research"],
  [/first (home|house|time)|starter home|stop renting|tired of renting/i, "first_home_guidance"],
  [/downsiz|smaller (home|house|place)|less upkeep|less maintenance/i, "downsizing"],
  [/more (room|space)|bigger (home|house)|outgrown/i, "more_space"],
  [/invest|rental income|cash flow|flip/i, "investor_interest"],
]

/** PURE. Build layers 2–4 from the canonical reads. Layer 1 is passed through untouched (it supports no need, by construction). */
function buildPersonaEvidence(src: PersonaSources): { stated: PersonaEvidence[]; behaviour: PersonaEvidence[]; inferred: PersonaEvidence[]; withheldFromMarketing: string[] } {
  const out: Record<EvidenceLayer, PersonaEvidence[]> = { stated_needs: [], behavioural_evidence: [], inferred_interests: [] }
  const withheld: string[] = []
  const push = (layer: EvidenceLayer, e: Omit<PersonaEvidence, "id" | "layer" | "confidence"> & { confidence?: number }) => {
    const n = out[layer].length + 1
    const prefix = layer === "stated_needs" ? "E2" : layer === "behavioural_evidence" ? "E3" : "E4"
    out[layer].push({ id: `${prefix}-${n}`, layer, confidence: e.confidence ?? BASE_CONF[layer], ...e })
  }
  const v = src.view
  // (a) the stored situation persona — its provenance decides the layer. Every canonical persona maps to a need (wave 149).
  const personaField = v?.fields["lifecycle.contact_persona"]
  const storedRaw = typeof personaField?.value === "string" ? personaField.value : null
  const stored = normalizeContactPersona(storedRaw)
  if (stored && storedRaw !== (src.ownPriorPersona ?? null) && stored !== "other") {
    const need = NEED_FOR_PERSONA[stored] ?? null
    if (need) push(STATED_BASES.has(personaField?.basis ?? "") ? "stated_needs" : "inferred_interests", { source: "contacts.contact_persona", summary: `recorded situation: ${MARKETING_NEEDS[need].label.toLowerCase()}`, supports: need, observedAt: personaField?.observedAt ?? null, confidence: STATED_BASES.has(personaField?.basis ?? "") ? 0.85 : 0.5 })
  }
  // (b) buyer criteria — "said" fields are stated needs (the buyer's literal words), the rest inferred.
  const c = src.criteria
  if (c) {
    for (const [field, p] of Object.entries(c.provenance ?? {})) {
      if (!p) continue
      const said = p.source === "said"
      const value = Array.isArray(p.value) ? (p.value as unknown[]).join(", ") : String(p.value ?? "")
      if (!value.trim()) continue
      const featureNeed = NEED_FOR_FEATURE.find(([re]) => re.test(value))?.[1] ?? null
      push(said ? "stated_needs" : "inferred_interests", { source: `property_preferences.criteria_provenance.${field}`, summary: `${said ? "said" : "learned"}: ${field}`, supports: featureNeed ?? "expressed_criteria", observedAt: p.at ?? null })
      // The literal words behind a SAID value can state the need itself ("we're relocating for my job") — a second stated item.
      const statedNeed = said && typeof p.evidence === "string" ? NEED_FOR_STATED_WORDS.find(([re]) => re.test(p.evidence as string))?.[1] ?? null : null
      if (statedNeed && statedNeed !== featureNeed) push("stated_needs", { source: `property_preferences.criteria_provenance.${field}.evidence`, summary: `in their own words: ${MARKETING_NEEDS[statedNeed].label.toLowerCase()}`, supports: statedNeed, observedAt: p.at ?? null })
    }
    for (const f of c.mustHaveFeatures ?? []) {
      const featureNeed = NEED_FOR_FEATURE.find(([re]) => re.test(f))?.[1]
      if (featureNeed && !c.provenance?.mustHaveFeatures) push("inferred_interests", { source: "property_preferences.inferred_must_have_features", summary: "learned feature preference", supports: featureNeed, observedAt: null })
    }
  }
  // (c) customer-360 intent observations — confirmed → stated; first-party → behaviour; provider / platform → inferred.
  for (const o of v?.intent?.observations ?? []) {
    const need = o.playbook ? NEED_FOR_PLAYBOOK[o.playbook] ?? null : null
    if (o.playbook && need === null && (o.playbook === "household" || o.playbook === "life_event")) { withheld.push(`intent:${o.playbook} — never a marketing need (household is a familial-status proxy; a life event is never named, ruling 17)`); continue }
    if (!need) continue
    const layer: EvidenceLayer = o.confirmed || STATED_BASES.has(o.basis) ? "stated_needs" : o.basis === "first_party_action" ? "behavioural_evidence" : "inferred_interests"
    push(layer, { source: `customer360.intent:${o.source}`, summary: `${o.confirmed ? "confirmed" : "observed"} intent: ${MARKETING_NEEDS[need].label.toLowerCase()}`, supports: need, observedAt: o.observedAt })
  }
  // (d) behaviour — engagement families and the decayed score (what the person DID).
  const eng = v?.engagement
  if (eng) {
    const searchCount = (eng.search?.count ?? 0) + (eng.portal?.count ?? 0) + (eng.website?.count ?? 0)
    if (searchCount > 0) push("behavioural_evidence", { source: "customer360.engagement.search+portal+website", summary: `active home search (${searchCount} saves / views / visits in the window)`, supports: "expressed_criteria", observedAt: eng.search?.lastAt ?? eng.portal?.lastAt ?? null, confidence: Math.min(0.85, 0.55 + searchCount * 0.03) })
    if ((eng.tours?.count ?? 0) > 0) push("behavioural_evidence", { source: "customer360.engagement.tours", summary: `requested or scheduled ${eng.tours.count} tour(s)`, supports: "expressed_criteria", observedAt: eng.tours.lastAt, confidence: 0.85 })
    if ((eng.forms?.count ?? 0) > 0) push("behavioural_evidence", { source: "customer360.engagement.forms", summary: `submitted ${eng.forms.count} form(s)`, supports: null, observedAt: eng.forms.lastAt })
  }
  if (v?.behaviour && v.behaviour.score > 0) push("behavioural_evidence", { source: "customer360.behaviour", summary: `decayed intent score ${Math.round(v.behaviour.score)} (${v.behaviour.trend})`, supports: null, observedAt: null, confidence: 0.6 })
  // (e) tenure / contact type — property facts, never person facts.
  const tenure = String((v?.fields["property.home_owner_status"]?.value as string | undefined) ?? src.hints?.homeOwnerStatus ?? "").toLowerCase()
  if (tenure.includes("rent")) push("inferred_interests", { source: "contacts.home_owner_status", summary: "currently renting", supports: "first_home_guidance", observedAt: v?.fields["property.home_owner_status"]?.observedAt ?? null })
  else if (tenure.includes("own")) push("inferred_interests", { source: "contacts.home_owner_status", summary: "owns their home", supports: "home_value_curiosity", observedAt: v?.fields["property.home_owner_status"]?.observedAt ?? null, confidence: 0.35 })
  const ctype = String((v?.fields["lifecycle.contact_type"]?.value as string | undefined) ?? src.hints?.contactType ?? "").toLowerCase()
  if (ctype === "seller" || ctype === "both") push("behavioural_evidence", { source: "contacts.contact_type", summary: `on record as a ${ctype}`, supports: "home_value_curiosity", observedAt: null, confidence: 0.65 })
  // (f) provider facts with intents (inferred, never confirmed) — a protected-sensitivity fact is skipped (it is layer 1).
  for (const f of v?.providerFacts ?? []) {
    if (/protected/i.test(f.sensitivity)) continue
    for (const intent of f.intents) {
      const need = intent === "moving" ? "relocation_research" : intent === "investing" ? "investor_interest" : intent === "selling" ? "home_value_curiosity" : intent === "refinance" || intent === "equity" ? "equity_planning" : null
      if (need) push("inferred_interests", { source: `provider:${f.provider}.${f.field}`, summary: `provider-modeled interest: ${MARKETING_NEEDS[need].label.toLowerCase()}`, supports: need, observedAt: f.freshness.observedAt })
    }
  }
  return { stated: out.stated_needs, behaviour: out.behavioural_evidence, inferred: out.inferred_interests, withheldFromMarketing: withheld }
}

// ─── THE PERSONA ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PersonaNeed { need: MarketingNeed; confidence: number; evidenceRefs: string[]; why: string }
export interface MarketingSafePersona {
  headline: string
  primaryNeed: MarketingNeed | null
  needs: PersonaNeed[]
  /** The situation persona this person may be reached under (contacts.contact_persona / persona_segment) — any canonical one. */
  campaignPersona: CampaignPersona | null
  audienceEligible: boolean
  messaging: { angles: string[]; educationTopics: string[]; tone: string; platformHooks: Partial<Record<"facebook" | "instagram" | "linkedin" | "tiktok", string>>; avoid: string[] }
}
export interface ServiceProfile {
  summary: string
  howToHelp: string[]
  openQuestions: string[]
  /** From the contact's own columns — never model-derived. */
  communication: { preferredChannel: string | null; preferredLanguage: string | null; bestTime: string | null; accessibility: unknown }
}
export interface FirewallRefusal { path: string; reason: string }
export interface PersonaDerivation {
  marketing: MarketingSafePersona
  service: ServiceProfile
  firewall: { refused: FirewallRefusal[]; withheldFromMarketing: string[] }
  escalate: "insufficient_evidence" | "human_review_sensitive_situation" | null
  source: "model" | "deterministic"
}

/** The avoid list every brief carries (real-estate-real-estate-marketing skill: Fair Housing Act § 3604(c) language). */
const FAIR_HOUSING_AVOID = Object.freeze([
  "school quality claims (name the district only)", "who a home or area is 'perfect for'", "houses of worship as selling points",
  "age or life-stage preferences", "neighbourhood demographics", "'exclusive' or 'private' wording that implies who is welcome",
])

const combine = (cs: number[]): number => Math.min(0.97, 1 - cs.reduce((acc, c) => acc * (1 - Math.max(0, Math.min(1, c))), 1))

function needsFrom(evidence: PersonaEvidence[]): PersonaNeed[] {
  const by = new Map<MarketingNeed, PersonaEvidence[]>()
  for (const e of evidence) if (e.supports) by.set(e.supports, [...(by.get(e.supports) ?? []), e])
  return [...by.entries()]
    .map(([need, es]) => ({ need, confidence: Number(combine(es.map((e) => e.confidence)).toFixed(2)), evidenceRefs: es.map((e) => e.id), why: es.map((e) => e.summary).slice(0, 3).join("; ") }))
    .sort((a, b) => b.confidence - a.confidence)
}

function assembleMarketing(needs: PersonaNeed[], over?: { headline?: string; angles?: string[]; educationTopics?: string[]; tone?: string; platformHooks?: MarketingSafePersona["messaging"]["platformHooks"] }): MarketingSafePersona {
  const primary = needs[0]?.need ?? null
  const withPersona = needs.find((n) => MARKETING_NEEDS[n.need].campaignPersona)
  const campaignPersona = withPersona ? MARKETING_NEEDS[withPersona.need].campaignPersona : null
  const spec = primary ? MARKETING_NEEDS[primary] : null
  return {
    headline: over?.headline ?? (spec ? spec.label : "Needs not yet known"),
    primaryNeed: primary,
    needs,
    campaignPersona,
    audienceEligible: !!withPersona && withPersona.confidence >= AUDIENCE_MIN_CONFIDENCE,
    messaging: {
      angles: over?.angles ?? (spec ? [...spec.angles] : []),
      educationTopics: over?.educationTopics ?? (spec ? [...spec.educationTopics] : []),
      tone: over?.tone ?? "warm, specific and neighbourly — helpful first, never pressured",
      platformHooks: over?.platformHooks ?? (spec ? { ...spec.hooks } : {}),
      avoid: [...FAIR_HOUSING_AVOID],
    },
  }
}

function serviceFromCanonical(v: Customer360 | null, criteria: BuyerCriteria | null, needs: PersonaNeed[]): ServiceProfile {
  const f = v?.fields ?? {}
  const val = (k: string) => (f[k]?.value ?? null) as string | null
  const openQuestions: string[] = []
  if (!val("property.timeline")) openQuestions.push("When are they hoping to move — 1-3, 3-6 or 6-12 months?")
  if (!criteria || (criteria.cities.length === 0 && criteria.zipCodes.length === 0)) openQuestions.push("Which areas are they considering?")
  if (!criteria || (criteria.maxPrice == null && criteria.minPrice == null)) openQuestions.push("What price range feels comfortable?")
  const help = needs.slice(0, 3).map((n) => `Lead with ${MARKETING_NEEDS[n.need].label.toLowerCase()}: ${MARKETING_NEEDS[n.need].educationTopics[0]}`)
  return {
    summary: needs.length ? `Focused on ${needs.slice(0, 2).map((n) => MARKETING_NEEDS[n.need].label.toLowerCase()).join(" and ")}.` : "Not enough evidence yet to say what they need — ask before assuming.",
    howToHelp: help,
    openQuestions,
    communication: { preferredChannel: val("preferences.preferred_channel") ?? v?.consent?.resolvedChannel ?? null, preferredLanguage: val("preferences.preferred_language"), bestTime: val("preferences.preferred_contact_time"), accessibility: f["preferences.accessibility_preferences"]?.value ?? null },
  }
}

/** PURE. The deterministic floor — the persona when no model answers (or its answer is refused). Layer 1 is not an input. */
export function derivePersonaDeterministic(src: PersonaSources): PersonaDerivation & { evidence: ReturnType<typeof buildPersonaEvidence> } {
  const evidence = buildPersonaEvidence(src)
  const needs = needsFrom([...evidence.stated, ...evidence.behaviour, ...evidence.inferred])
  return {
    marketing: assembleMarketing(needs),
    service: serviceFromCanonical(src.view, src.criteria, needs),
    firewall: { refused: [], withheldFromMarketing: evidence.withheldFromMarketing },
    escalate: evidence.stated.length + evidence.behaviour.length === 0 ? "insufficient_evidence" : null,
    source: "deterministic",
    evidence,
  }
}

// ─── THE EXPERT PROMPT ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PersonaPromptInput {
  brokerageName: string | null
  agentName: string | null
  firstName: string | null
  evidence: ReturnType<typeof buildPersonaEvidence>
  research: ResearchAttribute[]
  service: ServiceProfile["communication"]
  /**
   * WAVE 148 (148Z, ruling 17): the empathetic TONE for the person's current circumstances — `lifeEventToneBrief(...)` of
   * lib/enrichment/life-event-vocabulary.ts, never the events themselves. Shapes the SERVICE profile only.
   */
  serviceTone?: string | null
}

/** PURE. The persona strategist's brief (wave-148 prompt standard: role, brand, facts it may and may not use, the decision it
 *  owns, a typed output contract, the compliance boundary, the escalation rule and the creative brief). */
export function buildPersonaDerivationPrompt(input: PersonaPromptInput): { system: string; prompt: string } {
  const ev = (list: PersonaEvidence[]) => list.length ? list.map((e) => `  ${e.id} [${e.source}] ${e.summary}${e.supports ? ` → supports ${e.supports}` : ""} (confidence ${e.confidence})`).join("\n") : "  (none)"
  const research = input.research.length
    ? input.research.map((r) => `  ${r.id} ${r.field}${r.protectedClass ? ` <${r.protectedClass}>` : ""} = ${JSON.stringify(r.value)} (basis ${r.basis ?? "unstated"}, rights ${r.dataRights})`).join("\n")
    : "  (none read)"
  const system = [
    `You are the Persona Strategist on ${input.brokerageName ?? "this brokerage"}'s VIPAgents team — a data-ethics officer and a growth marketer at one table.`,
    `You serve ${input.agentName ?? "the agent"} and the person they help. "The AI is the first line of defense and how the answers are given will be a reflection on that agent's business. It is about them. Be kind and neighbourly."`,
    "",
    "YOUR MANDATE — two products from one study:",
    "1. A CUSTOMER-SERVICE PROFILE: how this person would most like to be helped — pace, detail, what to explain first, what to ask next. It may be shaped by every layer, including LAYER 1, but it never NAMES a protected characteristic or repeats a Layer-1 value.",
    "2. A MARKETING PERSONA: the person's SITUATION and NEEDS (what they are trying to do or learn, or the property they want — including an estate sale, a military move, a separation or a later-life move when the evidence shows it), chosen ONLY from the needs vocabulary, each citing evidence ids from LAYERS 2–4. This persona is what ads, posts and custom audiences read; every persona is allowed.",
    "",
    "FACTS YOU MAY RELY ON: only the evidence lines given, by id. NEVER INVENT: no fact, need, preference or confidence the evidence does not carry; when something is unknown, say it is unknown and put the question in openQuestions. Do not restate canonical facts the record already holds (channel, language, contact time, accessibility) — they are attached for you.",
    "",
    "COMPLIANCE BOUNDARY — it is about WORDING (Fair Housing Act 42 U.S.C. § 3604(c)) and the ad platform's housing rules, not about which persona exists: messaging may speak to the situation (an estate sale, PCS orders, a separation, a later-life move) but must never state or imply a PREFERENCE, LIMITATION or EXCLUSION by race, colour, national origin, religion, sex, sexual orientation or gender identity, familial status, disability, age, marital status, military status or source of income. No school-quality claims, no 'perfect for …', no 'ideal for retirees', no houses of worship as selling points, no neighbourhood demographics. Write invitationally ('if you are handling an estate …'), never as a presumption about this one person; never exploit hardship; never name or allude to THIS person's private life event in a message to them (ruling 17 — warmth, not surveillance). A need is never derived from a Layer-1 attribute; Layer 1 may only make the SERVICE more considerate.",
    "",
    "ESCALATION: if Layers 2–3 are empty, return no needs and escalate \"insufficient_evidence\". If the evidence shows a sensitive situation the person has not invited us into, keep it out of everything and escalate \"human_review_sensitive_situation\".",
    "",
    "CREATIVE BRIEF (where creativity is the job): write messaging a brilliant local marketer would be proud of — specific, useful, warm; angles that teach before they sell; platform-native hooks (Facebook: a community question; Instagram: a warm visual hook; LinkedIn: a peer-to-peer insight; TikTok: a conversational first line). Never cross-post identical copy.",
    "",
    "OUTPUT CONTRACT — return ONLY this JSON (no prose):",
    `{"serviceProfile":{"summary":string,"howToHelp":string[],"openQuestions":string[]},"marketingPersona":{"headline":string,"needs":[{"need":one of [${NEED_KEYS.join(", ")}],"confidence":number 0..1,"evidenceRefs":string[] (E2-/E3-/E4- ids only),"why":string}],"messaging":{"angles":string[],"educationTopics":string[],"tone":string,"platformHooks":{"facebook":string,"instagram":string,"linkedin":string,"tiktok":string}}},"escalate":null|"insufficient_evidence"|"human_review_sensitive_situation"}`,
  ].join("\n")
  const prompt = [
    `PERSON: ${input.firstName ?? "(name not on record)"}`,
    `CANONICAL SERVICE FACTS (from their record): ${JSON.stringify(input.service)}`,
    ...(input.serviceTone ? [`SERVICE TONE (how to be with them right now — shape the SERVICE profile only; never name, guess or allude to why): ${input.serviceTone}`] : []),
    "",
    "LAYER 1 — RESEARCH ATTRIBUTES (SERVICE-ONLY: may make the service more considerate; never a need, a label, an audience or a word of copy; never repeat a value):",
    research,
    "",
    "LAYER 2 — VERIFIED STATED NEEDS:",
    ev(input.evidence.stated),
    "",
    "LAYER 3 — BEHAVIOURAL EVIDENCE:",
    ev(input.evidence.behaviour),
    "",
    "LAYER 4 — INFERRED INTERESTS (with confidence; append is not intent):",
    ev(input.evidence.inferred),
    "",
    `Withheld from marketing by rule: ${input.evidence.withheldFromMarketing.join(" | ") || "(nothing)"}`,
  ].join("\n")
  return { system, prompt }
}

// ─── THE VALIDATOR — every model answer passes here or is dropped ───────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const strs = (v: unknown, max = 6): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : [])

/** PURE. Validate a model's answer against the evidence and the firewall; return the SAFE persona and every refusal. */
export function validatePersonaDerivation(
  raw: unknown,
  ctx: { evidence: ReturnType<typeof buildPersonaEvidence>; research: ResearchAttribute[]; fallback: PersonaDerivation },
): PersonaDerivation {
  const refused: FirewallRefusal[] = []
  const all = [...ctx.evidence.stated, ...ctx.evidence.behaviour, ...ctx.evidence.inferred]
  const byId = new Map(all.map((e) => [e.id, e]))
  const researchIds = new Set(ctx.research.map((r) => r.id))
  const researchValues = ctx.research.map((r) => (typeof r.value === "string" || typeof r.value === "number" ? String(r.value) : "")).filter(Boolean)
  const canonicalValues = new Set(Object.values(ctx.fallback.service.communication).map((x) => String(x ?? "").toLowerCase()).filter(Boolean))
  const leakValues = researchValues.filter((v) => !canonicalValues.has(v.toLowerCase()))
  const keep = (path: string, text: string): string | null => {
    const why = textViolation(text, leakValues)
    if (why) { refused.push({ path, reason: why }); return null }
    return text
  }
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>
  const mp = (r.marketingPersona && typeof r.marketingPersona === "object" ? r.marketingPersona : {}) as Record<string, any>
  const needs: PersonaNeed[] = []
  for (const [i, n] of (Array.isArray(mp.needs) ? mp.needs : []).entries()) {
    const path = `marketingPersona.needs[${i}]`
    if (!n || typeof n !== "object") { refused.push({ path, reason: "not an object" }); continue }
    if (!isMarketingNeed(n.need)) { refused.push({ path, reason: "the proposed need is not in the needs vocabulary (MARKETING_NEEDS) — never coined forward" }); continue }
    const refs = strs(n.evidenceRefs, 12)
    const cited = refs.filter((id) => researchIds.has(id) || /^R1-/.test(id))
    if (cited.length > 0) refused.push({ path: `${path}.evidenceRefs`, reason: `cites research-layer evidence (${cited.join(", ")}) — Layer 1 never supports a marketing need` })
    // A cited item must exist AND bear on this need: it supports this need, is general criteria context, or is context-only.
    // Evidence that supports a DIFFERENT specific need does not license this one (a need is never hung on unrelated evidence).
    const valid = refs.filter((id) => byId.has(id) && [n.need, "expressed_criteria", null].includes(byId.get(id)!.supports))
    if (valid.length === 0) { refused.push({ path, reason: "no existing Layer 2–4 evidence that bears on this need was cited — refused, never guessed" }); continue }
    const bound = combine(valid.map((id) => byId.get(id)!.confidence))
    const conf = Math.max(0, Math.min(bound, Number(n.confidence) || 0))
    const why = keep(`${path}.why`, str(n.why)) ?? valid.map((id) => byId.get(id)!.summary).join("; ")
    if (needs.some((x) => x.need === n.need)) continue
    needs.push({ need: n.need, confidence: Number(conf.toFixed(2)), evidenceRefs: valid, why })
  }
  needs.sort((a, b) => b.confidence - a.confidence)
  const msg = (mp.messaging && typeof mp.messaging === "object" ? mp.messaging : {}) as Record<string, any>
  const hooksIn = (msg.platformHooks && typeof msg.platformHooks === "object" ? msg.platformHooks : {}) as Record<string, unknown>
  const platformHooks: MarketingSafePersona["messaging"]["platformHooks"] = {}
  for (const p of ["facebook", "instagram", "linkedin", "tiktok"] as const) {
    const h = keep(`marketingPersona.messaging.platformHooks.${p}`, str(hooksIn[p]))
    if (h) platformHooks[p] = h
  }
  const angles = strs(msg.angles).map((a, i) => keep(`marketingPersona.messaging.angles[${i}]`, a)).filter((x): x is string => !!x)
  const topics = strs(msg.educationTopics).map((a, i) => keep(`marketingPersona.messaging.educationTopics[${i}]`, a)).filter((x): x is string => !!x)
  const headline = keep("marketingPersona.headline", str(mp.headline))
  const tone = keep("marketingPersona.messaging.tone", str(msg.tone))
  const finalNeeds = needs.length ? needs : ctx.fallback.marketing.needs
  const marketing = assembleMarketing(finalNeeds, {
    headline: headline || undefined, angles: angles.length ? angles : undefined, educationTopics: topics.length ? topics : undefined, tone: tone || undefined,
    platformHooks: Object.keys(platformHooks).length ? platformHooks : undefined,
  })
  const sp = (r.serviceProfile && typeof r.serviceProfile === "object" ? r.serviceProfile : {}) as Record<string, any>
  const summary = keep("serviceProfile.summary", str(sp.summary))
  const howToHelp = strs(sp.howToHelp).map((t, i) => keep(`serviceProfile.howToHelp[${i}]`, t)).filter((x): x is string => !!x)
  const openQuestions = strs(sp.openQuestions).map((t, i) => keep(`serviceProfile.openQuestions[${i}]`, t)).filter((x): x is string => !!x)
  const escalate = r.escalate === "insufficient_evidence" || r.escalate === "human_review_sensitive_situation" ? r.escalate : ctx.fallback.escalate
  return {
    marketing,
    service: {
      summary: summary || ctx.fallback.service.summary,
      howToHelp: howToHelp.length ? howToHelp : ctx.fallback.service.howToHelp,
      openQuestions: openQuestions.length ? openQuestions : ctx.fallback.service.openQuestions,
      communication: ctx.fallback.service.communication,
    },
    firewall: { refused, withheldFromMarketing: ctx.fallback.firewall.withheldFromMarketing },
    escalate,
    source: needs.length || summary || angles.length ? "model" : "deterministic",
  }
}

/** PURE — the last, independent check before a persona is persisted or reaches contacts.contact_persona / an audience. */
export function assertMarketingSafePersona(p: MarketingSafePersona, researchValues: readonly string[] = []): { ok: boolean; violations: string[] } {
  const v: string[] = []
  for (const n of p.needs) if (!isMarketingNeed(n.need)) v.push(`need ${String(n.need)} is outside the vocabulary`)
  // TOMBSTONE (wave 149, lane 149A): "campaign persona names a protected characteristic" was a violation here (148C) — reversed
  // by the owner ("every persona is allowed"); the persona only has to be canonical.
  if (p.campaignPersona && !isCampaignPersona(p.campaignPersona)) v.push(`campaign persona ${String(p.campaignPersona)} is not a canonical persona`)
  if (p.needs.some((n) => n.evidenceRefs.some((id) => /^R1-/.test(id)))) v.push("a need cites research-layer evidence")
  const texts = [p.headline, p.messaging.tone, ...p.messaging.angles, ...p.messaging.educationTopics, ...Object.values(p.messaging.platformHooks), ...p.needs.map((n) => n.why)]
  for (const t of texts) { const why = textViolation(String(t ?? ""), researchValues); if (why) v.push(why) }
  return { ok: v.length === 0, violations: v }
}
