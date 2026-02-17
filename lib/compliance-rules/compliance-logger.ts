"use server"

import { createClient } from "@/lib/supabase/server"
import { ComplianceVerdict } from "./compliance-engine"

// ============================================
// SYSTEM 4.2 – COMPLIANCE SIGNAL LOGGING
// Logs compliance evaluations to activities table (ONLY)
// ============================================

/**
 * Log compliance evaluation to activities table
 * This is the ONLY database write allowed by System 4.2
 */
export async function logComplianceEvaluation(params: {
  agent_id?: string
  content_id?: string // Runtime UUID (not persisted elsewhere)
  content_type: string
  channel_intent: string
  verdict: ComplianceVerdict
  content_preview?: string // First 200 chars only
}): Promise<{ success: boolean; activity_id?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("activities")
      .insert({
        agent_id: params.agent_id || null,
        entity_type: "content",
        entity_id: params.content_id || null,
        activity_type: "compliance_evaluated",
        title: `Compliance check: ${params.verdict.compliance_status}`,
        description: `Evaluated ${params.content_type} for ${params.channel_intent} channel`,
        notes: JSON.stringify({
          compliance_status: params.verdict.compliance_status,
          total_violations: params.verdict.summary.total_violations,
          highest_severity: params.verdict.summary.highest_severity,
          by_category: params.verdict.summary.by_category,
          by_severity: params.verdict.summary.by_severity,
          required_actions: params.verdict.required_actions,
          evaluated_at: params.verdict.evaluated_at,
          content_type: params.content_type,
          channel_intent: params.channel_intent,
          content_preview: params.content_preview,
          // DO NOT store full content or full violation details
          violation_count_only: params.verdict.violations.length,
        }),
        status: params.verdict.compliance_status === "pass" ? "completed" : "pending",
        completed_at: params.verdict.compliance_status === "pass" ? new Date().toISOString() : null,
      })
      .select("id")
      .single()

    if (error) {
      console.error("[System 4.2] Failed to log compliance evaluation:", error)
      return { success: false, error: error.message }
    }

    return { success: true, activity_id: data.id }
  } catch (error) {
    console.error("[System 4.2] Error logging compliance evaluation:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log batch compliance evaluations
 */
export async function logBatchComplianceEvaluations(
  evaluations: Array<{
    agent_id?: string
    content_id?: string
    content_type: string
    channel_intent: string
    verdict: ComplianceVerdict
    content_preview?: string
  }>
): Promise<{ success: boolean; logged_count: number }> {
  let logged_count = 0

  for (const evaluation of evaluations) {
    const result = await logComplianceEvaluation(evaluation)
    if (result.success) {
      logged_count++
    }
  }

  return { success: true, logged_count }
}

/**
 * Get compliance evaluation history from activities
 */
export async function getComplianceEvaluationHistory(params: {
  agent_id?: string
  limit?: number
  status_filter?: "pass" | "fail" | "review_required"
}): Promise<
  Array<{
    id: string
    title: string
    description: string
    activity_type: string
    notes: any
    status: string
    completed_at: string | null
    created_at: string
  }>
> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("id, title, description, activity_type, notes, status, completed_at, created_at")
      .eq("activity_type", "compliance_evaluated")
      .order("created_at", { ascending: false })

    if (params.agent_id) {
      query = query.eq("agent_id", params.agent_id)
    }

    if (params.limit) {
      query = query.limit(params.limit)
    }

    const { data, error } = await query

    if (error) {
      console.error("[System 4.2] Failed to get compliance history:", error)
      return []
    }

    // Filter by status if specified
    if (params.status_filter && data) {
      return data.filter((activity) => {
        try {
          const notes = typeof activity.notes === "string" ? JSON.parse(activity.notes) : activity.notes
          return notes.compliance_status === params.status_filter
        } catch {
          return false
        }
      })
    }

    return data || []
  } catch (error) {
    console.error("[System 4.2] Error getting compliance history:", error)
    return []
  }
}

/**
 * Get compliance statistics (aggregated from activities)
 */
export async function getComplianceStats(params: {
  agent_id?: string
  date_range?: { start: string; end: string }
}): Promise<{
  total_evaluations: number
  pass_count: number
  fail_count: number
  review_required_count: number
  by_content_type: Record<string, { pass: number; fail: number; review: number }>
  by_channel: Record<string, { pass: number; fail: number; review: number }>
  common_violations: Array<{ category: string; count: number }>
}> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("notes, created_at")
      .eq("activity_type", "compliance_evaluated")

    if (params.agent_id) {
      query = query.eq("agent_id", params.agent_id)
    }

    if (params.date_range) {
      query = query.gte("created_at", params.date_range.start).lte("created_at", params.date_range.end)
    }

    const { data, error } = await query

    if (error || !data) {
      return {
        total_evaluations: 0,
        pass_count: 0,
        fail_count: 0,
        review_required_count: 0,
        by_content_type: {},
        by_channel: {},
        common_violations: [],
      }
    }

    const stats = {
      total_evaluations: data.length,
      pass_count: 0,
      fail_count: 0,
      review_required_count: 0,
      by_content_type: {} as Record<string, { pass: number; fail: number; review: number }>,
      by_channel: {} as Record<string, { pass: number; fail: number; review: number }>,
      violation_categories: {} as Record<string, number>,
    }

    for (const activity of data) {
      try {
        const notes = typeof activity.notes === "string" ? JSON.parse(activity.notes) : activity.notes

        const status = notes.compliance_status
        const contentType = notes.content_type || "unknown"
        const channel = notes.channel_intent || "general"

        // Count by status
        if (status === "pass") stats.pass_count++
        else if (status === "fail") stats.fail_count++
        else if (status === "review_required") stats.review_required_count++

        // Count by content type
        if (!stats.by_content_type[contentType]) {
          stats.by_content_type[contentType] = { pass: 0, fail: 0, review: 0 }
        }
        if (status === "pass") stats.by_content_type[contentType].pass++
        else if (status === "fail") stats.by_content_type[contentType].fail++
        else if (status === "review_required") stats.by_content_type[contentType].review++

        // Count by channel
        if (!stats.by_channel[channel]) {
          stats.by_channel[channel] = { pass: 0, fail: 0, review: 0 }
        }
        if (status === "pass") stats.by_channel[channel].pass++
        else if (status === "fail") stats.by_channel[channel].fail++
        else if (status === "review_required") stats.by_channel[channel].review++

        // Count violation categories
        if (notes.by_category) {
          for (const [category, count] of Object.entries(notes.by_category)) {
            if (typeof count === "number" && count > 0) {
              stats.violation_categories[category] = (stats.violation_categories[category] || 0) + count
            }
          }
        }
      } catch {
        // Skip malformed entries
      }
    }

    // Convert violation categories to sorted array
    const common_violations = Object.entries(stats.violation_categories)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10) // Top 10

    return {
      ...stats,
      common_violations,
    }
  } catch (error) {
    console.error("[System 4.2] Error getting compliance stats:", error)
    return {
      total_evaluations: 0,
      pass_count: 0,
      fail_count: 0,
      review_required_count: 0,
      by_content_type: {},
      by_channel: {},
      common_violations: [],
    }
  }
}
