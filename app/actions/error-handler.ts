"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

export async function getErrorGroups(filters?: {
  severity?: string
  status?: string
  dateRange?: { from: string; to: string }
  limit?: number
}) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  let query = supabase
    .from("automation_errors")
    .select("*")
    .eq("brokerage_id", brokerageId)

  if (filters?.severity) {
    query = query.eq("severity", filters.severity)
  }

  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  if (filters?.dateRange) {
    query = query
      .gte("created_at", filters.dateRange.from)
      .lte("created_at", filters.dateRange.to)
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(filters?.limit || 100)

  if (error) {
    console.error("Error fetching error groups:", error)
    throw new Error("Failed to fetch error groups")
  }

  return data
}

export async function getErrorGroupDetails(groupId: string) {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from("automation_errors")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("id", groupId)
    .single()

  if (error) {
    console.error("Error fetching group details:", error)
    throw new Error("Failed to fetch group details")
  }

  return data
}

export async function dismissErrorGroup(groupId: string, reason: string) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  // Update error group status
  const { error: updateError } = await supabase
    .from("automation_errors")
    .update({
      status: "dismissed",
      dismissed_at: new Date().toISOString(),
      dismissed_by: userId,
      dismiss_reason: reason,
    })
    .eq("id", groupId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    console.error("Error dismissing group:", updateError)
    throw new Error("Failed to dismiss error group")
  }

  // Record activity (fire-and-forget)
  void supabase
    .from("activities")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: userId,
      activity_type: "error_group_dismissed",
      status: "completed",
      metadata: { error_group_id: groupId, reason },
    })

  return { success: true }
}

export async function resolveErrorGroup(groupId: string, solution: string) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  const { error: updateError } = await supabase
    .from("automation_errors")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      resolution_notes: solution,
    })
    .eq("id", groupId)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    console.error("Error resolving group:", updateError)
    throw new Error("Failed to resolve error group")
  }

  // Record activity (fire-and-forget)
  void supabase
    .from("activities")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: userId,
      activity_type: "error_group_resolved",
      status: "completed",
      metadata: { error_group_id: groupId, solution },
    })

  return { success: true }
}

export async function assignErrorGroup(groupId: string, assigneeId: string) {
  const supabase = await createClient()
  const { brokerageId, userId } = await getAgentContext()

  const { error } = await supabase
    .from("automation_errors")
    .update({
      assigned_to: assigneeId,
      assigned_at: new Date().toISOString(),
      assigned_by: userId,
    })
    .eq("id", groupId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("Error assigning group:", error)
    throw new Error("Failed to assign error group")
  }

  return { success: true }
}

export async function getErrorMetrics() {
  const supabase = await createClient()
  const { brokerageId } = await getAgentContext()

  // Get error counts by severity for last 24 hours
  const { data: severityCounts } = await supabase
    .from("automation_errors")
    .select("severity")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

  // Get top error types
  const { data: topErrors } = await supabase
    .from("automation_errors")
    .select("error_type, error_count")
    .eq("brokerage_id", brokerageId)
    .order("error_count", { ascending: false })
    .limit(5)

  // Get retry success rate
  const { data: retryStats } = await supabase
    .from("automation_errors")
    .select("status, retry_count")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

  const severity = {
    critical: severityCounts?.filter(e => e.severity === "critical").length || 0,
    high: severityCounts?.filter(e => e.severity === "high").length || 0,
    medium: severityCounts?.filter(e => e.severity === "medium").length || 0,
    low: severityCounts?.filter(e => e.severity === "low").length || 0,
  }

  const totalRetries = retryStats?.reduce((sum, e) => sum + (e.retry_count || 0), 0) || 0
  const successfulRetries = retryStats?.filter(e => e.status === "resolved").length || 0
  const retrySuccessRate = totalRetries > 0 ? (successfulRetries / totalRetries) * 100 : 0

  return {
    severityCounts: severity,
    topErrors: topErrors || [],
    retrySuccessRate: Math.round(retrySuccessRate),
    totalErrors24h: severityCounts?.length || 0,
  }
}
