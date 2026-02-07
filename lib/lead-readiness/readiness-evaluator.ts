import { createServiceClient } from "@/lib/supabase/service"

// Readiness states are DERIVED from existing data, not stored
export type ReadinessState =
  | "ai_qualifying"           // AI ISA is still working
  | "ready_for_assignment"    // Qualified, no agent yet
  | "assigned_active"         // Has agent, activity is fresh
  | "stalled_no_response"     // Has agent but stale (7+ days)
  | "broker_review_required"  // Inconsistent state or flagged

export type ReadinessEvaluation = {
  state: ReadinessState
  explanation: string
  recommendedAction: string
  staleDays?: number
  lastActivityDate?: Date | null
  warnings: string[]
}

const STALE_THRESHOLD_DAYS = 7

/**
 * Evaluates a lead's readiness state by analyzing existing fields.
 * Does NOT modify the lead or assign agents.
 * This is a pure derivation function for UI and decision support.
 */
export async function evaluateLeadReadiness(leadId: string): Promise<ReadinessEvaluation | null> {
  const supabase = createServiceClient()

  // Fetch lead with relevant fields
  const { data: lead, error } = await supabase
    .from("leads")
    .select("id, agent_id, lead_score, lead_stage, enrichment_status, enrichment_confidence, motivation_confidence, last_contacted_at, created_at")
    .eq("id", leadId)
    .single()

  if (error || !lead) {
    console.error("[v0] Lead readiness evaluation failed:", error)
    return null
  }

  // Fetch last meaningful activity
  const { data: activities } = await supabase
    .from("activities")
    .select("created_at, activity_type")
    .eq("contact_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)

  const lastActivity = activities?.[0]
  const lastActivityDate = lastActivity ? new Date(lastActivity.created_at) : null
  const now = new Date()

  // Calculate days since last contact or creation
  const referenceDate = lastActivityDate || new Date(lead.created_at)
  const staleDays = Math.floor((now.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24))

  const warnings: string[] = []

  // RULE 1: AI ISA is still qualifying
  // Low scores, early stage, enrichment pending
  if (
    !lead.agent_id &&
    (lead.enrichment_status === "pending" || lead.enrichment_status === "in_progress") &&
    (lead.lead_score === null || lead.lead_score < 50)
  ) {
    return {
      state: "ai_qualifying",
      explanation: `AI ISA is currently qualifying this lead. Enrichment status: ${lead.enrichment_status}. Lead score not yet finalized.`,
      recommendedAction: "Wait for AI ISA to complete qualification before manual intervention.",
      staleDays,
      lastActivityDate,
      warnings
    }
  }

  // RULE 2: Ready for assignment
  // Qualified (score >= 50), no agent, not stale
  if (
    !lead.agent_id &&
    lead.lead_score !== null &&
    lead.lead_score >= 50 &&
    staleDays < STALE_THRESHOLD_DAYS
  ) {
    return {
      state: "ready_for_assignment",
      explanation: `Lead is qualified (score: ${lead.lead_score}) and ready for agent assignment. No agent currently assigned.`,
      recommendedAction: "Assign an agent to begin human follow-up.",
      staleDays,
      lastActivityDate,
      warnings
    }
  }

  // RULE 3: Assigned and active
  // Has agent, activity is recent
  if (lead.agent_id && staleDays < STALE_THRESHOLD_DAYS) {
    return {
      state: "assigned_active",
      explanation: `Lead is assigned to an agent and has recent activity (${staleDays} days ago).`,
      recommendedAction: "Agent is actively working this lead. No intervention needed.",
      staleDays,
      lastActivityDate,
      warnings
    }
  }

  // RULE 4: Stalled - no response
  // Has agent OR qualified without agent, but stale
  if (staleDays >= STALE_THRESHOLD_DAYS) {
    if (lead.agent_id) {
      warnings.push("Agent has not followed up in 7+ days")
      return {
        state: "stalled_no_response",
        explanation: `Lead was assigned to an agent but has been inactive for ${staleDays} days. Last activity: ${lastActivityDate?.toLocaleDateString() || "unknown"}.`,
        recommendedAction: "Escalate to broker for review. Agent may need support or lead may need reassignment.",
        staleDays,
        lastActivityDate,
        warnings
      }
    } else {
      warnings.push("No agent assigned after 7+ days")
      return {
        state: "stalled_no_response",
        explanation: `Lead has been qualified for ${staleDays} days but no agent has been assigned.`,
        recommendedAction: "Urgently assign an agent or review qualification criteria.",
        staleDays,
        lastActivityDate,
        warnings
      }
    }
  }

  // RULE 5: Broker review required (catch-all)
  // Inconsistent state, low confidence, or edge case
  if (
    (lead.enrichment_confidence !== null && lead.enrichment_confidence < 0.5) ||
    (lead.motivation_confidence !== null && lead.motivation_confidence < 0.5)
  ) {
    warnings.push("Low confidence scores detected")
  }

  return {
    state: "broker_review_required",
    explanation: `Lead does not fit standard patterns. Enrichment confidence: ${lead.enrichment_confidence}, motivation confidence: ${lead.motivation_confidence}. Manual review recommended.`,
    recommendedAction: "Broker should review this lead's data quality and qualification status.",
    staleDays,
    lastActivityDate,
    warnings
  }
}

/**
 * Generates a detailed human-readable summary for UI display
 */
export function generateHandoffContext(evaluation: ReadinessEvaluation): string {
  const lines: string[] = []

  lines.push(`**Status:** ${evaluation.state.replace(/_/g, " ").toUpperCase()}`)
  lines.push(`**Explanation:** ${evaluation.explanation}`)
  lines.push(`**Recommended Action:** ${evaluation.recommendedAction}`)

  if (evaluation.staleDays !== undefined) {
    lines.push(`**Days Since Last Activity:** ${evaluation.staleDays}`)
  }

  if (evaluation.lastActivityDate) {
    lines.push(`**Last Activity Date:** ${evaluation.lastActivityDate.toLocaleDateString()}`)
  }

  if (evaluation.warnings.length > 0) {
    lines.push(`**Warnings:**`)
    evaluation.warnings.forEach(w => lines.push(`  - ${w}`))
  }

  return lines.join("\n")
}
