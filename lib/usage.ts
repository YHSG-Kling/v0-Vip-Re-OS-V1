

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
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
  // SERVICE CLIENT, like the other usage_counters writer (log-media-usage).
  // Every usage_counters policy is TO authenticated; on the anonymous AI lanes
  // (widget visitor, D-ID avatar turn — #187) the cookie client is the anon
  // role, so the increment was refused, the refusal swallowed below, and the
  // spend never reached the ai_tokens_monthly counter the cap reads.
  const supabase = createServiceClient()

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

// ─── TOMBSTONES (orphan burn-down, lane E) ───────────────────────────────────
//
// `getAllUsageMetrics(brokerageId)` DELETED.
//   SURVIVOR: app/actions/usage-overview.ts:63 `loadUsageOverview`, which serves
//   /dashboard/settings/usage and is strictly more complete on every axis:
//     · It derives the metric list FROM plan_limits instead of a hard-coded
//       array. That array named EIGHT metrics; plan_limits carries EIGHTEEN on
//       the live database, so the deleted function could never report
//       ai_tokens_monthly (the one metric with live counter rows), ai_voice_minutes,
//       live_avatar_*, live_assistant_*, tts_characters, voice_clones_created or
//       avatars_created — the whole AI/voice half of what a tenant is billed for.
//     · It HONOURS plan_limits.soft_limit_threshold. checkLimit below SELECTs
//       that column and then throws it away, so "approaching your limit" was
//       unrepresentable; the survivor turns it into status warning/exceeded.
//     · It resolves the tenant through resolveWriteContext() and gates on
//       isAdminOrBroker, rather than trusting a brokerageId argument.
//   MERGED BEFORE DELETING: the one thing this file held that the survivor
//   lacked — reads keyed on period_start ALONE, never period_end (see
//   lib/usage/period.ts and checkLimit:135). That is now carried at
//   app/actions/usage-overview.ts:88.
//
// `getBrokeragePlan(brokerageId)` DELETED.
//   SURVIVORS, one per half of what it returned:
//     · plan_tier → lib/billing/plan-tier.ts:51 `resolvePlanTier`, THE tier
//       reader. It normalises through toPlanTier so an unknown/missing value
//       falls to the TIGHTEST tier (FALLBACK_TIER) instead of being handed to
//       the caller raw — this function returned an untyped row, so a tenant with
//       a NULL plan_tier reached callers as `null` and each one guessed.
//     · billing_metadata → parsed by the ONE seat-override reader,
//       app/actions/superadmin/tenant-entitlements.ts:305 `parseSeatOverride`
//       (also used at app/dashboard/settings/page.tsx:147). Handing the raw jsonb
//       out invited a second parser.
//   Nothing merged: the deleted function performed no validation of either half.
//
// checkLimit below is deliberately KEPT even though its only caller was
// getAllUsageMetrics: it is the correct single-metric shape, it holds the
// canonical period key, and scripts/stream-routing-simulator.ts:193 slices this
// file between `incrementUsage` and `checkLimit` to prove incrementUsage writes
// on the service client — removing it would silently blank that proof's window
// and turn a passing guard into a vacuous one.
