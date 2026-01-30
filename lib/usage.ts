

import { createClient } from "@/lib/supabase/server"

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

  // Calculate current billing period (monthly)
  const now = new Date()
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

  // Upsert: increment if exists, create if not
  const { data: existing, error: fetchError } = await supabase
    .from("usage_counters")
    .select("id, value")
    .eq("brokerage_id", brokerageId)
    .eq("metric", metric)
    .eq("period_start", periodStart.toISOString())
    .eq("period_end", periodEnd.toISOString())
    .single()

  if (existing) {
    // Update existing counter
    const { error: updateError } = await supabase
      .from("usage_counters")
      .update({ value: existing.value + amount })
      .eq("id", existing.id)

    if (updateError) {
      console.error("Error updating usage counter:", updateError)
    }
  } else {
    // Insert new counter
    const { error: insertError } = await supabase.from("usage_counters").insert({
      brokerage_id: brokerageId,
      metric,
      value: amount,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    })

    if (insertError) {
      console.error(" Error inserting usage counter:", insertError)
    }
  }
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
    .single()

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
    .single()

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

  // Get current usage for this billing period
  const now = new Date()
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

  const { data: usage, error: usageError } = await supabase
    .from("usage_counters")
    .select("value")
    .eq("brokerage_id", brokerageId)
    .eq("metric", metric)
    .eq("period_start", periodStart.toISOString())
    .eq("period_end", periodEnd.toISOString())
    .single()

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
    .single()

  if (error) {
    console.error(" Error fetching brokerage plan:", error)
    return null
  }

  return data
}
