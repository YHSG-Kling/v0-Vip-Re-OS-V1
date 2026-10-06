// lib/kernel/resource-allocation.ts
//
// AUTONOMOUS RESOURCE ALLOCATION — RECOMMENDATION MODE FIRST (wave 106, lane 106A).
// Owner, verbatim: "Not automatically at first. Recommendation mode first." · lead assignment =
// Opportunity → Territory → eligible agents → capacity → competency → historical conversion →
// fatigue/workload → SLA → relationship → recommended agent · marketing = Budget → campaign
// performance → territory demand → agent capacity → pipeline need → marginal expected return →
// recommended allocation · "Use expensive reasoning only when expected value justifies it." · "Only
// purchase enrichment when missing information could change the decision."
//
// ONE kernel service: PURE PLANNERS (planLeadAssignment, planMarketingAllocation,
// shouldUseExpensiveReasoning, shouldPurchaseEnrichment — no model call, no I/O) over THIN READERS
// that re-query no survivor's table and name the survivor they read:
//   · opportunity ........ leads row (tenant-pinned)
//   · territory .......... farm_territories (zip_codes ∋ the lead's zip) — the same rows serves_territory derives from
//   · eligibility ........ agents.is_active (the roster), the rule pass stays lib/lead-assignment/*
//   · capacity + fatigue . capacityFor (lib/lead-assignment/capacity-pick.ts — THE ONE kernel answer; the
//                          twin's persisted capacity line first, readBrokerageTwin snapshot mode)
//   · competency ......... loadAgentCompetency → scoreCompetency (lib/education/skill-freshness(-radar).ts)
//   · conversion ......... leads handed to the agent (handed_to_agent_at) vs converted_at — the same
//                          outcome rail agent-scorecard / roi-ledger count on
//   · SLA ................ lead_sla_tracking (speed-to-lead's ledger; breached per agent)
//   · relationship ....... relationship_edges through neighbors (lib/kernel/relationship-graph.ts)
//   · campaign performance marketing_campaigns + marketing_attribution_credits (the ROI ledger's rows)
//   · territory demand ... territory_metrics (latest per zip) + farm_territories budgets
//   · pipeline need ...... the brokerage twin (now.pipeline / capacity)
//   · policy ............. brokerage_settings.settings.resource_allocation (TENANT_POLICY_SETTINGS_KEYS)
// A refused reader is a PUBLISHED BLIND SPOT on the recommendation, never a silent neutral.
//
// A recommendation is an improvement_proposals row of subject_kind `allocation` (104C's one proposal
// object; m721 widens the CHECK) that a HUMAN approves on the Manager Trust page — authority 6, never
// model-promoted; promotion of a lead-assignment proposal commits through the survivor
// handleLeadAssigned (improvement-proposals.ts applyChange), a marketing proposal's approval is the
// review. Every recommendation leaves a ledger row (withActionLedger, policy_ref resource_allocation)
// and an auditOnly kernel event. The existing assigner (lib/lead-assignment/tier-routing.ts
// autoAssignLead) CONSULTS this service: mode `recommend` (default) records beside its own decision,
// `consume` lets the recommendation replace the rules' pick (method ai_recommendation), `off` skips.
// Agents never see leads (CLAUDE.md §5) nor cost: the readers are the admin Command Center card and
// the team-lead brief line; no agent brief imports this module (the proof holds it).

import { hasHeadroom, type CapacityBand, type WorkloadSignals } from "@/lib/kernel/capacity-guardian"
import type { CompetencyProfile, CompetencySkill } from "@/lib/education/skill-freshness"

type Svc = { from: (t: string) => any }
const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

// ── POLICY (one tenant policy key, read through the registered settings store) ────────────────

export const RESOURCE_ALLOCATION_POLICY_KEY = "resource_allocation"
export const LEAD_ASSIGNMENT_MODES = ["off", "recommend", "consume"] as const
export type LeadAssignmentMode = (typeof LEAD_ASSIGNMENT_MODES)[number]

export interface ResourceAllocationPolicy {
  /** recommend (DEFAULT — the owner's "recommendation mode first") · consume (the assigner takes the recommendation) · off */
  lead_assignment_mode: LeadAssignmentMode
  /** Expensive reasoning runs only when expectedValueUsd / costUsd ≥ this. */
  ai_min_value_to_cost_ratio: number
  /** Enrichment for ONE decision is bought only up to this many USD. */
  enrichment_max_usd_per_decision: number
}

export const DEFAULT_RESOURCE_ALLOCATION_POLICY: Readonly<ResourceAllocationPolicy> = Object.freeze({
  lead_assignment_mode: "recommend",
  ai_min_value_to_cost_ratio: 20,
  enrichment_max_usd_per_decision: 1,
})

export type ResolvedAllocationPolicy = ResourceAllocationPolicy & { source: "default" | "tenant"; error: string | null }

/** PURE — the tenant's policy from brokerage_settings.settings (any shape; unknown / malformed → the default field). */
export function resolveResourceAllocationPolicy(settings: unknown, error: string | null = null): ResolvedAllocationPolicy {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[RESOURCE_ALLOCATION_POLICY_KEY] : null
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  const d = DEFAULT_RESOURCE_ALLOCATION_POLICY
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback)
  const mode = (LEAD_ASSIGNMENT_MODES as readonly string[]).includes(String(p?.lead_assignment_mode)) ? (p!.lead_assignment_mode as LeadAssignmentMode) : d.lead_assignment_mode
  return {
    lead_assignment_mode: mode,
    ai_min_value_to_cost_ratio: num(p?.ai_min_value_to_cost_ratio, d.ai_min_value_to_cost_ratio),
    enrichment_max_usd_per_decision: num(p?.enrichment_max_usd_per_decision, d.enrichment_max_usd_per_decision),
    source: p ? "tenant" : "default",
    error,
  }
}

/** THIN READER — a refused read answers the DEFAULT policy with the refusal published (a spend gate
 *  that cannot read its policy still gates, on the conservative defaults — never "nobody checked"). */
export async function loadResourceAllocationPolicy(svc: Svc, brokerageId: string): Promise<ResolvedAllocationPolicy> {
  if (!brokerageId) return resolveResourceAllocationPolicy(null, "no brokerage — default policy")
  try {
    const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return resolveResourceAllocationPolicy(null, `policy read refused: ${error.message}`)
    return resolveResourceAllocationPolicy((data as { settings?: unknown } | null)?.settings ?? null)
  } catch (e) {
    return resolveResourceAllocationPolicy(null, `policy read threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── LEAD ASSIGNMENT — the owner's chain, each step named ─────────────────────────────────────

export const LEAD_ASSIGNMENT_CHAIN = ["opportunity", "territory", "eligibility", "capacity", "competency", "conversion", "fatigue", "sla", "relationship"] as const
export type LeadAssignmentStep = (typeof LEAD_ASSIGNMENT_CHAIN)[number]

/** The weight each scored step carries in the ranking (sums to 1). Eligibility excludes, opportunity frames. */
export const LEAD_FACTOR_WEIGHTS: Readonly<Record<Exclude<LeadAssignmentStep, "opportunity" | "eligibility">, number>> = Object.freeze({
  territory: 0.15, capacity: 0.20, competency: 0.15, conversion: 0.20, fatigue: 0.10, sla: 0.10, relationship: 0.10,
})

/** The competency skills an opportunity's motivation makes relevant (scoreCompetency's vocabulary). */
export const RELEVANT_SKILLS_BY_MOTIVATION: Readonly<Record<"seller" | "buyer" | "other", readonly CompetencySkill[]>> = Object.freeze({
  // Wave 106D's ONE competency vocabulary (the 103A rail spellings closing / objection_handling /
  // lead_response / product_knowledge were tombstoned onto negotiation / follow_up / technology).
  seller: ["lead_conversion", "negotiation", "listing_presentation"],
  buyer: ["lead_conversion", "follow_up", "buyer_consultation"],
  other: ["follow_up", "lead_conversion"],
})

export interface LeadOpportunity {
  leadId: string
  zip: string | null
  motivationType: string | null
  persona: string | null
  estimatedValue: number | null
  leadScore: number | null
  source: string | null
  leadStage: string | null
  lifecycleState: string | null
  alreadyAssignedTo: string | null
}

export interface LeadCandidateFacts {
  /** agents.id — the FK every work table carries (never users.id). */
  agentId: string
  userId: string | null
  name: string | null
  /** null = no territory covers this zip (every eligible agent is considered). */
  inTerritory: boolean | null
  eligible: { ok: boolean; reason: string }
  capacity: { band: CapacityBand; load: number; headroom: number; fatigueTier: WorkloadSignals["fatigueTier"]; reasons: string[] } | null
  competency: Pick<CompetencyProfile, "skills" | "overall"> | null
  conversion: { handed: number; converted: number } | null
  sla: { tracked: number; breached: number } | null
  relationship: { types: string[] } | null
}

export interface LeadAssignmentFacts {
  brokerageId: string
  opportunity: LeadOpportunity
  territory: { covered: boolean; territoryIds: string[]; agentIds: string[]; reader: string }
  candidates: LeadCandidateFacts[]
  blindSpots: string[]
}

export interface LeadFactor { step: LeadAssignmentStep; score: number | null; weight: number; reason: string; reader: string }

export interface RankedAgent { agentId: string; name: string | null; total: number; factors: LeadFactor[]; load: number | null }

export interface LeadAssignmentRecommendation {
  kind: "lead_assignment"
  brokerageId: string
  leadId: string
  /** The owner's chain, in order: did the step contribute, with what, read from where. */
  chain: Array<{ step: LeadAssignmentStep; contributed: boolean; detail: string; reader: string }>
  ranked: RankedAgent[]
  excluded: Array<{ agentId: string; reason: string }>
  recommended: { agentId: string; name: string | null; total: number; why: string } | null
  blindSpots: string[]
}

const READER: Record<LeadAssignmentStep, string> = {
  opportunity: "leads (tenant-pinned)",
  territory: "farm_territories.zip_codes",
  eligibility: "agents.is_active",
  capacity: "capacityFor (capacity-pick.ts) / twin capacity line",
  competency: "loadAgentCompetency → scoreCompetency",
  conversion: "leads.handed_to_agent_at vs converted_at (180d)",
  fatigue: "agent_retention_scores.tier via capacityFor",
  sla: "lead_sla_tracking.breached (180d)",
  relationship: "relationship_edges via neighbors()",
}

function motivationClass(m: string | null): "seller" | "buyer" | "other" {
  const s = (m ?? "").toLowerCase()
  if (/sell|list|equity|downsiz|relocat/.test(s)) return "seller"
  if (/buy|purchase|invest|rent|move|first/.test(s)) return "buyer"
  return "other"
}

const BAND_SCORE: Record<CapacityBand, number> = { available: 1, busy: 0.7, at_capacity: 0.3, over: 0 }
const FATIGUE_SCORE: Record<NonNullable<WorkloadSignals["fatigueTier"]>, number> = { engaged: 1, healthy: 1, watch: 0.6, at_risk: 0.35, critical: 0.1 }

/**
 * PURE + deterministic — the owner's chain over gathered facts. Every ranked agent carries a score
 * per step with its reason and reader; an unreadable factor scores NEUTRAL (0.5) and says so, so a
 * refused read can never silently promote or demote an agent. Ties: lower load, then agentId.
 */
export function planLeadAssignment(facts: LeadAssignmentFacts): LeadAssignmentRecommendation {
  const o = facts.opportunity
  const blind = [...facts.blindSpots]
  const motivation = motivationClass(o.motivationType)
  const relevant = RELEVANT_SKILLS_BY_MOTIVATION[motivation]
  const chain: LeadAssignmentRecommendation["chain"] = []
  chain.push({ step: "opportunity", contributed: true, reader: READER.opportunity,
    detail: `lead ${o.leadId}: zip ${o.zip ?? "—"}, motivation ${o.motivationType ?? "unknown"} (${motivation}), persona ${o.persona ?? "—"}, score ${o.leadScore ?? "—"}, est. value ${o.estimatedValue != null ? `$${Math.round(o.estimatedValue).toLocaleString()}` : "—"}` })
  chain.push({ step: "territory", contributed: facts.territory.covered, reader: facts.territory.reader,
    detail: facts.territory.covered ? `${facts.territory.territoryIds.length} territor${facts.territory.territoryIds.length === 1 ? "y" : "ies"} cover zip ${o.zip}; ${facts.territory.agentIds.length} serving agent(s) lead the ranking` : `no active territory covers zip ${o.zip ?? "—"} — every eligible agent is considered` })

  const excluded: LeadAssignmentRecommendation["excluded"] = []
  const ranked: RankedAgent[] = []
  let readCapacity = 0, readCompetency = 0, readConversion = 0, readSla = 0, readRelationship = 0, withFatigue = 0
  for (const c of facts.candidates) {
    if (!c.eligible.ok) { excluded.push({ agentId: c.agentId, reason: c.eligible.reason }); continue }
    const f: LeadFactor[] = []
    const add = (step: keyof typeof LEAD_FACTOR_WEIGHTS, score: number | null, reason: string) => f.push({ step, score: score == null ? null : r3(clamp01(score)), weight: LEAD_FACTOR_WEIGHTS[step], reason, reader: READER[step] })
    // territory
    if (!facts.territory.covered) add("territory", 0.5, "no territory covers the zip — neutral")
    else add("territory", c.inTerritory ? 1 : 0.25, c.inTerritory ? "serves the lead's territory" : "outside the lead's territory")
    // capacity + fatigue (one read, two steps)
    if (c.capacity) {
      readCapacity++
      add("capacity", BAND_SCORE[c.capacity.band], `${c.capacity.band.replace("_", " ")}: load ${c.capacity.load}, headroom ${c.capacity.headroom}${c.capacity.reasons.length ? ` — ${c.capacity.reasons.slice(0, 2).join("; ")}` : ""}`)
      if (c.capacity.fatigueTier) { withFatigue++; add("fatigue", FATIGUE_SCORE[c.capacity.fatigueTier], `retention tier ${c.capacity.fatigueTier}`) }
      else add("fatigue", 1, "no fatigue signal on file (healthy by absence of evidence)")
    } else { add("capacity", 0.5, "capacity unreadable — neutral"); add("fatigue", 0.5, "fatigue unreadable — neutral") }
    // competency
    if (c.competency) {
      readCompetency++
      const scored = c.competency.skills.filter((s) => relevant.includes(s.skill) && s.score != null)
      if (scored.length > 0) {
        const mean = scored.reduce((a, s) => a + (s.score as number), 0) / scored.length
        add("competency", mean / 100, `${scored.map((s) => `${s.skill} ${s.score}`).join(", ")} (${motivation} skills)`)
      } else add("competency", 0.5, `no evidence yet on the ${motivation} skills (${relevant.join(", ")}) — unproven, neutral`)
    } else add("competency", 0.5, "competency not read — neutral")
    // conversion (Laplace-smoothed so three leads do not read as a 100% closer)
    if (c.conversion) {
      readConversion++
      const { handed, converted } = c.conversion
      if (handed >= 3) add("conversion", (converted + 1) / (handed + 2), `${converted} of ${handed} handed leads converted (180d, smoothed)`)
      else add("conversion", 0.5, `only ${handed} lead(s) handed in 180d — too thin, neutral`)
    } else add("conversion", 0.5, "conversion history not read — neutral")
    // SLA
    if (c.sla) {
      readSla++
      if (c.sla.tracked >= 3) add("sla", 1 - c.sla.breached / c.sla.tracked, `${c.sla.breached} of ${c.sla.tracked} lead SLAs breached (180d)`)
      else add("sla", 0.5, `only ${c.sla.tracked} SLA record(s) — neutral`)
    } else add("sla", 0.5, "SLA record not read — neutral")
    // relationship
    if (c.relationship) {
      readRelationship++
      if (c.relationship.types.length > 0) add("relationship", 1, `already related to this person: ${c.relationship.types.join(", ")}`)
      else add("relationship", 0.5, "no existing relationship with this person — neutral")
    } else add("relationship", 0.5, "relationship graph not read — neutral")
    const total = r3(f.reduce((a, x) => a + (x.score ?? 0.5) * x.weight, 0))
    ranked.push({ agentId: c.agentId, name: c.name, total, factors: f, load: c.capacity?.load ?? null })
  }
  ranked.sort((a, b) => b.total - a.total || (a.load ?? Infinity) - (b.load ?? Infinity) || a.agentId.localeCompare(b.agentId))
  const n = ranked.length
  chain.push({ step: "eligibility", contributed: true, reader: READER.eligibility, detail: `${n} eligible agent(s), ${excluded.length} excluded` })
  const stepLine = (step: LeadAssignmentStep, read: number, what: string) => chain.push({ step, contributed: read > 0, reader: READER[step], detail: read > 0 ? `${what} read for ${read} of ${n}` : `${what} unreadable — scored neutral for all ${n}` })
  stepLine("capacity", readCapacity, "capacity")
  stepLine("competency", readCompetency, `competency (${relevant.join(", ")})`)
  stepLine("conversion", readConversion, "historical conversion")
  chain.push({ step: "fatigue", contributed: readCapacity > 0, reader: READER.fatigue, detail: readCapacity > 0 ? `fatigue tier present for ${withFatigue} of ${n}` : "fatigue unreadable (rides the capacity read)" })
  stepLine("sla", readSla, "SLA record")
  stepLine("relationship", readRelationship, "relationship edges")
  if (n > 0 && readCapacity === 0) blind.push("capacity unreadable for every candidate")
  if (n > 0 && readCompetency === 0) blind.push("competency unreadable for every candidate")

  const top = ranked[0]
  const recommended = top ? {
    agentId: top.agentId, name: top.name, total: top.total,
    why: top.factors.filter((x) => (x.score ?? 0.5) >= 0.7).map((x) => `${x.step}: ${x.reason}`).join("; ") || "best of a weak field — every factor neutral or low",
  } : null
  if (!top) blind.push(n === 0 && excluded.length > 0 ? "no eligible agent — every candidate excluded" : "no candidates")
  return { kind: "lead_assignment", brokerageId: facts.brokerageId, leadId: o.leadId, chain, ranked, excluded, recommended, blindSpots: blind }
}

// ── THIN READERS (lead) — seams default to the survivors ─────────────────────────────────────

export interface LeadFactDeps {
  now?: Date
  /** Candidates past this cap are scored neutral on competency (the dearest read). */
  competencyCap?: number
  capacity?: (agentId: string) => Promise<LeadCandidateFacts["capacity"]>
  competency?: (agent: { id: string; user_id: string | null; brokerage_id: string }) => Promise<LeadCandidateFacts["competency"]>
}

export type LeadFactsResult = { ok: true; facts: LeadAssignmentFacts } | { ok: false; error: string }

function zipsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((z) => String(z).trim()).filter(Boolean)
  if (typeof v === "string") return v.replace(/[{}"]/g, "").split(",").map((z) => z.trim()).filter(Boolean)
  return []
}

/** Gather the chain's facts for ONE lead of ONE tenant. Every read is tenant-pinned and error-read. */
export async function gatherLeadAssignmentFacts(svc: Svc, input: { brokerageId: string; leadId: string }, deps: LeadFactDeps = {}): Promise<LeadFactsResult> {
  const { brokerageId, leadId } = input
  if (!brokerageId || !leadId) return { ok: false, error: "tenant scope and lead id required" }
  const now = deps.now ?? new Date()
  const since = new Date(now.getTime() - 180 * 86_400_000).toISOString()
  const blindSpots: string[] = []

  const { data: lead, error: leadErr } = await svc.from("leads")
    .select("id, brokerage_id, lead_stage, lifecycle_state, lead_score, property_zip_code, source, motivation_type, persona, estimated_value, agent_id, contact_id")
    .eq("id", leadId).eq("brokerage_id", brokerageId).maybeSingle()
  if (leadErr) return { ok: false, error: `lead read refused: ${leadErr.message}` }
  if (!lead) return { ok: false, error: "lead not found in this brokerage" }
  const opportunity: LeadOpportunity = {
    leadId, zip: lead.property_zip_code ?? null, motivationType: lead.motivation_type ?? null, persona: lead.persona ?? null,
    estimatedValue: lead.estimated_value != null ? Number(lead.estimated_value) : null, leadScore: lead.lead_score != null ? Number(lead.lead_score) : null,
    source: lead.source ?? null, leadStage: lead.lead_stage ?? null, lifecycleState: lead.lifecycle_state ?? null, alreadyAssignedTo: lead.agent_id ?? null,
  }

  const { data: agents, error: agentsErr } = await svc.from("agents").select("id, user_id, is_active").eq("brokerage_id", brokerageId).limit(500)
  if (agentsErr) return { ok: false, error: `roster read refused: ${agentsErr.message}` }
  const roster = (agents ?? []) as Array<{ id: string; user_id: string | null; is_active: boolean | null }>
  const active = roster.filter((a) => a.is_active !== false)
  const activeIds = active.map((a) => a.id)
  const userIds = active.map((a) => a.user_id).filter(Boolean) as string[]

  const names = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: users, error: uErr } = await svc.from("users").select("id, first_name, last_name").in("id", userIds)
    if (uErr) blindSpots.push(`names unreadable: ${uErr.message}`)
    for (const u of (users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) names.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim())
  }

  // territory
  let territory: LeadAssignmentFacts["territory"] = { covered: false, territoryIds: [], agentIds: [], reader: READER.territory }
  if (opportunity.zip) {
    const { data: terr, error: tErr } = await svc.from("farm_territories").select("id, agent_id, zip_codes, is_active").eq("brokerage_id", brokerageId).eq("is_active", true).limit(500)
    if (tErr) blindSpots.push(`territories unreadable: ${tErr.message}`)
    else {
      const hits = ((terr ?? []) as Array<{ id: string; agent_id: string | null; zip_codes: unknown }>).filter((t) => zipsOf(t.zip_codes).includes(opportunity.zip as string))
      territory = { covered: hits.length > 0, territoryIds: hits.map((t) => t.id), agentIds: [...new Set(hits.map((t) => t.agent_id).filter(Boolean) as string[])], reader: READER.territory }
    }
  }

  // conversion + SLA + relationship (one read each, grouped per agent)
  const conv = new Map<string, { handed: number; converted: number }>()
  let convOk = false
  if (activeIds.length > 0) {
    const { data: handed, error: hErr } = await svc.from("leads").select("agent_id, converted_at, handed_to_agent_at").eq("brokerage_id", brokerageId).in("agent_id", activeIds).gte("handed_to_agent_at", since).limit(5000)
    if (hErr) blindSpots.push(`conversion history unreadable: ${hErr.message}`)
    else { convOk = true; for (const r of (handed ?? []) as Array<{ agent_id: string; converted_at: string | null }>) { const c = conv.get(r.agent_id) ?? { handed: 0, converted: 0 }; c.handed++; if (r.converted_at) c.converted++; conv.set(r.agent_id, c) } }
  }
  const sla = new Map<string, { tracked: number; breached: number }>()
  let slaOk = false
  if (activeIds.length > 0) {
    const { data: slaRows, error: sErr } = await svc.from("lead_sla_tracking").select("agent_id, breached").eq("brokerage_id", brokerageId).in("agent_id", activeIds).gte("created_at", since).limit(5000)
    if (sErr) blindSpots.push(`SLA records unreadable: ${sErr.message}`)
    else { slaOk = true; for (const r of (slaRows ?? []) as Array<{ agent_id: string | null; breached: boolean | null }>) { if (!r.agent_id) continue; const s = sla.get(r.agent_id) ?? { tracked: 0, breached: 0 }; s.tracked++; if (r.breached) s.breached++; sla.set(r.agent_id, s) } }
  }
  const rel = new Map<string, string[]>()
  let relOk = false
  try {
    const { neighbors } = await import("@/lib/kernel/relationship-graph")
    const ents: Array<{ type: "lead" | "contact"; id: string }> = [{ type: "lead", id: leadId }]
    if (lead.contact_id) ents.push({ type: "contact", id: lead.contact_id })
    const byUser = new Map(active.filter((a) => a.user_id).map((a) => [a.user_id as string, a.id]))
    let refused: string | null = null
    for (const e of ents) {
      const n = await neighbors(svc as any, { brokerageId, entity: e })
      if (!n.ok) { refused = n.error; break }
      for (const edge of n.edges) {
        const agentUser = edge.from_entity_type === "agent" ? edge.from_entity_id : edge.to_entity_type === "agent" ? edge.to_entity_id : null
        const agentsId = agentUser ? byUser.get(agentUser) : null
        if (agentsId) rel.set(agentsId, [...(rel.get(agentsId) ?? []), edge.relationship_type])
      }
    }
    if (refused) blindSpots.push(`relationship graph unreadable: ${refused}`); else relOk = true
  } catch (e) { blindSpots.push(`relationship graph threw: ${e instanceof Error ? e.message : String(e)}`) }

  // capacity (the one kernel answer; the twin's line first) + competency (capped)
  const capacityOf = deps.capacity ?? (await defaultCapacityReader(svc, brokerageId, now))
  const competencyOf = deps.competency ?? (async (agent: { id: string; user_id: string | null; brokerage_id: string }) => {
    const { loadAgentCompetency } = await import("@/lib/education/skill-freshness-radar")
    const p = await loadAgentCompetency(svc as any, agent, now)
    return { skills: p.skills, overall: p.overall }
  })
  const cap = deps.competencyCap ?? 12
  const candidates: LeadCandidateFacts[] = []
  let competencyRead = 0
  for (const a of roster) {
    const base: LeadCandidateFacts = {
      agentId: a.id, userId: a.user_id, name: a.user_id ? names.get(a.user_id) ?? null : null,
      inTerritory: territory.covered ? territory.agentIds.includes(a.id) : null,
      eligible: a.is_active === false ? { ok: false, reason: "inactive agent (agents.is_active=false)" } : { ok: true, reason: "active" },
      capacity: null, competency: null, conversion: convOk ? conv.get(a.id) ?? { handed: 0, converted: 0 } : null,
      sla: slaOk ? sla.get(a.id) ?? { tracked: 0, breached: 0 } : null, relationship: relOk ? { types: rel.get(a.id) ?? [] } : null,
    }
    if (base.eligible.ok) {
      try { base.capacity = await capacityOf(a.id) } catch (e) { blindSpots.push(`capacity for ${a.id} threw: ${e instanceof Error ? e.message : String(e)}`) }
      if (competencyRead < cap) {
        competencyRead++
        try { base.competency = await competencyOf({ id: a.id, user_id: a.user_id, brokerage_id: brokerageId }) } catch (e) { blindSpots.push(`competency for ${a.id} threw: ${e instanceof Error ? e.message : String(e)}`) }
      }
    }
    candidates.push(base)
  }
  if (active.length > cap) blindSpots.push(`competency read for the first ${cap} of ${active.length} eligible agents (cap) — the rest scored neutral`)
  return { ok: true, facts: { brokerageId, opportunity, territory, candidates, blindSpots } }
}

async function defaultCapacityReader(svc: Svc, brokerageId: string, now: Date): Promise<(agentId: string) => Promise<LeadCandidateFacts["capacity"]>> {
  const { readBrokerageTwin, twinCapacityForAgent } = await import("@/lib/kernel/brokerage-twin")
  const { capacityFor, resolveBrokerageMaxLoad } = await import("@/lib/lead-assignment/capacity-pick")
  const twin = await readBrokerageTwin(brokerageId, { svc: svc as any, snapshot: { now } })
  let maxLoad: number | null = twin?.capacity.maxLoad ?? null
  return async (agentId: string) => {
    const line = twinCapacityForAgent(twin, agentId)
    if (line) return { band: line.band, load: line.load, headroom: line.headroom, fatigueTier: line.fatigueTier, reasons: line.reasons }
    maxLoad = maxLoad ?? await resolveBrokerageMaxLoad(svc as any, brokerageId)
    const c = await capacityFor(svc as any, brokerageId, agentId, { now, maxLoad })
    return { band: c.band, load: c.load, headroom: c.headroom, fatigueTier: c.fatigueTier ?? null, reasons: c.reasons }
  }
}

// ── RECORDING — proposal (human approves) + ledger + event per recommendation ───────────────

export const ALLOCATION_PROPOSER = "resource_allocation" as const
export const ALLOCATION_SUBJECT_KIND = "allocation" as const
export type AllocationKind = "lead_assignment" | "marketing_allocation"
export const allocationSubjectKey = (kind: AllocationKind, id: string): string => `${kind}:${id}`

export type RecordResult = { ok: true; proposalId: string; existing: boolean; ledgered: boolean } | { ok: false; error: string }

/**
 * ONE recommendation → ONE improvement_proposals row (subject_kind allocation, authority 6: a human on
 * the Manager Trust page decides) + ONE ledger row (allocation.recommend.<kind>, READ risk, policy_ref
 * resource_allocation) + ONE auditOnly kernel event. Idempotent on the subject key: a re-run of the
 * same recommendation finds the open row and writes no second ledger row.
 */
export async function recordAllocationRecommendation(
  svc: Svc,
  input: { brokerageId: string; kind: AllocationKind; subjectId: string; recommendation: LeadAssignmentRecommendation | MarketingAllocationRecommendation; evidenceRefs?: unknown[] },
): Promise<RecordResult> {
  if (!input.brokerageId) return { ok: false, error: "tenant scope required" }
  const subjectKey = allocationSubjectKey(input.kind, input.subjectId)
  const summary = summarizeRecommendation(input.recommendation)
  try {
    const { proposeImprovement } = await import("@/lib/kernel/improvement-proposals")
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    let ledgered = true
    const propose = () => proposeImprovement(svc, {
      brokerageId: input.brokerageId, subjectKind: ALLOCATION_SUBJECT_KIND, subjectKey, proposer: ALLOCATION_PROPOSER,
      proposedChange: { kind: input.kind, summary, recommendation: input.recommendation },
      evidenceRefs: input.evidenceRefs ?? [{ kind: "chain", steps: input.kind === "lead_assignment" ? (input.recommendation as LeadAssignmentRecommendation).chain : (input.recommendation as MarketingAllocationRecommendation).chain }],
    })
    // One ledger row per subject per DAY (the recommendation is re-made as facts move); the proposal
    // itself de-dupes on the OPEN row (proposeImprovement finds it), so a replayed day still answers
    // the proposal id a human is looking at — never a second proposal, never a second ledger row.
    const day = new Date().toISOString().slice(0, 10)
    let res = await withActionLedger<Awaited<ReturnType<typeof proposeImprovement>>>(
      {
        brokerageId: input.brokerageId,
        action: `allocation.recommend.${input.kind}`,
        actor: { type: "system", managerKey: "ai_isa" },
        subject: { type: input.kind === "lead_assignment" ? "lead" : "marketing_budget", id: input.subjectId },
        reasonCode: "STAFF_ALERT",
        reasonDetail: summary.slice(0, 500),
        idempotencyKey: `allocation.recommend:${subjectKey}:${day}`,
        riskClass: "READ",
        systemSource: "resource_allocation",
        policyKey: RESOURCE_ALLOCATION_POLICY_KEY,
        detail: { kind: input.kind, summary, blind_spots: input.recommendation.blindSpots },
      },
      propose,
      {
        settle: (r) => r.ok ? { status: "executed", outcome: r.existing ? "existing_proposal" : "proposed" } : { status: "failed", outcome: "proposal_refused", error: r.error },
        replay: () => { ledgered = false; return { ok: false as const, error: "__replay__" } },
      },
      { client: svc as any },
    )
    if (!res.ok && res.error === "__replay__") res = await propose()
    if (!res.ok) return { ok: false, error: res.error }
    if (!ledgered) return { ok: true, proposalId: res.id, existing: res.existing, ledgered: false }
    try {
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      await emitKernelEvent({ event: "resource_allocation.recommended", brokerageId: input.brokerageId, entityType: "improvement_proposal", entityId: res.id, source: "system", metadata: { kind: input.kind, subject_key: subjectKey, summary }, auditOnly: true, client: svc as any })
    } catch { /* the ledger row is the consequential evidence */ }
    return { ok: true, proposalId: res.id, existing: res.existing, ledgered }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** PURE: the one-line summary a card / brief / ledger carries. */
export function summarizeRecommendation(rec: LeadAssignmentRecommendation | MarketingAllocationRecommendation): string {
  if (rec.kind === "lead_assignment") {
    return rec.recommended
      ? `Assign lead to ${rec.recommended.name ?? rec.recommended.agentId} (score ${rec.recommended.total}; ${rec.ranked.length} ranked) — ${rec.recommended.why}`
      : `No agent recommended for the lead (${rec.excluded.length} excluded; ${rec.blindSpots.join("; ") || "no candidates"})`
  }
  const top = rec.allocations.filter((a) => a.amountUsd > 0).slice(0, 3)
  return top.length > 0
    ? `Allocate $${rec.budgetUsd.toLocaleString()}: ${top.map((a) => `${a.name} $${a.amountUsd.toLocaleString()} (${a.kind})`).join(", ")}${rec.allocations.filter((a) => a.amountUsd > 0).length > 3 ? ", …" : ""} — expected return $${Math.round(rec.totalExpectedReturnUsd).toLocaleString()}`
    : `No allocation recommended for $${rec.budgetUsd.toLocaleString()} (${rec.blindSpots.join("; ") || "no candidates with a positive marginal return"})`
}

// ── THE DOORS ───────────────────────────────────────────────────────────────────────────────

export type LeadRecommendResult =
  | { ok: true; recommendation: LeadAssignmentRecommendation; policy: ResolvedAllocationPolicy; record: RecordResult | null }
  | { ok: false; error: string }

/** Gather → plan → (record). `record: false` plans only (the assigner's consult decides whether to record). */
export async function recommendLeadAssignment(
  svc: Svc, input: { brokerageId: string; leadId: string },
  opts: LeadFactDeps & { record?: boolean; policy?: ResolvedAllocationPolicy } = {},
): Promise<LeadRecommendResult> {
  const facts = await gatherLeadAssignmentFacts(svc, input, opts)
  if (!facts.ok) return facts
  const policy = opts.policy ?? await loadResourceAllocationPolicy(svc, input.brokerageId)
  const recommendation = planLeadAssignment(facts.facts)
  if (policy.error) recommendation.blindSpots.push(policy.error)
  const record = opts.record === false ? null : await recordAllocationRecommendation(svc, { brokerageId: input.brokerageId, kind: "lead_assignment", subjectId: input.leadId, recommendation })
  return { ok: true, recommendation, policy, record }
}

export interface AssignerConsult {
  mode: LeadAssignmentMode
  /** The agent the assigner should use INSTEAD of its own pick — only in `consume` mode, only when one was recommended. */
  consumeAgentId: string | null
  recommendedAgentId: string | null
  /** The proposal written for a human (held lead, or a recommendation that differs from the rules' pick). */
  proposalId: string | null
  note: string
}

/**
 * THE ASSIGNER'S CONSULT (lib/lead-assignment/tier-routing.ts autoAssignLead). Never throws.
 *   off ........ nothing read, nothing written.
 *   recommend .. (DEFAULT) the chain runs; a HELD lead or a recommendation that DIFFERS from the rules'
 *                pick is recorded as a proposal for a human; the rules' pick stands.
 *   consume .... the recommendation replaces the rules' pick (method ai_recommendation); still recorded
 *                when the lead is held (a human routes it) — the policy key is the tenant's explicit opt-in.
 */
export async function consultLeadAssignmentRecommendation(
  svc: Svc, input: { brokerageId: string; leadId: string; rulesAgentId: string | null; held: boolean },
  deps: LeadFactDeps & { policy?: ResolvedAllocationPolicy } = {},
): Promise<AssignerConsult> {
  const policy = deps.policy ?? await loadResourceAllocationPolicy(svc, input.brokerageId)
  const mode = policy.lead_assignment_mode
  if (mode === "off") return { mode, consumeAgentId: null, recommendedAgentId: null, proposalId: null, note: "resource_allocation.lead_assignment_mode=off" }
  try {
    const r = await recommendLeadAssignment(svc, { brokerageId: input.brokerageId, leadId: input.leadId }, { ...deps, policy, record: false })
    if (!r.ok) return { mode, consumeAgentId: null, recommendedAgentId: null, proposalId: null, note: `recommendation unavailable: ${r.error}` }
    const rec = r.recommendation.recommended?.agentId ?? null
    const differs = rec != null && rec !== input.rulesAgentId
    const shouldRecord = input.held || (mode === "recommend" && differs)
    let proposalId: string | null = null
    if (shouldRecord) {
      const w = await recordAllocationRecommendation(svc, { brokerageId: input.brokerageId, kind: "lead_assignment", subjectId: input.leadId, recommendation: r.recommendation })
      proposalId = w.ok ? w.proposalId : null
    }
    const consume = mode === "consume" && rec != null && !input.held
    const note = rec == null
      ? `recommendation: none (${r.recommendation.blindSpots.join("; ") || "no eligible agent"})`
      : `recommendation: ${rec} score ${r.recommendation.recommended?.total}${input.held ? " (lead held — proposal for a human)" : differs ? (consume ? " (consumed — replaces the rules' pick)" : " (differs from the rules' pick — proposal for a human)") : " (agrees with the rules' pick)"}`
    return { mode, consumeAgentId: consume ? rec : null, recommendedAgentId: rec, proposalId, note }
  } catch (e) {
    return { mode, consumeAgentId: null, recommendedAgentId: null, proposalId: null, note: `recommendation threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── MARKETING ALLOCATION — marginal expected return, the math shown ─────────────────────────

export const MARKETING_ALLOCATION_CHAIN = ["budget", "campaign_performance", "territory_demand", "agent_capacity", "pipeline_need", "marginal_return"] as const
export type MarketingStep = (typeof MARKETING_ALLOCATION_CHAIN)[number]

/** With NO return history a candidate's base return per dollar is this flat prior (published on the step). */
export const MARKETING_PRIOR_RETURN_PER_USD = 1.5
/** Default spend (USD) at which a candidate's marginal return has halved. */
export const MARKETING_DEFAULT_SATURATION_USD = 1000
/** Fallback value of one conversion when the twin has no closed GCI to derive it from. */
export const MARKETING_DEFAULT_VALUE_PER_CONVERSION_USD = 5000

export interface MarketingCandidate {
  kind: "campaign" | "territory"
  id: string
  name: string
  spendUsd: number
  /** Attributed return in the window (credits / derived from conversions × value). */
  returnUsd: number
  leads: number
  conversions: number
  /** Agents with headroom to work what the spend produces (null = unreadable). */
  capacityHeadroom: number | null
  /** 0..1 how badly the pipeline needs leads here (null = unreadable). */
  pipelineNeed: number | null
  saturationUsd?: number
  reader: string
}

export interface MarketingAllocationFacts {
  brokerageId: string
  budgetUsd: number
  candidates: MarketingCandidate[]
  blindSpots: string[]
}

export interface AllocationStep { n: number; candidateId: string; amountUsd: number; marginalReturnPerUsd: number; cumulativeUsd: number; math: string }

export interface MarketingAllocationRecommendation {
  kind: "marketing_allocation"
  brokerageId: string
  budgetUsd: number
  chain: Array<{ step: MarketingStep; contributed: boolean; detail: string; reader: string }>
  allocations: Array<{ candidateId: string; kind: MarketingCandidate["kind"]; name: string; amountUsd: number; expectedReturnUsd: number; baseReturnPerUsd: number; capacityFactor: number; needFactor: number; saturationUsd: number; reasons: string[] }>
  steps: AllocationStep[]
  unallocatedUsd: number
  totalExpectedReturnUsd: number
  blindSpots: string[]
}

/** PURE — the marginal return of the NEXT dollar on candidate c after x dollars: base × capacity × need / (1 + x / saturation). */
export function marginalReturnPerUsd(c: { baseReturnPerUsd: number; capacityFactor: number; needFactor: number; saturationUsd: number }, allocatedUsd: number): number {
  return c.baseReturnPerUsd * c.capacityFactor * c.needFactor / (1 + allocatedUsd / Math.max(1, c.saturationUsd))
}

/**
 * PURE + deterministic — greedy marginal allocation: the budget goes out in equal increments, each to
 * the candidate whose NEXT dollar returns most (diminishing with spend already allocated); a candidate
 * with no agent headroom or a zero base return draws nothing. Every increment is a step with its math.
 */
export function planMarketingAllocation(facts: MarketingAllocationFacts, opts: { increments?: number } = {}): MarketingAllocationRecommendation {
  const blind = [...facts.blindSpots]
  const budget = Math.max(0, Math.round(facts.budgetUsd))
  const chain: MarketingAllocationRecommendation["chain"] = []
  chain.push({ step: "budget", contributed: budget > 0, detail: `$${budget.toLocaleString()} to allocate across ${facts.candidates.length} candidate(s)`, reader: "caller" })
  const cands = facts.candidates.map((c) => {
    const reasons: string[] = []
    let base: number
    if (c.spendUsd > 0 && c.returnUsd > 0) { base = c.returnUsd / c.spendUsd; reasons.push(`$${r2(c.returnUsd).toLocaleString()} returned on $${r2(c.spendUsd).toLocaleString()} spent → ${r2(base)} per $`) }
    else if (c.spendUsd > 0) { base = 0; reasons.push(`$${r2(c.spendUsd).toLocaleString()} spent, nothing attributed → 0 per $`) }
    else { base = MARKETING_PRIOR_RETURN_PER_USD; reasons.push(`no spend history → flat prior ${MARKETING_PRIOR_RETURN_PER_USD} per $`) }
    let capacityFactor: number
    if (c.capacityHeadroom == null) { capacityFactor = 0.5; reasons.push("agent capacity unreadable → factor 0.5") }
    else if (c.capacityHeadroom <= 0) { capacityFactor = 0.1; reasons.push("no agent headroom to work new leads → factor 0.1") }
    else { capacityFactor = clamp01(0.5 + c.capacityHeadroom / 20); reasons.push(`${c.capacityHeadroom} headroom → factor ${r2(capacityFactor)}`) }
    const needFactor = c.pipelineNeed == null ? 1 : r2(0.5 + c.pipelineNeed)
    reasons.push(c.pipelineNeed == null ? "pipeline need unreadable → factor 1" : `pipeline need ${r2(c.pipelineNeed)} → factor ${needFactor}`)
    const saturationUsd = c.saturationUsd ?? Math.max(MARKETING_DEFAULT_SATURATION_USD, c.spendUsd)
    return { c, baseReturnPerUsd: r3(base), capacityFactor: r2(capacityFactor), needFactor, saturationUsd, allocated: 0, expected: 0, reasons }
  })
  const readPerf = facts.candidates.filter((c) => c.spendUsd > 0).length
  chain.push({ step: "campaign_performance", contributed: readPerf > 0, detail: `${readPerf} of ${facts.candidates.length} candidates carry spend + attributed return`, reader: "marketing_campaigns + marketing_attribution_credits" })
  const terr = facts.candidates.filter((c) => c.kind === "territory")
  chain.push({ step: "territory_demand", contributed: terr.length > 0, detail: `${terr.length} territor${terr.length === 1 ? "y" : "ies"} with demand metrics`, reader: "territory_metrics + farm_territories" })
  const capRead = facts.candidates.filter((c) => c.capacityHeadroom != null).length
  chain.push({ step: "agent_capacity", contributed: capRead > 0, detail: capRead > 0 ? `headroom read for ${capRead} of ${facts.candidates.length}` : "agent capacity unreadable — factor 0.5 everywhere", reader: "brokerage twin capacity / capacityFor" })
  const needRead = facts.candidates.filter((c) => c.pipelineNeed != null).length
  chain.push({ step: "pipeline_need", contributed: needRead > 0, detail: needRead > 0 ? `pipeline need read for ${needRead}` : "pipeline need unreadable — factor 1", reader: "brokerage twin now.pipeline" })

  const steps: AllocationStep[] = []
  const increments = Math.max(1, opts.increments ?? 20)
  const step = Math.max(1, Math.round(budget / increments))
  let remaining = budget
  let n = 0
  while (remaining > 0 && cands.length > 0) {
    const amount = Math.min(step, remaining)
    let best: (typeof cands)[number] | null = null
    let bestM = 0
    for (const x of cands) { const m = marginalReturnPerUsd(x, x.allocated); if (m > bestM) { bestM = m; best = x } }
    if (!best || bestM <= 0) break
    n++
    const expected = bestM * amount
    best.allocated += amount; best.expected += expected; remaining -= amount
    steps.push({ n, candidateId: best.c.id, amountUsd: amount, marginalReturnPerUsd: r3(bestM), cumulativeUsd: best.allocated,
      math: `${best.baseReturnPerUsd} × ${best.capacityFactor} × ${best.needFactor} / (1 + ${best.allocated - amount}/${best.saturationUsd}) = ${r3(bestM)} per $ → $${amount} ≈ $${r2(expected)}` })
  }
  const allocations = cands.map((x) => ({ candidateId: x.c.id, kind: x.c.kind, name: x.c.name, amountUsd: x.allocated, expectedReturnUsd: r2(x.expected), baseReturnPerUsd: x.baseReturnPerUsd, capacityFactor: x.capacityFactor, needFactor: x.needFactor, saturationUsd: x.saturationUsd, reasons: x.reasons }))
    .sort((a, b) => b.amountUsd - a.amountUsd || a.candidateId.localeCompare(b.candidateId))
  const total = r2(allocations.reduce((a, x) => a + x.expectedReturnUsd, 0))
  chain.push({ step: "marginal_return", contributed: steps.length > 0, detail: steps.length > 0 ? `${steps.length} increment(s) of $${step}; expected return $${total.toLocaleString()}; $${remaining} unallocated` : "no candidate with a positive marginal return", reader: "planMarketingAllocation (greedy marginal)" })
  if (remaining > 0 && budget > 0) blind.push(`$${remaining} left unallocated — no remaining candidate returns more than $0 on the next dollar`)
  return { kind: "marketing_allocation", brokerageId: facts.brokerageId, budgetUsd: budget, chain, allocations, steps, unallocatedUsd: remaining, totalExpectedReturnUsd: total, blindSpots: blind }
}

export interface MarketingFactDeps {
  now?: Date
  /** Test seam — defaults to readBrokerageTwin (snapshot mode, then a fresh build). */
  twin?: () => Promise<import("@/lib/kernel/brokerage-twin").BrokerageTwin | null>
}

/** Gather the marketing chain's facts for ONE tenant (trailing 90 days). */
export async function gatherMarketingAllocationFacts(svc: Svc, input: { brokerageId: string; budgetUsd: number }, deps: MarketingFactDeps = {}): Promise<{ ok: true; facts: MarketingAllocationFacts } | { ok: false; error: string }> {
  const { brokerageId } = input
  if (!brokerageId) return { ok: false, error: "tenant scope required" }
  const now = deps.now ?? new Date()
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString()
  const blindSpots: string[] = []
  const candidates: MarketingCandidate[] = []

  let twin: import("@/lib/kernel/brokerage-twin").BrokerageTwin | null = null
  try {
    twin = deps.twin ? await deps.twin() : await (async () => { const { readBrokerageTwin } = await import("@/lib/kernel/brokerage-twin"); return (await readBrokerageTwin(brokerageId, { svc: svc as any, snapshot: { now } })) ?? await readBrokerageTwin(brokerageId, { svc: svc as any }) })()
  } catch (e) { blindSpots.push(`twin unreadable: ${e instanceof Error ? e.message : String(e)}`) }
  if (!twin) blindSpots.push("no brokerage twin — agent capacity and pipeline need unreadable")
  const headroomOf = (agentIds: readonly string[] | null): number | null => {
    if (!twin) return null
    const lines = agentIds ? twin.capacity.perAgent.filter((a) => agentIds.includes(a.agentId)) : twin.capacity.perAgent
    return lines.filter((a) => hasHeadroom(a.band)).reduce((s, a) => s + a.headroom, 0)
  }
  const pipelineNeed = twin ? r2(clamp01(1 - twin.now.pipeline.leads / Math.max(1, twin.capacity.headroom))) : null
  const valuePerConversion = twin && twin.economic.closedCount90d > 0 ? twin.economic.gciClosed90dCents / 100 / twin.economic.closedCount90d : MARKETING_DEFAULT_VALUE_PER_CONVERSION_USD
  if (!(twin && twin.economic.closedCount90d > 0)) blindSpots.push(`no closed GCI in the twin — territory conversions valued at the default $${MARKETING_DEFAULT_VALUE_PER_CONVERSION_USD}`)

  // campaigns + attribution credits (the ROI ledger's rows)
  const { data: camps, error: cErr } = await svc.from("marketing_campaigns").select("id, campaign_name, campaign_type, budget_spent, budget_total, attributed_gci_total, conversions, engagements, completed_at").eq("brokerage_id", brokerageId).limit(200)
  if (cErr) blindSpots.push(`campaigns unreadable: ${cErr.message}`)
  else {
    const credits = new Map<string, number>()
    const { data: cr, error: crErr } = await svc.from("marketing_attribution_credits").select("campaign_id, credit_dollars").eq("brokerage_id", brokerageId).gte("created_at", since).limit(5000)
    if (crErr) blindSpots.push(`attribution credits unreadable: ${crErr.message}`)
    for (const r of (cr ?? []) as Array<{ campaign_id: string | null; credit_dollars: number | null }>) if (r.campaign_id) credits.set(r.campaign_id, (credits.get(r.campaign_id) ?? 0) + Number(r.credit_dollars ?? 0))
    const rosterHeadroom = headroomOf(null)
    for (const c of (camps ?? []) as Array<{ id: string; campaign_name: string | null; campaign_type: string | null; budget_spent: number | null; budget_total: number | null; attributed_gci_total: number | null; conversions: number | null; engagements: number | null; completed_at: string | null }>) {
      if (c.completed_at) continue
      const spend = Number(c.budget_spent ?? 0)
      const ret = credits.has(c.id) ? (credits.get(c.id) as number) : Number(c.attributed_gci_total ?? 0)
      candidates.push({ kind: "campaign", id: c.id, name: c.campaign_name ?? `campaign ${c.id.slice(0, 8)}`, spendUsd: spend, returnUsd: ret, leads: Number(c.engagements ?? 0), conversions: Number(c.conversions ?? 0), capacityHeadroom: rosterHeadroom, pipelineNeed, saturationUsd: Math.max(MARKETING_DEFAULT_SATURATION_USD, spend, Number(c.budget_total ?? 0)), reader: "marketing_campaigns + marketing_attribution_credits" })
    }
  }

  // territories: latest metric per zip, summed per farm territory
  const { data: terr, error: tErr } = await svc.from("farm_territories").select("id, name, agent_id, zip_codes, is_active, marketing_budget_monthly").eq("brokerage_id", brokerageId).eq("is_active", true).limit(500)
  if (tErr) blindSpots.push(`territories unreadable: ${tErr.message}`)
  else if ((terr ?? []).length > 0) {
    const latest = new Map<string, { lead_count: number; conversion_count: number; conversion_rate: number | null; cost_per_lead: number | null; total_cost: number }>()
    const { data: tm, error: tmErr } = await svc.from("territory_metrics").select("zip_code, metric_date, lead_count, conversion_count, conversion_rate, cost_per_lead, total_cost").eq("brokerage_id", brokerageId).order("metric_date", { ascending: false }).limit(2000)
    if (tmErr) blindSpots.push(`territory metrics unreadable: ${tmErr.message}`)
    for (const m of (tm ?? []) as Array<{ zip_code: string; lead_count: number | null; conversion_count: number | null; conversion_rate: number | null; cost_per_lead: number | null; total_cost: number | null }>) {
      if (latest.has(m.zip_code)) continue
      latest.set(m.zip_code, { lead_count: Number(m.lead_count ?? 0), conversion_count: Number(m.conversion_count ?? 0), conversion_rate: m.conversion_rate == null ? null : Number(m.conversion_rate), cost_per_lead: m.cost_per_lead == null ? null : Number(m.cost_per_lead), total_cost: Number(m.total_cost ?? 0) })
    }
    for (const t of (terr ?? []) as Array<{ id: string; name: string | null; agent_id: string | null; zip_codes: unknown; marketing_budget_monthly: number | null }>) {
      let spend = 0, leads = 0, conversions = 0
      for (const z of zipsOf(t.zip_codes)) { const m = latest.get(z); if (!m) continue; spend += m.total_cost; leads += m.lead_count; conversions += m.conversion_count }
      candidates.push({ kind: "territory", id: t.id, name: t.name ?? `territory ${t.id.slice(0, 8)}`, spendUsd: spend, returnUsd: conversions * valuePerConversion, leads, conversions, capacityHeadroom: headroomOf(t.agent_id ? [t.agent_id] : []), pipelineNeed, saturationUsd: Math.max(MARKETING_DEFAULT_SATURATION_USD, spend, Number(t.marketing_budget_monthly ?? 0)), reader: "territory_metrics + farm_territories" })
    }
  }
  return { ok: true, facts: { brokerageId, budgetUsd: input.budgetUsd, candidates, blindSpots } }
}

export type MarketingRecommendResult =
  | { ok: true; recommendation: MarketingAllocationRecommendation; record: RecordResult | null }
  | { ok: false; error: string }

/** Gather → plan → (record): the subject key carries the budget and the day, so one budget question a day is one proposal. */
export async function recommendMarketingAllocation(svc: Svc, input: { brokerageId: string; budgetUsd: number }, opts: MarketingFactDeps & { record?: boolean } = {}): Promise<MarketingRecommendResult> {
  if (!(input.budgetUsd > 0)) return { ok: false, error: "budget must be positive" }
  const facts = await gatherMarketingAllocationFacts(svc, input, opts)
  if (!facts.ok) return facts
  const recommendation = planMarketingAllocation(facts.facts)
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10)
  const record = opts.record === false ? null : await recordAllocationRecommendation(svc, { brokerageId: input.brokerageId, kind: "marketing_allocation", subjectId: `${Math.round(input.budgetUsd)}:${day}`, recommendation })
  return { ok: true, recommendation, record }
}

// ── AI SPEND — "use expensive reasoning only when expected value justifies it" ──────────────

export interface ReasoningSpendDecision {
  useExpensive: boolean
  /** expectedValueUsd / costUsd, null when undeclared. */
  ratio: number | null
  reason: string
}

/**
 * PURE — the policy the ONE model router applies (lib/ai/models.ts generateTextRouted /
 * generateObjectRouted, request.economics). A caller that declares no expected value is routed by the
 * table as before (the policy only bites on a declared, small value); a declared value below the
 * tenant's ratio × cost sends the call to the cheaper model, and the decision is booked on the
 * ai_tool_usage row (context_json.reasoning_spend).
 */
export function shouldUseExpensiveReasoning(input: { feature: string; expectedValueUsd: number | null | undefined; costUsd: number; policy?: Pick<ResourceAllocationPolicy, "ai_min_value_to_cost_ratio"> | null }): ReasoningSpendDecision {
  const ev = input.expectedValueUsd
  if (ev == null || !Number.isFinite(ev)) return { useExpensive: true, ratio: null, reason: `${input.feature}: no expected value declared — the routing table governs` }
  if (!(input.costUsd > 0)) return { useExpensive: true, ratio: null, reason: `${input.feature}: estimated cost is $0 — nothing to save` }
  const min = input.policy?.ai_min_value_to_cost_ratio ?? DEFAULT_RESOURCE_ALLOCATION_POLICY.ai_min_value_to_cost_ratio
  const ratio = r2(ev / input.costUsd)
  return ratio >= min
    ? { useExpensive: true, ratio, reason: `${input.feature}: expected value $${r2(ev)} is ${ratio}× the $${input.costUsd.toFixed(4)} cost (≥ ${min}×) — expensive reasoning justified` }
    : { useExpensive: false, ratio, reason: `${input.feature}: expected value $${r2(ev)} is only ${ratio}× the $${input.costUsd.toFixed(4)} cost (< ${min}×) — cheaper model` }
}

// ── DATA SPEND — "only purchase enrichment when missing information could change the decision" ─

/**
 * WHICH DECISIONS DEPEND ON WHICH FIELDS — the one table in code. A field not listed under a decision
 * cannot change it, so it is never bought for it. Leads get email + direct mail only (CLAUDE.md §5),
 * so a lead's first touch depends on email alone — a phone would be paid for and never used.
 */
export const DECISION_FIELD_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  lead_first_touch: ["email"],
  contact_first_touch: ["email", "phone"],
  lead_assignment: ["property_zip_code", "motivation_type", "estimated_value"],
  seller_equity_outreach: ["estimated_value", "mortgage_balance", "home_owner_status"],
  dnc_scrub: ["phone"],
  direct_mail: ["mailing_address"],
  valuation: ["property_address"],
})
export type EnrichmentDecision = keyof typeof DECISION_FIELD_DEPENDENCIES

export interface EnrichmentPurchaseDecision {
  purchase: boolean
  /** The missing fields that COULD change the decision — the only ones to buy. */
  decisiveFields: string[]
  reason: string
}

/** PURE — fail closed: an undeclared decision buys nothing; nothing decisive missing buys nothing; over the per-decision cap buys nothing. */
export function shouldPurchaseEnrichment(input: { decision: string; missingFields: readonly string[]; providerCostUsd: number; policy?: Pick<ResourceAllocationPolicy, "enrichment_max_usd_per_decision"> | null }): EnrichmentPurchaseDecision {
  const deps = DECISION_FIELD_DEPENDENCIES[input.decision]
  if (!deps) return { purchase: false, decisiveFields: [], reason: `decision "${input.decision}" declares no field dependencies — nothing bought (fail closed)` }
  const decisive = input.missingFields.filter((f) => deps.includes(f))
  if (decisive.length === 0) return { purchase: false, decisiveFields: [], reason: `none of the missing fields (${input.missingFields.join(", ") || "none"}) could change ${input.decision} (depends on ${deps.join(", ")})` }
  const cap = input.policy?.enrichment_max_usd_per_decision ?? DEFAULT_RESOURCE_ALLOCATION_POLICY.enrichment_max_usd_per_decision
  if (input.providerCostUsd > cap) return { purchase: false, decisiveFields: decisive, reason: `$${input.providerCostUsd.toFixed(2)} exceeds the $${cap.toFixed(2)} per-decision cap for ${input.decision}` }
  return { purchase: true, decisiveFields: decisive, reason: `${decisive.join(", ")} could change ${input.decision} — buy for $${input.providerCostUsd.toFixed(2)}` }
}

// ── READ SURFACES (admin only — agents never see leads or cost) ──────────────────────────────

export interface AllocationBoard {
  open: number
  byKind: Record<AllocationKind, number>
  latest: Array<{ id: string; kind: AllocationKind; subjectKey: string; summary: string; status: string; createdAt: string }>
  /** improvement_proposals absent (m709 unapplied) — an empty board, not a refusal. */
  degraded: boolean
}

/** The OPEN allocation recommendations of one tenant, newest first (listImprovementProposals, filtered). */
export async function loadAllocationBoard(svc: Svc, brokerageId: string, opts: { limit?: number } = {}): Promise<{ ok: true; board: AllocationBoard } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "tenant scope required" }
  const { listImprovementProposals, OPEN_STATUSES } = await import("@/lib/kernel/improvement-proposals")
  const r = await listImprovementProposals(svc, brokerageId, { limit: 200 })
  if (!r.ok) return r
  const rows = r.rows.filter((p) => p.subject_kind === ALLOCATION_SUBJECT_KIND && (OPEN_STATUSES as readonly string[]).includes(p.status))
  const kindOf = (p: { proposed_change: Record<string, unknown> }): AllocationKind => (p.proposed_change?.kind === "marketing_allocation" ? "marketing_allocation" : "lead_assignment")
  const byKind: Record<AllocationKind, number> = { lead_assignment: 0, marketing_allocation: 0 }
  for (const p of rows) byKind[kindOf(p)]++
  return { ok: true, board: {
    open: rows.length, byKind, degraded: !r.available,
    latest: rows.slice(0, opts.limit ?? 5).map((p) => ({ id: p.id, kind: kindOf(p), subjectKey: p.subject_key, summary: String(p.proposed_change?.summary ?? ""), status: p.status, createdAt: p.created_at })),
  } }
}
