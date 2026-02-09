"use server"

import { createClient } from "@/lib/supabase/server"
import { ApprovalDecision } from "./approval-engine"

// ============================================
// SYSTEM 4.3 – APPROVAL SIGNAL LOGGING
// Logs approval decisions to activities table (ONLY)
// ============================================

/**
 * Log approval decision to activities table
 * This is the ONLY database write allowed by System 4.3
 */
export async function logApprovalDecision(params: {
  agent_id?: string
  content_id?: string // Runtime UUID (not persisted elsewhere)
  decision: ApprovalDecision
  requester_role: string
  content_preview?: string // First 200 chars only
}): Promise<{ success: boolean; activity_id?: string; error?: string }> {
  try {
    const supabase = await createClient()

    // Map approval status to activity type
    const activityTypeMap: Record<string, string> = {
      approved: "approval_auto_granted",
      pending: "approval_required",
      rejected: "approval_rejected",
    }

    const activityType = activityTypeMap[params.decision.approval_status] || "approval_decision"

    const { data, error } = await supabase
      .from("activities")
      .insert({
        agent_id: params.agent_id || null,
        entity_type: "content",
        entity_id: params.content_id || null,
        activity_type: activityType,
        title: `Approval ${params.decision.approval_status}: ${params.decision.metadata.content_type}`,
        description: `${params.decision.approval_status} for ${params.decision.metadata.channel_intent} content`,
        notes: JSON.stringify({
          approval_status: params.decision.approval_status,
          required_approvers: params.decision.required_approvers || [],
          blocking_reason: params.decision.blocking_reason,
          approval_notes: params.decision.approval_notes || [],
          decided_at: params.decision.decided_at,
          metadata: params.decision.metadata,
          requester_role: params.requester_role,
          content_preview: params.content_preview,
          // DO NOT store full content or compliance verdict
          signal_only: true,
        }),
        status: params.decision.approval_status === "approved" ? "completed" : "pending",
        completed_at: params.decision.approval_status === "approved" ? new Date().toISOString() : null,
      })
      .select("id")
      .single()

    if (error) {
      console.error("[System 4.3] Failed to log approval decision:", error)
      return { success: false, error: error.message }
    }

    return { success: true, activity_id: data.id }
  } catch (error) {
    console.error("[System 4.3] Error logging approval decision:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Log batch approval decisions
 */
export async function logBatchApprovalDecisions(
  decisions: Array<{
    agent_id?: string
    content_id?: string
    decision: ApprovalDecision
    requester_role: string
    content_preview?: string
  }>
): Promise<{ success: boolean; logged_count: number }> {
  let logged_count = 0

  for (const item of decisions) {
    const result = await logApprovalDecision(item)
    if (result.success) {
      logged_count++
    }
  }

  return { success: true, logged_count }
}

/**
 * Get approval decision history from activities
 */
export async function getApprovalDecisionHistory(params: {
  agent_id?: string
  limit?: number
  status_filter?: "approved" | "pending" | "rejected"
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
      .in("activity_type", ["approval_auto_granted", "approval_required", "approval_rejected"])
      .order("created_at", { ascending: false })

    if (params.agent_id) {
      query = query.eq("agent_id", params.agent_id)
    }

    if (params.limit) {
      query = query.limit(params.limit)
    }

    const { data, error } = await query

    if (error) {
      console.error("[System 4.3] Failed to get approval history:", error)
      return []
    }

    // Filter by status if specified
    if (params.status_filter && data) {
      return data.filter((activity) => {
        try {
          const notes = typeof activity.notes === "string" ? JSON.parse(activity.notes) : activity.notes
          return notes.approval_status === params.status_filter
        } catch {
          return false
        }
      })
    }

    return data || []
  } catch (error) {
    console.error("[System 4.3] Error getting approval history:", error)
    return []
  }
}

/**
 * Get approval statistics (aggregated from activities)
 */
export async function getApprovalStats(params: {
  agent_id?: string
  date_range?: { start: string; end: string }
}): Promise<{
  total_decisions: number
  approved_count: number
  pending_count: number
  rejected_count: number
  auto_approved_count: number
  by_content_type: Record<string, { approved: number; pending: number; rejected: number }>
  by_channel: Record<string, { approved: number; pending: number; rejected: number }>
  by_requester_role: Record<string, { approved: number; pending: number; rejected: number }>
  common_blocking_reasons: Array<{ reason: string; count: number }>
}> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("notes, created_at")
      .in("activity_type", ["approval_auto_granted", "approval_required", "approval_rejected"])

    if (params.agent_id) {
      query = query.eq("agent_id", params.agent_id)
    }

    if (params.date_range) {
      query = query.gte("created_at", params.date_range.start).lte("created_at", params.date_range.end)
    }

    const { data, error } = await query

    if (error || !data) {
      return {
        total_decisions: 0,
        approved_count: 0,
        pending_count: 0,
        rejected_count: 0,
        auto_approved_count: 0,
        by_content_type: {},
        by_channel: {},
        by_requester_role: {},
        common_blocking_reasons: [],
      }
    }

    const stats = {
      total_decisions: data.length,
      approved_count: 0,
      pending_count: 0,
      rejected_count: 0,
      auto_approved_count: 0,
      by_content_type: {} as Record<string, { approved: number; pending: number; rejected: number }>,
      by_channel: {} as Record<string, { approved: number; pending: number; rejected: number }>,
      by_requester_role: {} as Record<string, { approved: number; pending: number; rejected: number }>,
      blocking_reasons: {} as Record<string, number>,
    }

    for (const activity of data) {
      try {
        const notes = typeof activity.notes === "string" ? JSON.parse(activity.notes) : activity.notes

        const status = notes.approval_status
        const contentType = notes.metadata?.content_type || "unknown"
        const channel = notes.metadata?.channel_intent || "general"
        const requesterRole = notes.requester_role || "unknown"
        const autoApproved = notes.metadata?.auto_approved === true

        // Count by status
        if (status === "approved") {
          stats.approved_count++
          if (autoApproved) stats.auto_approved_count++
        } else if (status === "pending") {
          stats.pending_count++
        } else if (status === "rejected") {
          stats.rejected_count++
        }

        // Count by content type
        if (!stats.by_content_type[contentType]) {
          stats.by_content_type[contentType] = { approved: 0, pending: 0, rejected: 0 }
        }
        if (status === "approved") stats.by_content_type[contentType].approved++
        else if (status === "pending") stats.by_content_type[contentType].pending++
        else if (status === "rejected") stats.by_content_type[contentType].rejected++

        // Count by channel
        if (!stats.by_channel[channel]) {
          stats.by_channel[channel] = { approved: 0, pending: 0, rejected: 0 }
        }
        if (status === "approved") stats.by_channel[channel].approved++
        else if (status === "pending") stats.by_channel[channel].pending++
        else if (status === "rejected") stats.by_channel[channel].rejected++

        // Count by requester role
        if (!stats.by_requester_role[requesterRole]) {
          stats.by_requester_role[requesterRole] = { approved: 0, pending: 0, rejected: 0 }
        }
        if (status === "approved") stats.by_requester_role[requesterRole].approved++
        else if (status === "pending") stats.by_requester_role[requesterRole].pending++
        else if (status === "rejected") stats.by_requester_role[requesterRole].rejected++

        // Count blocking reasons
        if (notes.blocking_reason) {
          const reason = notes.blocking_reason
          stats.blocking_reasons[reason] = (stats.blocking_reasons[reason] || 0) + 1
        }
      } catch {
        // Skip malformed entries
      }
    }

    // Convert blocking reasons to sorted array
    const common_blocking_reasons = Object.entries(stats.blocking_reasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10) // Top 10

    return {
      ...stats,
      common_blocking_reasons,
    }
  } catch (error) {
    console.error("[System 4.3] Error getting approval stats:", error)
    return {
      total_decisions: 0,
      approved_count: 0,
      pending_count: 0,
      rejected_count: 0,
      auto_approved_count: 0,
      by_content_type: {},
      by_channel: {},
      by_requester_role: {},
      common_blocking_reasons: [],
    }
  }
}

/**
 * Get pending approvals requiring action
 */
export async function getPendingApprovals(params: {
  approver_role: string
  limit?: number
}): Promise<
  Array<{
    id: string
    title: string
    description: string
    notes: any
    created_at: string
  }>
> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("id, title, description, notes, created_at")
      .eq("activity_type", "approval_required")
      .eq("status", "pending")
      .order("created_at", { ascending: false })

    if (params.limit) {
      query = query.limit(params.limit)
    }

    const { data, error } = await query

    if (error) {
      console.error("[System 4.3] Failed to get pending approvals:", error)
      return []
    }

    // Filter by approver role authority
    if (data) {
      return data.filter((activity) => {
        try {
          const notes = typeof activity.notes === "string" ? JSON.parse(activity.notes) : activity.notes
          const requiredApprovers = notes.required_approvers || []
          return requiredApprovers.includes(params.approver_role)
        } catch {
          return false
        }
      })
    }

    return []
  } catch (error) {
    console.error("[System 4.3] Error getting pending approvals:", error)
    return []
  }
}
