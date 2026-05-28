// ============================================
// SYSTEM 4.5 – READINESS LOGGER
// Logs readiness signals to activities table
// ============================================

import { createServiceClient } from "@/lib/supabase/service"
import { ReadinessOutput } from "./readiness-evaluator"

/**
 * Log single readiness evaluation to activities table.
 *
 * `activities` requires brokerage_id, agent_id, title (all NOT NULL) and
 * stores arbitrary structured data in `metadata` (jsonb) — there is no
 * `payload` column. Callers MUST pass brokerage_id and agent_id in
 * additionalContext; missing context returns a clear error rather than
 * silently no-oping with a broken INSERT.
 */
export async function logReadinessEvaluation(
  contentId: string,
  readinessOutput: ReadinessOutput,
  additionalContext?: Record<string, unknown>
): Promise<{ success: boolean; activity_id?: string; error?: string }> {
  try {
    const brokerageId = (additionalContext?.brokerage_id ?? additionalContext?.brokerageId) as string | undefined
    const agentId = (additionalContext?.agent_id ?? additionalContext?.agentId) as string | undefined
    if (!brokerageId || !agentId) {
      return {
        success: false,
        error: "brokerage_id and agent_id are required in additionalContext to log readiness evaluation",
      }
    }

    const supabase = await createServiceClient()

    const activityType =
      readinessOutput.readiness_status === "ready" ? "campaign_ready" : "campaign_blocked"

    const title =
      readinessOutput.readiness_status === "ready"
        ? "Campaign content ready"
        : `Campaign content blocked: ${(readinessOutput.blocking_reasons ?? []).slice(0, 2).join("; ") || "unknown reason"}`

    const metadata = {
      readiness_status: readinessOutput.readiness_status,
      blocking_reasons: readinessOutput.blocking_reasons,
      ready_for_channels: readinessOutput.ready_for_channels,
      evaluated_at: readinessOutput.evaluated_at,
      ...readinessOutput.metadata,
      ...additionalContext,
    }

    const { data, error } = await supabase
      .from("activities")
      .insert({
        brokerage_id: brokerageId,
        agent_id: agentId,
        entity_type: "content",
        entity_id: contentId,
        activity_type: activityType,
        title,
        metadata,
        status: "completed",
      })
      .select("id")
      .single()

    if (error) {
      console.error("[v0] Failed to log readiness evaluation:", error)
      return { success: false, error: error.message }
    }

    return { success: true, activity_id: data?.id }
  } catch (err) {
    console.error("[v0] Error logging readiness evaluation:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Batch log multiple readiness evaluations
 */
export async function batchLogReadinessEvaluations(
  evaluations: Array<{
    content_id: string
    readiness_output: ReadinessOutput
    additional_context?: Record<string, unknown>
  }>
): Promise<{
  success: boolean
  logged_count: number
  failed_count: number
  errors: string[]
}> {
  const results = await Promise.allSettled(
    evaluations.map((ev) =>
      logReadinessEvaluation(ev.content_id, ev.readiness_output, ev.additional_context)
    )
  )

  const logged_count = results.filter(
    (r) => r.status === "fulfilled" && r.value.success
  ).length
  const failed_count = results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.success)
  ).length

  const errors: string[] = []
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason?.message || "Unknown error")
    } else if (result.status === "fulfilled" && !result.value.success) {
      errors.push(result.value.error || "Unknown error")
    }
  }

  return {
    success: logged_count > 0,
    logged_count,
    failed_count,
    errors,
  }
}

/**
 * Query readiness history for specific content
 */
export async function getReadinessHistory(
  contentId: string,
  limit: number = 50
): Promise<{
  success: boolean
  evaluations?: Array<{
    id: string
    activity_type: string
    metadata: Record<string, unknown>
    created_at: string
  }>
  error?: string
}> {
  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from("activities")
      .select("id, activity_type, metadata, created_at")
      .eq("entity_type", "content")
      .eq("entity_id", contentId)
      .in("activity_type", ["campaign_ready", "campaign_blocked"])
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) {
      console.error("[v0] Failed to fetch readiness history:", error)
      return { success: false, error: error.message }
    }

    return { success: true, evaluations: data || [] }
  } catch (err) {
    console.error("[v0] Error fetching readiness history:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Get readiness statistics for a time period
 */
export async function getReadinessStatistics(
  startDate: string,
  endDate: string
): Promise<{
  success: boolean
  statistics?: {
    total_evaluations: number
    ready_count: number
    blocked_count: number
    ready_percentage: number
    top_blocking_reasons: Array<{ reason: string; count: number }>
  }
  error?: string
}> {
  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from("activities")
      .select("activity_type, metadata")
      .eq("entity_type", "content")
      .in("activity_type", ["campaign_ready", "campaign_blocked"])
      .gte("created_at", startDate)
      .lte("created_at", endDate)

    if (error) {
      console.error("[v0] Failed to fetch readiness statistics:", error)
      return { success: false, error: error.message }
    }

    const total_evaluations = data?.length || 0
    const ready_count = data?.filter((d) => d.activity_type === "campaign_ready").length || 0
    const blocked_count = data?.filter((d) => d.activity_type === "campaign_blocked").length || 0
    const ready_percentage = total_evaluations > 0 ? (ready_count / total_evaluations) * 100 : 0

    // Aggregate blocking reasons
    const blockingReasonMap = new Map<string, number>()
    for (const activity of data || []) {
      if (activity.activity_type === "campaign_blocked") {
        const reasons = (activity.metadata as any)?.blocking_reasons || []
        for (const reason of reasons) {
          blockingReasonMap.set(reason, (blockingReasonMap.get(reason) || 0) + 1)
        }
      }
    }

    const top_blocking_reasons = Array.from(blockingReasonMap.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    return {
      success: true,
      statistics: {
        total_evaluations,
        ready_count,
        blocked_count,
        ready_percentage: Math.round(ready_percentage * 100) / 100,
        top_blocking_reasons,
      },
    }
  } catch (err) {
    console.error("[v0] Error calculating readiness statistics:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Log channel-specific readiness check. Same activities constraints as
 * logReadinessEvaluation — brokerageId + agentId are required.
 */
export async function logChannelReadinessCheck(
  contentId: string,
  channel: string,
  isReady: boolean,
  reason: string | undefined,
  context: { brokerageId: string; agentId: string }
): Promise<{ success: boolean; activity_id?: string; error?: string }> {
  try {
    if (!context?.brokerageId || !context?.agentId) {
      return { success: false, error: "brokerageId and agentId required" }
    }

    const supabase = await createServiceClient()

    const metadata = {
      channel,
      is_ready: isReady,
      reason,
      checked_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from("activities")
      .insert({
        brokerage_id: context.brokerageId,
        agent_id: context.agentId,
        entity_type: "content",
        entity_id: contentId,
        activity_type: "channel_readiness_check",
        title: `Channel readiness: ${channel} → ${isReady ? "ready" : "blocked"}`,
        metadata,
        status: "completed",
      })
      .select("id")
      .single()

    if (error) {
      console.error("[v0] Failed to log channel readiness check:", error)
      return { success: false, error: error.message }
    }

    return { success: true, activity_id: data?.id }
  } catch (err) {
    console.error("[v0] Error logging channel readiness check:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * Get readiness trends over time (daily aggregates)
 */
export async function getReadinessTrends(
  startDate: string,
  endDate: string
): Promise<{
  success: boolean
  trends?: Array<{
    date: string
    ready_count: number
    blocked_count: number
    ready_percentage: number
  }>
  error?: string
}> {
  try {
    const supabase = await createServiceClient()

    const { data, error } = await supabase
      .from("activities")
      .select("activity_type, created_at")
      .eq("entity_type", "content")
      .in("activity_type", ["campaign_ready", "campaign_blocked"])
      .gte("created_at", startDate)
      .lte("created_at", endDate)
      .order("created_at", { ascending: true })

    if (error) {
      console.error("[v0] Failed to fetch readiness trends:", error)
      return { success: false, error: error.message }
    }

    // Group by date
    const dateMap = new Map<
      string,
      { ready_count: number; blocked_count: number }
    >()

    for (const activity of data || []) {
      const date = new Date(activity.created_at).toISOString().split("T")[0]
      const existing = dateMap.get(date) || { ready_count: 0, blocked_count: 0 }

      if (activity.activity_type === "campaign_ready") {
        existing.ready_count++
      } else {
        existing.blocked_count++
      }

      dateMap.set(date, existing)
    }

    const trends = Array.from(dateMap.entries()).map(([date, counts]) => {
      const total = counts.ready_count + counts.blocked_count
      const ready_percentage = total > 0 ? (counts.ready_count / total) * 100 : 0

      return {
        date,
        ready_count: counts.ready_count,
        blocked_count: counts.blocked_count,
        ready_percentage: Math.round(ready_percentage * 100) / 100,
      }
    })

    return { success: true, trends }
  } catch (err) {
    console.error("[v0] Error calculating readiness trends:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}
