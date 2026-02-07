import { createServiceClient } from "@/lib/supabase/service"

export interface StaleLead {
  id: string
  firstName: string
  lastName: string
  email: string
  leadStage: string
  lastActivityDate: string | null
  daysStale: number
  staleReason: "no_assignment" | "no_recent_activity"
}

const STALE_THRESHOLD_DAYS = 7

/**
 * Detects stale leads based on assignment and activity criteria
 * - No agent assigned after 7 days
 * - No recent AI ISA or agent activity in 7 days
 */
export async function detectStaleLeads(brokerageId: string): Promise<StaleLead[]> {
  const supabase = createServiceClient()
  const staleDate = new Date()
  staleDate.setDate(staleDate.getDate() - STALE_THRESHOLD_DAYS)
  const staleDateStr = staleDate.toISOString()

  // Find leads without assigned agents older than 7 days
  const { data: unassignedLeads, error: unassignedError } = await supabase
    .from("leads")
    .select("id, first_name, last_name, email, lead_stage, created_at")
    .eq("brokerage_id", brokerageId)
    .is("agent_id", null)
    .lt("created_at", staleDateStr)
    .eq("is_active", true)

  if (unassignedError) {
    console.error("[detectStaleLeads] Error fetching unassigned leads:", unassignedError)
    return []
  }

  const staleLeads: StaleLead[] = []

  // Process each unassigned lead
  for (const lead of unassignedLeads || []) {
    const createdAt = new Date(lead.created_at)
    const daysStale = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))

    staleLeads.push({
      id: lead.id,
      firstName: lead.first_name || "",
      lastName: lead.last_name || "",
      email: lead.email || "",
      leadStage: lead.lead_stage || "new",
      lastActivityDate: lead.created_at,
      daysStale,
      staleReason: "no_assignment"
    })
  }

  // Find leads with agents but no recent activity
  const { data: assignedLeads, error: assignedError } = await supabase
    .from("leads")
    .select("id, first_name, last_name, email, lead_stage, agent_id")
    .eq("brokerage_id", brokerageId)
    .not("agent_id", "is", null)
    .eq("is_active", true)

  if (assignedError) {
    console.error("[detectStaleLeads] Error fetching assigned leads:", assignedError)
    return staleLeads
  }

  // Check last activity for assigned leads
  for (const lead of assignedLeads || []) {
    const { data: lastActivity } = await supabase
      .from("activities")
      .select("created_at")
      .eq("contact_id", lead.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (lastActivity) {
      const lastActivityDate = new Date(lastActivity.created_at)
      const daysSinceActivity = Math.floor((Date.now() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24))

      if (daysSinceActivity >= STALE_THRESHOLD_DAYS) {
        staleLeads.push({
          id: lead.id,
          firstName: lead.first_name || "",
          lastName: lead.last_name || "",
          email: lead.email || "",
          leadStage: lead.lead_stage || "new",
          lastActivityDate: lastActivity.created_at,
          daysStale: daysSinceActivity,
          staleReason: "no_recent_activity"
        })
      }
    }
  }

  return staleLeads
}
