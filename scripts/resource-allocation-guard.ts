#!/usr/bin/env tsx
/**
 * scripts/resource-allocation-guard.ts  (npm run test:resource-allocation) — wave 106, lane 106A.
 *
 * Proves AUTONOMOUS RESOURCE ALLOCATION, RECOMMENDATION MODE FIRST (lib/kernel/resource-allocation.ts):
 *   C   each step of the owner's lead chain contributes and is NAMED with its reader; the ranking is
 *       deterministic and every factor carries a score + reason; a positive control flips the winner;
 *   B   a refused / absent reader is a PUBLISHED blind spot and scores neutral — never a silent promotion;
 *   G   the thin readers gather one tenant's facts only (a foreign lead is not found; a foreign agent is
 *       never a candidate); the tenant policy resolves with defaults when unreadable;
 *   N   the recommendation NEVER replaces the assigner's pick unless the policy key says `consume`
 *       (default `recommend` records a proposal for a human and keeps the rules' pick; `off` reads nothing);
 *       one proposal + one ledger row + one event per recommendation, idempotent on re-run;
 *   H   a human decides: an AI agent / a manager can never promote an allocation (authority 6); an
 *       already-owned lead is refused at apply; the apply path is the survivor handleLeadAssigned;
 *   T   tenant isolation on the record and the board;
 *   M   marginal-return math: every increment is a step with its formula; a saturated candidate's next
 *       dollar returns less (positive control); no agent headroom draws nothing; the chain is named;
 *   A   AI spend: expensive reasoning only when expected value / cost ≥ the tenant ratio (controls);
 *   D   data spend: only the missing fields that could change the declared decision are bought; the
 *       Versium leg buys nothing for a decision no missing field can change (positive control: the
 *       default lead decision still asks email);
 *   V   agents never see leads / cost — the readers are admin surfaces (stripped-source census);
 *   W   wiring + registration, read from STRIPPED source, each with a positive control; the m-series
 *       CHECK for the proposal vocabularies is the RULE (latest defining migration lists every code value).
 * In-memory client only; no database, no network, no model call.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  LEAD_ASSIGNMENT_CHAIN, LEAD_FACTOR_WEIGHTS, MARKETING_ALLOCATION_CHAIN, DEFAULT_RESOURCE_ALLOCATION_POLICY, DECISION_FIELD_DEPENDENCIES,
  planLeadAssignment, planMarketingAllocation, marginalReturnPerUsd, shouldUseExpensiveReasoning, shouldPurchaseEnrichment,
  resolveResourceAllocationPolicy, loadResourceAllocationPolicy, gatherLeadAssignmentFacts, recommendLeadAssignment,
  consultLeadAssignmentRecommendation, recommendMarketingAllocation, loadAllocationBoard, summarizeRecommendation,
  type LeadAssignmentFacts, type LeadCandidateFacts, type MarketingAllocationFacts,
} from "../lib/kernel/resource-allocation"
import { PROPOSAL_SUBJECT_KINDS, PROPOSERS, PROPOSAL_AUTHORITY, OWNER_AUTHORITY_LEVEL, promotionDecision, evaluateProposal, decideProposal, promoteProposal } from "../lib/kernel/improvement-proposals"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const src = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

const B = "11111111-1111-4111-8111-111111111111"
const OTHER = "99999999-9999-4999-8999-999999999999"
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001"
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const LEAD = uuid(1), LEAD_HELD = uuid(2), LEAD_OTHER = uuid(3)
const A1 = uuid(11), A2 = uuid(12), A3 = uuid(13), A4 = uuid(14), AX = uuid(19)
const U1 = uuid(21), U2 = uuid(22), U3 = uuid(23), U4 = uuid(24), UX = uuid(29)
const NOW = new Date("2026-10-06T12:00:00.000Z")
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

const cand = (agentId: string, over: Partial<LeadCandidateFacts> = {}): LeadCandidateFacts => ({
  agentId, userId: null, name: `Agent ${agentId.slice(-2)}`, inTerritory: null, eligible: { ok: true, reason: "active" },
  capacity: { band: "available", load: 5, headroom: 30, fatigueTier: "healthy", reasons: [] },
  competency: { skills: [{ skill: "lead_conversion", label: "", score: 70, confidence: "high", evidence: [], gapTag: "" }, { skill: "negotiation", label: "", score: 70, confidence: "high", evidence: [], gapTag: "" }], overall: 70 },
  conversion: { handed: 10, converted: 4 }, sla: { tracked: 10, breached: 1 }, relationship: { types: [] }, ...over,
})
const factsFixture = (): LeadAssignmentFacts => ({
  brokerageId: B,
  opportunity: { leadId: LEAD, zip: "78701", motivationType: "selling", persona: "downsizer", estimatedValue: 450000, leadScore: 82, source: "web", leadStage: "qualified", lifecycleState: "consented", alreadyAssignedTo: null },
  territory: { covered: true, territoryIds: [uuid(31)], agentIds: [A1], reader: "farm_territories.zip_codes" },
  candidates: [
    cand(A1, { inTerritory: true, conversion: { handed: 12, converted: 7 }, sla: { tracked: 12, breached: 0 }, relationship: { types: ["referred_by"] } }),
    cand(A2, { inTerritory: false }),
    cand(A3, { inTerritory: false, eligible: { ok: false, reason: "inactive agent (agents.is_active=false)" } }),
    cand(A4, { inTerritory: false, capacity: { band: "at_capacity", load: 60, headroom: 2, fatigueTier: "critical", reasons: ["follow-up debt 9"] } }),
  ],
  blindSpots: [],
})

function seed(opts: { settings?: Record<string, unknown> | null; refuse?: Record<string, string> } = {}) {
  const agents = [
    { id: A1, user_id: U1, brokerage_id: B, is_active: true }, { id: A2, user_id: U2, brokerage_id: B, is_active: true },
    { id: A3, user_id: U3, brokerage_id: B, is_active: false }, { id: A4, user_id: U4, brokerage_id: B, is_active: true },
    { id: AX, user_id: UX, brokerage_id: OTHER, is_active: true },
  ]
  return memSupabase({
    leads: [
      { id: LEAD, brokerage_id: B, lead_stage: "qualified", lifecycle_state: "consented", lead_score: 82, property_zip_code: "78701", source: "web", motivation_type: "selling", persona: "downsizer", estimated_value: 450000, agent_id: null, contact_id: null },
      { id: LEAD_HELD, brokerage_id: B, lead_stage: "qualified", lifecycle_state: "consented", lead_score: 60, property_zip_code: "78702", source: "web", motivation_type: "buying", persona: null, estimated_value: null, agent_id: null, contact_id: null },
      { id: LEAD_OTHER, brokerage_id: OTHER, lead_stage: "qualified", lifecycle_state: "consented", lead_score: 50, property_zip_code: "78701", source: "web", motivation_type: "selling", persona: null, estimated_value: null, agent_id: null, contact_id: null },
      // handed history: A1 7 of 12 converted; A2 1 of 4; A4 0 of 3; a foreign agent's history never counts
      ...Array.from({ length: 12 }, (_, i) => ({ id: uuid(100 + i), brokerage_id: B, agent_id: A1, handed_to_agent_at: ago(10 + i), converted_at: i < 7 ? ago(5 + i) : null })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: uuid(200 + i), brokerage_id: B, agent_id: A2, handed_to_agent_at: ago(10 + i), converted_at: i < 1 ? ago(5) : null })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: uuid(300 + i), brokerage_id: B, agent_id: A4, handed_to_agent_at: ago(10 + i), converted_at: null })),
    ],
    agents,
    users: [{ id: U1, first_name: "Ana", last_name: "One" }, { id: U2, first_name: "Ben", last_name: "Two" }, { id: U3, first_name: "Cy", last_name: "Three" }, { id: U4, first_name: "Di", last_name: "Four" }, { id: UX, first_name: "Xeno", last_name: "Other" }],
    farm_territories: [{ id: uuid(31), brokerage_id: B, name: "Downtown", agent_id: A1, zip_codes: ["78701", "78703"], is_active: true, marketing_budget_monthly: 500 }, { id: uuid(32), brokerage_id: OTHER, name: "Foreign", agent_id: AX, zip_codes: ["78701"], is_active: true, marketing_budget_monthly: 0 }],
    lead_sla_tracking: [
      ...Array.from({ length: 6 }, (_, i) => ({ id: uuid(400 + i), brokerage_id: B, agent_id: A1, breached: false, created_at: ago(3 + i) })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: uuid(500 + i), brokerage_id: B, agent_id: A4, breached: i < 4, created_at: ago(3 + i) })),
    ],
    relationship_edges: [{ id: uuid(600), brokerage_id: B, from_entity_type: "lead", from_entity_id: LEAD, to_entity_type: "agent", to_entity_id: U1, relationship_type: "referred_by", evidence: { source: "referrals", confidence: 0.9, observed_at: ago(2) }, effective_from: ago(2), effective_to: null, created_by: null }],
    brokerage_settings: opts.settings === undefined ? [] : [{ id: uuid(900), brokerage_id: B, settings: opts.settings ?? {}, updated_at: ago(1) }],
    improvement_proposals: [], agent_action_ledger: [], tenant_policy_versions: [], lifecycle_events: [], brokerage_twin_snapshots: [],
    marketing_campaigns: [], marketing_attribution_credits: [], territory_metrics: [],
  }, { stampCreatedAt: true, refuse: opts.refuse })
}
const CAP: Record<string, LeadCandidateFacts["capacity"]> = {
  [A1]: { band: "available", load: 8, headroom: 32, fatigueTier: "healthy", reasons: [] },
  [A2]: { band: "busy", load: 20, headroom: 20, fatigueTier: "watch", reasons: [] },
  [A4]: { band: "at_capacity", load: 38, headroom: 2, fatigueTier: "at_risk", reasons: ["follow-up debt 6"] },
}
const deps = { now: NOW, capacity: async (id: string) => CAP[id] ?? null, competency: async (a: { id: string }) => (a.id === A1 ? { skills: [{ skill: "negotiation" as const, label: "", score: 80, confidence: "high" as const, evidence: [], gapTag: "" }], overall: 80 } : null) }

async function main() {
  console.log("\nresource-allocation-guard — wave 106A\n")

  // ── C: the chain, each step named ─────────────────────────────────────────────────────────
  console.log("C — the owner's lead chain")
  const rec = planLeadAssignment(factsFixture())
  check("C1 every step of the owner's chain appears, in order, naming its reader", rec.chain.map((s) => s.step).join(">") === LEAD_ASSIGNMENT_CHAIN.join(">") && rec.chain.every((s) => s.reader.length > 0 && s.detail.length > 0), rec.chain.map((s) => s.step).join(">"))
  check("C2 every scored step contributed on the fixture", rec.chain.filter((s) => s.step !== "opportunity").every((s) => s.contributed), JSON.stringify(rec.chain.filter((s) => !s.contributed)))
  check("C3 the territory agent with the best conversion, no SLA breach, a referral edge and headroom is recommended", rec.recommended?.agentId === A1 && /territory/.test(rec.recommended.why) && /conversion/.test(rec.recommended.why) && /relationship/.test(rec.recommended.why), rec.recommended?.why)
  check("C4 ranked list: A1 > A2 > A4 (at capacity + critical fatigue demoted), the inactive agent excluded with its reason", rec.ranked.map((r) => r.agentId).join(",") === [A1, A2, A4].join(",") && rec.excluded.length === 1 && rec.excluded[0].agentId === A3 && /inactive/.test(rec.excluded[0].reason), rec.ranked.map((r) => `${r.agentId.slice(-2)}:${r.total}`).join(","))
  const a4 = rec.ranked.find((r) => r.agentId === A4)!
  check("C5 each ranked agent carries one factor per weighted step with a score, reason and reader; weights sum to 1", rec.ranked.every((r) => r.factors.length === Object.keys(LEAD_FACTOR_WEIGHTS).length && r.factors.every((f) => f.score != null && f.reason && f.reader)) && Math.abs(Object.values(LEAD_FACTOR_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9)
  check("C6 fatigue and capacity are separate named factors (critical tier scores 0.1; at_capacity 0.3)", a4.factors.find((f) => f.step === "fatigue")?.score === 0.1 && a4.factors.find((f) => f.step === "capacity")?.score === 0.3)
  check("C7 deterministic: the same facts plan the same ranking", JSON.stringify(planLeadAssignment(factsFixture()).ranked) === JSON.stringify(rec.ranked))
  const flipped = factsFixture()
  flipped.candidates[0].capacity = { band: "over", load: 90, headroom: 0, fatigueTier: "critical", reasons: [] }
  flipped.candidates[0].conversion = { handed: 12, converted: 0 }
  flipped.candidates[0].sla = { tracked: 12, breached: 12 }
  check("C8 POSITIVE CONTROL: overloaded + non-converting + SLA-breaching A1 is no longer recommended", planLeadAssignment(flipped).recommended?.agentId !== A1)
  check("C9 no eligible agent → no recommendation, published", planLeadAssignment({ ...factsFixture(), candidates: [cand(A3, { eligible: { ok: false, reason: "inactive" } })] }).recommended === null && planLeadAssignment({ ...factsFixture(), candidates: [] }).blindSpots.some((b) => /no candidates/.test(b)))

  // ── B: refused reader → blind spot, neutral ───────────────────────────────────────────────
  console.log("\nB — a refused reader is a blind spot, scored neutral")
  const blind = factsFixture()
  for (const c of blind.candidates) { c.capacity = null; c.competency = null; c.sla = null; c.relationship = null; c.conversion = null }
  const brec = planLeadAssignment(blind)
  check("B1 unreadable factors score 0.5 everywhere and the chain says the step did not contribute", brec.ranked.every((r) => r.factors.filter((f) => f.step !== "territory").every((f) => f.score === 0.5 && /neutral/.test(f.reason))) && brec.chain.filter((s) => ["capacity", "competency", "conversion", "fatigue", "sla", "relationship"].includes(s.step)).every((s) => !s.contributed))
  check("B2 the blind spots are published on the recommendation", brec.blindSpots.some((b) => /capacity unreadable/.test(b)) && brec.blindSpots.some((b) => /competency unreadable/.test(b)))
  const refused = seed({ refuse: { lead_sla_tracking: "permission denied for table lead_sla_tracking" } })
  const gf = await gatherLeadAssignmentFacts(refused, { brokerageId: B, leadId: LEAD }, deps)
  check("B3 a refused SLA read is published by the gatherer and the planner names the step as not contributing", gf.ok && gf.facts.blindSpots.some((b) => /SLA records unreadable: permission denied/.test(b)) && !planLeadAssignment(gf.facts).chain.find((s) => s.step === "sla")!.contributed, gf.ok ? gf.facts.blindSpots.join("; ") : gf.error)
  check("B4 POSITIVE CONTROL: with the read allowed the SLA step contributes", (await (async () => { const g = await gatherLeadAssignmentFacts(seed(), { brokerageId: B, leadId: LEAD }, deps); return g.ok && planLeadAssignment(g.facts).chain.find((s) => s.step === "sla")!.contributed })()))

  // ── G: gather on one tenant ───────────────────────────────────────────────────────────────
  console.log("\nG — thin readers, one tenant")
  const mem = seed()
  const g = await gatherLeadAssignmentFacts(mem, { brokerageId: B, leadId: LEAD }, deps)
  check("G1 facts gathered: territory covers the zip through A1; A1's 7 of 12 conversions, 0 of 6 breaches, referral edge; inactive A3 ineligible; foreign AX absent", g.ok && g.facts.territory.covered && g.facts.territory.agentIds.join() === A1
    && g.facts.candidates.find((c) => c.agentId === A1)?.conversion?.converted === 7 && g.facts.candidates.find((c) => c.agentId === A1)?.sla?.breached === 0 && g.facts.candidates.find((c) => c.agentId === A1)?.relationship?.types.join() === "referred_by"
    && g.facts.candidates.find((c) => c.agentId === A3)?.eligible.ok === false && !g.facts.candidates.some((c) => c.agentId === AX), g.ok ? JSON.stringify(g.facts.candidates.map((c) => [c.agentId.slice(-2), c.conversion, c.sla, c.relationship])) : g.error)
  check("G2 the planner over gathered facts recommends A1 with names read from users", g.ok && planLeadAssignment(g.facts).recommended?.agentId === A1 && planLeadAssignment(g.facts).recommended?.name === "Ana One")
  const foreign = await gatherLeadAssignmentFacts(mem, { brokerageId: B, leadId: LEAD_OTHER }, deps)
  check("G3 another tenant's lead is NOT FOUND under this tenant", !foreign.ok && /not found/.test(foreign.error))
  const pol = await loadResourceAllocationPolicy(mem, B)
  check("G4 no settings row → the DEFAULT policy (recommend, ≥20×, $1/decision), source default", pol.lead_assignment_mode === "recommend" && pol.ai_min_value_to_cost_ratio === 20 && pol.enrichment_max_usd_per_decision === 1 && pol.source === "default")
  check("G5 a malformed tenant value falls back per field; a refused read answers the default with the refusal published", resolveResourceAllocationPolicy({ resource_allocation: { lead_assignment_mode: "yolo", ai_min_value_to_cost_ratio: -3, enrichment_max_usd_per_decision: 0.25 } }).enrichment_max_usd_per_decision === 0.25
    && resolveResourceAllocationPolicy({ resource_allocation: { lead_assignment_mode: "yolo" } }).lead_assignment_mode === "recommend"
    && (await loadResourceAllocationPolicy(seed({ refuse: { brokerage_settings: "denied" } }), B)).error?.includes("refused") === true)

  // ── N: never auto-applies unless the policy key says consume ──────────────────────────────
  console.log("\nN — recommendation mode first")
  const rulesPick = A2
  const n1 = await consultLeadAssignmentRecommendation(mem, { brokerageId: B, leadId: LEAD, rulesAgentId: rulesPick, held: false }, deps)
  check("N1 DEFAULT (recommend): a differing recommendation is NOT consumed — the rules' pick stands", n1.mode === "recommend" && n1.consumeAgentId === null && n1.recommendedAgentId === A1 && /differs/.test(n1.note), n1.note)
  const prop = mem.tables.improvement_proposals
  check("N2 …and ONE proposal is recorded: subject_kind allocation, proposer resource_allocation, PROPOSED, authority 6, subject lead_assignment:<lead>", prop.length === 1 && prop[0].subject_kind === "allocation" && prop[0].proposer === "resource_allocation" && prop[0].status === "PROPOSED" && prop[0].authority_required === OWNER_AUTHORITY_LEVEL && prop[0].subject_key === `lead_assignment:${LEAD}` && n1.proposalId === prop[0].id, JSON.stringify(prop[0]))
  const led = mem.tables.agent_action_ledger.filter((r) => r.action === "allocation.recommend.lead_assignment")
  check("N3 …ONE ledger row: allocation.recommend.lead_assignment, actor system/ai_isa, STAFF_ALERT, READ, executed, policy_ref resource_allocation@…", led.length === 1 && led[0].actor_type === "system" && led[0].reason_code === "STAFF_ALERT" && led[0].risk_class === "READ" && led[0].status === "executed" && String(led[0].policy_ref ?? "").startsWith("resource_allocation@"), JSON.stringify(led[0]))
  check("N4 …ONE auditOnly event resource_allocation.recommended", mem.tables.lifecycle_events.filter((e) => e.event_type === "resource_allocation.recommended").length === 1, JSON.stringify(mem.tables.lifecycle_events.map((e) => e.event_type)))
  const again = await consultLeadAssignmentRecommendation(mem, { brokerageId: B, leadId: LEAD, rulesAgentId: rulesPick, held: false }, deps)
  // BLIND SPOT, published: the in-memory client has no UNIQUE on agent_action_ledger.idempotency_key, so the
  // live collapse of a second claim cannot fire here — the proof holds the MECHANISM (one subject-day key).
  const led2 = mem.tables.agent_action_ledger.filter((r) => r.action === "allocation.recommend.lead_assignment")
  check("N5 re-run is idempotent: the open proposal is found (same id, no second proposal) and every ledger claim carries the SAME subject-day idempotency key (the live UNIQUE collapses it)", again.proposalId === prop[0].id && mem.tables.improvement_proposals.length === 1 && new Set(led2.map((r) => r.idempotency_key)).size === 1 && /^allocation\.recommend:lead_assignment:/.test(String(led2[0].idempotency_key)), JSON.stringify(led2.map((r) => r.idempotency_key)))
  const agree = await consultLeadAssignmentRecommendation(mem, { brokerageId: B, leadId: LEAD_HELD, rulesAgentId: A1, held: false }, deps)
  check("N6 POSITIVE CONTROL: an AGREEING recommendation records nothing in recommend mode", agree.recommendedAgentId === A1 && agree.proposalId === null && mem.tables.improvement_proposals.length === 1 && /agrees/.test(agree.note), agree.note)
  const held = await consultLeadAssignmentRecommendation(mem, { brokerageId: B, leadId: LEAD_HELD, rulesAgentId: null, held: true }, deps)
  check("N7 a HELD lead always gets a proposal (a human routes it) and is never consumed", held.proposalId !== null && held.consumeAgentId === null && mem.tables.improvement_proposals.length === 2 && /held/.test(held.note))
  const consumeMem = seed({ settings: { resource_allocation: { lead_assignment_mode: "consume" } } })
  const n8 = await consultLeadAssignmentRecommendation(consumeMem, { brokerageId: B, leadId: LEAD, rulesAgentId: rulesPick, held: false }, deps)
  check("N8 policy key `consume` (explicit opt-in): the recommendation replaces the rules' pick; no proposal (nothing for a human to do)", n8.mode === "consume" && n8.consumeAgentId === A1 && n8.proposalId === null && consumeMem.tables.improvement_proposals.length === 0, n8.note)
  const offMem = seed({ settings: { resource_allocation: { lead_assignment_mode: "off" } } })
  const n9 = await consultLeadAssignmentRecommendation(offMem, { brokerageId: B, leadId: LEAD, rulesAgentId: rulesPick, held: false }, { ...deps, capacity: async () => { throw new Error("must not be read when off") } })
  check("N9 policy key `off`: nothing read, nothing written", n9.mode === "off" && n9.consumeAgentId === null && n9.recommendedAgentId === null && offMem.tables.improvement_proposals.length === 0 && offMem.tables.agent_action_ledger.length === 0)
  check("N10 the subject kind's authority is OWNER level (6) — a human, always", PROPOSAL_AUTHORITY.allocation === OWNER_AUTHORITY_LEVEL)

  // ── H: a human decides; the apply path is the survivor ───────────────────────────────────
  console.log("\nH — a human approves; promotion through the survivor commit")
  const id = prop[0].id as string
  const ev = await evaluateProposal(mem, { brokerageId: B, id })
  check("H1 evaluation is deterministic and INCONCLUSIVE (a human decides; chain steps counted)", ev.ok && ev.status === "EVALUATED" && ev.evaluation.verdict === "inconclusive" && ev.evaluation.evaluator === "none" && Number((ev.evaluation.detail as { chainSteps?: number }).chainSteps) === LEAD_ASSIGNMENT_CHAIN.length, JSON.stringify(ev))
  check("H2 an AI agent can never promote an allocation; a manager at the top rung cannot either (owner level)",
    !promotionDecision({ status: "APPROVED", verdict: "inconclusive", authorityRequired: PROPOSAL_AUTHORITY.allocation, actor: { type: "agent" } }).allow
    && !promotionDecision({ status: "APPROVED", verdict: "pass", authorityRequired: PROPOSAL_AUTHORITY.allocation, actor: { type: "manager", managerKey: "ai_isa" }, gate: { actorAuthority: 5, autonomy: { allow: true } as never } }).allow
    && promotionDecision({ status: "APPROVED", verdict: "inconclusive", authorityRequired: PROPOSAL_AUTHORITY.allocation, actor: { type: "user", userId: ADMIN, isTenantAdmin: true } }).allow)
  const dec = await decideProposal(mem, { brokerageId: B, id, decision: "approve", actor: { type: "user", userId: ADMIN, isTenantAdmin: true }, reason: "agreed" })
  check("H3 a tenant admin approves → APPROVED", dec.ok && mem.tables.improvement_proposals[0].status === "APPROVED")
  mem.tables.leads.find((l) => l.id === LEAD)!.agent_id = A2 // the rules assigned it meanwhile
  const pr = await promoteProposal(mem, { brokerageId: B, id, actor: { type: "user", userId: ADMIN, isTenantAdmin: true } })
  check("H4 apply REFUSES a lead that already has an owner (no second assignment) — the refusal is the ledger outcome", !pr.ok && /already has an owner/.test(pr.error) && mem.tables.agent_action_ledger.some((r) => r.action === "learning.proposal.promote" && r.status === "failed"), pr.ok ? "promoted" : pr.error)
  const ip = src("lib/kernel/improvement-proposals.ts")
  const allocCase = ip.slice(ip.indexOf('case "allocation": {', ip.indexOf("async function applyChange")), ip.indexOf('case "prompt":', ip.indexOf("async function applyChange")))
  check("H5 the apply path is the SURVIVOR: evaluateAssignmentEligibility gate then handleLeadAssigned with method ai_recommendation (stripped source)", /evaluateAssignmentEligibility\(/.test(allocCase) && /handleLeadAssigned\(\{/.test(allocCase) && /method: "ai_recommendation"/.test(allocCase) && allocCase.indexOf("evaluateAssignmentEligibility(") < allocCase.indexOf("handleLeadAssigned({"))

  // ── T: tenant isolation ───────────────────────────────────────────────────────────────────
  console.log("\nT — tenant isolation")
  const other = await consultLeadAssignmentRecommendation(mem, { brokerageId: OTHER, leadId: LEAD, rulesAgentId: null, held: true }, deps)
  check("T1 the owning tenant's lead is unavailable under another tenant — nothing recorded for OTHER", /not found/.test(other.note) && !mem.tables.improvement_proposals.some((p) => p.brokerage_id === OTHER))
  const r2 = await recommendLeadAssignment(mem, { brokerageId: OTHER, leadId: LEAD_OTHER }, { ...deps, capacity: async () => null, competency: async () => null })
  check("T2 the other tenant recommends over ITS roster only (AX), never this tenant's agents", r2.ok && r2.recommendation.ranked.map((r) => r.agentId).join() === AX && r2.record?.ok === true)
  const boardB = await loadAllocationBoard(mem, B)
  const boardO = await loadAllocationBoard(mem, OTHER)
  check("T3 the board is tenant-scoped: B sees its 2 open rows (the approved one counts as open — awaiting promotion), OTHER sees 1", boardB.ok && boardB.board.open === 2 && boardB.board.byKind.lead_assignment === 2 && boardO.ok && boardO.board.open === 1, JSON.stringify([boardB, boardO]))

  // ── M: marketing — marginal expected return ───────────────────────────────────────────────
  console.log("\nM — marketing allocation: marginal return, the math shown")
  const mf = (over: Partial<MarketingAllocationFacts> = {}): MarketingAllocationFacts => ({
    brokerageId: B, budgetUsd: 2000, blindSpots: [], candidates: [
      { kind: "campaign", id: "X", name: "Seller equity video", spendUsd: 1000, returnUsd: 3000, leads: 40, conversions: 4, capacityHeadroom: 20, pipelineNeed: 0.5, reader: "fixture" },
      { kind: "territory", id: "Y", name: "Downtown", spendUsd: 500, returnUsd: 750, leads: 10, conversions: 1, capacityHeadroom: 10, pipelineNeed: 0.5, reader: "fixture" },
      { kind: "territory", id: "Z", name: "No-one home", spendUsd: 400, returnUsd: 1200, leads: 12, conversions: 2, capacityHeadroom: 0, pipelineNeed: 0.5, reader: "fixture" },
    ], ...over,
  })
  const m = planMarketingAllocation(mf())
  check("M1 the marketing chain appears in order with named readers", m.chain.map((s) => s.step).join(">") === MARKETING_ALLOCATION_CHAIN.join(">") && m.chain.every((s) => s.reader && s.detail))
  check("M2 the whole budget is allocated in increments, each step carrying its formula (base × capacity × need / (1 + allocated/saturation))", m.unallocatedUsd === 0 && m.steps.length === 20 && m.steps.every((s) => /×.*\/ \(1 \+ \d+\/\d+\) = [\d.]+ per \$/.test(s.math)) && m.steps.reduce((a, s) => a + s.amountUsd, 0) === 2000, m.steps[0]?.math)
  const byId = Object.fromEntries(m.allocations.map((a) => [a.candidateId, a]))
  check("M3 the strongest return draws most, the moderate one some, the one with NO agent headroom (factor 0.1) draws nothing", byId.X.amountUsd > byId.Y.amountUsd && byId.Y.amountUsd > 0 && byId.Z.amountUsd === 0 && byId.Z.capacityFactor === 0.1, JSON.stringify(m.allocations.map((a) => [a.candidateId, a.amountUsd])))
  const xSteps = m.steps.filter((s) => s.candidateId === "X").map((s) => s.marginalReturnPerUsd)
  check("M4 diminishing: X's marginal return falls with every dollar already allocated", xSteps.every((v, i) => i === 0 || v < xSteps[i - 1]) && marginalReturnPerUsd({ baseReturnPerUsd: 3, capacityFactor: 1, needFactor: 1, saturationUsd: 1000 }, 1000) === 1.5)
  const allX = mf().candidates[0]
  const concentrated = Array.from({ length: 20 }, (_, i) => marginalReturnPerUsd({ baseReturnPerUsd: 3, capacityFactor: byId.X.capacityFactor, needFactor: byId.X.needFactor, saturationUsd: allX.spendUsd }, i * 100) * 100).reduce((a, b) => a + b, 0)
  check("M5 POSITIVE CONTROL: the greedy split's expected return beats putting the whole budget on X alone", m.totalExpectedReturnUsd > concentrated, `${m.totalExpectedReturnUsd} vs ${Math.round(concentrated)}`)
  const flat = planMarketingAllocation(mf({ candidates: [{ kind: "campaign", id: "N", name: "New", spendUsd: 0, returnUsd: 0, leads: 0, conversions: 0, capacityHeadroom: null, pipelineNeed: null, reader: "fixture" }] }))
  check("M6 no history → a published flat prior; unreadable capacity / need → published factors", flat.allocations[0].reasons.some((r) => /flat prior/.test(r)) && flat.allocations[0].reasons.some((r) => /capacity unreadable/.test(r)) && flat.allocations[0].reasons.some((r) => /need unreadable/.test(r)))
  const zero = planMarketingAllocation(mf({ candidates: [{ kind: "campaign", id: "D", name: "Dead", spendUsd: 900, returnUsd: 0, leads: 0, conversions: 0, capacityHeadroom: 5, pipelineNeed: 0.5, reader: "fixture" }] }))
  check("M7 a candidate that returned nothing on real spend draws nothing; the unallocated remainder is a blind spot", zero.allocations[0].amountUsd === 0 && zero.unallocatedUsd === 2000 && zero.blindSpots.some((b) => /unallocated/.test(b)))
  const mm = seed()
  const mr = await recommendMarketingAllocation(mm, { brokerageId: B, budgetUsd: 1500 }, { now: NOW, twin: async () => null })
  check("M8 the marketing door gathers (territory from farm_territories, no twin → blind spots), records ONE proposal + ledger row", mr.ok && mr.recommendation.blindSpots.some((b) => /no brokerage twin/.test(b)) && mr.recommendation.allocations.some((a) => a.kind === "territory" && a.name === "Downtown") && mr.record?.ok === true && mm.tables.improvement_proposals.length === 1 && mm.tables.agent_action_ledger.filter((r) => r.action === "allocation.recommend.marketing_allocation").length === 1, mr.ok ? JSON.stringify(mr.recommendation.allocations) : mr.error)
  check("M9 the summary line carries the split and the expected return", mr.ok && /Allocate \$1,500/.test(summarizeRecommendation(mr.recommendation)) && /expected return/.test(summarizeRecommendation(mr.recommendation)))

  // ── A: AI spend ───────────────────────────────────────────────────────────────────────────
  console.log("\nA — expensive reasoning only when expected value justifies it")
  check("A1 undeclared value → the routing table governs (expensive allowed)", shouldUseExpensiveReasoning({ feature: "x", expectedValueUsd: null, costUsd: 0.05 }).useExpensive)
  check("A2 $2,500 of value on a $0.05 call → expensive justified (50,000×)", shouldUseExpensiveReasoning({ feature: "offer_analysis", expectedValueUsd: 2500, costUsd: 0.05 }).useExpensive)
  check("A3 $0.50 of value on a $0.05 call → cheaper model (10× < 20×)", !shouldUseExpensiveReasoning({ feature: "x", expectedValueUsd: 0.5, costUsd: 0.05 }).useExpensive)
  check("A4 the tenant ratio governs: at 5× the same call is justified", shouldUseExpensiveReasoning({ feature: "x", expectedValueUsd: 0.5, costUsd: 0.05, policy: { ai_min_value_to_cost_ratio: 5 } }).useExpensive && DEFAULT_RESOURCE_ALLOCATION_POLICY.ai_min_value_to_cost_ratio === 20)

  // ── D: data spend ─────────────────────────────────────────────────────────────────────────
  console.log("\nD — buy only what could change the decision")
  check("D1 a lead's first touch depends on EMAIL only (leads get email + direct mail) — a missing phone is never bought for it", DECISION_FIELD_DEPENDENCIES.lead_first_touch.join() === "email" && shouldPurchaseEnrichment({ decision: "lead_first_touch", missingFields: ["email", "phone"], providerCostUsd: 0.1 }).decisiveFields.join() === "email")
  check("D2 a contact's first touch depends on email + phone", shouldPurchaseEnrichment({ decision: "contact_first_touch", missingFields: ["email", "phone"], providerCostUsd: 0.1 }).decisiveFields.join() === "email,phone")
  check("D3 a decision none of the missing fields can change buys nothing", !shouldPurchaseEnrichment({ decision: "valuation", missingFields: ["email", "phone"], providerCostUsd: 0.1 }).purchase)
  check("D4 an undeclared decision buys nothing (fail closed); over the per-decision cap buys nothing", !shouldPurchaseEnrichment({ decision: "vibes", missingFields: ["email"], providerCostUsd: 0.1 }).purchase && !shouldPurchaseEnrichment({ decision: "lead_first_touch", missingFields: ["email"], providerCostUsd: 2 }).purchase && shouldPurchaseEnrichment({ decision: "lead_first_touch", missingFields: ["email"], providerCostUsd: 2, policy: { enrichment_max_usd_per_decision: 5 } }).purchase)
  const { runVersiumContactLeg } = await import("../lib/ai-isa/property-lookup-rail")
  const asked: string[] = []
  const hit = async (output: string) => { asked.push(output); return { ok: true, status: 200, data: { versium: { match_counts: { [output]: 1 }, results: [{ "Email Address": "ana@example.com" }] } } } }
  const legDeps = { call: hit as never, meter: async () => undefined, checkBudget: async () => ({ allowed: true }), allocationPolicy: async () => ({ enrichment_max_usd_per_decision: 1 }) }
  const identity = { firstName: "Ana", lastName: "Owner", city: "Austin", state: "TX" }
  const noImpact = await runVersiumContactLeg({ brokerageId: B, stage: "contact", identity, hasEmail: false, hasPhone: false, systemSource: "proof", decision: "valuation" }, legDeps)
  check("D5 the Versium leg buys NOTHING for a decision no missing field can change (no call, $0, skipped no_decision_impact)", !noImpact.answered && noImpact.cost === 0 && asked.length === 0 && /^no_decision_impact/.test(noImpact.skipped ?? ""), noImpact.skipped ?? "")
  const lead = await runVersiumContactLeg({ brokerageId: B, stage: "lead", identity, hasEmail: false, hasPhone: false, systemSource: "proof" }, legDeps)
  check("D6 POSITIVE CONTROL: the default lead decision still asks EMAIL (and only email) — existing behaviour kept", lead.answered && asked.join() === "email")
  asked.length = 0
  const contactAssign = await runVersiumContactLeg({ brokerageId: B, stage: "contact", identity, hasEmail: true, hasPhone: false, systemSource: "proof", decision: "dnc_scrub" }, legDeps)
  check("D7 a declared decision narrows the ask to its decisive fields (dnc_scrub → phone only)", asked.join() === "phone" && contactAssign.skipped === null)

  // ── V: agents never see leads / cost ──────────────────────────────────────────────────────
  console.log("\nV — agents never see leads or cost")
  const briefDir = "lib/intelligence/user-type-briefs"
  const importers = readdirSync(join(ROOT, briefDir)).filter((f) => f.endsWith(".ts")).filter((f) => /resource-allocation/.test(src(`${briefDir}/${f}`)))
  check("V1 among the user-type briefs ONLY the team-lead brief (admin roster) reads the board; the agent daily briefing never imports the module", importers.join() === "team-lead.ts" && !/resource-allocation/.test(src("lib/intelligence/daily-briefing-generator.ts")), importers.join())
  const page = src("app/dashboard/admin/command-center/page.tsx")
  check("V2 the Command Center card renders only behind the admin-roster gate (isAdminOrBroker) and never on the platform scope", /data\.allocationBoard && brokerageId && !isSuperadmin && isAdminOrBroker\(/.test(page))
  check("V3 the recommendation handed to the ledger names agents by agents.id and carries no cost for a lead; a marketing summary (cost) exists only on admin readers", !/cost/i.test(summarizeRecommendation(rec)) && /\$/.test(summarizeRecommendation(m)))
  check("V4 POSITIVE CONTROL: the census recognises an importer (team-lead.ts is one)", /resource-allocation/.test(src(`${briefDir}/team-lead.ts`)))

  // ── W: wiring + registration ──────────────────────────────────────────────────────────────
  console.log("\nW — wiring, read from stripped source")
  const tr = src("lib/lead-assignment/tier-routing.ts")
  const auto = tr.slice(tr.indexOf("export async function autoAssignLead("))
  check("W1 autoAssignLead CONSULTS the recommender after its own resolver and before coverage, and only `consumeAgentId` may replace the pick (method ai_recommendation)",
    /consultLeadAssignmentRecommendation\(/.test(auto) && auto.indexOf("resolveTierRouting(") < auto.indexOf("consultLeadAssignmentRecommendation(") && auto.indexOf("consultLeadAssignmentRecommendation(") < auto.indexOf("redirectForCoverage(")
    && /if \(consult\.consumeAgentId && consult\.consumeAgentId !== decision\.agentId\)/.test(auto) && /decision\.method = "ai_recommendation"/.test(auto))
  const models = src("lib/ai/models.ts")
  check("W2 BOTH routed lanes apply the reasoning-spend policy and book it on the ai_tool_usage row (contextExtra.reasoning_spend)", (models.match(/applyReasoningSpendPolicy\(request, tableModel, tableFallback, estTokens\)/g) ?? []).length === 2 && (models.match(/reasoning_spend: spend\.booking/g) ?? []).length === 2 && /shouldUseExpensiveReasoning\(/.test(models))
  check("W3 real callers declare expected value: offer-strategy-advisor (list price commission) and appraisal-negotiation (gap)", /economics: \{ expectedValueUsd: Math\.round\(params\.listPrice/.test(src("lib/offers/offer-strategy-advisor.ts")) && /economics: \{ expectedValueUsd: Math\.round\(Math\.abs\(context\.gapAmount\)/.test(src("lib/kernel/appraisal-negotiation.ts")))
  const rail = src("lib/ai-isa/property-lookup-rail.ts")
  check("W4 the Versium leg gates every paid ask through shouldPurchaseEnrichment and asks only the decisive fields", /shouldPurchaseEnrichment\(\{ decision, missingFields: missing/.test(rail) && /const outputs = missing\.filter\(\(f\) => purchase\.decisiveFields\.includes\(f\)\)/.test(rail))
  check("W5 the Command Center loads the board (loadAllocationBoard) and the page renders AllocationCard; the team-lead brief carries the line", /loadAllocationBoard\(supabase as any, brokerageId\)/.test(src("lib/kernel/command-center.ts")) && /<AllocationCard board=\{data\.allocationBoard\}/.test(page) && /id: "allocation-recommendations"/.test(src("lib/intelligence/user-type-briefs/team-lead.ts")))
  check("W6 resource_allocation is a registered tenant policy key (settings store) and the ledger row names it", "resource_allocation" in TENANT_POLICY_SETTINGS_KEYS && /policyKey: RESOURCE_ALLOCATION_POLICY_KEY/.test(src("lib/kernel/resource-allocation.ts")))
  check("W7 the proposal vocabularies carry allocation / resource_allocation", PROPOSAL_SUBJECT_KINDS.includes("allocation") && PROPOSERS.includes("resource_allocation"))
  // THE RULE, not a waypoint: the LATEST migration that defines each CHECK lists exactly the code constant.
  const migDir = join(ROOT, "supabase/migrations")
  const latestCheck = (constraint: string): string[] | null => {
    const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
    for (const f of [...files].reverse()) {
      const body = readFileSync(join(migDir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      const mm = new RegExp(`${constraint}\\s*CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, "s").exec(body)
      if (mm) return [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    }
    return null
  }
  check("W8 the latest migration defining improvement_proposals' two CHECKs lists exactly the code constants (superset rule)", JSON.stringify(latestCheck("improvement_proposals_subject_kind_check")) === JSON.stringify([...PROPOSAL_SUBJECT_KINDS].sort()) && JSON.stringify(latestCheck("improvement_proposals_proposer_check")) === JSON.stringify([...PROPOSERS].sort()), JSON.stringify([latestCheck("improvement_proposals_subject_kind_check"), latestCheck("improvement_proposals_proposer_check")]))
  check("W9 POSITIVE CONTROL: the migration finder returns null for an unknown constraint", latestCheck("no_such_constraint_check") === null)
  check("W10 MAINTENANCE_DOMAINS owns resource_allocation with this proof and co-owners", MAINTENANCE_DOMAINS.resource_allocation?.proof === "test:resource-allocation" && (MAINTENANCE_DOMAINS.resource_allocation?.coOwners?.length ?? 0) >= 2)
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
  check("W11 registered as test:resource-allocation and in the guard chain", pkg.scripts["test:resource-allocation"]?.includes("resource-allocation-guard") === true && /npm run test:resource-allocation(\s|&|$)/.test(pkg.scripts.guard))
  const door = src("app/actions/admin/improvement-proposals.ts")
  check("W13 the marketing door is a tenant-admin server action (gate first, tenant from the session, then the service client) that the Command Center card's form calls", /export async function recommendMarketingAllocationFormAction\(/.test(door) && door.indexOf("requireLearningAdmin(", door.indexOf("recommendMarketingAllocationFormAction(")) < door.indexOf("recommendMarketingAllocation(createServiceClient(), { brokerageId: gate.brokerageId") && /<form action=\{recommendMarketingAllocationFormAction\}/.test(src("app/dashboard/admin/command-center/allocation-card.tsx")))
  check("W12 the recommender is ONE module: no second planner for 'who should get this lead' outside it (stripped census of planLeadAssignment definitions)", (["lib/kernel", "lib/lead-assignment", "lib/intelligence"].flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`)).filter((f) => /function planLeadAssignment\(/.test(src(f)))).join() === "lib/kernel/resource-allocation.ts")

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { for (const f of fails) console.log(`   - ${f}`); console.log(" ❌ RESOURCE_ALLOCATION_FAIL"); process.exit(1) }
  console.log(" ✅ RESOURCE_ALLOCATION_OK")
}

main().catch((e) => { console.error(e); process.exit(1) })
