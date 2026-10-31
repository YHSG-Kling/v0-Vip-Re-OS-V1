// lib/kernel/self-optimization.ts
//
// SELF-OPTIMIZING MANAGER TEAMS — BOUNDED (wave 108, lane 108G; owner 2026-10-07: "managers improve strategies
// together — campaign sequencing, model routing, creative choice, education interventions, follow-up timing,
// provider selection, property recommendations — NEVER authority policies, financial rules or compliance
// boundaries").
//
// NOTHING HERE IS A SECOND LEARNING SYSTEM. The survivors stay the survivors:
//   · the ONE proposal object ...... lib/kernel/improvement-proposals.ts (propose → evaluate → decide → promote →
//                                    roll back, ledgered through withActionLedger). This module is a CALLER of it;
//                                    the forbidden-surface refusal below is enforced INSIDE that kernel
//                                    (proposeImprovement / evaluateImprovement / decideProposal / promoteProposal).
//   · evaluators ................... decision replay (lib/kernel/decision-replay.ts via evaluateImprovement), experiment
//                                    arm results (pickWinningVariant), plus three deterministic re-measurements built
//                                    here for the classes no evaluator covered (reasoning-spend replay over
//                                    ai_tool_usage.context_json.reasoning_spend, experience attribution over the ROI
//                                    ledger's byExperience, provider reliability over the connector gateway's
//                                    PROVIDER-scoped api_response_logs — the gateway writes brokerage_id NULL by design
//                                    and a backup miss is not metered, so no per-tenant provider outcome exists to read).
//   · writers / rollback ........... the survivor writers improvement-proposals.ts applyChange already calls
//                                    (retireLosingVariants / restoreRetiredVariants, writeIsaSettings,
//                                    mergeBrokerageSettings → appendTenantPolicyVersion); rollback = the same writer
//                                    with the recorded previous value (a NEW version, history never rewritten).
//   · readers of a promoted value .. lib/campaign-sequences/ab-variant.ts (active steps), lib/ai-isa/lead-action-plan.ts
//                                    planNextLeadTouch (ISA timing) + planNextBestExperience (experience bias),
//                                    lib/ai/models.ts shouldUseExpensiveReasoning (resource_allocation ratio),
//                                    lib/avm/provider-chain.ts requestPropertyValuation (provider skip).
//   · co-proposal .................. the registry's declared collaboration edges (MANAGER_COLLABORATIONS / canRefer) —
//                                    a co-proposer is only ever a manager that already shares a domain with the owner.
//   · authority .................... promotionDecision (the ladder + autonomy gate) PLUS the tenant's own list of
//                                    classes allowed to promote autonomously (policy key `self_optimization`, written
//                                    only by a human through the policy-proposal path). Not on the list → a human.

import { parsePolicyKey } from "@/lib/kernel/tenant-policy"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import type { ImprovementProposalRow, ProposalEvaluation, PromotionGate } from "@/lib/kernel/improvement-proposals"

type Svc = { from: (t: string) => any }

// ── THE VOCABULARIES (one const each; the optimization class is CHECKed in m732 where it is stored) ─────────

// Wave 137E (BREADTH): + transaction_reminder_timing — the first class beyond the listing/lead funnel whose
// evaluator (deadline_outcomes over transaction_deadlines), rollback (mergeBrokerageSettings) and reader
// (lib/kernel/calendar-deadline-watcher.ts) are all real. m740 widens m732's CHECK to this list.
export const OPTIMIZATION_CLASSES = ["campaign_sequencing", "model_routing", "creative_choice", "education_intervention", "followup_timing", "provider_selection", "property_recommendation", "transaction_reminder_timing"] as const
export type OptimizationClass = (typeof OPTIMIZATION_CLASSES)[number]

/**
 * Wave 138E — candidates EVALUATED and NOT built, each because a real piece is missing. A class is built only
 * with a real evaluator + rollback + READER (E1–E4); a promoted value nobody reads is a write wearing the
 * costume of a learning loop. Each entry names the file that WOULD read the promoted value; the proof fails
 * the moment that file starts reading tenant tuning (the record is then stale — build the class or drop the
 * line), so this list can never sit here reading as "still impossible" after the gap closes.
 * @proofSeam the self-optimization proof reads each named reader file to hold the record honest
 */
export const OPTIMIZATION_CANDIDATES_NOT_BUILT: ReadonlyArray<{ candidate: string; wouldBeReadBy: string; missing: string }> = Object.freeze([
  { candidate: "home_value_review_cadence", wouldBeReadBy: "lib/agents/sphere-agent.ts", missing: "no cadence reader: the home_value_review strategy runs on the mission cadence (strategy timing.cadenceDays), and no producer reads a tenant review interval" },
  { candidate: "recruiting_outreach_timing", wouldBeReadBy: "lib/agents/recruit-outreach-producer.ts", missing: "no timing knob and no outcome reader: recruit outreach proposes into the approval gate on demand; recruit reply/hire outcomes are not attributed back to send timing" },
  { candidate: "video_variant_selection", wouldBeReadBy: "lib/video/format-learning.ts", missing: "covered, not missing: creative_choice already records the media_kind preference (lib/kernel/media-intelligence.ts mediaKindVerdict); a second class would be a second vocabulary for one choice" },
])
export function isOptimizationClass(v: unknown): v is OptimizationClass {
  return typeof v === "string" && (OPTIMIZATION_CLASSES as readonly string[]).includes(v)
}

/** What the optimizer may NEVER touch, whoever approves it. */
export const FORBIDDEN_SURFACES = ["authority_policy", "financial_rule", "compliance_boundary", "policy_outside_allowed_list"] as const
export type ForbiddenSurface = (typeof FORBIDDEN_SURFACES)[number]

/** The tenant key the classes on the ALLOWED list write (experience bias, provider skip). */
export const OPTIMIZATION_TUNING_POLICY_KEY = "optimization_tuning"
/** The tenant key that says which classes may promote WITHOUT a human — authority policy, never optimizable. */
export const SELF_OPTIMIZATION_POLICY_KEY = "self_optimization"
/** The proposer the team cycle writes as (m732 widens the proposer CHECK). */
export const TEAM_OPTIMIZATION_PROPOSER = "team_optimization"
/** The rung a governed manager needs to promote an optimization (below owner level — the surface is proven allowed). */
export const OPTIMIZATION_CLASS_AUTHORITY: AuthorityLevel = 4
/** An experience bias is a nudge, never a takeover: |bias| ≤ this (the NBE's forced precedence is untouched). */
export const EXPERIENCE_BIAS_LIMIT = 15
const EXPERIENCE_BIAS_STEP = 5

export type OptimizationEvaluator = "experiment_arms" | "decision_replay" | "reasoning_spend_replay" | "experience_attribution" | "provider_reliability" | "deadline_outcomes"

/** Transaction-deadline reminder lead time (hours before the deadline the watcher notifies). The platform
 *  default is the watcher's historic 24h; an optimization moves it one STEP at a time inside [MIN, MAX]. */
export const DEADLINE_REMINDER_DEFAULT_HOURS = 24
const DEADLINE_REMINDER_MIN_HOURS = 24
export const DEADLINE_REMINDER_MAX_HOURS = 96
const DEADLINE_REMINDER_STEP_HOURS = 24
/** A missed-deadline rate at or above this argues for EARLIER reminders. */
const DEADLINE_MISSED_RATE_EARLIER = 0.05

type ClassSurface =
  | { subjectKind: "variant"; subjectPrefix: string }
  | { subjectKind: "policy"; policyKey: RegExp; fields: readonly string[]; shape: "isa_fields" | "settings_patch" }

export interface OptimizationClassDef {
  key: OptimizationClass
  label: string
  /** The accountable manager (it brings the autonomy gate when the class is on the tenant's autonomous list). */
  owner: ManagerKey
  /** Co-proposers — each on a DECLARED collaboration domain with the owner (registry edge, checked by the proof). */
  coProposers: ReadonlyArray<{ manager: ManagerKey; domain: string }>
  surface: ClassSurface
  evaluator: OptimizationEvaluator
  /** The survivor writer a promotion lands through; rollback re-applies the recorded previous value through it. */
  rollback: string
  /** Where the promoted value is read (so a promotion is never a write nobody reads). */
  reader: string
}

const ISA_KEY = /^ai_isa_settings(:(team|agent):[0-9a-f-]{36})?$/

export const OPTIMIZATION_CLASS_DEFS: Readonly<Record<OptimizationClass, OptimizationClassDef>> = Object.freeze({
  campaign_sequencing: {
    key: "campaign_sequencing", label: "Campaign sequencing (sequence copy A/B winners)", owner: "campaign_orchestrator",
    coProposers: [{ manager: "ai_isa", domain: "sequence_touch_cadence" }],
    surface: { subjectKind: "variant", subjectPrefix: "sequence_ab:" },
    evaluator: "experiment_arms", rollback: "restoreRetiredVariants (campaign_sequence_steps.is_active)",
    reader: "lib/campaign-sequences/ab-variant.ts pickStepVariant (active step rows only)",
  },
  creative_choice: {
    key: "creative_choice", label: "Creative choice (media kind per purpose / market)", owner: "asset_manager",
    coProposers: [{ manager: "campaign_orchestrator", domain: "creative_distribution" }, { manager: "ads_manager", domain: "creative_distribution" }],
    surface: { subjectKind: "variant", subjectPrefix: "media_kind:" },
    evaluator: "experiment_arms", rollback: "restoreRetiredVariants (media proposals retire no rows — 106C recommendation mode)",
    reader: "lib/kernel/media-intelligence.ts mediaKindVerdict (the recorded preference)",
  },
  followup_timing: {
    key: "followup_timing", label: "Follow-up timing (ISA touch interval / touch cap)", owner: "ai_isa",
    coProposers: [{ manager: "campaign_orchestrator", domain: "sequence_touch_cadence" }],
    surface: { subjectKind: "policy", policyKey: ISA_KEY, fields: ["touch_interval_days", "max_touches_lead"], shape: "isa_fields" },
    evaluator: "decision_replay", rollback: "writeIsaSettings (previous fields)",
    reader: "lib/ai-isa/lead-action-plan.ts planNextLeadTouch (touch_interval_days / max_touches_lead)",
  },
  model_routing: {
    key: "model_routing", label: "Model routing (expensive-reasoning value/cost ratio)", owner: "ai_isa",
    coProposers: [{ manager: "finance_manager", domain: "ai_spend_ledger" }, { manager: "asset_manager", domain: "ai_spend_ledger" }],
    surface: { subjectKind: "policy", policyKey: /^resource_allocation$/, fields: ["ai_min_value_to_cost_ratio"], shape: "settings_patch" },
    evaluator: "reasoning_spend_replay", rollback: "mergeBrokerageSettings:resource_allocation (previous value)",
    reader: "lib/ai/models.ts → lib/kernel/resource-allocation.ts shouldUseExpensiveReasoning",
  },
  education_intervention: {
    key: "education_intervention", label: "Education interventions (next-best-experience education bias)", owner: "ai_isa",
    coProposers: [{ manager: "campaign_orchestrator", domain: "sequence_touch_cadence" }, { manager: "data_steward", domain: "seller_signal_education_routing" }],
    surface: { subjectKind: "policy", policyKey: /^optimization_tuning$/, fields: ["experience_bias.education"], shape: "settings_patch" },
    evaluator: "experience_attribution", rollback: "mergeBrokerageSettings:optimization_tuning (previous value)",
    reader: "lib/ai-isa/lead-action-plan.ts planNextBestExperience (tuning.experienceBias, learned slice)",
  },
  property_recommendation: {
    key: "property_recommendation", label: "Property recommendations (next-best-experience properties bias)", owner: "shopping_agent",
    coProposers: [{ manager: "ai_isa", domain: "buyer_tour_to_deal_story" }, { manager: "listing_concierge", domain: "listing_demand_bridge" }],
    surface: { subjectKind: "policy", policyKey: /^optimization_tuning$/, fields: ["experience_bias.properties"], shape: "settings_patch" },
    evaluator: "experience_attribution", rollback: "mergeBrokerageSettings:optimization_tuning (previous value)",
    reader: "lib/ai-isa/lead-action-plan.ts planNextBestExperience (tuning.experienceBias, learned slice)",
  },
  provider_selection: {
    key: "provider_selection", label: "Provider selection (skip a failing BACKUP provider for this tenant)", owner: "data_steward",
    coProposers: [{ manager: "ai_isa", domain: "public_records_seller_signals" }],
    surface: { subjectKind: "policy", policyKey: /^optimization_tuning$/, fields: ["provider_skip.property_valuation"], shape: "settings_patch" },
    evaluator: "provider_reliability", rollback: "mergeBrokerageSettings:optimization_tuning (previous value)",
    reader: "lib/avm/provider-chain.ts requestPropertyValuation (tenant provider skip; the owner-ruled primary is never skipped)",
  },
  // Wave 137E: transactions / closing. Co-proposer on the DECLARED closing_money_and_risk edge (registry).
  transaction_reminder_timing: {
    key: "transaction_reminder_timing", label: "Transaction reminder timing (deadline reminder lead hours)", owner: "deal_coordinator",
    coProposers: [{ manager: "compliance_officer", domain: "closing_money_and_risk" }],
    surface: { subjectKind: "policy", policyKey: /^optimization_tuning$/, fields: ["deadline_reminder_hours"], shape: "settings_patch" },
    evaluator: "deadline_outcomes", rollback: "mergeBrokerageSettings:optimization_tuning (previous value)",
    reader: "lib/kernel/calendar-deadline-watcher.ts checkUpcomingDeadlines (tenant transaction-deadline horizon)",
  },
})

// ── FORBIDDEN SURFACES — named, so a refusal says WHICH boundary it protects ────────────────────────────────
// Paths are `<policy key>` (a whole value) or `<policy key>.<field>[.<field>]`. First match wins (specific first).
const FORBIDDEN_POLICY_PATHS: ReadonlyArray<{ re: RegExp; surface: ForbiddenSurface; why: string }> = [
  { re: /^(authority_level|autonomy_tier):/, surface: "authority_policy", why: "a manager's authority rung / autonomy posture" },
  { re: /^self_optimization(\.|$)/, surface: "authority_policy", why: "which classes may promote without a human — the human's own control" },
  { re: /^ai_agent_capabilities(\.|$)/, surface: "authority_policy", why: "which tools an AI agent may use" },
  { re: /^procurement_autonomy\.max_auto_approve_usd$/, surface: "financial_rule", why: "the auto-approve purchase cap" },
  { re: /^procurement_autonomy(\.|$)/, surface: "authority_policy", why: "what a manager may buy without approval" },
  { re: /^learned_vetoes(\.|$)/, surface: "authority_policy", why: "a human's veto of a learned adjustment" },
  { re: /^(lead_routing|default_assignment_method)(\.|$)/, surface: "authority_policy", why: "who receives the brokerage's leads" },
  { re: /^assignment_rule:/, surface: "authority_policy", why: "a lead assignment rule" },
  { re: /^resource_allocation\.lead_assignment_mode$/, surface: "authority_policy", why: "whether the assigner consumes a recommendation" },
  { re: /^resource_allocation\.enrichment_max_usd_per_decision$/, surface: "financial_rule", why: "the per-decision data spend cap" },
  { re: /^strategy_overrides(\.|$)/, surface: "authority_policy", why: "a strategy's budget, authority and approval" },
  { re: /^(vendor_tier_pricing|referral_appreciation|farm_mail)(\.|$)/, surface: "financial_rule", why: "prices, payouts and paid-mail volume" },
  { re: /(^|\.)(commission|billing|pricing|payout|invoice|residual|budget|spend_cap|price)[a-z_]*(\.|$)/i, surface: "financial_rule", why: "money is never optimized by a model (deterministic rules + Finance)" },
  { re: /^(network_benchmarks_opt_in|ce_provider|contact_fatigue_weights)(\.|$)/, surface: "compliance_boundary", why: "consent, licensing and person-protection settings" },
  { re: /^ai_isa_settings(:[^.]*)?\.(require_broker_approval|auto_send[a-z_]*)$/, surface: "authority_policy", why: "whether the ISA may act without a human" },
  { re: /^ai_isa_settings(:[^.]*)?\.(blocked_lifecycle_states|lead_allowed_channels|contact_allowed_channels|quiet_hours[a-z_]*|[a-z_]*consent[a-z_]*|[a-z_]*opt_out[a-z_]*|[a-z_]*dnc[a-z_]*)$/, surface: "compliance_boundary", why: "who may be contacted, on which channel, when" },
  { re: /(^|\.)([a-z_]*fair_housing[a-z_]*|[a-z_]*compliance[a-z_]*|[a-z_]*tcpa[a-z_]*)(\.|$)/, surface: "compliance_boundary", why: "a compliance boundary" },
]

/** PURE — the forbidden surface a policy path touches (null = not named forbidden). */
function forbiddenSurfaceOf(path: string): { surface: ForbiddenSurface; why: string } | null {
  for (const f of FORBIDDEN_POLICY_PATHS) if (f.re.test(path)) return { surface: f.surface, why: f.why }
  return null
}

const META_KEYS = new Set(["optimization", "previous", "summary", "changed_keys", "recommendation"])
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

function leafPaths(obj: Record<string, unknown>, prefix: string, depth = 0): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (isObj(v) && depth < 3 && Object.keys(v).length > 0) out.push(...leafPaths(v, p, depth + 1))
    else out.push(p)
  }
  return out
}

/** PURE — every policy path a `policy` proposal would change. A whole `value` is the bare key (it can touch anything under it). */
function changedPolicyPaths(row: { subject_key: string; proposed_change: Record<string, unknown> | null }): string[] {
  const key = row.subject_key
  const change = row.proposed_change ?? {}
  if ("value" in change) return [key]
  if (isObj(change.patch)) return leafPaths(change.patch, key)
  const fields = Object.keys(change).filter((k) => !META_KEYS.has(k))
  return fields.length ? fields.map((f) => `${key}.${f}`) : [key]
}

export type SurfaceVerdict =
  | { scope: "governance"; reason: string }
  | { scope: "legacy"; reason: string }
  | { scope: "optimizable"; class: OptimizationClass; paths: string[] }
  | { scope: "forbidden"; surface: ForbiddenSurface; class: string | null; paths: string[]; reason: string }

/** The optimization block a team proposal carries in proposed_change (m732 CHECKs `class`). */
interface OptimizationBlock {
  class: OptimizationClass
  cycle_id: string
  owner: ManagerKey
  co_proposers: Array<{ manager: ManagerKey; domain: string }>
  /** Every manager that contributed evidence (owner first) — the co-proposal record. */
  managers: ManagerKey[]
  evidence_by_manager: Record<string, string>
}

function optimizationBlockOf(change: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const o = change?.optimization
  return isObj(o) ? o : null
}

/**
 * PURE — WHICH SURFACE does this proposal touch? The kernel refuses `forbidden` at propose, evaluate, decide and
 * promote, whoever the actor is.
 *   · a HUMAN proposal with no optimization block is GOVERNANCE (an admin changing policy on its own screen —
 *     the forbidden list does not bind a human's own policy edit; it binds the OPTIMIZER);
 *   · a MACHINE proposal (any learner) on a `policy` subject is checked against the named forbidden paths;
 *     its other kinds (variant / threshold / prompt / allocation / strategy) are the learners' LEGACY lanes;
 *   · a proposal carrying an optimization block must name a known class, match that class's subject surface, and
 *     change ONLY the class's allowed fields — anything else is forbidden (the named surface, or
 *     policy_outside_allowed_list).
 */
export function classifyProposalSurface(row: { subject_kind: string; subject_key: string; proposer?: string | null; proposed_change: Record<string, unknown> | null }): SurfaceVerdict {
  const opt = optimizationBlockOf(row.proposed_change)
  const policyPaths = row.subject_kind === "policy" ? changedPolicyPaths(row) : []
  const named = policyPaths.map((p) => ({ p, f: forbiddenSurfaceOf(p) })).find((x) => x.f)
  if (!opt) {
    if (row.proposer === "human") return { scope: "governance", reason: "a human's own policy edit (no optimization class)" }
    if (row.proposer === TEAM_OPTIMIZATION_PROPOSER) return { scope: "forbidden", surface: "policy_outside_allowed_list", class: null, paths: policyPaths, reason: "a team optimization proposal must carry its optimization class" }
    if (named) return { scope: "forbidden", surface: named.f!.surface, class: null, paths: policyPaths, reason: `${named.p} is ${named.f!.why} — a learner never changes it` }
    return { scope: "legacy", reason: `${row.subject_kind} proposal from ${row.proposer ?? "a learner"}` }
  }
  const cls = opt.class
  if (!isOptimizationClass(cls)) return { scope: "forbidden", surface: "policy_outside_allowed_list", class: String(cls ?? ""), paths: policyPaths, reason: `"${String(cls)}" is not an optimizable class (${OPTIMIZATION_CLASSES.join(", ")})` }
  if (named) return { scope: "forbidden", surface: named.f!.surface, class: cls, paths: policyPaths, reason: `${named.p} is ${named.f!.why} — never optimized` }
  const def = OPTIMIZATION_CLASS_DEFS[cls]
  const s = def.surface
  if (row.subject_kind !== s.subjectKind) return { scope: "forbidden", surface: "policy_outside_allowed_list", class: cls, paths: policyPaths, reason: `${cls} optimizes ${s.subjectKind} subjects, not ${row.subject_kind}` }
  if (s.subjectKind === "variant") {
    return row.subject_key.startsWith(s.subjectPrefix)
      ? { scope: "optimizable", class: cls, paths: [row.subject_key] }
      : { scope: "forbidden", surface: "policy_outside_allowed_list", class: cls, paths: [row.subject_key], reason: `${cls} optimizes ${s.subjectPrefix}* variants only` }
  }
  if (!s.policyKey.test(row.subject_key) || !parsePolicyKey(row.subject_key)) return { scope: "forbidden", surface: "policy_outside_allowed_list", class: cls, paths: policyPaths, reason: `${row.subject_key} is not on ${cls}'s allowed policy list` }
  const change = row.proposed_change ?? {}
  if ("value" in change) return { scope: "forbidden", surface: "policy_outside_allowed_list", class: cls, paths: policyPaths, reason: "an optimization changes named fields, never a whole policy value" }
  if (s.shape === "settings_patch" && !isObj(change.patch)) return { scope: "forbidden", surface: "policy_outside_allowed_list", class: cls, paths: policyPaths, reason: `${cls} proposals carry a field patch` }
  const outside = policyPaths.filter((p) => !s.fields.includes(p.slice(row.subject_key.length + 1)))
  if (outside.length || policyPaths.length === 0) return { scope: "forbidden", surface: "policy_outside_allowed_list", class: cls, paths: policyPaths, reason: `${outside.join(", ") || "nothing"} is outside ${cls}'s allowed fields (${s.fields.join(", ")})` }
  return { scope: "optimizable", class: cls, paths: policyPaths }
}

// ── TENANT POLICY (the autonomous list + the tuning the readers consume) ─────────────────────────────────────

export interface SelfOptimizationPolicy { autonomousClasses: OptimizationClass[]; readable: boolean }

/** PURE — `self_optimization` { autonomous_classes: [...] }. Absent / malformed → NONE (a human approves everything). */
export function resolveSelfOptimizationPolicy(settings: unknown): SelfOptimizationPolicy {
  const raw = isObj(settings) ? settings[SELF_OPTIMIZATION_POLICY_KEY] : null
  const list = isObj(raw) && Array.isArray(raw.autonomous_classes) ? raw.autonomous_classes : []
  return { autonomousClasses: [...new Set(list.filter(isOptimizationClass))], readable: true }
}

export interface OptimizationTuning {
  experienceBias: { education?: number; properties?: number }
  providerSkip: { property_valuation?: string[] }
  /** Wave 137E: transaction-deadline reminder lead hours (absent = the watcher's default). */
  deadlineReminderHours?: number
}

const clampBias = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.max(-EXPERIENCE_BIAS_LIMIT, Math.min(EXPERIENCE_BIAS_LIMIT, Math.round(n))) : undefined)

/** PURE — `optimization_tuning` as the readers consume it (malformed → empty: nothing tuned). */
export function resolveOptimizationTuning(settings: unknown): OptimizationTuning {
  const raw = isObj(settings) ? settings[OPTIMIZATION_TUNING_POLICY_KEY] : null
  const t = isObj(raw) ? raw : {}
  const eb = isObj(t.experience_bias) ? t.experience_bias : {}
  const ps = isObj(t.provider_skip) ? t.provider_skip : {}
  const experienceBias: OptimizationTuning["experienceBias"] = {}
  const e = clampBias(eb.education); if (e !== undefined && e !== 0) experienceBias.education = e
  const p = clampBias(eb.properties); if (p !== undefined && p !== 0) experienceBias.properties = p
  const providerSkip: OptimizationTuning["providerSkip"] = {}
  if (Array.isArray(ps.property_valuation)) providerSkip.property_valuation = ps.property_valuation.map(String).filter((x) => /^[a-z0-9_]{1,40}$/.test(x))
  const out: OptimizationTuning = { experienceBias, providerSkip }
  const dh = clampReminderHours(t.deadline_reminder_hours)
  if (dh !== undefined) out.deadlineReminderHours = dh
  return out
}

/** PURE — a stored reminder lead time, clamped to [MIN, MAX] whole hours (malformed → undefined = default). */
function clampReminderHours(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(DEADLINE_REMINDER_MIN_HOURS, Math.min(DEADLINE_REMINDER_MAX_HOURS, Math.round(n))) : undefined
}

/** The deadline watcher's one read — each tenant's reminder lead hours (one query for the batch). A refused
 *  read keeps EVERY tenant on the default (the historic behaviour), never a widened window. */
export async function loadDeadlineReminderHours(svc: Svc, brokerageIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const ids = [...new Set(brokerageIds.filter(Boolean))]
  if (ids.length === 0) return out
  const { data, error } = await svc.from("brokerage_settings").select("brokerage_id, settings").in("brokerage_id", ids)
  if (error) { console.error(`[self-optimization] deadline reminder tuning unreadable — default ${DEADLINE_REMINDER_DEFAULT_HOURS}h for all: ${error.message}`); return out }
  for (const r of (data ?? []) as Array<{ brokerage_id: string; settings: unknown }>) {
    const h = resolveOptimizationTuning(r.settings).deadlineReminderHours
    if (h !== undefined) out.set(r.brokerage_id, h)
  }
  return out
}

/** The tenant's settings object (one read; tenant-scoped). A refused read is reported, never "nothing set". */
export async function readTenantSettings(svc: Svc, brokerageId: string): Promise<{ ok: true; settings: Record<string, unknown> } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no brokerage" }
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `brokerage_settings read refused: ${error.message}` }
  const s = (data as { settings?: unknown } | null)?.settings
  return { ok: true, settings: isObj(s) ? s : {} }
}

/** FAIL CLOSED: an unreadable policy grants NO autonomous class. */
export async function loadSelfOptimizationPolicy(svc: Svc, brokerageId: string): Promise<SelfOptimizationPolicy> {
  const r = await readTenantSettings(svc, brokerageId)
  return r.ok ? resolveSelfOptimizationPolicy(r.settings) : { autonomousClasses: [], readable: false }
}

/** The provider-chain reader's one call — tenant skips for a capability; an unreadable policy skips nothing. */
export async function loadTenantProviderSkips(brokerageId: string, client?: Svc): Promise<string[]> {
  try {
    const svc = client ?? (await import("@/lib/supabase/service")).createServiceClient()
    const r = await readTenantSettings(svc, brokerageId)
    return r.ok ? resolveOptimizationTuning(r.settings).providerSkip.property_valuation ?? [] : []
  } catch { return [] }
}

// ── DETERMINISTIC EVALUATORS for the classes no survivor evaluator covered (no model ever scores) ────────────

export const OPTIMIZATION_MIN_SAMPLE = 20
/** A call whose declared expected value is at least this is never moved to the cheaper model by an optimization. */
export const HIGH_VALUE_USD = 500

export interface ReasoningBooking { expectedValueUsd: number; routedCostUsd: number; cheaperCostUsd: number; decision: string }

/** PURE — replay the recorded reasoning-spend decisions under the proposed ratio. */
export function replayReasoningSpend(bookings: readonly ReasoningBooking[], currentRatio: number, proposedRatio: number) {
  let flips = 0, toCheaper = 0, toExpensive = 0, highValueDowngrades = 0, savedUsd = 0, addedUsd = 0
  for (const b of bookings) {
    if (!(b.routedCostUsd > 0)) continue
    const ratio = b.expectedValueUsd / b.routedCostUsd
    const before = ratio >= currentRatio, after = ratio >= proposedRatio
    if (before === after) continue
    flips++
    const delta = Math.max(0, b.routedCostUsd - b.cheaperCostUsd)
    if (before && !after) { toCheaper++; savedUsd += delta; if (b.expectedValueUsd >= HIGH_VALUE_USD) highValueDowngrades++ }
    else { toExpensive++; addedUsd += delta }
  }
  return { replayed: bookings.length, flips, toCheaper, toExpensive, highValueDowngrades, savedUsd: Math.round(savedUsd * 10000) / 10000, addedUsd: Math.round(addedUsd * 10000) / 10000 }
}

/** PURE — the candidate ratio from the bookings (null = no change argued). */
function modelRoutingCandidate(bookings: readonly ReasoningBooking[], currentRatio: number): number | null {
  if (bookings.length < OPTIMIZATION_MIN_SAMPLE) return null
  const ratioOf = (b: ReasoningBooking) => (b.routedCostUsd > 0 ? b.expectedValueUsd / b.routedCostUsd : Infinity)
  const starved = bookings.filter((b) => b.expectedValueUsd >= HIGH_VALUE_USD && ratioOf(b) < currentRatio)
  if (starved.length > 0) return Math.max(1, Math.floor(Math.min(...starved.map(ratioOf))))
  const marginal = bookings.filter((b) => b.expectedValueUsd < HIGH_VALUE_USD && ratioOf(b) >= currentRatio && ratioOf(b) < currentRatio * 1.5)
  return marginal.length >= 5 ? Math.round(currentRatio * 1.5) : null
}

export interface ExperienceStats { actions: Record<string, number>; outcomes: Record<string, number> }

/** PURE — the bias direction the attributed outcomes argue for `kind` (+1 / −1 / 0), or null when the sample is short. */
export function experienceDirection(kind: "education" | "properties", s: ExperienceStats): { direction: -1 | 0 | 1; rate: number; restRate: number } | null {
  const a = s.actions[kind] ?? 0
  const restA = Object.entries(s.actions).filter(([k]) => k !== kind).reduce((t, [, n]) => t + n, 0)
  if (a < OPTIMIZATION_MIN_SAMPLE || restA < OPTIMIZATION_MIN_SAMPLE) return null
  const rate = (s.outcomes[kind] ?? 0) / a
  const restRate = Object.entries(s.outcomes).filter(([k]) => k !== kind).reduce((t, [, n]) => t + n, 0) / restA
  const direction = restRate > 0 ? (rate >= restRate * 1.5 ? 1 : rate <= restRate * 0.5 ? -1 : 0) : rate > 0 ? 1 : 0
  return { direction, rate: Math.round(rate * 1000) / 1000, restRate: Math.round(restRate * 1000) / 1000 }
}

interface DeadlineOutcomeStats { resolved: number; missed: number }

/** PURE — does the deadline record support moving the reminder lead time from `current` to `proposed` hours? */
function deadlineReminderVerdict(current: number, proposed: number, s: DeadlineOutcomeStats): { verdict: "pass" | "fail" | "inconclusive"; why: string } {
  if (!Number.isFinite(proposed) || proposed < DEADLINE_REMINDER_MIN_HOURS || proposed > DEADLINE_REMINDER_MAX_HOURS || proposed % 1 !== 0) return { verdict: "fail", why: `the reminder lead must be whole hours in [${DEADLINE_REMINDER_MIN_HOURS}, ${DEADLINE_REMINDER_MAX_HOURS}]` }
  if (proposed === current) return { verdict: "fail", why: "the proposed reminder lead changes nothing" }
  if (s.resolved < OPTIMIZATION_MIN_SAMPLE) return { verdict: "inconclusive", why: `${s.resolved} resolved transaction deadlines in the window (< ${OPTIMIZATION_MIN_SAMPLE}) — a human decides` }
  const rate = s.missed / s.resolved
  const pctTxt = `${Math.round(rate * 1000) / 10}% of ${s.resolved} resolved deadlines were missed`
  if (proposed > current) return rate >= DEADLINE_MISSED_RATE_EARLIER ? { verdict: "pass", why: `${pctTxt} — remind earlier (${current}h → ${proposed}h)` } : { verdict: "fail", why: `${pctTxt} — the record does not argue for earlier reminders` }
  return s.missed === 0 ? { verdict: "pass", why: `${pctTxt} — none missed, the reminder can come later (${current}h → ${proposed}h)` } : { verdict: "fail", why: `${pctTxt} — never remind later while deadlines are being missed` }
}

/** PURE — the candidate lead time the record argues for (null = no change). */
function deadlineReminderCandidate(current: number, s: DeadlineOutcomeStats): number | null {
  if (s.resolved < OPTIMIZATION_MIN_SAMPLE) return null
  const rate = s.missed / s.resolved
  if (rate >= DEADLINE_MISSED_RATE_EARLIER && current < DEADLINE_REMINDER_MAX_HOURS) return Math.min(DEADLINE_REMINDER_MAX_HOURS, current + DEADLINE_REMINDER_STEP_HOURS)
  if (s.missed === 0 && current > DEADLINE_REMINDER_MIN_HOURS) return Math.max(DEADLINE_REMINDER_MIN_HOURS, current - DEADLINE_REMINDER_STEP_HOURS)
  return null
}

export interface ProviderStat { calls: number; errors: number }

/** PURE — may this tenant skip `provider` on the valuation route? Never the primary (the route order is an owner ruling: RentCast first). */
export function providerSkipVerdict(provider: string, route: readonly string[], stat: ProviderStat, skipping: boolean): { verdict: "pass" | "fail" | "inconclusive"; why: string } {
  if (!route.includes(provider)) return { verdict: "fail", why: `${provider} is not on the valuation route (${route.join(" → ")})` }
  if (route[0] === provider) return { verdict: "fail", why: `${provider} is the route's owner-ruled primary — never skipped` }
  if (stat.calls < OPTIMIZATION_MIN_SAMPLE) return { verdict: "inconclusive", why: `${stat.calls} gateway calls to ${provider} in the window (< ${OPTIMIZATION_MIN_SAMPLE}) — a human decides` }
  const rate = stat.errors / stat.calls
  if (skipping) return rate >= 0.5 ? { verdict: "pass", why: `${provider} failed ${Math.round(rate * 100)}% of ${stat.calls} gateway calls in 30 days — skip it` } : { verdict: "fail", why: `${provider} fails only ${Math.round(rate * 100)}% — no skip` }
  return rate < 0.2 ? { verdict: "pass", why: `${provider} recovered (${Math.round(rate * 100)}% of ${stat.calls}) — un-skip` } : { verdict: "fail", why: `${provider} still fails ${Math.round(rate * 100)}% — keep skipping` }
}

// ── EVIDENCE READERS (tenant-scoped; every refusal is reported) ─────────────────────────────────────────────

async function readReasoningBookings(svc: Svc, brokerageId: string, sinceIso: string): Promise<{ ok: true; rows: ReasoningBooking[] } | { ok: false; error: string }> {
  const { data, error } = await svc.from("ai_tool_usage").select("context_json, created_at").eq("brokerage_id", brokerageId).gte("created_at", sinceIso).limit(2000)
  if (error) return { ok: false, error: `ai_tool_usage read refused: ${error.message}` }
  const rows: ReasoningBooking[] = []
  for (const r of (data ?? []) as Array<{ context_json?: unknown }>) {
    const b = isObj(r.context_json) && isObj(r.context_json.reasoning_spend) ? r.context_json.reasoning_spend : null
    if (!b) continue
    const ev = Number(b.expected_value_usd), rc = Number(b.routed_cost_usd), cc = Number(b.cheaper_cost_usd)
    if (Number.isFinite(ev) && Number.isFinite(rc) && rc > 0) rows.push({ expectedValueUsd: ev, routedCostUsd: rc, cheaperCostUsd: Number.isFinite(cc) ? cc : rc, decision: String(b.decision ?? "") })
  }
  return { ok: true, rows }
}

/** The provider's chronic reliability (30 days) from the connector gateway's PROVIDER-scoped ledger (rows with no
 *  tenant — lib/agentic-os/connector-gateway.ts logApiResponse writes brokerage_id NULL on purpose). No tenant's
 *  private rows are read; the route-around cool-down (acute outages) stays routeCapability's job. */
async function readProviderStat(svc: Svc, provider: string, sinceIso: string): Promise<{ ok: true; stat: ProviderStat } | { ok: false; error: string }> {
  const { data, error } = await svc.from("api_response_logs").select("is_error, recorded_at").is("brokerage_id", null).eq("service_key", provider).gte("recorded_at", sinceIso).limit(2000)
  if (error) return { ok: false, error: `api_response_logs read refused: ${error.message}` }
  const rows = (data ?? []) as Array<{ is_error?: boolean | null }>
  return { ok: true, stat: { calls: rows.length, errors: rows.filter((r) => r.is_error === true).length } }
}

/** Experience actions (ledger detail.experience) + their attributed outcomes (the ROI ledger's byExperience). */
async function readExperienceStats(svc: Svc, brokerageId: string, sinceIso: string): Promise<{ ok: true; stats: ExperienceStats } | { ok: false; error: string }> {
  const { data, error } = await svc.from("agent_action_ledger").select("id, detail, created_at").eq("brokerage_id", brokerageId).gte("created_at", sinceIso).limit(5000)
  if (error) return { ok: false, error: `agent_action_ledger read refused: ${error.message}` }
  const { isExperienceKind } = await import("@/lib/ai-isa/lead-action-plan")
  const actions: Record<string, number> = {}
  for (const r of (data ?? []) as Array<{ detail?: unknown }>) {
    const k = isObj(r.detail) ? r.detail.experience : null
    if (isExperienceKind(k)) actions[k] = (actions[k] ?? 0) + 1
  }
  const { loadLedgerAttribution } = await import("@/lib/intelligence/roi-ledger")
  const att = await loadLedgerAttribution(svc, brokerageId, { sinceIso })
  if (!att.ok) return { ok: false, error: `ledger attribution refused: ${att.error}` }
  const outcomes: Record<string, number> = {}
  for (const row of att.result.byExperience) outcomes[row.key] = Object.values(row.lastTouchOutcomes ?? {}).reduce((t, n) => t + Number(n ?? 0), 0)
  return { ok: true, stats: { actions, outcomes } }
}

/** Resolved transaction deadlines (missed vs completed / waived / extended) in the window — tenant-pinned. */
async function readDeadlineOutcomes(svc: Svc, brokerageId: string, sinceIso: string): Promise<{ ok: true; stats: DeadlineOutcomeStats } | { ok: false; error: string }> {
  const { data: deadlineData, error } = await svc.from("transaction_deadlines").select("status, deadline_date").eq("brokerage_id", brokerageId).gte("deadline_date", sinceIso.slice(0, 10)).in("status", ["missed", "completed", "waived", "extended"]).limit(5000)
  if (error) return { ok: false, error: `transaction_deadlines read refused: ${error.message}` }
  const deadlineRows = (deadlineData ?? []) as Array<{ status: string | null }>
  return { ok: true, stats: { resolved: deadlineRows.length, missed: deadlineRows.filter((deadlineRow) => deadlineRow.status === "missed").length } }
}

const WINDOW_DAYS = 90
const sinceOf = (now: Date, days = WINDOW_DAYS) => new Date(now.getTime() - days * 86_400_000).toISOString()

export interface OptimizationEvalDeps {
  now?: Date
  /** @proofSeam the proof injects attributed experience stats (the live path reads the ROI ledger). */
  experienceStats?: ExperienceStats
}

/**
 * Score an OPTIMIZATION proposal of a class whose evaluator lives here (model routing, education / property
 * experience bias, provider selection) — deterministic re-measurement over this tenant's own records; the stored
 * numbers are never trusted. Called by improvement-proposals.ts evaluateImprovement.
 */
export async function evaluateOptimizationClass(
  svc: Svc,
  row: Pick<ImprovementProposalRow, "brokerage_id" | "subject_kind" | "subject_key" | "proposed_change">,
  cls: OptimizationClass,
  deps: OptimizationEvalDeps = {},
): Promise<ProposalEvaluation> {
  const now = deps.now ?? new Date()
  const change = row.proposed_change ?? {}
  const patch = isObj(change.patch) ? change.patch : {}
  const previous = isObj(change.previous) ? change.previous : {}
  const def = OPTIMIZATION_CLASS_DEFS[cls]
  switch (def.evaluator) {
    case "reasoning_spend_replay": {
      const proposed = Number(patch.ai_min_value_to_cost_ratio)
      const current = Number(previous.ai_min_value_to_cost_ratio ?? 20)
      if (!(proposed > 0)) return { evaluator: "reasoning_spend_replay", verdict: "fail", score: null, why: "no positive ai_min_value_to_cost_ratio proposed", detail: {} }
      const b = await readReasoningBookings(svc, row.brokerage_id, sinceOf(now))
      if (!b.ok) return { evaluator: "reasoning_spend_replay", verdict: "inconclusive", score: null, why: b.error, detail: {} }
      const r = replayReasoningSpend(b.rows, current, proposed)
      if (r.replayed < OPTIMIZATION_MIN_SAMPLE) return { evaluator: "reasoning_spend_replay", verdict: "inconclusive", score: null, why: `${r.replayed} booked reasoning decisions (< ${OPTIMIZATION_MIN_SAMPLE}) — a human decides`, detail: r }
      if (r.highValueDowngrades > 0) return { evaluator: "reasoning_spend_replay", verdict: "fail", score: r.savedUsd, why: `would move ${r.highValueDowngrades} call(s) worth ≥ $${HIGH_VALUE_USD} to the cheaper model — refused`, detail: r }
      if (r.flips === 0) return { evaluator: "reasoning_spend_replay", verdict: "inconclusive", score: 0, why: "the proposed ratio changes no recorded decision", detail: r }
      return { evaluator: "reasoning_spend_replay", verdict: "pass", score: r.savedUsd - r.addedUsd, why: `replayed ${r.replayed}: ${r.toCheaper} to the cheaper model (saves $${r.savedUsd}), ${r.toExpensive} to the stronger (adds $${r.addedUsd}); no high-value call downgraded`, detail: r }
    }
    case "experience_attribution": {
      const kind = cls === "education_intervention" ? "education" : "properties"
      const eb = isObj(patch.experience_bias) ? patch.experience_bias : {}
      const prevEb = isObj(previous.experience_bias) ? previous.experience_bias : {}
      const delta = Number(eb[kind] ?? 0) - Number(prevEb[kind] ?? 0)
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(Number(eb[kind])) > EXPERIENCE_BIAS_LIMIT) return { evaluator: "experience_attribution", verdict: "fail", score: null, why: `the ${kind} bias must move within ±${EXPERIENCE_BIAS_LIMIT}`, detail: { proposed: eb[kind] ?? null } }
      let stats = deps.experienceStats
      if (!stats) {
        const s = await readExperienceStats(svc, row.brokerage_id, sinceOf(now))
        if (!s.ok) return { evaluator: "experience_attribution", verdict: "inconclusive", score: null, why: s.error, detail: {} }
        stats = s.stats
      }
      const d = experienceDirection(kind, stats)
      if (!d) return { evaluator: "experience_attribution", verdict: "inconclusive", score: null, why: `fewer than ${OPTIMIZATION_MIN_SAMPLE} ${kind} / other experiences on the ledger — a human decides`, detail: { stats } }
      const want = Math.sign(delta)
      if (d.direction === want) return { evaluator: "experience_attribution", verdict: "pass", score: d.rate, why: `re-measured: ${kind} converts ${d.rate} vs ${d.restRate} for the other experiences — the bias moves the right way`, detail: { ...d, stats } }
      return { evaluator: "experience_attribution", verdict: d.direction === 0 ? "inconclusive" : "fail", score: d.rate, why: `re-measured: ${kind} converts ${d.rate} vs ${d.restRate} — the evidence does not support moving the bias ${want > 0 ? "up" : "down"}`, detail: { ...d, stats } }
    }
    case "provider_reliability": {
      const { CONTACT_PROVIDER_ROUTES } = await import("@/lib/ai-isa/property-lookup-rail")
      const route = (CONTACT_PROVIDER_ROUTES.property_valuation ?? []).map((e: { provider: string }) => e.provider)
      const ps = isObj(patch.provider_skip) ? patch.provider_skip : {}
      const next = Array.isArray(ps.property_valuation) ? ps.property_valuation.map(String) : []
      const prevPs = isObj(previous.provider_skip) ? previous.provider_skip : {}
      const prev = Array.isArray(prevPs.property_valuation) ? prevPs.property_valuation.map(String) : []
      const added = next.filter((p) => !prev.includes(p)), removed = prev.filter((p) => !next.includes(p))
      if (added.length + removed.length === 0) return { evaluator: "provider_reliability", verdict: "fail", score: null, why: "the proposed skip list changes nothing", detail: {} }
      const verdicts: Array<{ provider: string; verdict: string; why: string }> = []
      for (const [provider, skipping] of [...added.map((p) => [p, true] as const), ...removed.map((p) => [p, false] as const)]) {
        const s = await readProviderStat(svc, provider, sinceOf(now, 30))
        if (!s.ok) return { evaluator: "provider_reliability", verdict: "inconclusive", score: null, why: s.error, detail: {} }
        verdicts.push({ provider, ...providerSkipVerdict(provider, route, s.stat, skipping) })
      }
      const worst = verdicts.find((v) => v.verdict === "fail") ?? verdicts.find((v) => v.verdict === "inconclusive")
      return { evaluator: "provider_reliability", verdict: (worst?.verdict ?? "pass") as "pass" | "fail" | "inconclusive", score: null, why: verdicts.map((v) => v.why).join("; "), detail: { route, verdicts } }
    }
    case "deadline_outcomes": {
      const proposed = Number(patch.deadline_reminder_hours)
      const current = Number(previous.deadline_reminder_hours ?? DEADLINE_REMINDER_DEFAULT_HOURS)
      const d = await readDeadlineOutcomes(svc, row.brokerage_id, sinceOf(now, 180))
      if (!d.ok) return { evaluator: "deadline_outcomes", verdict: "inconclusive", score: null, why: d.error, detail: {} }
      const v = deadlineReminderVerdict(current, proposed, d.stats)
      return { evaluator: "deadline_outcomes", verdict: v.verdict, score: d.stats.resolved ? Math.round((d.stats.missed / d.stats.resolved) * 1000) / 1000 : null, why: `re-measured: ${v.why}`, detail: { ...d.stats, current, proposed } }
    }
    default:
      return { evaluator: "none", verdict: "inconclusive", score: null, why: `${cls} is evaluated by ${def.evaluator} in improvement-proposals.ts`, detail: {} }
  }
}

// ── THE TEAM OPTIMIZATION CYCLE (weekly cron: app/api/cron/team-optimization) ───────────────────────────────

export interface ManagerEvidence { manager: ManagerKey; role: "owner" | "co_proposer"; domain: string | null; summary: string; refs: unknown[] }

export interface CycleClassResult {
  class: OptimizationClass
  outcome: "proposed" | "adopted" | "no_candidate" | "held" | "promoted" | "rejected" | "refused" | "error"
  proposalId: string | null
  managers: ManagerKey[]
  detail: string
}

export interface TeamOptimizationCycleResult {
  brokerageId: string
  cycleId: string
  autonomousClasses: OptimizationClass[]
  classes: CycleClassResult[]
  proposed: number
  adopted: number
  promoted: number
  held: number
  errors: string[]
}

export interface TeamCycleDeps extends OptimizationEvalDeps {
  /** @proofSeam the proof injects each owner's gate; live = the manager's autonomy posture + authority rung. */
  gateFor?: (managerKey: ManagerKey) => Promise<PromotionGate>
  /** @proofSeam the proof injects the decision replay (the live path replays recorded decisions). */
  replay?: typeof import("@/lib/kernel/decision-replay").replayDecisions
  /** @proofSeam current brokerage-tier ISA timing (live = resolveLeadSettingsResolution). */
  isaTiming?: () => Promise<{ touch_interval_days: number | null; max_touches_lead: number | null } | null>
}

async function liveGate(brokerageId: string, managerKey: ManagerKey, svc: Svc): Promise<PromotionGate> {
  try {
    const { resolveManagerAutonomy, resolveAgentAuthorityLevel, autonomyDecision } = await import("@/lib/managers/autonomy-gate")
    const [posture, authority] = await Promise.all([resolveManagerAutonomy(brokerageId, managerKey, svc as any), resolveAgentAuthorityLevel(brokerageId, managerKey, svc as any)])
    return { actorAuthority: authority, autonomy: autonomyDecision({ managerKey, effective: posture, authorityLevel: authority }) }
  } catch {
    return { actorAuthority: null, autonomy: { allow: false, held: true, posture: "approval_required", reason: "autonomy gate could not be read — promotion held (fail closed)" } }
  }
}

/** PURE — the co-proposal record every team proposal carries (owner first, then each declared co-proposer). */
function coProposalBlock(cls: OptimizationClass, cycleId: string, evidence: readonly ManagerEvidence[]): OptimizationBlock {
  const def = OPTIMIZATION_CLASS_DEFS[cls]
  return {
    class: cls, cycle_id: cycleId, owner: def.owner,
    co_proposers: def.coProposers.map((c) => ({ manager: c.manager, domain: c.domain })),
    managers: [def.owner, ...def.coProposers.map((c) => c.manager)],
    evidence_by_manager: Object.fromEntries(evidence.map((e) => [e.manager, e.summary])),
  }
}

/**
 * ONE tenant's weekly cycle. For every class: each participating manager contributes its evidence; the team
 * co-proposes ONE change (or adopts a learner's open proposal of that class); the kernel evaluates it by replay /
 * re-measurement; it promotes ONLY when the class is on the tenant's autonomous list AND the owner's gate allows —
 * otherwise it waits EVALUATED for a human on the Manager Trust page. Never throws.
 */
export async function runTeamOptimizationCycle(svc: Svc, brokerageId: string, deps: TeamCycleDeps = {}): Promise<TeamOptimizationCycleResult> {
  const now = deps.now ?? new Date()
  const cycleId = `${now.toISOString().slice(0, 10)}`
  const out: TeamOptimizationCycleResult = { brokerageId, cycleId, autonomousClasses: [], classes: [], proposed: 0, adopted: 0, promoted: 0, held: 0, errors: [] }
  if (!brokerageId) { out.errors.push("no brokerage"); return out }
  const kernel = await import("@/lib/kernel/improvement-proposals")
  const st = await readTenantSettings(svc, brokerageId)
  if (!st.ok) { out.errors.push(st.error); return out }
  out.autonomousClasses = resolveSelfOptimizationPolicy(st.settings).autonomousClasses
  const tuning = isObj(st.settings[OPTIMIZATION_TUNING_POLICY_KEY]) ? (st.settings[OPTIMIZATION_TUNING_POLICY_KEY] as Record<string, unknown>) : {}
  const ra = isObj(st.settings.resource_allocation) ? (st.settings.resource_allocation as Record<string, unknown>) : {}
  const currentRatio = typeof ra.ai_min_value_to_cost_ratio === "number" ? ra.ai_min_value_to_cost_ratio : 20
  const since = sinceOf(now)

  const ev = (cls: OptimizationClass, ownerSummary: string, ownerRefs: unknown[], coSummaries: Partial<Record<ManagerKey, string>> = {}): ManagerEvidence[] => {
    const def = OPTIMIZATION_CLASS_DEFS[cls]
    return [
      { manager: def.owner, role: "owner", domain: null, summary: ownerSummary, refs: ownerRefs },
      ...def.coProposers.map((c) => ({ manager: c.manager, role: "co_proposer" as const, domain: c.domain, summary: coSummaries[c.manager] ?? `${c.manager} co-proposes on ${c.domain} — its stewarded evidence is the shared ledger read above`, refs: [{ kind: "collaboration_domain", key: c.domain }] })),
    ]
  }

  // After a proposal exists: evaluate, then promote only within class + authority + the tenant's autonomous list.
  const settle = async (cls: OptimizationClass, id: string, managers: ManagerKey[], base: CycleClassResult["outcome"]): Promise<CycleClassResult> => {
    const got = await kernel.loadProposal(svc, brokerageId, id)
    if (!got.ok) return { class: cls, outcome: "error", proposalId: id, managers, detail: got.error }
    let status = got.row.status
    if (status === "PROPOSED") {
      const e = await kernel.evaluateProposal(svc, { brokerageId, id }, { now, replay: deps.replay, experienceStats: deps.experienceStats })
      if (!e.ok) return { class: cls, outcome: "error", proposalId: id, managers, detail: e.error }
      status = e.status
      if (status === "REJECTED") return { class: cls, outcome: "rejected", proposalId: id, managers, detail: `evaluator ${e.evaluation.evaluator}: ${e.evaluation.why}` }
    }
    if (status !== "EVALUATED") return { class: cls, outcome: base, proposalId: id, managers, detail: `proposal ${status}` }
    if (!out.autonomousClasses.includes(cls)) { out.held++; return { class: cls, outcome: "held", proposalId: id, managers, detail: `${cls} is not on the tenant's autonomous list — a human decides on the Manager Trust page` } }
    const owner = OPTIMIZATION_CLASS_DEFS[cls].owner
    const gate = await (deps.gateFor ? deps.gateFor(owner) : liveGate(brokerageId, owner, svc))
    const actor = { type: "manager" as const, managerKey: owner, reason: `team optimization ${cycleId}: ${cls}` }
    const d = await kernel.decideProposal(svc, { brokerageId, id, decision: "approve", actor, gate })
    if (!d.ok) { out.held++; return { class: cls, outcome: "held", proposalId: id, managers, detail: d.error } }
    const p = await kernel.promoteProposal(svc, { brokerageId, id, actor, gate })
    if (!p.ok) { out.held++; return { class: cls, outcome: "held", proposalId: id, managers, detail: p.error } }
    out.promoted++
    return { class: cls, outcome: "promoted", proposalId: id, managers, detail: `promoted through ${p.writer}${p.policyVersionRef ? ` (${p.policyVersionRef})` : ""}` }
  }

  const propose = async (cls: OptimizationClass, subjectKey: string, change: Record<string, unknown>, evidence: ManagerEvidence[], summary: string): Promise<CycleClassResult> => {
    const block = coProposalBlock(cls, cycleId, evidence)
    const r = await kernel.proposeImprovement(svc, {
      brokerageId, subjectKind: "policy", subjectKey, proposer: TEAM_OPTIMIZATION_PROPOSER,
      proposedChange: { ...change, summary, optimization: block },
      evidenceRefs: evidence.map((e) => ({ kind: "manager_evidence", manager: e.manager, role: e.role, domain: e.domain, summary: e.summary, refs: e.refs })),
    })
    if (!r.ok) return { class: cls, outcome: /forbidden surface/.test(r.error) ? "refused" : "error", proposalId: null, managers: block.managers, detail: r.error }
    if (!r.existing) out.proposed++
    return settle(cls, r.id, block.managers, r.existing ? "held" : "proposed")
  }

  for (const cls of OPTIMIZATION_CLASSES) {
    const def = OPTIMIZATION_CLASS_DEFS[cls]
    const managers = [def.owner, ...def.coProposers.map((c) => c.manager)]
    try {
      if (def.surface.subjectKind === "variant") {
        // ADOPT the learners' open proposals of this class (copy-learning / media intelligence) — the team
        // co-signs them instead of proposing a duplicate (the learner stays the survivor of the evidence).
        const prefix = def.surface.subjectPrefix
        const list = await kernel.listImprovementProposals(svc, brokerageId, { limit: 200 })
        if (!list.ok) { out.errors.push(`${cls}: ${list.error}`); out.classes.push({ class: cls, outcome: "error", proposalId: null, managers, detail: list.error }); continue }
        const open = list.rows.filter((p) => p.subject_kind === "variant" && p.subject_key.startsWith(prefix) && (kernel.OPEN_STATUSES as readonly string[]).includes(p.status)).slice(0, 10)
        if (open.length === 0) { out.classes.push({ class: cls, outcome: "no_candidate", proposalId: null, managers, detail: `no open ${prefix}* proposal from the learner this week` }); continue }
        for (const p of open) {
          if (!optimizationBlockOf(p.proposed_change)) {
            const evidence = ev(cls, `${p.proposer} proposed '${String(p.proposed_change?.winner ?? "?")}' for ${p.subject_key}`, [{ kind: "improvement_proposal", id: p.id }])
            const block = coProposalBlock(cls, cycleId, evidence)
            const { data, error } = await svc.from("improvement_proposals")
              .update({ proposed_change: { ...(p.proposed_change ?? {}), optimization: block }, evidence_refs: [...(Array.isArray(p.evidence_refs) ? p.evidence_refs : []), ...evidence.map((e) => ({ kind: "manager_evidence", manager: e.manager, role: e.role, domain: e.domain, summary: e.summary }))], updated_at: now.toISOString() })
              .eq("brokerage_id", brokerageId).eq("id", p.id).select("id")
            if (error || (data ?? []).length !== 1) { out.errors.push(`${cls}: co-proposal not recorded on ${p.id} (${error?.message ?? "no row matched"})`); continue }
            out.adopted++
          }
          out.classes.push(await settle(cls, p.id, managers, "adopted"))
        }
        continue
      }
      if (cls === "followup_timing") {
        const isa = deps.isaTiming ? await deps.isaTiming() : await (async () => {
          const { resolveLeadSettingsResolution } = await import("@/lib/ai-isa/lead-action-plan")
          const r = await resolveLeadSettingsResolution({ brokerageId })
          return r.status === "unreadable" ? null : { touch_interval_days: r.settings.touch_interval_days ?? null, max_touches_lead: r.settings.max_touches_lead ?? null }
        })()
        if (!isa) { out.classes.push({ class: cls, outcome: "error", proposalId: null, managers, detail: "ISA settings unreadable — no timing proposal" }); continue }
        const { data: fa, error: faErr } = await svc.from("fatigue_alerts").select("id, created_at").eq("brokerage_id", brokerageId).gte("created_at", sinceOf(now, 30)).limit(500)
        if (faErr) { out.classes.push({ class: cls, outcome: "error", proposalId: null, managers, detail: `fatigue_alerts read refused: ${faErr.message}` }); continue }
        const alerts = (fa ?? []).length
        const cur = isa.touch_interval_days ?? 3
        if (alerts < 5 || cur >= 14) { out.classes.push({ class: cls, outcome: "no_candidate", proposalId: null, managers, detail: `${alerts} fatigue alert(s) in 30d at a ${cur}-day interval — no timing change argued` }); continue }
        const evidence = ev(cls, `touch interval ${cur}d (ISA settings)`, [{ kind: "ai_isa_settings", touch_interval_days: cur }], { campaign_orchestrator: `${alerts} contact fatigue alerts in 30 days (fatigue_alerts) — the sequences touch too often` })
        out.classes.push(await propose(cls, "ai_isa_settings", { touch_interval_days: cur + 1, previous: { touch_interval_days: isa.touch_interval_days } }, evidence, `slow the ISA touch interval ${cur}d → ${cur + 1}d (fatigue)`))
        continue
      }
      if (cls === "model_routing") {
        const b = await readReasoningBookings(svc, brokerageId, since)
        if (!b.ok) { out.classes.push({ class: cls, outcome: "error", proposalId: null, managers, detail: b.error }); continue }
        const next = modelRoutingCandidate(b.rows, currentRatio)
        if (next === null || next === currentRatio) { out.classes.push({ class: cls, outcome: "no_candidate", proposalId: null, managers, detail: `${b.rows.length} booked reasoning decisions — no ratio change argued` }); continue }
        const evidence = ev(cls, `${b.rows.length} reasoning-spend decisions at ratio ${currentRatio}×`, [{ kind: "ai_tool_usage.reasoning_spend", n: b.rows.length }], { finance_manager: "the AI spend ledger (ai_tool_usage cost) the change is replayed against" })
        out.classes.push(await propose(cls, "resource_allocation", { patch: { ai_min_value_to_cost_ratio: next }, previous: { ai_min_value_to_cost_ratio: currentRatio } }, evidence, `expensive reasoning at ≥ ${next}× value/cost (was ${currentRatio}×)`))
        continue
      }
      if (cls === "education_intervention" || cls === "property_recommendation") {
        const kind = cls === "education_intervention" ? "education" : "properties"
        let stats = deps.experienceStats
        if (!stats) { const s = await readExperienceStats(svc, brokerageId, since); if (!s.ok) { out.classes.push({ class: cls, outcome: "error", proposalId: null, managers, detail: s.error }); continue } stats = s.stats }
        const d = experienceDirection(kind, stats)
        const prevEb = isObj(tuning.experience_bias) ? tuning.experience_bias : {}
        const cur = clampBias(prevEb[kind]) ?? 0
        const nextBias = d ? Math.max(-EXPERIENCE_BIAS_LIMIT, Math.min(EXPERIENCE_BIAS_LIMIT, cur + d.direction * EXPERIENCE_BIAS_STEP)) : cur
        if (!d || d.direction === 0 || nextBias === cur) { out.classes.push({ class: cls, outcome: "no_candidate", proposalId: null, managers, detail: d ? `${kind} converts ${d.rate} vs ${d.restRate} — no bias change argued` : `short sample for ${kind}` }); continue }
        const evidence = ev(cls, `${kind}: ${stats.actions[kind] ?? 0} experiences, ${stats.outcomes[kind] ?? 0} attributed outcomes (rate ${d.rate} vs ${d.restRate})`, [{ kind: "roi_ledger.byExperience", experience: kind }])
        out.classes.push(await propose(cls, OPTIMIZATION_TUNING_POLICY_KEY, { patch: { experience_bias: { [kind]: nextBias } }, previous: { experience_bias: { [kind]: cur } } }, evidence, `${kind} experience bias ${cur} → ${nextBias}`))
        continue
      }
      if (cls === "transaction_reminder_timing") {
        const cur = clampReminderHours(tuning.deadline_reminder_hours) ?? DEADLINE_REMINDER_DEFAULT_HOURS
        const d = await readDeadlineOutcomes(svc, brokerageId, sinceOf(now, 180))
        if (!d.ok) { out.classes.push({ class: cls, outcome: "error", proposalId: null, managers, detail: d.error }); continue }
        const next = deadlineReminderCandidate(cur, d.stats)
        if (next === null) { out.classes.push({ class: cls, outcome: "no_candidate", proposalId: null, managers, detail: `${d.stats.missed} of ${d.stats.resolved} resolved transaction deadlines missed (180d) at a ${cur}h reminder — no timing change argued` }); continue }
        const evidence = ev(cls, `${d.stats.missed} of ${d.stats.resolved} resolved transaction deadlines missed in 180 days at a ${cur}h reminder lead`, [{ kind: "transaction_deadlines", ...d.stats }], { compliance_officer: "a missed contract deadline is closing risk (closing_money_and_risk) — reminder timing only, never the deadline itself" })
        out.classes.push(await propose(cls, OPTIMIZATION_TUNING_POLICY_KEY, { patch: { deadline_reminder_hours: next }, previous: { deadline_reminder_hours: cur } }, evidence, `transaction deadline reminders ${cur}h → ${next}h before the deadline`))
        continue
      }
      if (cls === "provider_selection") {
        const { CONTACT_PROVIDER_ROUTES } = await import("@/lib/ai-isa/property-lookup-rail")
        const route = (CONTACT_PROVIDER_ROUTES.property_valuation ?? []).map((e: { provider: string }) => e.provider)
        const ps = isObj(tuning.provider_skip) ? tuning.provider_skip : {}
        const cur = Array.isArray(ps.property_valuation) ? ps.property_valuation.map(String) : []
        const next = [...cur]
        const stats: Record<string, ProviderStat> = {}
        for (const provider of route.slice(1)) {
          const s = await readProviderStat(svc, provider, sinceOf(now, 30))
          if (!s.ok) { out.errors.push(`${cls}: ${s.error}`); continue }
          stats[provider] = s.stat
          const skipping = !cur.includes(provider)
          if (providerSkipVerdict(provider, route, s.stat, skipping).verdict === "pass") { if (skipping) next.push(provider); else next.splice(next.indexOf(provider), 1) }
        }
        if (JSON.stringify(next) === JSON.stringify(cur)) { out.classes.push({ class: cls, outcome: "no_candidate", proposalId: null, managers, detail: `valuation backups healthy for this tenant (${JSON.stringify(stats)})` }); continue }
        const evidence = ev(cls, `valuation backup calls by provider through the gateway (30d): ${JSON.stringify(stats)}`, [{ kind: "api_response_logs", stats }])
        out.classes.push(await propose(cls, OPTIMIZATION_TUNING_POLICY_KEY, { patch: { provider_skip: { property_valuation: next } }, previous: { provider_skip: { property_valuation: cur } } }, evidence, `valuation provider skip [${cur.join(", ")}] → [${next.join(", ")}]`))
        continue
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      out.errors.push(`${cls}: ${msg}`)
      out.classes.push({ class: cls, outcome: "error", proposalId: null, managers, detail: msg })
    }
  }
  return out
}
