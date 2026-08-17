

import { createClient } from "@/lib/supabase/server"
import { currentUsagePeriod } from "@/lib/usage/period"

export interface UsageLimit {
  withinLimit: boolean
  used: number
  limit: number
  percentage: number
  metric: string
}

/**
 * Increments usage counter for a given metric and brokerage
 * Upserts into the current billing period (month-based)
 */
export async function incrementUsage(brokerageId: string, metric: string, amount = 1): Promise<void> {
  const supabase = await createClient()

  // ONE period vocabulary (#190). This function used to compute LOCAL month
  // boundaries with an INCLUSIVE end while every reader — including the
  // v_brokerage_ai_quota view that gates AI spend — keyed on the UTC/EXCLUSIVE
  // convention. period_end is part of the UNIQUE key, so the quota join could
  // NEVER match a row this wrote: AI usage metered to a row nothing read.
  const { periodStartIso, periodEndIso } = currentUsagePeriod()

  // Read-then-write raced under concurrency (two requests both see "missing",
  // one insert loses). The UNIQUE(brokerage_id, period_start, period_end,
  // metric) key makes the read half of the old dance unnecessary for the
  // insert case; the increment still needs the current value, so keep the read
  // but let a conflicting insert fall through to an update instead of erroring.
  const { data: existing, error: fetchError } = await supabase
    .from("usage_counters")
    .select("id, value")
    .eq("brokerage_id", brokerageId)
    .eq("metric", metric)
    .eq("period_start", periodStartIso)
    .maybeSingle()
  if (fetchError) {
    console.error("[usage] counter read refused — this call will NOT be metered:", fetchError.message)
    return
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("usage_counters")
      .update({ value: existing.value + amount })
      .eq("id", existing.id)
    if (updateError) console.error("[usage] counter update refused — not metered:", updateError.message)
    return
  }

  const { error: insertError } = await supabase.from("usage_counters").insert({
    brokerage_id: brokerageId,
    metric,
    value: amount,
    period_start: periodStartIso,
    period_end: periodEndIso,
  })
  if (!insertError) return
  // Lost the insert race: another request created the row between our read and
  // write. Fold this increment into it rather than dropping the count.
  if (insertError.code === "23505") {
    const { data: winner } = await supabase
      .from("usage_counters")
      .select("id, value")
      .eq("brokerage_id", brokerageId)
      .eq("metric", metric)
      .eq("period_start", periodStartIso)
      .maybeSingle()
    if (winner) {
      const { error: e2 } = await supabase
        .from("usage_counters").update({ value: winner.value + amount }).eq("id", winner.id)
      if (e2) console.error("[usage] post-race update refused — not metered:", e2.message)
      return
    }
  }
  console.error("[usage] counter insert refused — this call was NOT metered:", insertError.message)
}

/**
 * Checks if a brokerage is within limits for a given metric
 * Returns current usage, limit, and whether within limit
 */
export async function checkLimit(brokerageId: string, metric: string): Promise<UsageLimit> {
  const supabase = await createClient()

  // Get brokerage plan tier
  const { data: brokerage, error: brokerageError } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", brokerageId)
    .maybeSingle()

  if (brokerageError || !brokerage) {
    console.error(" Error fetching brokerage:", brokerageError)
    return {
      withinLimit: false,
      used: 0,
      limit: 0,
      percentage: 0,
      metric,
    }
  }

  // Get plan limit for this metric
  const { data: planLimit, error: limitError } = await supabase
    .from("plan_limits")
    .select("limit_value, soft_limit_threshold")
    .eq("plan_tier", brokerage.plan_tier)
    .eq("metric", metric)
    .maybeSingle()

  if (limitError || !planLimit) {
    console.error(" Error fetching plan limit:", limitError)
    return {
      withinLimit: true, // Default to allowing if limit not found
      used: 0,
      limit: -1,
      percentage: 0,
      metric,
    }
  }

  // Get current usage for this billing period — the CANONICAL period, keyed on
  // period_start only. Pinning period_end too is how the old rows (written with
  // an inclusive end) became unreadable to their own limit check.
  const { periodStartIso } = currentUsagePeriod()

  const { data: usage, error: usageError } = await supabase
    .from("usage_counters")
    .select("value")
    .eq("brokerage_id", brokerageId)
    .eq("metric", metric)
    .eq("period_start", periodStartIso)
    .maybeSingle()

  const used = usage?.value || 0
  const limit = planLimit.limit_value

  // -1 means unlimited
  if (limit === -1) {
    return {
      withinLimit: true,
      used,
      limit: -1,
      percentage: 0,
      metric,
    }
  }

  const percentage = (used / limit) * 100
  const withinLimit = used < limit

  return {
    withinLimit,
    used,
    limit,
    percentage,
    metric,
  }
}

/**
 * Gets all usage metrics for a brokerage in the current billing period
 */
export async function getAllUsageMetrics(brokerageId: string): Promise<UsageLimit[]> {
  const metrics = [
    "llm_calls",
    "video_minutes",
    "active_users",
    "contacts_count",
    "active_transactions",
    "sms_sent",
    "emails_sent",
    "storage_gb",
  ]

  const results = await Promise.all(metrics.map((metric) => checkLimit(brokerageId, metric)))

  return results
}

/**
 * Gets brokerage plan details
 */
export async function getBrokeragePlan(brokerageId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("brokerages")
    .select("plan_tier, billing_metadata")
    .eq("id", brokerageId)
    .maybeSingle()

  if (error) {
    console.error(" Error fetching brokerage plan:", error)
    return null
  }

  return data
}
