// Agent task (correct location, no changes): none — this file was Type B
// SYSTEM 4.2 – COMPLIANCE SIGNAL LOGGING
// Writes compliance evaluations to compliance_events table (NOT activities)

import { createClient } from "@/lib/supabase/server"
import { ComplianceVerdict } from "./compliance-engine"

const GATE_NAME_MAP: Record<string, string> = {
  brand_voice:  "brand_voice",
  tcpa:         "tcpa",
  authority:    "authority",
  fair_housing: "fair_housing",
  them_first:   "them_first",
}

function resolveGateName(contentType: string, channelIntent: string): string {
  // Map content/channel combos to canonical gate names
  if (channelIntent === "sms" || channelIntent === "call") return "tcpa"
  if (contentType === "fair_housing_scan")                  return "fair_housing"
  if (contentType === "brand_voice_check")                  return "brand_voice"
  if (contentType === "them_first_check")                   return "them_first"
  return GATE_NAME_MAP[contentType] ?? "brand_voice"
}

/**
 * Log compliance evaluation to compliance_events table.
 * This is the ONLY database write allowed by System 4.2.
 */
export async function logComplianceEvaluation(params: {
  agent_id?: string
  content_id?: string
  content_type: string
  channel_intent: string
  verdict: ComplianceVerdict
  content_preview?: string
  entity_type?: string
  entity_id?: string
  brokerage_id?: string
  message_type?: string
}): Promise<{ success: boolean; activity_id?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const gate_name  = resolveGateName(params.content_type, params.channel_intent)
    const allowed    = params.verdict.compliance_status === "pass"
    const violations = params.verdict.violations.map((v: any) =>
      typeof v === "string" ? v : v.description ?? v.rule ?? JSON.stringify(v)
    )

    const { data, error } = await supabase
      .from("compliance_events")
      .insert({
        brokerage_id:   params.brokerage_id ?? null,
        gate_name,
        allowed,
        violations,
        blocked_reason: allowed
          ? null
          : `${params.verdict.summary.total_violations} violation(s): ${params.verdict.summary.highest_severity}`,
        actor_role:     null,
        entity_type:    params.entity_type ?? "content",
        entity_id:      params.entity_id   ?? params.content_id ?? null,
        actor_user_id:  params.agent_id    ?? null,
        message_type:   params.message_type ?? params.channel_intent ?? null,
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
 * Log batch compliance evaluations.
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
    if (result.success) logged_count++
  }
  return { success: true, logged_count }
}

/**
 * Get compliance evaluation history from compliance_events.
 */
export async function getComplianceEvaluationHistory(params: {
  agent_id?: string
  limit?: number
  status_filter?: "pass" | "fail" | "review_required"
}): Promise<
  Array<{
    id: string
    gate_name: string
    allowed: boolean
    violations: string[]
    blocked_reason: string | null
    entity_type: string | null
    entity_id: string | null
    actor_user_id: string | null
    created_at: string
  }>
> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("compliance_events")
      .select("id, gate_name, allowed, violations, blocked_reason, entity_type, entity_id, actor_user_id, created_at")
      .order("created_at", { ascending: false })

    if (params.agent_id) query = query.eq("actor_user_id", params.agent_id)
    if (params.limit)    query = query.limit(params.limit)

    if (params.status_filter) {
      if (params.status_filter === "pass") query = query.eq("allowed", true)
      else                                  query = query.eq("allowed", false)
    }

    const { data, error } = await query
    if (error) {
      console.error("[System 4.2] Failed to get compliance history:", error)
      return []
    }
    return data ?? []
  } catch (error) {
    console.error("[System 4.2] Error getting compliance history:", error)
    return []
  }
}

/**
 * Get compliance statistics aggregated from compliance_events.
 */
export async function getComplianceStats(params: {
  agent_id?: string
  date_range?: { start: string; end: string }
}): Promise<{
  total_evaluations: number
  pass_count: number
  fail_count: number
  review_required_count: number
  by_gate: Record<string, { pass: number; fail: number }>
  common_violations: Array<{ violation: string; count: number }>
}> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("compliance_events")
      .select("gate_name, allowed, violations, created_at")

    if (params.agent_id)             query = query.eq("actor_user_id", params.agent_id)
    if (params.date_range) {
      query = query
        .gte("created_at", params.date_range.start)
        .lte("created_at", params.date_range.end)
    }

    const { data, error } = await query

    if (error || !data) {
      return { total_evaluations: 0, pass_count: 0, fail_count: 0, review_required_count: 0, by_gate: {}, common_violations: [] }
    }

    const by_gate: Record<string, { pass: number; fail: number }> = {}
    const violation_counts: Record<string, number> = {}
    let pass_count = 0
    let fail_count = 0

    for (const row of data) {
      if (row.allowed) pass_count++
      else             fail_count++

      if (!by_gate[row.gate_name]) by_gate[row.gate_name] = { pass: 0, fail: 0 }
      if (row.allowed) by_gate[row.gate_name].pass++
      else             by_gate[row.gate_name].fail++

      for (const v of (row.violations ?? [])) {
        violation_counts[v] = (violation_counts[v] ?? 0) + 1
      }
    }

    const common_violations = Object.entries(violation_counts)
      .map(([violation, count]) => ({ violation, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    return {
      total_evaluations:    data.length,
      pass_count,
      fail_count,
      review_required_count: 0, // compliance_events is binary allowed/blocked
      by_gate,
      common_violations,
    }
  } catch (error) {
    console.error("[System 4.2] Error getting compliance stats:", error)
    return { total_evaluations: 0, pass_count: 0, fail_count: 0, review_required_count: 0, by_gate: {}, common_violations: [] }
  }
}
