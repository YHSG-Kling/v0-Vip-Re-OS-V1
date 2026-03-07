"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { detectStaleLeads } from "@/lib/lead-assignment"

export interface EscalationResult {
  success: boolean
  escalatedCount: number
  message: string
}

/**
 * Escalates stale leads to admins/brokers
 * - Detects stale leads automatically
 * - Logs escalation event
 * - Alerts admins/brokers (informational only, no auto-assignment)
 * - Prevents duplicate escalations within 7 days
 */
export async function escalateStaleLeads(brokerageId: string): Promise<EscalationResult> {
  const supabase = createServiceClient()

  try {
    console.log(`[v0] Detecting stale leads for brokerage ${brokerageId}`)

    // Step 1: Detect stale leads
    const staleLeads = await detectStaleLeads(brokerageId)

    if (staleLeads.length === 0) {
      return {
        success: true,
        escalatedCount: 0,
        message: "No stale leads found"
      }
    }

    console.log(`[v0] Found ${staleLeads.length} stale leads`)

    let escalatedCount = 0

    // Step 2: Process each stale lead
    for (const lead of staleLeads) {
      // Check if already escalated within last 7 days
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

      const { data: recentEscalation } = await supabase
        .from("activities")
        .select("id")
        .eq("contact_id", lead.id)
        .eq("activity_type", "lead_escalation")
        .gte("created_at", sevenDaysAgo.toISOString())
        .limit(1)
        .single()

      if (recentEscalation) {
        console.log(`[StaleLead] Lead ${lead.id} already escalated recently, skipping`)
        continue
      }

      // Step 3: Log escalation activity — Agent task (correct location, no changes) — activity_type: lead_escalation
      const { error: activityError } = await supabase.from("activities").insert({
        contact_id: lead.id,
        activity_type: "lead_escalation",
        title: "Stale Lead Escalation",
        description: `Lead has been stale for ${lead.daysStale} days. Reason: ${lead.staleReason}. Last activity: ${lead.lastActivityDate || "none"}`,
        status: "pending",
        priority: "high",
        brokerage_id: brokerageId,
        created_at: new Date().toISOString()
      })

      if (activityError) {
        console.error(`[StaleLead] Failed to log escalation for lead ${lead.id}:`, activityError)
        continue
      }

      escalatedCount++
      console.log(`[v0] Escalated lead ${lead.id} (${lead.email})`)
    }

    return {
      success: true,
      escalatedCount,
      message: `Successfully escalated ${escalatedCount} stale leads to admins/brokers`
    }

  } catch (error: any) {
    console.error("[escalateStaleLeads] Error:", error)

    // Log to automation_errors
    await supabase.from("automation_errors").insert({
      workflow_name: "stale_lead_escalation",
      error_message: error.message || "Unknown error during escalation",
      severity: "medium",
      status: "unresolved",
      context_json: JSON.stringify({
        brokerageId,
        timestamp: new Date().toISOString()
      }),
      created_at: new Date().toISOString()
    })

    return {
      success: false,
      escalatedCount: 0,
      message: "An error occurred during escalation"
    }
  }
}
