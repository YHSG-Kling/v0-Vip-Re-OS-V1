#!/usr/bin/env tsx
/**
 * scripts/self-optimization-guard.ts  (npm run test:self-optimization) — wave 108, lane 108G.
 *
 * Proves SELF-OPTIMIZING MANAGER TEAMS, BOUNDED (lib/kernel/self-optimization.ts over the ONE proposal kernel
 * lib/kernel/improvement-proposals.ts):
 *   S  the surface classifier: each FORBIDDEN surface (authority / financial / compliance / outside the allowed
 *      list) is named, each beside its allowed positive control; a human's own policy edit stays governance;
 *   K  the kernel REFUSES a forbidden surface at every door (propose, evaluate, decide, promote) for every actor,
 *      an allowed one passes (control); the autonomous list gates a manager, never a human;
 *   E  every class has an evaluator and a rollback — registry AND live (evaluate pass + fail control, promote,
 *      roll back to the exact previous value through the survivor writer);
 *   C  the team cycle: each manager's evidence, the co-proposal recorded with ALL managers on DECLARED registry
 *      edges, a learner's open proposal co-signed (no duplicate), promotion only within class + autonomy list +
 *      gate, ledgered;
 *   T  tenant isolation (another tenant's evidence never read, its proposals never touched, readers tenant-scoped);
 *   N  the promoted values are READ (NBE learned bias, provider skip) with controls;
 *   W  wiring, read from STRIPPED source, each with a positive control; vocabularies derived, never pinned.
 * In-memory client only, no DB, no network, no model calls.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  OPTIMIZATION_CLASSES, OPTIMIZATION_CLASS_DEFS, FORBIDDEN_SURFACES, classifyProposalSurface, replayReasoningSpend, providerSkipVerdict,
  experienceDirection, loadTenantProviderSkips, resolveOptimizationTuning, runTeamOptimizationCycle, OPTIMIZATION_CLASS_AUTHORITY, TEAM_OPTIMIZATION_PROPOSER,
  type OptimizationClass,
  loadDeadlineReminderHours, DEADLINE_REMINDER_MAX_HOURS, evaluateOptimizationClass, OPTIMIZATION_CANDIDATES_NOT_BUILT,
} from "../lib/kernel/self-optimization"
import {
  PROPOSERS, promotionDecision, proposeImprovement, evaluateProposal, decideProposal, promoteProposal, rollbackProposal, loadProposal,
  type ImprovementProposalRow,
} from "../lib/kernel/improvement-proposals"
import { planNextBestExperience, type NextBestExperienceInput } from "../lib/ai-isa/lead-action-plan"
import { requestPropertyValuation } from "../lib/avm/provider-chain"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS, MANAGERS, canRefer } from "../lib/kernel/manager-registry"

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
const NOW = new Date("2026-10-07T12:00:00.000Z")
const RECENT = "2026-10-01T00:00:00.000Z"
const admin = { type: "user" as const, userId: ADMIN, isTenantAdmin: true }
const allowGate = { actorAuthority: 4 as const, autonomy: { allow: true, held: false, posture: null, reason: null } }
const heldGate = { actorAuthority: 6 as const, autonomy: { allow: false, held: true, posture: "approval_required" as const, reason: "ai_isa is approval_required" } }
let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`
const settingsRow = (b: string, settings: Record<string, unknown> = {}) => ({ id: uuid(), brokerage_id: b, settings, updated_at: "2026-10-01T00:00:00.000Z" })
const booking = (b: string, ev: number, routed: number, cheaper: number) => ({ id: uuid(), brokerage_id: b, created_at: RECENT, context_json: { reasoning_spend: { decision: "expensive", expected_value_usd: ev, routed_cost_usd: routed, cheaper_cost_usd: cheaper } } })
const apiLog = (b: string | null, key: string, isError: boolean) => ({ id: uuid(), brokerage_id: b, service_key: key, is_error: isError, recorded_at: RECENT })
const opt = (cls: string) => ({ optimization: { class: cls, cycle_id: "proof", owner: "ai_isa", co_proposers: [], managers: ["ai_isa"], evidence_by_manager: {} } })
const C = (cls: string, kind: string, key: string, change: Record<string, unknown>, proposer = TEAM_OPTIMIZATION_PROPOSER) =>
  classifyProposalSurface({ subject_kind: kind, subject_key: key, proposer, proposed_change: { ...change, ...opt(cls) } })
const RA = { lead_assignment_mode: "recommend", ai_min_value_to_cost_ratio: 20, enrichment_max_usd_per_decision: 1 }
const okReplay = async () => ({ ok: true as const, report: { examined: 6, replayed: 6, agreements: 5, disagreements: [{ outcomes: [] }], agreementRate: 0.83, byReasonCode: {}, unreplayable: { noSnapshot: 0 } }, attributionError: null }) as any
const earnedReplay = async () => ({ ok: true as const, report: { examined: 6, replayed: 6, agreements: 5, disagreements: [{ outcomes: [{ cents: 250000 }] }], agreementRate: 0.83, byReasonCode: {}, unreplayable: { noSnapshot: 0 } }, attributionError: null }) as any
const goodEdu = { actions: { education: 40, communication: 100 }, outcomes: { education: 8, communication: 5 } }
const badEdu = { actions: { education: 40, communication: 100 }, outcomes: { education: 0, communication: 30 } }

async function main() {
  console.log("\nself-optimization-guard — wave 108G\n")

  // ── S: the surface classifier (pure) ───────────────────────────────────────────────────────────────────────
  console.log("S — forbidden surfaces named, each beside its allowed control")
  const s1 = C("followup_timing", "policy", "autonomy_tier:ai_isa", { value: "autonomous" })
  check("S1 a manager's autonomy posture is AUTHORITY policy — forbidden", s1.scope === "forbidden" && s1.surface === "authority_policy", JSON.stringify(s1))
  const s2 = C("model_routing", "policy", "self_optimization", { patch: { autonomous_classes: ["model_routing"] } })
  check("S2 the autonomous list itself is authority policy — the optimizer can never widen its own autonomy", s2.scope === "forbidden" && s2.surface === "authority_policy", JSON.stringify(s2))
  const s3 = C("model_routing", "policy", "resource_allocation", { patch: { enrichment_max_usd_per_decision: 5 } })
  const s3c = C("model_routing", "policy", "resource_allocation", { patch: { ai_min_value_to_cost_ratio: 30 } })
  check("S3 the data-spend cap is a FINANCIAL rule — forbidden; the reasoning ratio on the same key is allowed (control)", s3.scope === "forbidden" && s3.surface === "financial_rule" && s3c.scope === "optimizable" && s3c.class === "model_routing", JSON.stringify([s3, s3c]))
  const s4 = C("provider_selection", "policy", "vendor_tier_pricing", { patch: { photography: 99 } })
  check("S4 vendor prices are a financial rule — forbidden", s4.scope === "forbidden" && s4.surface === "financial_rule")
  const s5 = C("followup_timing", "policy", "ai_isa_settings", { lead_allowed_channels: ["sms"] })
  const s5q = C("followup_timing", "policy", "ai_isa_settings", { quiet_hours_start: "06:00" })
  const s5c = C("followup_timing", "policy", "ai_isa_settings", { touch_interval_days: 4, previous: { touch_interval_days: 3 } })
  check("S5 contact channels / quiet hours are COMPLIANCE boundaries — forbidden; the touch interval is allowed (control)", s5.scope === "forbidden" && s5.surface === "compliance_boundary" && s5q.scope === "forbidden" && s5q.surface === "compliance_boundary" && s5c.scope === "optimizable", JSON.stringify([s5, s5q, s5c]))
  const s5a = C("followup_timing", "policy", "ai_isa_settings", { require_broker_approval: false })
  check("S5b whether the ISA may act without a human is authority — forbidden", s5a.scope === "forbidden" && s5a.surface === "authority_policy")
  const s6 = C("education_intervention", "policy", "optimization_tuning", { patch: { experience_bias: { video: 5 } } })
  const s6x = C("education_intervention", "policy", "optimization_tuning", { patch: { experience_bias: { properties: 5 } } })
  const s6c = C("education_intervention", "policy", "optimization_tuning", { patch: { experience_bias: { education: 5 } } })
  check("S6 a field outside the class's allowed list (another kind, another class's field) — forbidden; its own field allowed (control)", s6.scope === "forbidden" && s6.surface === "policy_outside_allowed_list" && s6x.scope === "forbidden" && s6c.scope === "optimizable", JSON.stringify([s6, s6x, s6c]))
  const s7 = C("model_routing", "policy", "resource_allocation", { value: RA })
  const s7u = C("brand_voice", "policy", "optimization_tuning", { patch: { experience_bias: { education: 5 } } })
  const s7k = C("followup_timing", "policy", "experiments", { patch: { kill_switch: true } })
  const s7a = C("campaign_sequencing", "allocation", "lead_assignment:x", { recommendation: {} })
  check("S7 a whole policy value, an unknown class, a key off the class list, a kind outside every class — all outside the allowed list", [s7, s7u, s7k, s7a].every((v) => v.scope === "forbidden" && v.surface === "policy_outside_allowed_list"), JSON.stringify([s7, s7u, s7k, s7a].map((v) => v.scope)))
  const g1 = classifyProposalSurface({ subject_kind: "policy", subject_key: "vendor_tier_pricing", proposer: "human", proposed_change: { value: { photography: 99 } } })
  const g2 = classifyProposalSurface({ subject_kind: "policy", subject_key: "vendor_tier_pricing", proposer: "strategy_learning", proposed_change: { value: { photography: 99 } } })
  const g3 = classifyProposalSurface({ subject_kind: "policy", subject_key: "workforce_thresholds", proposer: TEAM_OPTIMIZATION_PROPOSER, proposed_change: { value: {} } })
  const g4 = classifyProposalSurface({ subject_kind: "variant", subject_key: "sequence_ab:s1", proposer: "copy_learning", proposed_change: { winner: "A" } })
  check("S8 a HUMAN's own policy edit is governance (the list binds the optimizer); the same change from a LEARNER is forbidden; a team proposal without a class is refused; a learner's variant stays legacy",
    g1.scope === "governance" && g2.scope === "forbidden" && g2.surface === "financial_rule" && g3.scope === "forbidden" && g4.scope === "legacy", JSON.stringify([g1.scope, g2.scope, g3.scope, g4.scope]))
  const example: Record<OptimizationClass, () => ReturnType<typeof C>> = {
    campaign_sequencing: () => C("campaign_sequencing", "variant", "sequence_ab:seq1", { winner: "A" }),
    creative_choice: () => C("creative_choice", "variant", "media_kind:seller_equity:all", { winner: "video" }),
    followup_timing: () => C("followup_timing", "policy", "ai_isa_settings", { touch_interval_days: 4 }),
    model_routing: () => s3c,
    education_intervention: () => s6c,
    property_recommendation: () => C("property_recommendation", "policy", "optimization_tuning", { patch: { experience_bias: { properties: 5 } } }),
    provider_selection: () => C("provider_selection", "policy", "optimization_tuning", { patch: { provider_skip: { property_valuation: ["batchdata"] } } }),
    transaction_reminder_timing: () => C("transaction_reminder_timing", "policy", "optimization_tuning", { patch: { deadline_reminder_hours: 48 } }),
  }
  check("S9 every class's own surface classifies OPTIMIZABLE as that class (positive control per class)", OPTIMIZATION_CLASSES.every((c) => { const v = example[c](); return v.scope === "optimizable" && v.class === c }))
  check("S10 FORBIDDEN_SURFACES names the owner's three boundaries + the allowed-list rule", ["authority_policy", "financial_rule", "compliance_boundary", "policy_outside_allowed_list"].every((s) => (FORBIDDEN_SURFACES as readonly string[]).includes(s)))

  // ── K: every kernel door refuses a forbidden surface ───────────────────────────────────────────────────────
  console.log("K — the kernel refuses at propose / evaluate / decide / promote")
  const memK = memSupabase({ improvement_proposals: [], brokerage_settings: [settingsRow(B, { resource_allocation: RA })], tenant_policy_versions: [], agent_action_ledger: [], ai_tool_usage: [] }, { stampCreatedAt: true })
  const pf = await proposeImprovement(memK, { brokerageId: B, subjectKind: "policy", subjectKey: "resource_allocation", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { patch: { enrichment_max_usd_per_decision: 50 }, ...opt("model_routing") } })
  check("K1 propose: a forbidden surface is refused and NOTHING is written", !pf.ok && /forbidden surface financial_rule/.test(pf.error) && memK.tables.improvement_proposals.length === 0, JSON.stringify(pf))
  const pa = await proposeImprovement(memK, { brokerageId: B, subjectKind: "policy", subjectKey: "resource_allocation", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { patch: { ai_min_value_to_cost_ratio: 30 }, previous: { ai_min_value_to_cost_ratio: 20 }, ...opt("model_routing") } })
  check("K2 propose: the allowed surface is recorded at the optimization rung (not owner level)", pa.ok && memK.tables.improvement_proposals[0]?.authority_required === OPTIMIZATION_CLASS_AUTHORITY, JSON.stringify(pa))
  const forbiddenRow = (status: string, evaluation: unknown = null): ImprovementProposalRow => ({ id: uuid(), brokerage_id: B, subject_kind: "policy", subject_key: "resource_allocation", proposer: "team_optimization", proposed_change: { patch: { lead_assignment_mode: "consume" }, ...opt("model_routing") }, evidence_refs: [], status: status as any, evaluation: evaluation as any, evaluated_at: null, authority_required: 4, decided_by: null, decided_at: null, decision_reason: null, policy_version_ref: null, promoted_at: null, rolled_back_at: null, rollback_policy_version_ref: null, created_at: RECENT, updated_at: RECENT })
  const fProposed = forbiddenRow("PROPOSED"), fEvaluated = forbiddenRow("EVALUATED", { evaluator: "none", verdict: "pass", score: null, why: "", detail: {} }), fApproved = forbiddenRow("APPROVED", { evaluator: "none", verdict: "pass", score: null, why: "", detail: {} })
  memK.tables.improvement_proposals.push(fProposed, fEvaluated, fApproved)
  const ef = await evaluateProposal(memK, { brokerageId: B, id: fProposed.id })
  check("K3 evaluate: a forbidden row (written around the door) FAILS → REJECTED, naming the surface", ef.ok && ef.status === "REJECTED" && /forbidden surface authority_policy/.test(ef.evaluation.why), JSON.stringify(ef))
  const df = await decideProposal(memK, { brokerageId: B, id: fEvaluated.id, decision: "approve", actor: admin })
  check("K4 decide: even a TENANT ADMIN cannot approve a forbidden surface; the row stays EVALUATED", !df.ok && /forbidden surface/.test(df.error) && memK.tables.improvement_proposals.find((r) => r.id === fEvaluated.id)?.status === "EVALUATED")
  const prf = await promoteProposal(memK, { brokerageId: B, id: fApproved.id, actor: admin })
  check("K5 promote: an APPROVED forbidden row is refused for a human, nothing ledgered, settings untouched", !prf.ok && prf.held === true && /forbidden surface/.test(prf.error) && memK.tables.agent_action_ledger.length === 0 && memK.tables.brokerage_settings[0].settings.resource_allocation.lead_assignment_mode === "recommend")
  const surfOk = classifyProposalSurface({ subject_kind: "policy", subject_key: "resource_allocation", proposer: "team_optimization", proposed_change: { patch: { ai_min_value_to_cost_ratio: 30 }, ...opt("model_routing") } })
  const base = { status: "APPROVED" as const, verdict: "pass" as const, authorityRequired: OPTIMIZATION_CLASS_AUTHORITY }
  const mgr = { type: "manager" as const, managerKey: "ai_isa" }
  check("K6 pure: a manager on a class NOT on the autonomous list is refused; on the list allowed (control); a human needs no list", !promotionDecision({ ...base, actor: mgr, gate: allowGate, optimization: { surface: surfOk, autonomousClasses: [] } }).allow
    && promotionDecision({ ...base, actor: mgr, gate: allowGate, optimization: { surface: surfOk, autonomousClasses: ["model_routing"] } }).allow
    && promotionDecision({ ...base, actor: admin, optimization: { surface: surfOk, autonomousClasses: [] } }).allow)
  check("K7 pure: the list never lets a manager past its gate (held gate refused even when listed)", !promotionDecision({ ...base, actor: mgr, gate: heldGate, optimization: { surface: surfOk, autonomousClasses: ["model_routing"] } }).allow)

  // ── E: every class has an evaluator and a rollback ──────────────────────────────────────────────────────────
  console.log("E — evaluator + rollback per class (registry and live)")
  check("E0 the class registry IS the vocabulary (keys = OPTIMIZATION_CLASSES, no extra, no missing)", Object.keys(OPTIMIZATION_CLASS_DEFS).sort().join(",") === [...OPTIMIZATION_CLASSES].sort().join(","))
  const EVALUATORS = new Set(["experiment_arms", "decision_replay", "reasoning_spend_replay", "experience_attribution", "provider_reliability", "deadline_outcomes"])
  check("E1 every class names an evaluator the kernel implements and a rollback writer", OPTIMIZATION_CLASSES.every((c) => EVALUATORS.has(OPTIMIZATION_CLASS_DEFS[c].evaluator) && OPTIMIZATION_CLASS_DEFS[c].rollback.length > 0))
  const kernelSrc = src("lib/kernel/improvement-proposals.ts"), soSrc = src("lib/kernel/self-optimization.ts")
  check("E2 each evaluator has an implementation (survivor branch in the kernel or a case in evaluateOptimizationClass)",
    /evaluator: "experiment_arms"/.test(kernelSrc) && /evaluator: "decision_replay"/.test(kernelSrc) && ["reasoning_spend_replay", "experience_attribution", "provider_reliability", "deadline_outcomes"].every((e) => soSrc.includes(`case "${e}"`)))
  check("E3 each rollback writer is wired in applyChange (restoreRetiredVariants, writeIsaSettings, mergeBrokerageSettings)", ["restoreRetiredVariants", "writeIsaSettings", "mergeBrokerageSettings"].every((w) => kernelSrc.includes(w)) && OPTIMIZATION_CLASSES.every((c) => ["restoreRetiredVariants", "writeIsaSettings", "mergeBrokerageSettings"].some((w) => OPTIMIZATION_CLASS_DEFS[c].rollback.includes(w))))
  check("E4 each class's READER exists in the named file (a promotion is never a write nobody reads)", OPTIMIZATION_CLASSES.every((c) => {
    const r = OPTIMIZATION_CLASS_DEFS[c].reader
    const files = [...r.matchAll(/lib\/[\w/.-]+\.ts/g)].map((m) => m[0])
    const sym = (/([A-Za-z]+) \(|([A-Za-z]+)$/.exec(r.replace(/\s*\(.*\)\s*$/, "")) ?? [])[0]?.replace(/[ (]/g, "") ?? ""
    return files.length > 0 && files.every((f) => existsSync(join(ROOT, f))) && files.some((f) => src(f).includes(sym))
  }), OPTIMIZATION_CLASSES.map((c) => OPTIMIZATION_CLASS_DEFS[c].reader).join(" | "))

  // Wave 138E — the candidates evaluated and NOT built stay honest: none is a class, each names a real file, and
  // that file still reads no tenant tuning (a reader appearing makes the record stale → build the class or drop it).
  {
    const readsTuning = (f: string) => /optimization_tuning|resolveOptimizationTuning\(/.test(src(f))
    const bad = OPTIMIZATION_CANDIDATES_NOT_BUILT.filter((c) => (OPTIMIZATION_CLASSES as readonly string[]).includes(c.candidate) || !existsSync(join(ROOT, c.wouldBeReadBy)) || readsTuning(c.wouldBeReadBy) || c.missing.length < 40)
    check(`E4b the ${OPTIMIZATION_CANDIDATES_NOT_BUILT.length} evaluated-not-built candidates are not classes, name a real would-be reader, and that reader still reads no tenant tuning`, OPTIMIZATION_CANDIDATES_NOT_BUILT.length > 0 && bad.length === 0, bad.map((c) => c.candidate).join(","))
    check("E4c (POSITIVE CONTROL) the staleness test recognises a real reader: lib/ai-isa/lead-action-plan.ts (the NBE planner) reads the tuning", readsTuning("lib/ai-isa/lead-action-plan.ts"))
  }

  // model_routing — reasoning-spend replay, live promote + rollback.
  const memE = memSupabase({
    improvement_proposals: [], tenant_policy_versions: [], agent_action_ledger: [], api_response_logs: [],
    brokerage_settings: [settingsRow(B, { resource_allocation: RA }), settingsRow(OTHER, {})],
    ai_tool_usage: [...Array.from({ length: 25 }, () => booking(B, 50, 1, 0.1)), ...Array.from({ length: 30 }, () => booking(OTHER, 900, 50, 1))],
  }, { stampCreatedAt: true })
  const mr = await proposeImprovement(memE, { brokerageId: B, subjectKind: "policy", subjectKey: "resource_allocation", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { patch: { ai_min_value_to_cost_ratio: 60 }, previous: { ai_min_value_to_cost_ratio: 20 }, ...opt("model_routing") } })
  const mrId = mr.ok ? mr.id : ""
  const mre = await evaluateProposal(memE, { brokerageId: B, id: mrId }, { now: NOW })
  check("E5 model_routing: replayed THIS tenant's 25 booked decisions → pass (no high-value call downgraded; OTHER's 30 never read)", mre.ok && mre.evaluation.evaluator === "reasoning_spend_replay" && mre.evaluation.verdict === "pass" && (mre.evaluation.detail as any).replayed === 25, JSON.stringify(mre))
  const neg = replayReasoningSpend([...Array.from({ length: 25 }, () => ({ expectedValueUsd: 50, routedCostUsd: 1, cheaperCostUsd: 0.1, decision: "expensive" })), { expectedValueUsd: 600, routedCostUsd: 20, cheaperCostUsd: 1, decision: "expensive" }], 20, 60)
  check("E6 model_routing negative control: a ≥ $500 call moved to the cheaper model is counted (the evaluator fails on it)", neg.highValueDowngrades === 1 && neg.toCheaper === 26)
  await decideProposal(memE, { brokerageId: B, id: mrId, decision: "approve", actor: admin })
  const mrp = await promoteProposal(memE, { brokerageId: B, id: mrId, actor: admin })
  const raAfter = memE.tables.brokerage_settings[0].settings.resource_allocation
  check("E7 model_routing promoted through mergeBrokerageSettings: ONLY the ratio moved (the field patch kept lead_assignment_mode + the data cap)", mrp.ok && mrp.policyVersionRef === "resource_allocation@1" && raAfter.ai_min_value_to_cost_ratio === 60 && raAfter.lead_assignment_mode === "recommend" && raAfter.enrichment_max_usd_per_decision === 1, JSON.stringify([mrp, raAfter]))
  const ledE = memE.tables.agent_action_ledger.filter((r) => r.action === "learning.proposal.promote")
  check("E8 the promotion is LEDGERED (learning.proposal.promote, executed, policy_ref resource_allocation@…)", ledE.length === 1 && ledE[0].status === "executed" && String(ledE[0].policy_ref ?? "").startsWith("resource_allocation@"), JSON.stringify(ledE))
  const mrr = await rollbackProposal(memE, { brokerageId: B, id: mrId, actor: admin })
  const raBack = memE.tables.brokerage_settings[0].settings.resource_allocation
  check("E9 model_routing rollback restores the EXACT previous value as a new version, ledgered", mrr.ok && mrr.policyVersionRef === "resource_allocation@2" && JSON.stringify(raBack) === JSON.stringify(RA) && memE.tables.agent_action_ledger.some((r) => r.action === "learning.proposal.rollback"), JSON.stringify(raBack))

  // education_intervention / property_recommendation — experience attribution, live promote + rollback.
  const ed = await proposeImprovement(memE, { brokerageId: B, subjectKind: "policy", subjectKey: "optimization_tuning", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { patch: { experience_bias: { education: 5 } }, previous: { experience_bias: { education: 0 } }, ...opt("education_intervention") } })
  const edId = ed.ok ? ed.id : ""
  const ede = await evaluateProposal(memE, { brokerageId: B, id: edId }, { now: NOW, experienceStats: goodEdu })
  check("E10 education_intervention: attributed outcomes (education 0.2 vs 0.05) support +5 → pass", ede.ok && ede.evaluation.evaluator === "experience_attribution" && ede.evaluation.verdict === "pass", JSON.stringify(ede))
  const dirBad = experienceDirection("education", badEdu)
  check("E11 education negative control: the reversed evidence argues DOWN (a +5 would fail)", dirBad?.direction === -1)
  await decideProposal(memE, { brokerageId: B, id: edId, decision: "approve", actor: admin })
  const edp = await promoteProposal(memE, { brokerageId: B, id: edId, actor: admin })
  check("E12 education bias promoted into optimization_tuning and READ by the resolver", edp.ok && resolveOptimizationTuning(memE.tables.brokerage_settings[0].settings).experienceBias.education === 5, JSON.stringify(edp))
  const edr = await rollbackProposal(memE, { brokerageId: B, id: edId, actor: admin })
  check("E13 education rollback removes the bias (previous absent → key removed)", edr.ok && resolveOptimizationTuning(memE.tables.brokerage_settings[0].settings).experienceBias.education === undefined)
  const pr = await proposeImprovement(memE, { brokerageId: B, subjectKind: "policy", subjectKey: "optimization_tuning", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { patch: { experience_bias: { properties: -5 } }, previous: { experience_bias: { properties: 0 } }, ...opt("property_recommendation") } })
  const pre = await evaluateProposal(memE, { brokerageId: B, id: pr.ok ? pr.id : "" }, { now: NOW, experienceStats: { actions: { properties: 40, communication: 100 }, outcomes: { properties: 0, communication: 30 } } })
  check("E14 property_recommendation: evidence argues down → a −5 bias passes", pre.ok && pre.evaluation.verdict === "pass", JSON.stringify(pre))

  // provider_selection — tenant reliability, never the primary.
  // The gateway's ledger is PROVIDER-scoped (brokerage_id NULL by design); a tenant-attributed row is never read.
  memE.tables.api_response_logs.push(...Array.from({ length: 25 }, (_, i) => apiLog(null, "batchdata", i < 20)), ...Array.from({ length: 40 }, () => apiLog(OTHER, "batchdata", false)))
  const ps = await proposeImprovement(memE, { brokerageId: B, subjectKind: "policy", subjectKey: "optimization_tuning", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { patch: { provider_skip: { property_valuation: ["batchdata"] } }, previous: { provider_skip: { property_valuation: [] } }, ...opt("provider_selection") } })
  const psId = ps.ok ? ps.id : ""
  const pse = await evaluateProposal(memE, { brokerageId: B, id: psId }, { now: NOW })
  check("E15 provider_selection: the backup failed 20/25 gateway calls (provider-scoped ledger) → skip passes; OTHER's tenant-attributed rows are not read", pse.ok && pse.evaluation.evaluator === "provider_reliability" && pse.evaluation.verdict === "pass", JSON.stringify(pse))
  const route = ["rentcast", "batchdata"]
  check("E16 provider negative controls: the owner-ruled primary is never skipped; a healthy backup is not skipped; a thin sample is a human's call",
    providerSkipVerdict("rentcast", route, { calls: 50, errors: 50 }, true).verdict === "fail" && providerSkipVerdict("batchdata", route, { calls: 25, errors: 2 }, true).verdict === "fail" && providerSkipVerdict("batchdata", route, { calls: 5, errors: 5 }, true).verdict === "inconclusive")
  await decideProposal(memE, { brokerageId: B, id: psId, decision: "approve", actor: admin })
  const psp = await promoteProposal(memE, { brokerageId: B, id: psId, actor: admin })
  const skipsB = await loadTenantProviderSkips(B, memE), skipsO = await loadTenantProviderSkips(OTHER, memE)
  check("E17 provider skip promoted and read TENANT-SCOPED (B skips batchdata, OTHER skips nothing)", psp.ok && skipsB.join() === "batchdata" && skipsO.length === 0, JSON.stringify([psp, skipsB, skipsO]))
  await decideProposal(memE, { brokerageId: B, id: pr.ok ? pr.id : "", decision: "approve", actor: admin })
  const prp = await promoteProposal(memE, { brokerageId: B, id: pr.ok ? pr.id : "", actor: admin })
  const psr = await rollbackProposal(memE, { brokerageId: B, id: psId, actor: admin })
  check("E18 provider skip rollback restores ONLY its own field: the list is empty again, the LATER properties bias on the same key survives",
    prp.ok && psr.ok && (await loadTenantProviderSkips(B, memE)).length === 0 && resolveOptimizationTuning(memE.tables.brokerage_settings[0].settings).experienceBias.properties === -5, JSON.stringify(memE.tables.brokerage_settings[0].settings.optimization_tuning))
  check("E18b two classes on ONE policy key never dedup onto each other (each open proposal is its own class)", new Set(memE.tables.improvement_proposals.filter((r) => r.subject_key === "optimization_tuning").map((r) => r.proposed_change?.optimization?.class)).size === 3)

  // followup_timing — decision replay (survivor evaluator), campaign_sequencing / creative_choice — experiment arms.
  const ft = await proposeImprovement(memE, { brokerageId: B, subjectKind: "policy", subjectKey: "ai_isa_settings", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { touch_interval_days: 4, previous: { touch_interval_days: 3 }, ...opt("followup_timing") } })
  const fte = await evaluateProposal(memE, { brokerageId: B, id: ft.ok ? ft.id : "" }, { now: NOW, replay: okReplay })
  const ft2 = classifyProposalSurface({ subject_kind: "policy", subject_key: "ai_isa_settings", proposer: TEAM_OPTIMIZATION_PROPOSER, proposed_change: { touch_interval_days: 4, ...opt("followup_timing") } })
  check("E19 followup_timing: decision replay over recorded decisions (no earned decision changes) → pass", fte.ok && fte.evaluation.evaluator === "decision_replay" && fte.evaluation.verdict === "pass" && ft2.scope === "optimizable", JSON.stringify(fte))
  const memF = memSupabase({ improvement_proposals: [], brokerage_settings: [settingsRow(B)] }, { stampCreatedAt: true })
  const ftb = await proposeImprovement(memF, { brokerageId: B, subjectKind: "policy", subjectKey: "ai_isa_settings", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { touch_interval_days: 4, previous: { touch_interval_days: 3 }, ...opt("followup_timing") } })
  const ftbe = await evaluateProposal(memF, { brokerageId: B, id: ftb.ok ? ftb.id : "" }, { now: NOW, replay: earnedReplay })
  check("E20 followup_timing negative control: a change to a decision that EARNED is refused (REJECTED)", ftbe.ok && ftbe.status === "REJECTED")
  check("E21 followup_timing rollback writer strips the proposal's bookkeeping before writeIsaSettings (no PGRST204 on previous/optimization)", /PROPOSAL_META_KEYS\.has\(k\)/.test(kernelSrc) && /"previous", "optimization", "summary"/.test(kernelSrc))
  const stats = [{ variant: "A", sent: 600, replies: 120 }, { variant: "B", sent: 600, replies: 30 }]
  const cs = await proposeImprovement(memF, { brokerageId: B, subjectKind: "variant", subjectKey: "sequence_ab:seq-proof", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { winner: "A", stats, loserIds: [], ...opt("campaign_sequencing") } })
  const cse = await evaluateProposal(memF, { brokerageId: B, id: cs.ok ? cs.id : "" }, { now: NOW })
  const cr = await proposeImprovement(memF, { brokerageId: B, subjectKind: "variant", subjectKey: "media_kind:seller_equity:all", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { winner: "B", stats, loserIds: [], ...opt("creative_choice") } })
  const cre = await evaluateProposal(memF, { brokerageId: B, id: cr.ok ? cr.id : "" }, { now: NOW })
  check("E22 campaign_sequencing passes on the arm results; creative_choice naming the LOSER fails (negative control)", cse.ok && cse.evaluation.evaluator === "experiment_arms" && cse.evaluation.verdict === "pass" && cre.ok && cre.status === "REJECTED", JSON.stringify([cse, cre]))

  // ── C + A + T: the team cycle ───────────────────────────────────────────────────────────────────────────────
  console.log("C / A / T — the weekly team cycle")
  const seqProposal = { id: uuid(), brokerage_id: B, subject_kind: "variant", subject_key: "sequence_ab:seq-live", proposer: "copy_learning", proposed_change: { winner: "A", stats, loserIds: [] }, evidence_refs: [{ kind: "campaign_sequence_steps" }], status: "PROPOSED", evaluation: null, evaluated_at: null, authority_required: 4, decided_by: null, decided_at: null, decision_reason: null, policy_version_ref: null, promoted_at: null, rolled_back_at: null, rollback_policy_version_ref: null, created_at: RECENT, updated_at: RECENT }
  const cycleSeed = () => memSupabase({
    improvement_proposals: [{ ...seqProposal }], tenant_policy_versions: [], agent_action_ledger: [],
    brokerage_settings: [settingsRow(B, { resource_allocation: { ...RA }, self_optimization: { autonomous_classes: ["model_routing"] } }), settingsRow(OTHER, { resource_allocation: { ...RA } })],
    ai_tool_usage: [...Array.from({ length: 25 }, () => booking(B, 5, 0.2, 0.02)), ...Array.from({ length: 30 }, () => booking(OTHER, 900, 50, 1))],
    api_response_logs: [...Array.from({ length: 25 }, (_, i) => apiLog(null, "batchdata", i < 20))],
    fatigue_alerts: Array.from({ length: 6 }, () => ({ id: uuid(), brokerage_id: B, created_at: RECENT, alert_type: "high_fatigue" })),
  }, { stampCreatedAt: true })
  const memC = cycleSeed()
  const deps = { now: NOW, gateFor: async () => allowGate, replay: okReplay, isaTiming: async () => ({ touch_interval_days: 3, max_touches_lead: 6 }), experienceStats: goodEdu }
  const cyc = await runTeamOptimizationCycle(memC, B, deps)
  const by = (c: OptimizationClass) => cyc.classes.filter((r) => r.class === c)
  const teamRows = memC.tables.improvement_proposals.filter((r) => r.proposer === TEAM_OPTIMIZATION_PROPOSER)
  check("C1 the cycle co-proposed for the classes with evidence (model routing, follow-up timing, education, provider selection)", ["model_routing", "followup_timing", "education_intervention", "provider_selection"].every((c) => teamRows.some((r) => r.proposed_change?.optimization?.class === c)), JSON.stringify(cyc.classes.map((c) => [c.class, c.outcome, c.detail])))
  check("C2 every team proposal records ALL its managers (owner first, then each co-proposer) and one manager_evidence per manager",
    teamRows.length > 0 && teamRows.every((r) => {
      const o = r.proposed_change.optimization, def = OPTIMIZATION_CLASS_DEFS[o.class as OptimizationClass]
      const want = [def.owner, ...def.coProposers.map((c) => c.manager)]
      const evMgrs = (r.evidence_refs as any[]).filter((e) => e.kind === "manager_evidence").map((e) => e.manager)
      return JSON.stringify(o.managers) === JSON.stringify(want) && want.every((m) => evMgrs.includes(m) && typeof o.evidence_by_manager[m] === "string")
    }))
  check("C3 every co-proposer edge is a DECLARED registry collaboration (canRefer on its domain); an undeclared pair is refused (control)",
    OPTIMIZATION_CLASSES.every((c) => { const d = OPTIMIZATION_CLASS_DEFS[c]; return d.owner in MANAGERS && d.coProposers.length > 0 && d.coProposers.every((cp) => canRefer(d.owner, cp.manager, cp.domain)) }) && !canRefer("asset_manager", "recruiting_manager", "creative_distribution"))
  const adopted = memC.tables.improvement_proposals.find((r) => r.id === seqProposal.id)
  check("C4 the learner's open sequence proposal is CO-SIGNED (optimization block, both managers) — no duplicate team proposal", adopted?.proposed_change?.optimization?.class === "campaign_sequencing" && JSON.stringify(adopted.proposed_change.optimization.managers) === JSON.stringify(["campaign_orchestrator", "ai_isa"]) && !teamRows.some((r) => String(r.subject_key).startsWith("sequence_ab:")) && cyc.adopted === 1)
  const mrRow = teamRows.find((r) => r.proposed_change?.optimization?.class === "model_routing")
  check("A1 model_routing is on the autonomous list + the gate allows → PROMOTED by ai_isa, ratio 20 → 30", by("model_routing")[0]?.outcome === "promoted" && mrRow?.status === "PROMOTED" && memC.tables.brokerage_settings[0].settings.resource_allocation.ai_min_value_to_cost_ratio === 30, JSON.stringify(by("model_routing")))
  const led = memC.tables.agent_action_ledger.filter((r) => r.action === "learning.proposal.promote")
  check("A2 the autonomous promotion is LEDGERED: LEARNED_IMPROVEMENT, actor manager ai_isa, policy_ref resource_allocation@…", led.length === 1 && led[0].reason_code === "LEARNED_IMPROVEMENT" && led[0].actor_type === "manager" && led[0].actor_manager_key === "ai_isa" && String(led[0].policy_ref ?? "").startsWith("resource_allocation@"), JSON.stringify(led))
  check("A3 classes NOT on the list wait EVALUATED for a human (follow-up timing, education, provider selection, the co-signed sequence) — nothing else written to settings",
    ["followup_timing", "education_intervention", "provider_selection", "campaign_sequencing"].every((c) => by(c as OptimizationClass).every((r) => r.outcome === "held")) && memC.tables.brokerage_settings[0].settings.optimization_tuning === undefined, JSON.stringify(cyc.classes.map((c) => [c.class, c.outcome])))
  const memH = cycleSeed()
  const cycH = await runTeamOptimizationCycle(memH, B, { ...deps, gateFor: async () => heldGate })
  check("A4 control: the SAME listed class under a holding gate is held, not promoted", cycH.classes.find((c) => c.class === "model_routing")?.outcome === "held" && memH.tables.agent_action_ledger.length === 0 && memH.tables.brokerage_settings[0].settings.resource_allocation.ai_min_value_to_cost_ratio === 20)
  check("T1 OTHER's evidence was never read (the model-routing evidence counts B's 25 bookings; OTHER's starved ≥ $500 calls would have argued a DIFFERENT change) and OTHER got no proposal",
    String(mrRow?.proposed_change?.optimization?.evidence_by_manager?.ai_isa ?? "").startsWith("25 ") && mrRow?.proposed_change?.patch?.ai_min_value_to_cost_ratio === 30 && !memC.tables.improvement_proposals.some((r) => r.brokerage_id === OTHER) && memC.tables.brokerage_settings[1].settings.resource_allocation.ai_min_value_to_cost_ratio === 20)
  const xRead = await loadProposal(memC, OTHER, mrRow?.id ?? "")
  const xPromote = await promoteProposal(memC, { brokerageId: OTHER, id: teamRows.find((r) => r.status === "EVALUATED")?.id ?? "", actor: admin })
  const xCycle = await runTeamOptimizationCycle(memC, OTHER, { ...deps, isaTiming: async () => ({ touch_interval_days: 3, max_touches_lead: 6 }) })
  check("T2 another tenant cannot read or promote B's proposals; OTHER's own cycle never touches B's rows", !xRead.ok && !xPromote.ok && memC.tables.improvement_proposals.filter((r) => r.brokerage_id === B).every((r) => r.brokerage_id === B) && xCycle.classes.every((c) => !c.proposalId || memC.tables.improvement_proposals.find((r) => r.id === c.proposalId)?.brokerage_id === OTHER))
  check("T3 a tenant whose settings are unreadable gets NO autonomy (fail closed) and no cycle", (await runTeamOptimizationCycle(memSupabase({ brokerage_settings: [] }, { refuse: { brokerage_settings: "permission denied" } }), B, deps)).errors.length === 1)

  // ── N: the promoted values are READ ─────────────────────────────────────────────────────────────────────────
  console.log("N — readers")
  const nbe = (over: Partial<NextBestExperienceInput> = {}): NextBestExperienceInput => ({
    now: NOW, subject: "contact", nba: { memoryFacts: [], intent: { score: 70, trend: "rising", velocityPerDay: 2, accelerationPerDay2: 0, confidence: "high", independentSources: 3, momentumRank: 70, evidence: [] } as any },
    person: { contactType: "buyer", persona: "first_time", hasAssignedAgent: true }, behavior: { touchpoints7d: 1, lastTouchpointChannel: null, portalEducationViews: 0 },
    transaction: null, education: { open: 1, completed: 0, nextModule: { id: "m1", title: "Offers 101", milestoneKey: null } }, fatigue: { riskLevel: null },
    policy: { complianceHardFlag: false, allowedChannels: ["email"], autoSendAllowed: true, videoAllowed: true }, ...over,
  })
  const n0 = planNextBestExperience(nbe()), n1 = planNextBestExperience(nbe({ tuning: { experienceBias: { properties: 10 } } }))
  check("N1 the promoted properties bias moves the choice (education 60 vs properties 55 → properties 65), reason names the learned slice", n0.chosen.kind === "education" && n1.chosen.kind === "properties" && n1.contributed.includes("learned"), `${n0.chosen.kind}/${n1.chosen.kind}`)
  const n2 = planNextBestExperience(nbe({ nba: { memoryFacts: [] }, tuning: { experienceBias: { properties: 15 } } }))
  check("N2 control: a bias never INVENTS an experience no slice argued for", !n2.ranked.some((r) => r.kind === "properties"))
  const n3 = planNextBestExperience(nbe({ fatigue: { riskLevel: "critical" }, tuning: { experienceBias: { properties: 15 } } }))
  check("N3 control: a bias never overrides the forced fatigue wait", n3.chosen.kind === "wait")
  const val = async (skips: string[]) => requestPropertyValuation({ brokerageId: B, address: "1 Main St" } as any, {
    providerHealth: async () => ({ state: "healthy", routeAround: false, reason: "ok" }),
    eligibility: async () => ({ eligible: false, overBudget: false }),
    fallback: { access: async () => ({ allowed: false, reason: "proof" }) },
    tenantProviderSkips: async () => skips,
  })
  const v1 = await val(["batchdata"]), v0 = await val([]), vP = await val(["rentcast", "batchdata"])
  check("N4 the valuation route skips the tenant's promoted backup (batchdata never tried) — control: with no skip it is tried",
    !v1.providersTried.includes("batchdata") && v1.skipped.some((s) => s.provider === "batchdata" && /optimization_tuning/.test(s.reason)) && v0.providersTried.includes("batchdata"), JSON.stringify([v1, v0]))
  check("N5 the owner-ruled primary is never skipped even if a stored skip names it", !vP.skipped.some((s) => s.provider === "rentcast" && /optimization_tuning/.test(s.reason)))

  // ── R: wave 137E BREADTH — transaction_reminder_timing (evaluator + rollback + reader, all real) ─────────────
  console.log("R — breadth class: transaction reminder timing")
  const dl = (b: string, status: string) => ({ id: uuid(), brokerage_id: b, status, deadline_date: "2026-09-01", transaction_id: uuid(), deadline_type: "inspection" })
  // The rule, driven through the class's real evaluator (evaluateOptimizationClass) over in-memory deadline rows.
  const verdict = async (current: number, proposed: number, resolved: number, missed: number) => (await evaluateOptimizationClass(
    memSupabase({ transaction_deadlines: [...Array.from({ length: resolved - missed }, () => dl(B, "completed")), ...Array.from({ length: missed }, () => dl(B, "missed"))] }),
    { brokerage_id: B, subject_kind: "policy", subject_key: "optimization_tuning", proposed_change: { patch: { deadline_reminder_hours: proposed }, previous: { deadline_reminder_hours: current } } } as any, "transaction_reminder_timing", { now: NOW })).verdict
  check("R1 the deadline rule: earlier reminders pass at a ≥ 5% missed rate and fail at 0 missed; later passes ONLY with none missed; a thin sample is a human's call; out-of-bounds / no-change fail",
    (await verdict(24, 48, 40, 4)) === "pass" && (await verdict(24, 48, 40, 0)) === "fail"
    && (await verdict(48, 24, 40, 0)) === "pass" && (await verdict(48, 24, 40, 1)) === "fail"
    && (await verdict(24, 48, 5, 5)) === "inconclusive" && (await verdict(24, DEADLINE_REMINDER_MAX_HOURS + 24, 40, 10)) === "fail" && (await verdict(24, 24, 40, 10)) === "fail")
  const s11 = C("transaction_reminder_timing", "policy", "optimization_tuning", { patch: { deadline_reminder_hours: 48, experience_bias: { education: 5 } } })
  const s11b = C("transaction_reminder_timing", "policy", "transaction_deadlines_policy", { patch: { deadline_reminder_hours: 48 } })
  check("R2 the class may touch ONLY deadline_reminder_hours on optimization_tuning (another field / another key = forbidden; the deadline itself is never a surface)", s11.scope === "forbidden" && s11.surface === "policy_outside_allowed_list" && s11b.scope === "forbidden", JSON.stringify([s11, s11b]))
  const memR = memSupabase({
    improvement_proposals: [], tenant_policy_versions: [], agent_action_ledger: [],
    brokerage_settings: [settingsRow(B, {}), settingsRow(OTHER, {})],
    transaction_deadlines: [...Array.from({ length: 36 }, () => dl(B, "completed")), ...Array.from({ length: 4 }, () => dl(B, "missed")), ...Array.from({ length: 40 }, () => dl(OTHER, "completed"))],
  }, { stampCreatedAt: true })
  const tr = await proposeImprovement(memR, { brokerageId: B, subjectKind: "policy", subjectKey: "optimization_tuning", proposer: TEAM_OPTIMIZATION_PROPOSER, proposedChange: { patch: { deadline_reminder_hours: 48 }, previous: { deadline_reminder_hours: 24 }, ...opt("transaction_reminder_timing") } })
  const trId = tr.ok ? tr.id : ""
  const tre = await evaluateProposal(memR, { brokerageId: B, id: trId }, { now: NOW })
  check("R3 evaluator deadline_outcomes re-measures B's OWN deadlines (4/40 missed → earlier passes); OTHER's clean record is not read", tre.ok && tre.evaluation.evaluator === "deadline_outcomes" && tre.evaluation.verdict === "pass" && (tre.evaluation.detail as any).resolved === 40, JSON.stringify(tre))
  await decideProposal(memR, { brokerageId: B, id: trId, decision: "approve", actor: admin })
  const trp = await promoteProposal(memR, { brokerageId: B, id: trId, actor: admin })
  const leadMap = await loadDeadlineReminderHours(memR, [B, OTHER])
  check("R4 promoted through mergeBrokerageSettings and READ by the watcher's loader TENANT-SCOPED (B 48h, OTHER default)", trp.ok && leadMap.get(B) === 48 && !leadMap.has(OTHER) && resolveOptimizationTuning(memR.tables.brokerage_settings[0].settings).deadlineReminderHours === 48, JSON.stringify([trp, [...leadMap]]))
  const trr = await rollbackProposal(memR, { brokerageId: B, id: trId, actor: admin })
  const after = await loadDeadlineReminderHours(memR, [B])
  check("R5 rollback re-applies the recorded previous value through the same writer (B back to 24h — a new version, history kept)", trr.ok && (after.get(B) ?? 24) === 24 && memR.tables.tenant_policy_versions.length >= 2, JSON.stringify([trr, [...after]]))
  check("R6 (control) an unreadable settings batch keeps every tenant on the default (never a widened window)", (await loadDeadlineReminderHours(memSupabase({ brokerage_settings: [] }, { refuse: { brokerage_settings: "denied" } }), [B])).size === 0)
  const memRC = memSupabase({ improvement_proposals: [], tenant_policy_versions: [], agent_action_ledger: [], brokerage_settings: [settingsRow(B, {})], transaction_deadlines: [...Array.from({ length: 30 }, () => dl(B, "completed")), ...Array.from({ length: 6 }, () => dl(B, "missed"))] }, { stampCreatedAt: true })
  const cycR = await runTeamOptimizationCycle(memRC, B, { now: NOW, gateFor: async () => allowGate, replay: okReplay, isaTiming: async () => ({ touch_interval_days: 3, max_touches_lead: 6 }), experienceStats: goodEdu })
  const trRow = memRC.tables.improvement_proposals.find((r) => r.proposed_change?.optimization?.class === "transaction_reminder_timing")
  check("R7 the weekly cycle co-proposes it (deal_coordinator + compliance_officer, 24h → 48h) and HOLDS it for a human (not on the autonomous list)",
    !!trRow && trRow.proposed_change.patch.deadline_reminder_hours === 48 && JSON.stringify(trRow.proposed_change.optimization.managers) === JSON.stringify(["deal_coordinator", "compliance_officer"]) && cycR.classes.find((c) => c.class === "transaction_reminder_timing")?.outcome === "held", JSON.stringify(cycR.classes.find((c) => c.class === "transaction_reminder_timing")))
  const watcher = src("lib/kernel/calendar-deadline-watcher.ts")
  check("R8 the READER is wired: the deadline watcher loads the tenant lead (loadDeadlineReminderHours) and applies it ONLY to transaction deadline types", /loadDeadlineReminderHours\(supabase,/.test(watcher) && /TRANSACTION_DEADLINE_TYPES\.has\(e\.event_type\)\s*\?\s*tenantLead\.get/.test(watcher) && /leadHoursFor\(calEvent\)/.test(watcher))

  // ── W: wiring + registration (stripped source; vocabularies derived) ───────────────────────────────────────
  console.log("W — wiring")
  const count = (hay: string, needle: string) => hay.split(needle).length - 1
  check("W0 positive control: the counter sees a planted call twice", count("x classifyProposalSurface(a) classifyProposalSurface(b)", "classifyProposalSurface(") === 2)
  check("W1 the kernel classifies at propose + evaluate + (decide, promote via optimizationContext)", count(kernelSrc, "classifyProposalSurface(") >= 3 && count(kernelSrc, "optimizationContext(svc, row, input.actor)") === 2)
  const dispatch = src("lib/kernel/cron-dispatch.ts"), cronRoute = src("app/api/cron/team-optimization/route.ts")
  check("W2 the weekly cron is registered and runs the cycle per tenant", /"\/api\/cron\/team-optimization"\s*,\s*schedule:\s*"[0-9]+ [0-9]+ \* \* [0-6]"/.test(dispatch) && /runTeamOptimizationCycle\(svc, b\.id\)/.test(cronRoute) && /verifyCronAuth\(request\)/.test(cronRoute))
  const lap = src("lib/ai-isa/lead-action-plan.ts"), chain = src("lib/avm/provider-chain.ts")
  check("W3 the NBE planner applies the learned bias and its loader reads optimization_tuning", /input\.tuning\?\.experienceBias/.test(lap) && /resolveOptimizationTuning\(/.test(lap) && /tuning,\s*\n?\s*\}/.test(lap))
  check("W4 the valuation route reads the tenant skip (loadTenantProviderSkips) and filters the routed providers", /loadTenantProviderSkips\(/.test(chain) && /tenantSkips\.has\(p\)/.test(chain))
  const page = src("app/dashboard/admin/manager-trust/page.tsx"), panel = src("app/dashboard/admin/manager-trust/self-optimization-panel.tsx"), act = src("app/actions/admin/improvement-proposals.ts")
  check("W5 the Manager Trust page mounts the autonomous-list panel; its form submits a HUMAN policy proposal on self_optimization through proposeEvaluatePromote", /<SelfOptimizationPanel \/>/.test(page) && /action=\{setSelfOptimizationAutonomyFormAction\}/.test(panel) && /subjectKey: SELF_OPTIMIZATION_POLICY_KEY, proposer: "human"/.test(act) && /requireLearningAdmin\("self-optimization/.test(act))
  check("W6 both policy keys are registered tenant policy (versioned)", !!TENANT_POLICY_SETTINGS_KEYS.optimization_tuning && !!TENANT_POLICY_SETTINGS_KEYS.self_optimization)
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  check("W7 test:self-optimization is registered and in the guard chain (membership, not position)", typeof pkg.scripts["test:self-optimization"] === "string" && new RegExp("npm run test:self-optimization(\\s|&|$)").test(pkg.scripts.guard ?? ""))
  const dom = Object.values(MAINTENANCE_DOMAINS).find((d: any) => d.proof === "test:self-optimization") as any
  check("W8 MAINTENANCE_DOMAINS owns the proof with an owner and co-owners NAMED in the prose", !!dom && [dom.manager, ...(dom.coOwners ?? [])].every((m: string) => dom.what.includes(m)) && (dom.coOwners ?? []).length >= 2)
  const migDir = join(ROOT, "supabase/migrations")
  const latestDefining = (constraint: string): string | null => {
    const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort((a, b) => Number(/^m(\d+)/.exec(a)?.[1] ?? 0) - Number(/^m(\d+)/.exec(b)?.[1] ?? 0))
    let hit: string | null = null
    for (const f of files) if (new RegExp(`ADD CONSTRAINT ${constraint}`).test(readFileSync(join(migDir, f), "utf8"))) hit = f
    return hit
  }
  const propMig = latestDefining("improvement_proposals_proposer_check"), classMig = latestDefining("improvement_proposals_optimization_class_check")
  const propSql = propMig ? readFileSync(join(migDir, propMig), "utf8") : "", classSql = classMig ? readFileSync(join(migDir, classMig), "utf8") : ""
  check("W9 the LATEST migration defining the proposer CHECK carries every PROPOSERS value (derived, superset rule)", !!propMig && PROPOSERS.every((p) => propSql.includes(`'${p}'`)), propMig ?? "none")
  check("W10 the LATEST migration defining the optimization-class CHECK carries every OPTIMIZATION_CLASSES value", !!classMig && OPTIMIZATION_CLASSES.every((c) => classSql.includes(`'${c}'`)), classMig ?? "none")
  check("W11 that migration's line 1 is a lane stamp or an applied stamp (never pinned to either)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2})/.test(classSql))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  " + fails.join("\n  ")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
