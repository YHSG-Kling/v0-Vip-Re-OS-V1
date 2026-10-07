/**
 * lib/kernel/autonomy-budgets.ts — CONTROLLED AUTONOMOUS BUDGETING (wave 108, lane 108F; m731).
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner: "explicit envelopes: Ads may shift ≤10% of monthly budget between proven campaigns; provider
 * router ≤$X enrichment for high-value opportunities; Asset Manager ≤Y renders per campaign; Recruiting
 * ≤$Z approved prospect data; Finance watches all; no unlimited AI spend."
 *
 * SURVIVORS EVALUATED (none replaced — LAW 1/2):
 *   · tenant policy ........ lib/kernel/tenant-policy.ts (versioned keys). The envelopes are ONE more key,
 *                            `autonomy_budgets`, beside resource_allocation (106A) and procurement_autonomy
 *                            (107B) — written only through mergeBrokerageSettings / a `policy` proposal.
 *   · per-decision gates ... resource_allocation.enrichment_max_usd_per_decision (shouldPurchaseEnrichment),
 *                            procurement_autonomy.max_auto_approve_usd (procurementAutonomyDecision),
 *                            lib/ads/ad-manager.ts MAX_AD_DAILY_BUDGET_USD / clampDailyBudget — PER-ACTION
 *                            caps with no period total and nothing atomic: two concurrent decisions could
 *                            each pass. Kept; the envelope is the PERIOD total above them.
 *   · AI spend ............. mayUseAndAfford (ai_tokens budget half) + ai_tool_usage — the tier's token
 *                            limit is the AI ceiling; the report below watches it daily (no second meter).
 *   · vendor spend ......... lib/vendor-governance/budget-gate.ts checkVendorBudget — a tenant-wide vendor
 *                            budget, not per manager, not atomic. Kept beside.
 *   · live tables .......... tier_budgets / budgets / agent_credit_budgets (checked live 2026-10-07) are a
 *                            channel default, an agent's income plan and agent credits — none is a manager
 *                            envelope. NO envelope ledger existed → m731 builds autonomy_budget_consumptions
 *                            + consume_autonomy_budget (advisory-locked check-and-insert: ATOMIC).
 *
 * THE ONE ENFORCEMENT FUNCTION: consumeAutonomyEnvelope. Every autonomous spend calls it BEFORE spending:
 * it reads the tenant's envelope (unreadable = refuse, fail closed), refuses a zero envelope ("default all
 * zero = recommendation only"), consumes atomically through the RPC (over-cap = refused, never partial),
 * and leaves ONE FINANCIAL ledger row (withActionLedger autonomy.envelope.<envelope>, policy_ref
 * autonomy_budgets@<version>) whether it allowed or refused. The census (AUTONOMOUS_SPENDERS) names every
 * autonomous spender and the gate it routes through; scripts/autonomous-budgeting-guard.ts proves it.
 * Before m731 is applied the RPC is absent → every envelope REFUSES (degraded, said) — recommendation only.
 */

import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any }

export const AUTONOMY_BUDGETS_POLICY_KEY = "autonomy_budgets"

/** m731 CHECK autonomy_budget_consumptions_envelope_check mirrors this list (check-vocabulary-guard). */
export const AUTONOMY_ENVELOPES = ["ads_budget_shift", "provider_high_value", "asset_renders", "recruiting_prospect_data", "experiment_budget", "procurement_auto_book"] as const
export type AutonomyEnvelope = (typeof AUTONOMY_ENVELOPES)[number]

export const ENVELOPE_UNITS = ["usd", "renders"] as const
export type EnvelopeUnit = (typeof ENVELOPE_UNITS)[number]

export interface EnvelopeSpec {
  /** The manager accountable for spending inside it (MANAGERS key). */
  manager: ManagerKey
  unit: EnvelopeUnit
  /** month = resets each calendar month (UTC); lifetime = a per-scope total that never resets. */
  period: "month" | "lifetime"
  /** What the per-scope cap is keyed on (null = no per-scope cap). */
  scope: "campaign" | "decision" | null
  what: string
}

export const ENVELOPE_SPECS: Readonly<Record<AutonomyEnvelope, EnvelopeSpec>> = Object.freeze({
  ads_budget_shift: { manager: "ads_manager", unit: "usd", period: "month", scope: null, what: "daily budget shifted between PROVEN live campaigns (monthly-equivalent USD) — cap = pct × the live monthly budget" },
  provider_high_value: { manager: "data_steward", unit: "usd", period: "month", scope: "decision", what: "provider-router data spend ABOVE the base per-decision cap, only for HIGH-VALUE opportunities (value tier from lead score / twin)" },
  asset_renders: { manager: "asset_manager", unit: "renders", period: "lifetime", scope: "campaign", what: "variant renders the Asset Manager produces without a human, per campaign" },
  recruiting_prospect_data: { manager: "recruiting_manager", unit: "usd", period: "month", scope: null, what: "approved recruiting prospect data purchased per month" },
  experiment_budget: { manager: "campaign_orchestrator", unit: "usd", period: "month", scope: null, what: "budget an autonomously deployed experiment may commit per month" },
  procurement_auto_book: { manager: "listing_concierge", unit: "usd", period: "month", scope: null, what: "vendor purchases procurement_autonomy books with no human, per month (the per-purchase cap stays procurement_autonomy's)" },
})

export const VALUE_TIERS = ["standard", "high", "top"] as const
export type ValueTier = (typeof VALUE_TIERS)[number]

export interface AutonomyBudgetsPolicy {
  ads_manager: { max_shift_pct_of_monthly_budget: number }
  provider_router: { per_decision_max_usd: Record<ValueTier, number>; monthly_max_usd: number }
  asset_manager: { max_renders_per_campaign: number }
  recruiting_manager: { max_prospect_data_usd_per_month: number }
  experiments: { max_usd_per_month: number }
  listing_concierge: { max_auto_book_usd_per_month: number }
  /** What the finance report treats as an anomaly. */
  finance: { burst_share_of_cap: number; ai_spike_multiple: number; refusal_pressure: number }
  /** false = the policy read was refused → every envelope refuses (fail closed). */
  readable: boolean
  note?: string
}

/** DEFAULT ALL ZERO = recommendation only (owner, wave 108). */
export const DEFAULT_AUTONOMY_BUDGETS: Readonly<AutonomyBudgetsPolicy> = Object.freeze({
  ads_manager: { max_shift_pct_of_monthly_budget: 0 },
  provider_router: { per_decision_max_usd: { standard: 0, high: 0, top: 0 }, monthly_max_usd: 0 },
  asset_manager: { max_renders_per_campaign: 0 },
  recruiting_manager: { max_prospect_data_usd_per_month: 0 },
  experiments: { max_usd_per_month: 0 },
  listing_concierge: { max_auto_book_usd_per_month: 0 },
  finance: { burst_share_of_cap: 0.5, ai_spike_multiple: 3, refusal_pressure: 3 },
  readable: true,
})

const num = (v: unknown, max = Number.POSITIVE_INFINITY): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0
}

/** PURE — brokerage_settings.settings → the envelopes. Anything malformed is ZERO (never "unlimited").
 * @proofSeam scripts/autonomous-budgeting-guard.ts asserts the all-zero default and the clamping directly. */
export function resolveAutonomyBudgets(settings: unknown, note?: string): AutonomyBudgetsPolicy {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, any>)[AUTONOMY_BUDGETS_POLICY_KEY] : null
  const d = DEFAULT_AUTONOMY_BUDGETS
  if (!raw || typeof raw !== "object") return { ...structuredClone(d as AutonomyBudgetsPolicy), ...(note ? { note } : {}) }
  const pd = raw.provider_router?.per_decision_max_usd ?? {}
  return {
    ads_manager: { max_shift_pct_of_monthly_budget: num(raw.ads_manager?.max_shift_pct_of_monthly_budget, 100) },
    provider_router: { per_decision_max_usd: { standard: num(pd.standard), high: num(pd.high), top: num(pd.top) }, monthly_max_usd: num(raw.provider_router?.monthly_max_usd) },
    asset_manager: { max_renders_per_campaign: Math.floor(num(raw.asset_manager?.max_renders_per_campaign)) },
    recruiting_manager: { max_prospect_data_usd_per_month: num(raw.recruiting_manager?.max_prospect_data_usd_per_month) },
    experiments: { max_usd_per_month: num(raw.experiments?.max_usd_per_month) },
    listing_concierge: { max_auto_book_usd_per_month: num(raw.listing_concierge?.max_auto_book_usd_per_month) },
    finance: {
      burst_share_of_cap: num(raw.finance?.burst_share_of_cap, 1) || d.finance.burst_share_of_cap,
      ai_spike_multiple: num(raw.finance?.ai_spike_multiple) || d.finance.ai_spike_multiple,
      refusal_pressure: Math.floor(num(raw.finance?.refusal_pressure)) || d.finance.refusal_pressure,
    },
    readable: true,
  }
}

/** The ONE read of the envelopes. FAIL CLOSED: a refused read → readable:false (every envelope refuses). */
export async function loadAutonomyBudgets(svc: Svc, brokerageId: string): Promise<AutonomyBudgetsPolicy> {
  if (!brokerageId) return { ...resolveAutonomyBudgets(null, "no tenant"), readable: false }
  try {
    const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { ...resolveAutonomyBudgets(null, `policy read refused: ${error.message}`), readable: false }
    return resolveAutonomyBudgets((data as { settings?: unknown } | null)?.settings ?? null)
  } catch (e) {
    return { ...resolveAutonomyBudgets(null, `policy read threw: ${(e as Error).message}`), readable: false }
  }
}

// ── VALUE TIERS (the provider router's "high-value opportunity") ──────────────────────────────

/** Lead-score floors (0–100, the leads/contacts lead_score scale) and the value multiple of the reference
 *  (the twin's typical deal value, when the caller has it). */
export const VALUE_TIER_THRESHOLDS = Object.freeze({ highScore: 70, topScore: 85, highValueMultiple: 1.25, topValueMultiple: 2 })

/** PURE — which value tier an opportunity is in. No signal = standard (never promoted on silence). */
export function opportunityValueTier(input: { leadScore?: number | null; estimatedValue?: number | null; referenceValue?: number | null }): { tier: ValueTier; why: string } {
  const t = VALUE_TIER_THRESHOLDS
  const s = Number(input.leadScore)
  const v = Number(input.estimatedValue), ref = Number(input.referenceValue)
  const ratio = Number.isFinite(v) && v > 0 && Number.isFinite(ref) && ref > 0 ? v / ref : null
  if ((Number.isFinite(s) && s >= t.topScore) || (ratio !== null && ratio >= t.topValueMultiple)) return { tier: "top", why: `lead score ${Number.isFinite(s) ? s : "?"}${ratio !== null ? `, value ${ratio.toFixed(2)}× reference` : ""}` }
  if ((Number.isFinite(s) && s >= t.highScore) || (ratio !== null && ratio >= t.highValueMultiple)) return { tier: "high", why: `lead score ${Number.isFinite(s) ? s : "?"}${ratio !== null ? `, value ${ratio.toFixed(2)}× reference` : ""}` }
  return { tier: "standard", why: Number.isFinite(s) || ratio !== null ? `lead score ${Number.isFinite(s) ? s : "?"} below ${t.highScore}` : "no lead score or value signal" }
}

// ── LIMITS (pure) ─────────────────────────────────────────────────────────────────────────────

export interface EnvelopeLimits { periodCap: number | null; scopeCap: number | null; open: boolean; why: string }

/** PURE — the caps THIS consumption is judged against. `open:false` = the envelope is zero (recommendation only).
 * @proofSeam scripts/autonomous-budgeting-guard.ts asserts every envelope's cap derivation directly. */
export function envelopeLimits(p: AutonomyBudgetsPolicy, envelope: AutonomyEnvelope, input: { basisUsd?: number | null; valueTier?: ValueTier | null } = {}): EnvelopeLimits {
  const closed = (why: string): EnvelopeLimits => ({ periodCap: null, scopeCap: null, open: false, why })
  if (!p.readable) return closed(`autonomy_budgets unreadable — ${p.note ?? "refused"} (fail closed)`)
  switch (envelope) {
    case "ads_budget_shift": {
      const pct = p.ads_manager.max_shift_pct_of_monthly_budget
      const basis = Number(input.basisUsd)
      if (!(pct > 0)) return closed("ads_manager shift envelope is 0% — recommendation only")
      if (!(Number.isFinite(basis) && basis > 0)) return closed("no live monthly ad budget to take a share of")
      const cap = Math.round(basis * pct) / 100
      return { periodCap: cap, scopeCap: null, open: true, why: `${pct}% of $${basis.toFixed(2)} monthly = $${cap.toFixed(2)}` }
    }
    case "provider_high_value": {
      const tier = input.valueTier ?? "standard"
      const per = p.provider_router.per_decision_max_usd[tier] ?? 0
      const month = p.provider_router.monthly_max_usd
      if (!(per > 0)) return closed(`provider router has no per-decision envelope for a ${tier} opportunity — recommendation only`)
      if (!(month > 0)) return closed("provider router monthly envelope is $0 — recommendation only")
      return { periodCap: month, scopeCap: per, open: true, why: `${tier}: ≤ $${per} per decision, ≤ $${month} per month` }
    }
    case "asset_renders": {
      const r = p.asset_manager.max_renders_per_campaign
      return r > 0 ? { periodCap: null, scopeCap: r, open: true, why: `≤ ${r} renders per campaign` } : closed("asset_manager render envelope is 0 — recommendation only")
    }
    case "recruiting_prospect_data": {
      const m = p.recruiting_manager.max_prospect_data_usd_per_month
      return m > 0 ? { periodCap: m, scopeCap: null, open: true, why: `≤ $${m} prospect data per month` } : closed("recruiting_manager prospect-data envelope is $0 — recommendation only")
    }
    case "experiment_budget": {
      const m = p.experiments.max_usd_per_month
      return m > 0 ? { periodCap: m, scopeCap: null, open: true, why: `≤ $${m} autonomous experiment budget per month` } : closed("experiment envelope is $0 — a human deploys")
    }
    case "procurement_auto_book": {
      const m = p.listing_concierge.max_auto_book_usd_per_month
      return m > 0 ? { periodCap: m, scopeCap: null, open: true, why: `≤ $${m} auto-booked per month` } : closed("procurement auto-book envelope is $0 — agent approval")
    }
  }
}

/** PURE — the period a consumption counts in (UTC month, or lifetime). */
function envelopePeriodKey(envelope: AutonomyEnvelope, now: Date): string {
  return ENVELOPE_SPECS[envelope].period === "lifetime" ? "lifetime" : now.toISOString().slice(0, 7)
}

// ── THE ONE ENFORCEMENT FUNCTION ──────────────────────────────────────────────────────────────

export interface ConsumeEnvelopeInput {
  /** The VERIFIED tenant (the session's / the event row's) — never a body. */
  brokerageId: string
  envelope: AutonomyEnvelope
  /** USD or renders, per ENVELOPE_SPECS[envelope].unit. */
  amount: number
  /** campaign id / decision id when the envelope has a per-scope cap. */
  scopeKey?: string | null
  /** ads_budget_shift: the live monthly budget the percentage is taken of. */
  basisUsd?: number | null
  /** provider_high_value: the opportunity's tier. */
  valueTier?: ValueTier | null
  /** WHY the spend (the spend's own reason code — one vocabulary, lib/kernel/action-ledger.ts). */
  reasonCode: string
  reasonDetail: string
  subject: { type: string; id?: string | null; ref?: string | null }
  idempotencyKey?: string | null
  now?: Date
}

export type EnvelopeVerdict =
  | { allowed: true; consumptionId: string; periodConsumed: number | null; scopeConsumed: number | null; limits: EnvelopeLimits; policyRef: string; reason: string }
  | { allowed: false; reason: string; degraded?: boolean; limits: EnvelopeLimits | null; policyRef: string | null }

const RPC_ABSENT = new Set(["PGRST202", "42883", "42P01", "PGRST205"])

export interface EnvelopeDeps {
  /** Injected policy (proofs). Default: loadAutonomyBudgets. */
  policy?: AutonomyBudgetsPolicy
  /** Injected ledger (proofs). Default: lib/kernel/action-ledger.ts withActionLedger. */
  ledger?: <T>(ctx: Record<string, unknown>, run: () => Promise<T>, hooks: { settle: (r: T) => Record<string, unknown>; replay: (claim: { kind: string }) => T }, svc: Svc) => Promise<T>
}

/**
 * Consume `amount` from the tenant's envelope, or refuse. Never throws. Every call leaves one FINANCIAL ledger
 * row (allowed = executed / consumed, refused = skipped / envelope_refused) carrying the policy ref.
 */
export async function consumeAutonomyEnvelope(svc: Svc, input: ConsumeEnvelopeInput, deps: EnvelopeDeps = {}): Promise<EnvelopeVerdict> {
  const now = input.now ?? new Date()
  if (!input.brokerageId) return { allowed: false, reason: "no tenant — refused", limits: null, policyRef: null }
  if (!(AUTONOMY_ENVELOPES as readonly string[]).includes(input.envelope)) return { allowed: false, reason: `unknown envelope ${String(input.envelope)}`, limits: null, policyRef: null }
  if (!(Number.isFinite(input.amount) && input.amount > 0)) return { allowed: false, reason: "amount must be a positive number", limits: null, policyRef: null }
  const spec = ENVELOPE_SPECS[input.envelope]
  if (spec.scope && !input.scopeKey) return { allowed: false, reason: `${input.envelope} is capped per ${spec.scope} — a scope key is required`, limits: null, policyRef: null }
  const policy = deps.policy ?? (await loadAutonomyBudgets(svc, input.brokerageId))
  const limits = envelopeLimits(policy, input.envelope, { basisUsd: input.basisUsd, valueTier: input.valueTier })
  let policyRef = `${AUTONOMY_BUDGETS_POLICY_KEY}@unknown`
  try { policyRef = await (await import("@/lib/kernel/tenant-policy")).resolvePolicyRef(svc, input.brokerageId, AUTONOMY_BUDGETS_POLICY_KEY) } catch { /* @unknown is honest */ }
  const periodKey = envelopePeriodKey(input.envelope, now)
  const scopeKey = input.scopeKey ?? "all"

  const run = async (): Promise<EnvelopeVerdict> => {
    if (!limits.open) return { allowed: false, reason: limits.why, limits, policyRef }
    if (typeof svc.rpc !== "function") return { allowed: false, reason: "no atomic consume available on this client — refused (fail closed)", degraded: true, limits, policyRef }
    const { data, error } = await svc.rpc("consume_autonomy_budget", {
      p_brokerage_id: input.brokerageId, p_envelope: input.envelope, p_period_key: periodKey, p_scope_key: scopeKey,
      p_amount: input.amount, p_unit: spec.unit, p_period_cap: limits.periodCap, p_scope_cap: limits.scopeCap,
      p_manager: spec.manager, p_policy_ref: policyRef, p_reason: input.reasonDetail.slice(0, 500),
    })
    if (error) {
      const absent = RPC_ABSENT.has(String(error.code ?? ""))
      return { allowed: false, degraded: absent, reason: absent ? "envelope ledger absent (m731 not applied) — recommendation only" : `envelope consume refused: ${error.message}`, limits, policyRef }
    }
    const r = (data ?? {}) as { ok?: boolean; id?: string; reason?: string; period_consumed?: number; scope_consumed?: number }
    if (!r.ok || !r.id) return { allowed: false, reason: `over the envelope — ${r.reason ?? "refused"} (${limits.why})`, limits, policyRef }
    return { allowed: true, consumptionId: r.id, periodConsumed: r.period_consumed ?? null, scopeConsumed: r.scope_consumed ?? null, limits, policyRef, reason: `${input.amount} ${spec.unit} consumed — ${limits.why}` }
  }

  const ledger = deps.ledger ?? (async <T,>(ctx: Record<string, unknown>, fn: () => Promise<T>, hooks: { settle: (r: T) => Record<string, unknown>; replay: (claim: { kind: string }) => T }, client: Svc): Promise<T> => {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    return withActionLedger<T>(ctx as any, fn, hooks as any, { client: client as any })
  })
  try {
    const verdict = await ledger<EnvelopeVerdict>(
      {
        brokerageId: input.brokerageId, action: `autonomy.envelope.${input.envelope}`,
        actor: { type: "manager", managerKey: spec.manager },
        subject: input.subject, reasonCode: input.reasonCode, reasonDetail: input.reasonDetail.slice(0, 500),
        idempotencyKey: input.idempotencyKey ?? null, riskClass: "FINANCIAL", systemSource: "autonomy_budgets",
        policyKey: AUTONOMY_BUDGETS_POLICY_KEY,
        // The amount rides detail, NOT cost_usd: the spend's own row books what it cost (no double count).
        detail: { envelope: { key: input.envelope, amount: input.amount, unit: spec.unit, period_key: periodKey, scope_key: scopeKey, period_cap: limits.periodCap, scope_cap: limits.scopeCap, value_tier: input.valueTier ?? null, why: limits.why } },
      },
      run,
      {
        settle: (v) => v.allowed ? { status: "executed", outcome: "envelope_consumed", provider: "autonomy_budget_consumptions", providerRef: v.consumptionId } : { status: "skipped", outcome: "envelope_refused", error: v.reason.slice(0, 500) },
        replay: (claim) => ({ allowed: false, reason: claim.kind === "replay" ? "already decided for this key (ledger replay) — not consumed twice" : `ledger refused: ${claim.kind}`, limits, policyRef }),
      },
      svc,
    )
    if (verdict.allowed) {
      try {
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        await emitKernelEvent({ event: "autonomy_budget.consumed", brokerageId: input.brokerageId, entityType: input.subject.type, entityId: input.subject.id ?? null, source: "system", metadata: { envelope: input.envelope, amount: input.amount, unit: spec.unit, consumption_id: verdict.consumptionId, policy_ref: policyRef }, auditOnly: true, client: svc as any } as any)
      } catch { /* the ledger row is the consequential record */ }
    }
    return verdict
  } catch (e) {
    return { allowed: false, reason: `envelope gate threw: ${(e as Error).message} — refused (fail closed)`, limits, policyRef }
  }
}

/** Give a consumption back when the spend it authorised did NOT happen. Counted (CLAUDE.md §3). */
export async function releaseAutonomyEnvelope(svc: Svc, input: { brokerageId: string; consumptionId: string; reason: string; now?: Date }): Promise<{ ok: boolean; error?: string }> {
  if (!input.brokerageId || !input.consumptionId) return { ok: false, error: "tenant + consumption id required" }
  const { data, error } = await svc.from("autonomy_budget_consumptions")
    .update({ status: "released", released_at: (input.now ?? new Date()).toISOString(), release_reason: input.reason.slice(0, 500) })
    .eq("id", input.consumptionId).eq("brokerage_id", input.brokerageId).eq("status", "consumed").select("id")
  if (error) return { ok: false, error: `release refused: ${error.message}` }
  if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "release matched no consumed row for this tenant" }
  return { ok: true }
}

// ── THE CENSUS — every autonomous spender and the gate it routes through ──────────────────────

export interface AutonomousSpender {
  spender: string
  /** Repo-relative file holding the spend decision (null = no spender exists yet). */
  file: string | null
  /** "envelope" = calls consumeAutonomyEnvelope(<envelope>); otherwise the named pre-existing ceiling. */
  gate: "envelope" | "ceiling"
  envelope?: AutonomyEnvelope
  ceiling?: string
  /** For a ceiling: the code tokens that prove the file runs it (the census reads stripped source). */
  requires?: string[]
  note: string
}

/** @proofSeam scripts/autonomous-budgeting-guard.ts reads every file named here by stripped source. */
export const AUTONOMOUS_SPENDERS: readonly AutonomousSpender[] = Object.freeze([
  { spender: "ads budget shift between proven campaigns", file: "lib/ads/ad-outcome-loop.ts", gate: "envelope", envelope: "ads_budget_shift", note: "unproven / over-envelope → the gated budget_rebalance proposal (human)" },
  { spender: "provider router enrichment above the per-decision cap", file: "lib/ai-isa/property-lookup-rail.ts", gate: "envelope", envelope: "provider_high_value", note: "high / top value tier only" },
  { spender: "asset manager variant renders", file: "lib/kernel/media-intelligence.ts", gate: "envelope", envelope: "asset_renders", note: "per campaign; reuse first (findSufficientAsset)" },
  { spender: "autonomous experiment budget", file: "lib/kernel/experiment-pipeline.ts", gate: "envelope", envelope: "experiment_budget", note: "only an autonomously deployed class consumes; a human deploy is human-authorised" },
  { spender: "procurement auto-book", file: "lib/kernel/procurement.ts", gate: "envelope", envelope: "procurement_auto_book", note: "on top of procurement_autonomy's per-purchase cap" },
  { spender: "recruiting prospect data", file: null, gate: "envelope", envelope: "recruiting_prospect_data", note: "NO purchaser exists at base 2476e09a5 (the recruiting capability is lane 108H's approved build) — it must call consumeAutonomyEnvelope('recruiting_prospect_data')" },
  { spender: "base enrichment within the per-decision cap", file: "lib/ai-isa/property-lookup-rail.ts", gate: "ceiling", ceiling: "resource_allocation.enrichment_max_usd_per_decision (shouldPurchaseEnrichment) + checkVendorBudget", requires: ["shouldPurchaseEnrichment(", "checkVendorBudget("], note: "106A's per-decision gate + the tenant vendor budget" },
  { spender: "AI reasoning (expensive model upgrade)", file: "lib/ai/models.ts", gate: "ceiling", ceiling: "mayUseAndAfford ai_tokens budget half + resource_allocation.ai_min_value_to_cost_ratio", requires: ["mayUseAndAfford(", "shouldUseExpensiveReasoning("], note: "the tier's token limit bounds it; the finance report watches ai_tool_usage daily" },
])

// ── FINANCE: the daily envelope report + anomaly signal ───────────────────────────────────────

export interface ConsumptionRow { envelope: string; amount: number | string; period_key: string; scope_key: string; period_cap: number | string | null; scope_cap: number | string | null; status: string; created_at: string; released_at?: string | null }
export interface EnvelopeLine { envelope: AutonomyEnvelope; manager: ManagerKey; unit: EnvelopeUnit; consumedPeriod: number; consumedToday: number; released: number; cap: number | null; refusalsToday: number; utilisation: number | null }
export interface AutonomyBudgetReport { day: string; period: string; lines: EnvelopeLine[]; ai: { todayUsd: number; trailingDailyAvgUsd: number }; anomalies: string[]; blindSpots: string[] }

/** PURE — the report from the rows. Anomalies: over cap, ≥ 80 % used, a one-day burst, refusal pressure, an AI spend spike.
 * @proofSeam scripts/autonomous-budgeting-guard.ts asserts each anomaly with a positive and a negative control. */
export function composeAutonomyBudgetReport(input: { policy: AutonomyBudgetsPolicy; consumptions: ConsumptionRow[]; refusals: Array<{ action: string; created_at: string }>; aiUsage: Array<{ cost_cents: number | string | null; created_at: string }>; now: Date }): AutonomyBudgetReport {
  const day = input.now.toISOString().slice(0, 10)
  const period = input.now.toISOString().slice(0, 7)
  const f = input.policy.finance
  const lines: EnvelopeLine[] = []
  const anomalies: string[] = []
  for (const e of AUTONOMY_ENVELOPES) {
    const spec = ENVELOPE_SPECS[e]
    const rows = input.consumptions.filter((r) => r.envelope === e && (spec.period === "lifetime" || r.period_key === period))
    const live = rows.filter((r) => r.status === "consumed")
    const consumedPeriod = live.reduce((s, r) => s + Number(r.amount || 0), 0)
    const consumedToday = live.filter((r) => String(r.created_at).slice(0, 10) === day).reduce((s, r) => s + Number(r.amount || 0), 0)
    const released = rows.filter((r) => r.status === "released").length
    const latest = [...live].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
    const cap = latest ? Number(latest.period_cap ?? latest.scope_cap ?? NaN) : NaN
    const capN = Number.isFinite(cap) && cap > 0 ? cap : null
    const refusalsToday = input.refusals.filter((r) => r.action === `autonomy.envelope.${e}` && String(r.created_at).slice(0, 10) === day).length
    // "Is the envelope open at all now" — a unit basis / the top tier, so only a ZERO policy reads closed.
    const limits = envelopeLimits(input.policy, e, { basisUsd: 1, valueTier: "top" })
    const utilisation = capN && spec.scope === null ? consumedPeriod / capN : null
    lines.push({ envelope: e, manager: spec.manager, unit: spec.unit, consumedPeriod: Math.round(consumedPeriod * 100) / 100, consumedToday: Math.round(consumedToday * 100) / 100, released, cap: capN, refusalsToday, utilisation: utilisation === null ? null : Math.round(utilisation * 1000) / 1000 })
    if (consumedToday > 0 && !limits.open) anomalies.push(`${e}: ${consumedToday} ${spec.unit} consumed today but the envelope is now closed (${limits.why})`)
    if (utilisation !== null && utilisation > 1) anomalies.push(`${e}: ${consumedPeriod} ${spec.unit} consumed vs a ${capN} cap — OVER CAP`)
    else if (utilisation !== null && utilisation >= 0.8) anomalies.push(`${e}: ${(utilisation * 100).toFixed(0)}% of the ${period} envelope used`)
    if (capN && spec.scope === null && consumedToday > f.burst_share_of_cap * capN) anomalies.push(`${e}: ${consumedToday} ${spec.unit} in one day (> ${(f.burst_share_of_cap * 100).toFixed(0)}% of the cap) — burst`)
    if (refusalsToday >= f.refusal_pressure) anomalies.push(`${e}: ${refusalsToday} refusals today — the envelope is binding (raise it or keep recommendation mode)`)
  }
  const dayMs = Date.parse(`${day}T00:00:00.000Z`)
  const todayCents = input.aiUsage.filter((u) => Date.parse(u.created_at) >= dayMs).reduce((s, u) => s + Number(u.cost_cents || 0), 0)
  const priorCents = input.aiUsage.filter((u) => { const t = Date.parse(u.created_at); return t < dayMs && t >= dayMs - 7 * 86_400_000 }).reduce((s, u) => s + Number(u.cost_cents || 0), 0)
  const ai = { todayUsd: Math.round(todayCents) / 100, trailingDailyAvgUsd: Math.round(priorCents / 7) / 100 }
  if (ai.todayUsd >= 5 && ai.todayUsd > f.ai_spike_multiple * Math.max(ai.trailingDailyAvgUsd, 0.01)) anomalies.push(`AI spend $${ai.todayUsd.toFixed(2)} today vs a $${ai.trailingDailyAvgUsd.toFixed(2)}/day trailing average (> ${f.ai_spike_multiple}×)`)
  return { day, period, lines, ai, anomalies, blindSpots: ["per-campaign render caps report lifetime totals, not a utilisation ratio", "AI spend is the ai_tool_usage ledger (platform-paid rows included) — vendor spend is checkVendorBudget's"] }
}

/** Read the rows (tenant-pinned) and compose the report — also the envelope admin screen's caps / consumption read (wave 137). */
export async function buildAutonomyBudgetReport(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<{ ok: true; report: AutonomyBudgetReport; policy: AutonomyBudgetsPolicy } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "tenant scope required" }
  const policy = await loadAutonomyBudgets(svc, brokerageId)
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const blind: string[] = []
  const c = await svc.from("autonomy_budget_consumptions").select("envelope, amount, period_key, scope_key, period_cap, scope_cap, status, created_at, released_at, release_reason").eq("brokerage_id", brokerageId).gte("created_at", monthStart).limit(5000)
  if (c.error) { if (!RPC_ABSENT.has(String(c.error.code ?? ""))) return { ok: false, error: `autonomy_budget_consumptions: ${c.error.message}` }; blind.push("envelope ledger absent (m731 not applied)") }
  const r = await svc.from("agent_action_ledger").select("action, created_at").eq("brokerage_id", brokerageId).in("action", AUTONOMY_ENVELOPES.map((e) => `autonomy.envelope.${e}`)).eq("status", "skipped").gte("created_at", dayStart).limit(5000)
  if (r.error) return { ok: false, error: `agent_action_ledger: ${r.error.message}` }
  const a = await svc.from("ai_tool_usage").select("cost_cents, created_at").eq("brokerage_id", brokerageId).gte("created_at", new Date(Date.parse(dayStart) - 7 * 86_400_000).toISOString()).limit(20000)
  if (a.error) return { ok: false, error: `ai_tool_usage: ${a.error.message}` }
  const report = composeAutonomyBudgetReport({ policy, consumptions: (c.data ?? []) as ConsumptionRow[], refusals: (r.data ?? []) as any[], aiUsage: (a.data ?? []) as any[], now })
  report.blindSpots.push(...blind)
  return { ok: true, report, policy }
}

/**
 * The Finance Manager's daily delivery: the report on the bus (cron_manager → finance_manager) when the
 * tenant has any envelope activity or open envelope, and an ESCALATION when an anomaly fired. Wired on the
 * nightly app/api/cron/brokerage-pl-rollup (Finance's own P&L tick).
 */
export async function deliverAutonomyBudgetReport(svc: Svc, brokerageId: string, now: Date = new Date(), deps: { publish?: typeof import("@/lib/kernel/manager-signals").publishManagerSignal } = {}): Promise<{ reported: boolean; escalated: boolean; anomalies: string[]; error?: string }> {
  const built = await buildAutonomyBudgetReport(svc, brokerageId, now)
  if (!built.ok) return { reported: false, escalated: false, anomalies: [], error: built.error }
  const { report, policy } = built
  const anyOpen = AUTONOMY_ENVELOPES.some((e) => envelopeLimits(policy, e, { basisUsd: 1, valueTier: "top" }).open)
  const anyActivity = report.lines.some((l) => l.consumedPeriod > 0 || l.refusalsToday > 0)
  if (!anyOpen && !anyActivity && report.anomalies.length === 0) return { reported: false, escalated: false, anomalies: [] }
  const publish = deps.publish ?? (await import("@/lib/kernel/manager-signals")).publishManagerSignal
  const summary = report.lines.filter((l) => l.consumedPeriod > 0 || l.refusalsToday > 0).map((l) => `${l.envelope} ${l.consumedPeriod}${l.unit === "usd" ? " USD" : " renders"}${l.cap ? `/${l.cap}` : ""}${l.refusalsToday ? `, ${l.refusalsToday} refused today` : ""}`).join("; ") || "no autonomous spend this period"
  const rep = await publish({ brokerageId, fromManager: "cron_manager", toManager: "finance_manager", signalType: "autonomy_budget_report", message: `Autonomous budget envelopes ${report.day}: ${summary}. AI $${report.ai.todayUsd.toFixed(2)} today.`, payload: { report }, dedupe: false }, svc as any)
  let escalated = false
  if (report.anomalies.length > 0) {
    const esc = await publish({ brokerageId, fromManager: "cron_manager", toManager: "finance_manager", signalType: "autonomy_budget_escalated", message: `Autonomous spend anomaly: ${report.anomalies.join(" · ").slice(0, 900)}`, payload: { day: report.day, anomalies: report.anomalies }, dedupe: false }, svc as any)
    escalated = esc.ok
  }
  return { reported: rep.ok, escalated, anomalies: report.anomalies, ...(rep.ok ? {} : { error: rep.reason }) }
}

// ── THE ENVELOPE ADMIN SCREEN'S FIELD TABLE + VALIDATOR (wave 137, owner "approve all": "an envelope admin
// screen is approved"). The screen (app/dashboard/admin/manager-trust/autonomy-envelopes-editor.tsx) reads
// and edits THIS key through the ONE versioned policy path (a human `policy` proposal → promoteProposal →
// mergeBrokerageSettings → appendTenantPolicyVersion); nothing on it writes the setting directly.
// `money: true` fields OBLIGATE THE BROKERAGE TO PAY — only TENANT_COMMERCE_ADMIN_USER_TYPES may change them
// (lib/auth/resolve-user-role.ts); the render cap and the Finance anomaly thresholds are tenant-admin edits.

interface AutonomyEnvelopeField { path: string; label: string; unit: "pct" | "usd" | "renders" | "share" | "multiple" | "count"; money: boolean; min: number; max: number; envelope: AutonomyEnvelope | null }

/** @proofSeam scripts/autonomous-budgeting-guard.ts asserts every resolver path is editable here and the money split. */
export const AUTONOMY_ENVELOPE_FIELDS: readonly AutonomyEnvelopeField[] = Object.freeze([
  { path: "ads_manager.max_shift_pct_of_monthly_budget", label: "Ads Manager — max shift between proven campaigns (% of the live monthly budget)", unit: "pct", money: true, min: 0, max: 100, envelope: "ads_budget_shift" },
  { path: "provider_router.per_decision_max_usd.standard", label: "Provider router — per decision, standard opportunity", unit: "usd", money: true, min: 0, max: 1000, envelope: "provider_high_value" },
  { path: "provider_router.per_decision_max_usd.high", label: "Provider router — per decision, high-value opportunity", unit: "usd", money: true, min: 0, max: 1000, envelope: "provider_high_value" },
  { path: "provider_router.per_decision_max_usd.top", label: "Provider router — per decision, top-value opportunity", unit: "usd", money: true, min: 0, max: 1000, envelope: "provider_high_value" },
  { path: "provider_router.monthly_max_usd", label: "Provider router — monthly total", unit: "usd", money: true, min: 0, max: 100000, envelope: "provider_high_value" },
  { path: "asset_manager.max_renders_per_campaign", label: "Asset Manager — renders per campaign", unit: "renders", money: false, min: 0, max: 1000, envelope: "asset_renders" },
  { path: "recruiting_manager.max_prospect_data_usd_per_month", label: "Recruiting — prospect data per month", unit: "usd", money: true, min: 0, max: 100000, envelope: "recruiting_prospect_data" },
  { path: "experiments.max_usd_per_month", label: "Experiments — autonomous budget per month", unit: "usd", money: true, min: 0, max: 100000, envelope: "experiment_budget" },
  { path: "listing_concierge.max_auto_book_usd_per_month", label: "Procurement — auto-booked vendor spend per month", unit: "usd", money: true, min: 0, max: 100000, envelope: "procurement_auto_book" },
  { path: "finance.burst_share_of_cap", label: "Finance — one-day burst alarm (share of the cap)", unit: "share", money: false, min: 0.05, max: 1, envelope: null },
  { path: "finance.ai_spike_multiple", label: "Finance — AI spend spike alarm (× trailing daily average)", unit: "multiple", money: false, min: 1, max: 100, envelope: null },
  { path: "finance.refusal_pressure", label: "Finance — refusals per day that flag a binding envelope", unit: "count", money: false, min: 1, max: 1000, envelope: null },
])

const getPath = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o)

/**
 * PURE — the screen's edit → the stored policy value. Every field is bounded (a value out of bounds is an
 * error, never clamped silently); the result is resolved through resolveAutonomyBudgets so what is stored
 * is exactly what the enforcement reads. `moneyChanged` names the money fields that moved — the caller
 * refuses them unless the seat is a commerce admin.
 * @proofSeam scripts/autonomous-budgeting-guard.ts drives it directly (bounds, money split, round trip).
 */
export function validateAutonomyBudgetsEdit(input: Record<string, unknown>, current: AutonomyBudgetsPolicy): { ok: true; value: Record<string, unknown>; changedKeys: string[]; moneyChanged: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const value: Record<string, any> = {}
  const changedKeys: string[] = [], moneyChanged: string[] = []
  for (const f of AUTONOMY_ENVELOPE_FIELDS) {
    const raw = input[f.path]
    const n = raw === undefined || raw === null || String(raw).trim() === "" ? Number(getPath(current, f.path)) : Number(raw)
    if (!Number.isFinite(n) || n < f.min || n > f.max) { errors.push(`${f.label}: must be between ${f.min} and ${f.max}`); continue }
    const v = f.unit === "renders" || f.unit === "count" ? Math.floor(n) : Math.round(n * 100) / 100
    const keys = f.path.split(".")
    let cur = value
    for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {})
    cur[keys[keys.length - 1]] = v
    if (v !== Number(getPath(current, f.path))) { changedKeys.push(f.path); if (f.money) moneyChanged.push(f.path) }
  }
  if (errors.length) return { ok: false, errors }
  const resolved = resolveAutonomyBudgets({ [AUTONOMY_BUDGETS_POLICY_KEY]: value })
  const { readable: _r, note: _n, ...stored } = resolved
  return { ok: true, value: stored, changedKeys, moneyChanged }
}
