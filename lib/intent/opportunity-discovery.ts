// lib/intent/opportunity-discovery.ts
//
// EARLY OPPORTUNITY DISCOVERY — the combination of C9 movement records into an OPPORTUNITY READING and the arbiter's MENU
// (wave 149, lane 149H; owner ruling 18, 2026-11-03: "find the needle in the haystack — permitted indicators that someone may be
// starting to consider moving, selling, buying, investing or refinancing, before they search for an agent; combine signals;
// verified vs inferred; the arbiter decides research / education / monitoring / outreach / human; kind and never exploitative").
//
// WHAT THIS ADDS ON THE SURVIVOR (LAW 1 / LAW 2 — no second scorer, no second registry):
//   lib/intent/movement-signals.ts scoreMovementCombination already combines C9 records per EVENT RELEVANCE (a score, a band,
//   corroboration, caps, the arithmetic). It does not say WHICH DECISION the person may be approaching. This module reads the same
//   records per OPPORTUNITY (move / sell / buy / invest / refinance), applies the combination rules that make a reading honest, and
//   builds the arbiter's closed menu in THE one engagement vocabulary (lib/enrichment/life-event-vocabulary.ts
//   LIFE_EVENT_ENGAGEMENT_MODES — quiet_monitoring / research / helpful_education / appropriate_outreach / human; owner ruling 17
//   named the same five ways of answering; one spelling, CLAUDE.md §6).
//
// THE COMBINATION RULES (deterministic — AI explains, deterministic services calculate and gate):
//   1. A SINGLE OBSERVATION NEVER RAISES AN OPPORTUNITY. One source (however many times it repeats) is `single_observation` — quiet
//      monitoring or research only. The person's own words are the one exception and are labelled `stated`, not inferred.
//   2. INFERENCES NEVER READ AS FACTS. Combinations with nothing verified or reported stay `watch`.
//   3. CORROBORATION IS INDEPENDENCE. `likely` needs two independent source KINDS, one verified record and a confirmed identity.
//   4. CONTEXT NEVER SCORES. Market / community events (rates, an employer expanding) are counted beside the reading, never in it.
//   5. STALE IS NOT CURRENT. An observation older than three of its source's half-lives no longer counts.
//   6. NEVER INTRUSIVE. A reading touched by a life event or a protected proxy is `sensitive`: every outward brief is event-agnostic,
//      carries only the tone brief (lifeEventToneBrief), and is screened by screenLifeEventOutreach before it leaves this module.
//   7. COST. Research is planned cheapest first; free first-party reads always run; a strategy already run on the SAME evidence is
//      REUSED (re-research only when the evidence changed — no clock); a paid strategy waits for mayUseAndAfford (fail closed).
//
// PURE. No I/O, no model call. The model that reasons over the reading is the one the movement manager and the arbiter already call
// (OPPORTUNITY_COMBINATION_BRIEF rides their system prompts — lib/intent/movement-signals.ts MOVEMENT_DECISION_SYSTEM).

import type { IntentKind } from "@/lib/enrichment/intent-signal-sources"
import {
  LIFE_EVENT_ENGAGEMENT_MODES, canonicalLifeEventType, lifeEventToneBrief, screenLifeEventOutreach,
  type LifeEventEngagementMode, type LifeEventType,
} from "@/lib/enrichment/life-event-vocabulary"
import {
  CONTEXT_RELEVANCE, COST_CLASSES, EPISTEMIC_RANK, INTIMATE_RELEVANCE, RESEARCH_STRATEGIES, movementSource,
  type CostClass, type EpistemicClass, type MovementRelevance, type MovementSourceKind,
} from "@/lib/intent/movement-source-registry"

const DAY_MS = 86_400_000

// ── vocabularies ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The five home decisions of ruling 18. */
export const OPPORTUNITY_KINDS = Object.freeze(["move", "sell", "buy", "invest", "refinance"] as const)
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number]

/** ORDERED. `stated` is the person's own words — highest, and never an inference. */
export const OPPORTUNITY_STAGES = Object.freeze(["none", "single_observation", "watch", "emerging", "likely", "stated"] as const)
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number]
const STAGE_RANK: Readonly<Record<OpportunityStage, number>> = Object.freeze({ none: 0, single_observation: 1, watch: 2, emerging: 3, likely: 4, stated: 5 })
export const stageAtLeast = (s: OpportunityStage, min: OpportunityStage): boolean => STAGE_RANK[s] >= STAGE_RANK[min]

/** lane 144E's IntentKind → the decision it bears on (investing has no IntentKind — it is read from its sources / topic tags). */
const INTENT_OPPORTUNITY: Readonly<Record<IntentKind, OpportunityKind | null>> = Object.freeze({
  moving: "move", home_sale: "sell", home_purchase: "buy", refinance: "refinance",
  property_engagement: null, market_engagement: null, life_event: null, relationship_moment: null,
})
/** The decision → the IntentKind a record stores (investing rides `home_purchase` plus an `opportunity:invest` evidence tag). */
export const OPPORTUNITY_INTENT: Readonly<Record<OpportunityKind, IntentKind>> = Object.freeze({ move: "moving", sell: "home_sale", buy: "home_purchase", refinance: "refinance", invest: "home_purchase" })
/** Sources whose evidence is about INVESTING (the investment analyzer, Versium's investing interest) — never read as a home purchase. */
const INVESTING_SOURCES: ReadonlySet<string> = new Set(["fp_calc_investment", "po_investor_activity"])
/** The person's own words / own explicit choice (C1 inbound statement, the portal's "Your Next Move" tap). */
const STATED_SOURCES: ReadonlySet<string> = new Set(["fp_inbound_stated", "fp_next_move_tap"])
/** How many half-lives an observation keeps counting (rule 5). */
const STALE_AFTER_HALF_LIVES = 3

/** Topic → decision, for the tenant's OWN content (a post's category + title — never the person). Deterministic, word-bounded. */
const TOPIC_PATTERNS: ReadonlyArray<readonly [OpportunityKind, RegExp]> = Object.freeze([
  ["sell", /\b(sell|sellers?|selling|list(?:ing)? your|staging|home values?|what (?:your|my) home is worth|equity|net proceeds)\b/i],
  ["buy", /\b(buy|buyers?|buying|first[- ]time|down payment|pre-?approv\w*|house[- ]hunt\w*|making an offer)\b/i],
  ["refinance", /\b(refinanc\w*|refi|cash[- ]out|heloc|interest rates?)\b/i],
  ["invest", /\b(invest\w*|rental propert\w*|landlord\w*|1031|cash flow|cap rate|short[- ]term rental\w*)\b/i],
  ["move", /\b(relocat\w*|moving (?:to|guide|checklist)|new city|downsiz\w*|upsiz\w*|right[- ]siz\w*)\b/i],
] as const)

/** PURE. The decisions a piece of the tenant's own content is about (empty = not a home-decision topic). */
export function opportunityKindsForTopic(text: string | null | undefined): OpportunityKind[] {
  const t = String(text ?? "")
  return OPPORTUNITY_KINDS.filter((k) => TOPIC_PATTERNS.some(([kind, re]) => kind === k && re.test(t)))
}

/** The evidence tag an adapter writes when the decision is known from the TOPIC, not the source (`opportunity:<kind>`). */
export const opportunityTag = (k: OpportunityKind): string => `opportunity:${k}`

// ── the reading ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The fields of a C9 record (built or stored) this module reads. */
export interface OpportunityObservation {
  id: string
  sourceKey: string
  relevance: MovementRelevance
  confidence: EpistemicClass
  identity: "record_key" | "verified_match" | "name_only" | "none"
  observedAt: string
  intents?: readonly string[] | null
  /** evidence.fields — `opportunity:<kind>` tags written by a topic adapter are authoritative. */
  fields?: readonly string[] | null
  lifeEvent?: string | null
  protectedProxy?: boolean | null
}

/** PURE. The decisions one observation bears on (topic tags first, then the investing sources, then the record's intents). */
function opportunityKindsFor(o: Pick<OpportunityObservation, "sourceKey" | "relevance" | "intents" | "fields">): OpportunityKind[] {
  const tagged = (o.fields ?? []).map((f) => /^opportunity:(\w+)$/.exec(String(f))?.[1]).filter((k): k is OpportunityKind => (OPPORTUNITY_KINDS as readonly string[]).includes(String(k)))
  if (tagged.length > 0) return OPPORTUNITY_KINDS.filter((k) => tagged.includes(k))
  if (INVESTING_SOURCES.has(o.sourceKey)) return ["invest"]
  const intents = o.intents && o.intents.length > 0 ? o.intents : (movementSource(o.sourceKey)?.intents ?? [])
  const out = new Set<OpportunityKind>()
  for (const i of intents) { const k = INTENT_OPPORTUNITY[i as IntentKind]; if (k) out.add(k) }
  if (o.relevance === "relocation") out.add("move")
  return OPPORTUNITY_KINDS.filter((k) => out.has(k))
}

export interface OpportunityAssessment {
  kind: OpportunityKind
  stage: OpportunityStage
  /** Distinct sources (a repeat from the same source is ONE observation). */
  independentSources: number
  sourceKinds: MovementSourceKind[]
  verified: number
  reported: number
  inferred: number
  identityConfirmed: boolean
  relevances: MovementRelevance[]
  newestAt: string | null
  evidenceIds: string[]
  /** One plain line — sources by KIND only, never a source name, an event or a person. */
  reason: string
}

export interface OpportunityReading {
  primary: OpportunityAssessment | null
  assessments: OpportunityAssessment[]
  /** A life event or a protected proxy touches the evidence: outward briefs are event-agnostic and tone-only. */
  sensitive: boolean
  /** The empathetic tone for the writer (lifeEventToneBrief) — a tone, never a fact. */
  toneBrief: string | null
  /** For the screen only (screenLifeEventOutreach `events`) — never rendered, never in a prompt as a fact. */
  screenEvents: LifeEventType[]
  /** Market / community context present (counted beside the reading, never in it — rule 4). */
  contextObservations: number
  /** Observations dropped as stale (rule 5). */
  staleObservations: number
  explanation: string
}

const confidenceRank = (c: EpistemicClass) => EPISTEMIC_RANK[c] ?? 0
const isConfirmed = (i: OpportunityObservation["identity"]) => i === "record_key" || i === "verified_match"

/** PURE. The combination rules (header 1–6) over ONE subject's observations. Deterministic; `now` injectable. */
export function readOpportunities(observations: readonly OpportunityObservation[], opts: { now?: Date } = {}): OpportunityReading {
  const now = opts.now ?? new Date()
  let contextObservations = 0, staleObservations = 0
  const live: OpportunityObservation[] = []
  for (const o of observations) {
    if (CONTEXT_RELEVANCE.has(o.relevance)) { contextObservations++; continue }
    if (o.confidence === "unknown") continue
    const half = movementSource(o.sourceKey)?.halfLifeDays ?? 30
    const age = (now.getTime() - Date.parse(o.observedAt)) / DAY_MS
    if (!Number.isFinite(age) || age > half * STALE_AFTER_HALF_LIVES) { staleObservations++; continue }
    live.push(o)
  }
  const screenEvents = [...new Set(live.map((o) => canonicalLifeEventType(o.lifeEvent ?? null)).filter((t): t is LifeEventType => !!t))]
  const sensitive = screenEvents.length > 0 || live.some((o) => INTIMATE_RELEVANCE.has(o.relevance) || o.relevance === "life_stage" || !!o.protectedProxy)
  const toneBrief = screenEvents.length > 0 ? lifeEventToneBrief(screenEvents.map((type) => ({ type, observed_at: now.toISOString() }))) : null

  const assessments: OpportunityAssessment[] = []
  for (const kind of OPPORTUNITY_KINDS) {
    const mine = live.filter((o) => opportunityKindsFor(o).includes(kind))
    if (mine.length === 0) continue
    // Rule 1: one source is one observation — keep its strongest (class, then newest).
    const bySource = new Map<string, OpportunityObservation>()
    for (const o of mine) {
      const cur = bySource.get(o.sourceKey)
      if (!cur || confidenceRank(o.confidence) > confidenceRank(cur.confidence) || (confidenceRank(o.confidence) === confidenceRank(cur.confidence) && o.observedAt > cur.observedAt)) bySource.set(o.sourceKey, o)
    }
    const best = [...bySource.values()]
    const n = best.length
    const sourceKinds = [...new Set(best.map((o) => movementSource(o.sourceKey)?.kind).filter((k): k is MovementSourceKind => !!k))]
    const verified = best.filter((o) => o.confidence === "verified").length
    const reported = best.filter((o) => o.confidence === "reported").length
    const grounded = verified + reported
    const identityConfirmed = best.some((o) => confidenceRank(o.confidence) >= EPISTEMIC_RANK.reported && isConfirmed(o.identity))
    const stated = best.some((o) => STATED_SOURCES.has(o.sourceKey) && confidenceRank(o.confidence) >= EPISTEMIC_RANK.reported && isConfirmed(o.identity))
    const stage: OpportunityStage =
      stated ? "stated"
        : n === 1 ? "single_observation"
          : grounded === 0 ? "watch"
            : sourceKinds.length >= 2 && verified >= 1 && identityConfirmed ? "likely"
              : "emerging"
    const why =
      stage === "stated" ? "the person told us themselves"
        : stage === "single_observation" ? "one source only — a single observation is never an opportunity"
          : stage === "watch" ? "inferences only — nothing verified or reported"
            : stage === "likely" ? "independent kinds of evidence agree, one verified, identity confirmed"
              : sourceKinds.length < 2 ? "more than one source, but all of one kind — not yet independent" : !identityConfirmed ? "independent sources, but the identity is not confirmed" : "independent sources, nothing verified yet"
    assessments.push({
      kind, stage, independentSources: n, sourceKinds, verified, reported, inferred: n - grounded, identityConfirmed,
      relevances: [...new Set(best.map((o) => o.relevance))], newestAt: best.reduce<string | null>((m, o) => (!m || o.observedAt > m ? o.observedAt : m), null),
      evidenceIds: best.map((o) => o.id).sort(),
      reason: `${kind}: ${stage.replace(/_/g, " ")} — ${n} independent source${n === 1 ? "" : "s"} across ${sourceKinds.length} kind${sourceKinds.length === 1 ? "" : "s"} (${sourceKinds.map((k) => k.replace(/_/g, " ")).join(", ") || "unregistered"}); ${verified} verified, ${reported} reported, ${n - grounded} inferred — ${why}`,
    })
  }
  assessments.sort((a, b) => STAGE_RANK[b.stage] - STAGE_RANK[a.stage] || b.independentSources - a.independentSources || (b.verified + b.reported) - (a.verified + a.reported) || OPPORTUNITY_KINDS.indexOf(a.kind) - OPPORTUNITY_KINDS.indexOf(b.kind))
  const primary = assessments.find((a) => a.stage !== "none") ?? null
  const notes = [
    ...(contextObservations > 0 ? [`${contextObservations} market / community context observation${contextObservations === 1 ? "" : "s"} counted beside the reading, never in it`] : []),
    ...(staleObservations > 0 ? [`${staleObservations} stale observation${staleObservations === 1 ? "" : "s"} (older than ${STALE_AFTER_HALF_LIVES} half-lives) not counted`] : []),
    ...(sensitive ? ["a sensitive personal moment touches this evidence — every outward brief is event-agnostic and tone-only"] : []),
  ]
  const explanation = assessments.length === 0
    ? `No home-decision evidence in the window.${notes.length ? ` ${notes.join("; ")}.` : ""}`
    : `${assessments.map((a) => a.reason).join(" | ")}${notes.length ? ` | ${notes.join("; ")}` : ""}`
  return { primary, assessments, sensitive, toneBrief, screenEvents, contextObservations, staleObservations, explanation }
}

// ── the arbiter's menu (the INPUT SHAPE the arbiter consumes — lane 149C owns how the arbiter times what it picks) ─────────────────

export type OpportunityOptionStatus = "eligible" | "needs_authority" | "needs_budget" | "not_eligible"

export interface OpportunityResearchStep { key: string; costClass: CostClass; status: "run" | "reuse" | "needs_budget"; rail: string; why: string }

export interface OpportunityMenuOption {
  mode: LifeEventEngagementMode
  status: OpportunityOptionStatus
  why: string
  /** The planner experience that carries it (lib/ai-isa/lead-action-plan.ts EXPERIENCE_KINDS — one vocabulary). */
  experience: "wait" | "research" | "education" | "communication" | "agent_intervention"
  /** For the WRITER: what kind of help fits — event-agnostic, screened. Null for internal steps. */
  brief: string | null
  /** For the WRITER: the empathetic tone (lifeEventToneBrief) when the reading is sensitive — an instruction, never copy. */
  tone?: string | null
  /** A human approves before anything leaves (the tenant's autonomy is supervised). */
  requiresApproval?: boolean
  research?: OpportunityResearchStep[]
}

export interface OpportunityMenu {
  options: OpportunityMenuOption[]
  /** The policy's own answer when nothing better is justified — never a person by reflex, never a timer. */
  floor: "quiet_monitoring"
  /** Outward briefs the screen had to replace (should be 0; a non-zero count is a finding). */
  screenFallbacks: number
}

export interface OpportunityMenuContext {
  /** A lead / contact / lifetime client we already hold (never a raw lead, a property or a territory). */
  personIdentified: boolean
  /** At least one decisive record permits outreach at the record (source terms + subject class — C9 `outreach`). */
  outreachPermitted: boolean
  /** The tenant's autonomy posture (lib/managers/autonomy-gate.ts) — `unknown` when the caller did not read it (fail closed). */
  autonomy: "autonomous" | "supervised" | "unknown"
  /** mayUseAndAfford for paid research — null = not asked yet (fail closed: paid steps wait). */
  paidResearchAffordable: boolean | null
  /** Research already run for this subject (strategy key + when) — the decision rows' research_keys + decided_at. */
  priorResearch?: ReadonlyArray<{ key: string; at: string }>
}

/** What kind of help fits each decision — kind, practical, never a pitch, never a reason we think so. */
const EDUCATION_BRIEF: Readonly<Record<OpportunityKind, string>> = Object.freeze({
  sell: "Something genuinely useful about their home and their neighbourhood market — what similar homes nearby have done lately and what owners usually look at first — offered, never pushed; no price for their home without a CMA.",
  buy: "Practical help with the homes and the buying steps that fit what they have told us — a short guide, a couple of fitting homes, an open door to questions.",
  refinance: "Plain-language education on how rates, equity and loan terms work, with the offer of an introduction to licensed lenders they choose; never a rate, a payment or a loan quote.",
  invest: "A neutral primer on how a local rental is evaluated (rent, vacancy, expenses, financing) with the tenant's market data; never a projected return or a promise.",
  move: "A practical moving and new-area resource — a checklist, local know-how, trusted vendors — useful whatever the reason and wherever they go.",
})
const NEVER_LINE = "Never mention the signals, where anything came from, or any life event, and never let the message suggest anything was observed about them; if they want space, quiet monitoring is the answer."

/** PURE. The research plan (rule 7): cheapest first, reuse on unchanged evidence, paid steps behind the budget gate. */
function researchPlan(primary: OpportunityAssessment, ctx: OpportunityMenuContext): OpportunityResearchStep[] {
  const steps: OpportunityResearchStep[] = []
  const strategies = [...RESEARCH_STRATEGIES]
    .filter((s) => s.costClass !== "contract_required" && s.corroborates.some((r) => primary.relevances.includes(r)))
    .sort((a, b) => COST_CLASSES.indexOf(a.costClass) - COST_CLASSES.indexOf(b.costClass))
  for (const s of strategies) {
    const prior = (ctx.priorResearch ?? []).filter((p) => p.key === s.key).map((p) => p.at).sort().pop() ?? null
    const unchanged = !!prior && !!primary.newestAt && primary.newestAt <= prior
    const paid = s.gate === "mayUseAndAfford"
    if (unchanged) { steps.push({ key: s.key, costClass: s.costClass, status: "reuse", rail: s.rail, why: `already run on this evidence (${prior!.slice(0, 10)}) — reused; re-run only when new evidence arrives` }); continue }
    if (paid && ctx.paidResearchAffordable !== true) { steps.push({ key: s.key, costClass: s.costClass, status: "needs_budget", rail: s.rail, why: ctx.paidResearchAffordable === false ? "mayUseAndAfford refused — not run" : "paid: waits for mayUseAndAfford (not asked yet — fail closed)" }); continue }
    steps.push({ key: s.key, costClass: s.costClass, status: "run", rail: s.rail, why: paid ? "paid, inside the tenant's budget" : "free" })
  }
  return steps
}

/** PURE. The arbiter's closed menu over the five engagement modes, each with its status and why. */
export function opportunityMenu(reading: OpportunityReading, ctx: OpportunityMenuContext): OpportunityMenu {
  const p = reading.primary
  const stage: OpportunityStage = p?.stage ?? "none"
  let screenFallbacks = 0
  const tone = reading.sensitive ? reading.toneBrief : null
  // The brief is screened as if it were copy (it shapes the copy). The TONE is the vocabulary's own instruction to the writer and
  // rides beside it unscreened (`tone`) — it names what to avoid ("no condolences as an opener"), which a copy screen would flag.
  const screened = (brief: string): string => {
    const text = `${brief} ${NEVER_LINE}`
    if (screenLifeEventOutreach(text, { events: reading.screenEvents.map((type) => ({ type })) }).ok) return text
    screenFallbacks++
    return `Something genuinely useful and kind that would suit any homeowner. ${NEVER_LINE}`
  }
  const options: OpportunityMenuOption[] = []
  for (const mode of LIFE_EVENT_ENGAGEMENT_MODES) {
    if (mode === "quiet_monitoring") {
      options.push({ mode, status: "eligible", experience: "wait", brief: null, why: "always permitted — waiting for one more independent sign is a legitimate answer (no timer; new evidence re-opens the decision)" })
    } else if (mode === "research") {
      if (!p || stage === "stated") { options.push({ mode, status: "not_eligible", experience: "research", brief: null, why: !p ? "no home-decision evidence to corroborate" : "the person told us themselves — nothing to corroborate" }); continue }
      const research = researchPlan(p, ctx)
      const status: OpportunityOptionStatus = research.some((s) => s.status === "run") ? "eligible" : research.some((s) => s.status === "needs_budget") ? "needs_budget" : "not_eligible"
      options.push({ mode, status, experience: "research", brief: null, research, why: research.length === 0 ? "no permitted strategy corroborates this evidence" : status === "not_eligible" ? "every strategy already ran on this evidence — nothing new to learn until new evidence arrives" : `cheapest first: ${research.map((s) => `${s.key} (${s.status})`).join(", ")}` })
    } else if (mode === "helpful_education") {
      const blocks: string[] = []
      if (!ctx.personIdentified) blocks.push("not a person we hold")
      if (!ctx.outreachPermitted) blocks.push("no decisive record permits outreach")
      if (!stageAtLeast(stage, "emerging")) blocks.push(stage === "single_observation" ? "a single observation is never an opportunity" : stage === "watch" ? "inferences only" : "no opportunity reading")
      options.push(blocks.length === 0 && p
        ? { mode, status: "eligible", experience: "education", brief: screened(EDUCATION_BRIEF[p.kind]), tone, why: `${p.kind} is ${stage.replace(/_/g, " ")} — useful, low-pressure education under consent / DNC / frequency (the arbiter picks the channel)` }
        : { mode, status: "not_eligible", experience: "education", brief: null, why: blocks.join("; ") })
    } else if (mode === "appropriate_outreach") {
      const blocks: string[] = []
      if (!ctx.personIdentified) blocks.push("not a person we hold")
      if (!ctx.outreachPermitted) blocks.push("no decisive record permits outreach")
      if (!stageAtLeast(stage, "likely")) blocks.push(`the reading is only "${stage.replace(/_/g, " ")}" — outreach needs "likely" or the person's own words`)
      if (p && !p.identityConfirmed) blocks.push("identity not confirmed")
      if (blocks.length > 0 || !p) { options.push({ mode, status: "not_eligible", experience: "communication", brief: null, why: blocks.join("; ") || "no reading" }); continue }
      const brief = screened(`A short, personal, helpful note about ${p.kind === "sell" ? "their home and their options" : p.kind === "buy" ? "the homes they are looking for" : p.kind === "refinance" ? "understanding their equity and options (lender introduction only on request)" : p.kind === "invest" ? "evaluating a rental property" : "the move ahead"} — an invitation to talk, no urgency, no deal.`)
      if (ctx.autonomy === "unknown") options.push({ mode, status: "needs_authority", experience: "communication", brief, tone, why: "the evidence supports it, but the tenant's autonomy was not read here — the arbiter reads it (fail closed) before offering this" })
      else options.push({ mode, status: "eligible", experience: "communication", brief, tone, requiresApproval: ctx.autonomy !== "autonomous", why: ctx.autonomy === "autonomous" ? "corroborated, confirmed, reachable — under consent / DNC / TCPA / frequency" : "corroborated and reachable — the tenant's autonomy is supervised, so a person approves the draft first" })
    } else {
      const ok = ctx.personIdentified && stageAtLeast(stage, "emerging")
      options.push({ mode, status: ok ? "eligible" : "not_eligible", experience: "agent_intervention", brief: null, why: ok ? "a person may always take a real opportunity — a choice, never a reflex (ruling 17)" : !ctx.personIdentified ? "not a person we hold" : "nothing for a person yet — a single observation or inferences only" })
    }
  }
  return { options, floor: "quiet_monitoring", screenFallbacks }
}

/**
 * PURE (wave 149Z — the arbiter READS the reading, lane 149H Outside-lane 1). The reading + menu as the follow-up arbiter's
 * EVIDENCE (lib/ai-isa/followup-arbiter.ts ArbiterFacts.opportunity): only the modes the menu does not mark `not_eligible`, each
 * with why, the experience that carries it and whether an approver must see it — never a brief's words, a tone, an event or a
 * source (those are the writer's). Undefined when there is no primary reading or nothing eligible. Structural input so the
 * arbiter passes what the hook returned without importing this module eagerly.
 */
export function opportunityFactsFrom(o: {
  reading?: { primary?: { kind?: string | null; stage?: string | null } | null; sensitive?: boolean } | null
  menu?: { options: ReadonlyArray<{ mode: string; status: string; why: string; experience: string; requiresApproval?: boolean }>; floor: string } | null
} | null | undefined): { kind: string; stage: string; sensitive: boolean; modes: Array<{ mode: string; status: string; why: string; experience: string; requiresApproval: boolean }>; floor: string } | undefined {
  if (!o?.reading?.primary || !o.menu) return undefined
  const modes = o.menu.options.filter((m) => m.status !== "not_eligible").map((m) => ({ mode: m.mode, status: m.status, why: m.why, experience: m.experience, requiresApproval: m.requiresApproval === true }))
  if (modes.length === 0) return undefined
  return { kind: String(o.reading.primary.kind ?? "unknown"), stage: String(o.reading.primary.stage ?? "none"), sensitive: o.reading.sensitive === true, modes, floor: o.menu.floor }
}

// ── the expert brief the deciding models read (one text, two readers) ─────────────────────────────────────────────────────────

/**
 * Appended to the movement manager's decision prompt (lib/intent/movement-signals.ts MOVEMENT_DECISION_SYSTEM) and offered to the
 * arbiter (Outside-lane, lane 149C) — the reasoning a behavioural researcher with a conscience applies to a combination.
 */
export const OPPORTUNITY_COMBINATION_BRIEF = [
  "HOW TO READ A COMBINATION (the `opportunity` reading): you are a behavioural researcher with a conscience. Early signs of a home decision (moving, selling, buying, investing, refinancing) are small and independent — the person's own activity on the tenant's surfaces, a public record about their property, their own public post, a licensed provider field — and NONE of them alone means anything. The reading's stage is computed by policy and you may never raise it: single_observation (one source, however often it repeats) and watch (inferences only) allow only quiet monitoring or research; emerging allows helpful education; likely (independent kinds agree, one verified, identity confirmed) or stated (the person's own words) allow appropriate outreach under consent and authority. Market and community context explain timing, never intent. Treat 'inferred' as a guess, 'reported' as unchecked, 'verified' as an authoritative record.",
  "WHAT KIND MEANS HERE: you serve the person, not the pipeline. Choose the least intrusive step that would genuinely help: often that is to keep watching quietly. Never let a message reveal what was observed, from where, or any life event; never exploit hardship, urgency or fear; never infer anything about a protected characteristic. Paid research is a cost to the tenant — free first-party reads first, reuse what was already learned, buy only what would change the decision.",
].join("\n")
