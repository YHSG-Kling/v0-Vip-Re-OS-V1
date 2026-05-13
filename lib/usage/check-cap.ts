/**
 * lib/usage/check-cap.ts
 *
 * Pre-flight cap check for chargeable actions. Resolves the brokerage's plan
 * tier → the limit for this metric → compares with the current month's usage
 * → returns one of:
 *
 *   { allowed: true,  used, limit, percent, soft_warning: false }   below soft
 *   { allowed: true,  used, limit, percent, soft_warning: true }    >= soft, < hard
 *   { allowed: false, used, limit, percent }                        >= hard
 *
 * Caller decides whether to soft-warn the user or hard-block. The portal live
 * avatar session route hard-blocks at the cap; the Twin Studio voice clone
 * action soft-warns at 80% so the user can still finish their setup.
 *
 * Returns { allowed: true, limit: -1 } when limit_value === -1 (unlimited).
 * Returns { allowed: true } and an info-level error if the brokerage row
 * can't be read — usage caps are advisory, never the path that takes a
 * customer down.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { MediaMetric } from "./log-media-usage"

export type CapMetric = MediaMetric | "llm_calls" | "sms_sent" | "emails_sent" | "storage_gb" | "ai_tokens_monthly"

export interface CapResult {
  allowed: boolean
  used: number
  limit: number
  percent: number
  soft_warning: boolean
  /** Only set when soft-warning or blocked — friendly message for the UI. */
  message?: string
  /** Only set on error. */
  error?: string
}

const UNLIMITED: CapResult = {
  allowed: true,
  used: 0,
  limit: -1,
  percent: 0,
  soft_warning: false,
}

export async function checkUsageCap(params: {
  brokerageId: string
  metric: CapMetric
  /** Add this much to the current count and check the result against the cap.
   *  Use for pre-flight — e.g., "if this 5-minute session goes through, do
   *  we cross the cap?" Default 0 (just inspecting current state). */
  addQuantity?: number
}): Promise<CapResult> {
  const supabase = createServiceClient()

  // 1. Plan tier
  const { data: brokerage, error: brokerageError } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", params.brokerageId)
    .maybeSingle()

  if (brokerageError || !brokerage) {
    // Fail open — never let a usage check kill the user's flow.
    return { ...UNLIMITED, error: brokerageError?.message ?? "brokerage not found" }
  }

  const planTier = brokerage.plan_tier ?? "solo_agent"

  // 2. Limit for (tier, metric)
  const { data: limitRow } = await supabase
    .from("plan_limits")
    .select("limit_value, soft_limit_threshold")
    .eq("plan_tier", planTier)
    .eq("metric", params.metric)
    .maybeSingle()

  if (!limitRow) {
    // No limit row = uncapped (defensive — shouldn't happen after seed).
    return UNLIMITED
  }

  const limit = Number(limitRow.limit_value)
  const softThreshold = Number(limitRow.soft_limit_threshold ?? 0.8)

  if (limit < 0) return UNLIMITED // -1 = unlimited

  // 3. Current month usage
  const now = new Date()
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

  const { data: counter } = await supabase
    .from("usage_counters")
    .select("value")
    .eq("brokerage_id", params.brokerageId)
    .eq("period_start", periodStart.toISOString())
    .eq("period_end", periodEnd.toISOString())
    .eq("metric", params.metric)
    .maybeSingle()

  const used = Number(counter?.value ?? 0) + Math.max(0, params.addQuantity ?? 0)
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const softLimit = Math.floor(limit * softThreshold)

  if (used >= limit) {
    return {
      allowed: false,
      used,
      limit,
      percent,
      soft_warning: false,
      message: friendlyHardCapMessage(params.metric),
    }
  }

  if (used >= softLimit) {
    return {
      allowed: true,
      used,
      limit,
      percent,
      soft_warning: true,
      message: friendlySoftCapMessage(params.metric, percent),
    }
  }

  return { allowed: true, used, limit, percent, soft_warning: false }
}

function friendlyHardCapMessage(metric: CapMetric): string {
  switch (metric) {
    case "live_avatar_minutes":
      return "You've reached your monthly live AI conversation limit. Upgrade to keep talking face-to-face."
    case "live_avatar_sessions":
      return "You've reached your monthly live AI session limit. Upgrade for more."
    case "tts_characters":
      return "You've reached your monthly voice synthesis limit."
    case "voice_clones_created":
      return "You've created the maximum twins for this month."
    case "avatars_created":
      return "You've created the maximum twins for this month."
    case "vapi_minutes":
      return "You've reached your monthly AI calling limit."
    case "llm_calls":
      return "You've reached your monthly AI request limit."
    case "video_minutes":
      return "You've reached your monthly video generation limit."
    case "live_assistant_minutes":
      return "You've reached your monthly on-the-go assistant limit. Upgrade to keep using it."
    case "live_assistant_sessions":
      return "You've reached your monthly assistant session limit. Upgrade for more."
    default:
      return "You've reached this month's plan limit."
  }
}

function friendlySoftCapMessage(metric: CapMetric, percent: number): string {
  return `You've used ${percent}% of your monthly allowance for ${metricLabel(metric)}.`
}

function metricLabel(metric: CapMetric): string {
  switch (metric) {
    case "live_avatar_minutes": return "live AI conversations"
    case "live_avatar_sessions": return "live AI sessions"
    case "tts_characters": return "voice synthesis"
    case "voice_clones_created": return "twin voices"
    case "avatars_created": return "twin avatars"
    case "vapi_minutes": return "AI calling"
    case "llm_calls": return "AI requests"
    case "video_minutes": return "video generation"
    case "live_assistant_minutes": return "on-the-go assistant"
    case "live_assistant_sessions": return "assistant sessions"
    default: return metric
  }
}
