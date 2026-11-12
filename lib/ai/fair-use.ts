/**
 * lib/ai/fair-use.ts
 *
 * AI fair-use quota enforcement (subscription-included AI).
 *
 * Brokerages do NOT pay per-token — AI is bundled in the plan. The plan tier
 * sets the INCLUDED monthly token quota tied to the brokerage's plan_tier
 * (solo_agent / team / brokerage / multi_location).
 *
 * OVER the included quota, the owner ruling (m479) is SERVED AND BILLED, not
 * refused: when the tier's overage terms (plan_limits.overage_allowed) permit
 * it, the call proceeds with overageActive set and the excess is billed at
 * period close (lib/billing/ai-overage.ts derives it from usage_counters —
 * there is no second accrual). A tier with no overage terms keeps today's
 * hard block. An approved ai_quota_overrides grant extends the INCLUDED
 * quota; overage starts only after included + override.
 *
 * Wraps lib/usage/check-cap.ts for the 'ai_tokens_monthly' metric and adds
 * (a) superadmin pass-through and (b) active override lookup.
 *
 * Call site: lib/ai/models.ts:generateAIResponse() — runs pre-flight before
 * any AI Gateway request. If hard-blocked, the AI call is short-circuited
 * with a friendly upgrade message.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { checkUsageCap, type CapResult } from "@/lib/usage/check-cap"

export interface FairUseResult {
  /** false = HARD BLOCK at hard cap. Caller must not make the AI call. */
  allowed:        boolean
  /** true = past soft threshold (80%). Caller may continue but should surface a warning. */
  softWarning:    boolean
  /** Tokens used this month (from usage_counters). */
  tokensUsed:     number
  /** Tier ceiling. -1 = unlimited. */
  tokensLimit:    number
  /** 0–100. */
  percentUsed:    number
  /** Human-friendly message for UI / error response. Only set on warn or block. */
  message?:       string
  /** True when an admin-approved override is in effect for the period. */
  overrideActive: boolean
  /** Extra tokens granted by the active override (added to limit). */
  overrideTokens: number
  /** True when the tenant is past the included quota (limit + override) and is
   *  being SERVED under the tier's overage terms — billed at period close. */
  overageActive: boolean
  /** Tokens past the included total (including this call's addTokens estimate).
   *  0 unless overageActive. */
  overageTokens: number
}

/** Returns true if there is an active override row that hasn't expired. */
async function readActiveOverrideTokens(brokerageId: string): Promise<number> {
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("ai_quota_overrides")
      .select("extra_tokens, effective_until")
      .eq("brokerage_id", brokerageId)
      .eq("status", "approved")
      .order("approved_at", { ascending: false })
      .limit(5)
    if (!data || data.length === 0) return 0
    const now = Date.now()
    return data
      .filter(r => !r.effective_until || new Date(r.effective_until).getTime() > now)
      .reduce((sum, r) => sum + Number(r.extra_tokens ?? 0), 0)
  } catch {
    return 0
  }
}

/**
 * The tier's overage terms for ai_tokens_monthly (m479). Any refusal or
 * missing row reads as terms-off — the fail-safe direction: a tenant is
 * hard-blocked (today's behaviour), never billed overage nobody agreed to.
 */
async function readOverageTerms(brokerageId: string): Promise<{ allowed: boolean; rateCentsPer1k: number }> {
  const OFF = { allowed: false, rateCentsPer1k: 0 }
  try {
    const svc = createServiceClient()
    const { data: brokerage, error: brokerageError } = await svc
      .from("brokerages")
      .select("plan_tier")
      .eq("id", brokerageId)
      .maybeSingle()
    if (brokerageError || !brokerage) return OFF
    const { data: terms, error: termsError } = await svc
      .from("plan_limits")
      .select("overage_allowed, overage_rate_cents_per_1k")
      .eq("plan_tier", brokerage.plan_tier ?? "solo_agent")
      .eq("metric", "ai_tokens_monthly")
      .maybeSingle()
    if (termsError || !terms) return OFF
    return {
      allowed: !!terms.overage_allowed,
      rateCentsPer1k: Number(terms.overage_rate_cents_per_1k ?? 0),
    }
  } catch {
    return OFF
  }
}

/**
 * Pre-flight fair-use check. Add the estimated token cost of the call
 * via addTokens so we can short-circuit on "this one extra call would
 * cross the cap" rather than waiting for the counter to actually exceed.
 *
 * Fails OPEN on error — usage checks must never be the path that kills
 * a working customer flow.
 */
export async function checkAIFairUse(params: {
  brokerageId: string | null | undefined
  /** Estimated tokens this pending call will consume. Default 0 = inspect only. */
  addTokens?: number
  /** When true, skip the cap entirely (cron, webhook, superadmin override). */
  bypass?: boolean
}): Promise<FairUseResult> {
  // No brokerage context = background job / webhook → uncapped.
  if (!params.brokerageId || params.bypass) {
    return {
      allowed: true, softWarning: false, tokensUsed: 0, tokensLimit: -1,
      percentUsed: 0, overrideActive: false, overrideTokens: 0,
      overageActive: false, overageTokens: 0,
    }
  }

  const overrideTokens = await readActiveOverrideTokens(params.brokerageId)

  const cap: CapResult = await checkUsageCap({
    brokerageId: params.brokerageId,
    metric:      "ai_tokens_monthly",
    addQuantity: params.addTokens ?? 0,
  })

  // Apply override on top of base cap if present.
  const effectiveLimit = cap.limit < 0 ? -1 : cap.limit + overrideTokens
  const effectiveUsed  = cap.used
  const effectivePct   = effectiveLimit > 0
    ? Math.min(100, Math.round((effectiveUsed / effectiveLimit) * 100))
    : 0

  // If override moves us back under the hard cap, allow.
  const reAllowed = effectiveLimit < 0 ? true : effectiveUsed < effectiveLimit
  const reSoftWarn = effectiveLimit > 0
    ? effectiveUsed >= Math.floor(effectiveLimit * 0.80) && reAllowed
    : false

  // Past included + override: SERVED AND BILLED when the tier's terms allow it
  // (m479 owner ruling) — the excess is derived from usage_counters at period
  // close and invoiced; no second accrual happens here. Terms off / missing /
  // refused → today's hard block, unchanged. The terms read only happens on
  // the over-quota path, so under-quota calls pay no extra round-trip.
  if (!reAllowed && effectiveLimit >= 0) {
    const terms = await readOverageTerms(params.brokerageId)
    if (terms.allowed) {
      const overageTokens = Math.max(0, effectiveUsed - effectiveLimit)
      return {
        allowed:        true,
        softWarning:    false,
        tokensUsed:     effectiveUsed,
        tokensLimit:    effectiveLimit,
        percentUsed:    effectivePct,
        message:        `You've used your plan's included AI allowance for this billing period — additional usage is billed as overage at your plan's rate.`,
        overrideActive: overrideTokens > 0,
        overrideTokens,
        overageActive:  true,
        overageTokens,
      }
    }
  }

  return {
    allowed:        reAllowed,
    softWarning:    reSoftWarn,
    tokensUsed:     effectiveUsed,
    tokensLimit:    effectiveLimit,
    percentUsed:    effectivePct,
    message:        !reAllowed
      ? "AI fair-use limit reached for this billing period. Contact your broker admin to request more or upgrade the plan."
      : reSoftWarn
      ? `You've used ${effectivePct}% of this month's AI allowance.`
      : undefined,
    overrideActive: overrideTokens > 0,
    overrideTokens,
    overageActive:  false,
    overageTokens:  0,
  }
}

/**
 * Standalone status read — for dashboards. Same data, no add-tokens math.
 * Reads the v_brokerage_ai_quota view (more efficient + reflects current
 * tier without round-trip to plan_limits in app code).
 */
export async function getBrokerageAIQuotaStatus(
  brokerageId: string,
): Promise<{
  brokerageId:  string
  planTier:     "solo_agent" | "team" | "brokerage" | "multi_location"
  tokensUsed:   number
  tokensLimit:  number
  percentUsed:  number
  quotaStatus:  "ok" | "warning" | "blocked" | "unlimited"
} | null> {
  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("v_brokerage_ai_quota")
      .select("brokerage_id, plan_tier, tokens_used, token_limit, percent_used, quota_status")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (error || !data) return null
    return {
      brokerageId:  data.brokerage_id as string,
      planTier:     data.plan_tier as "solo_agent" | "team" | "brokerage" | "multi_location",
      tokensUsed:   Number(data.tokens_used ?? 0),
      tokensLimit:  Number(data.token_limit ?? -1),
      percentUsed:  Number(data.percent_used ?? 0),
      quotaStatus:  (data.quota_status ?? "ok") as "ok" | "warning" | "blocked" | "unlimited",
    }
  } catch {
    return null
  }
}
