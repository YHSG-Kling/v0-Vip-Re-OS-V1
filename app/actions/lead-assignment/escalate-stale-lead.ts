"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { detectStaleLeads } from "@/lib/lead-assignment"

export interface EscalationResult {
  success: boolean
  escalatedCount: number
  message: string
}

const ESCALATE_ROLES = ["broker", "broker_owner", "broker_admin", "admin", "super_admin", "superadmin"]

/**
 * Escalates stale leads to admins/brokers.
 * - Detects stale leads automatically
 * - Logs escalation event
 * - Alerts admins/brokers (informational only, no auto-assignment)
 * - Prevents duplicate escalations within 7 days
 *
 * Previously trusted a caller-supplied brokerageId with no auth — any
 * signed-in user could force-escalate another brokerage's leads.
 * Now: admin role required; brokerage derived from session.
 */
export async function escalateStaleLeads(_brokerageId?: string): Promise<EscalationResult> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, escalatedCount: 0, message: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) {
    return { success: false, escalatedCount: 0, message: "Unauthorized" }
  }
  if (!ESCALATE_ROLES.includes(callerRow.user_type ?? "")) {
    return { success: false, escalatedCount: 0, message: "Only brokers and admins can escalate stale leads" }
  }
  const brokerageId = callerRow.brokerage_id

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
