import { createServiceClient } from "@/lib/supabase/service"
import { excludeConvertedLeads } from "@/lib/contact-promotion/conversion-finality"

export interface StaleLead {
  id: string
  firstName: string
  lastName: string
  email: string
  leadStage: string
  lastActivityDate: string | null
  daysStale: number
  staleReason: "no_assignment" | "no_recent_activity"
  /** The conversion marker, carried so the consumer can re-check rather than
   *  trust one query filter. Always null here — converted leads are excluded. */
  contactId: string | null
}

const STALE_THRESHOLD_DAYS = 7

/**
 * Detects stale leads based on assignment and activity criteria
 * - No agent assigned after 7 days
 * - No recent AI ISA or agent activity in 7 days
 *
 * CONVERSION FINALITY: a CONVERTED lead is not a stale lead — it is a client,
 * and the ruling is that lead-keyed communication/updates cease on conversion.
 * Both sweeps below exclude `contact_id IS NOT NULL`.
 *
 * `is_active = true` was doing this job by accident and doing it badly: two of
 * the three converters stamp `is_active=false`, the third (crm.ts
 * convertLeadToContact) did NOT, so every lead converted through the manual
 * lead-desk lane stayed `is_active=true` and sailed through here. That leak is
 * closed at the converter in this same pass, but the filter belongs HERE too:
 * `contact_id` is the only marker every converter writes, and legacy rows
 * converted before the fix still carry the old, wrong `is_active`.
 */
export async function detectStaleLeads(brokerageId: string): Promise<StaleLead[]> {
  const supabase = createServiceClient()
  const staleDate = new Date()
  staleDate.setDate(staleDate.getDate() - STALE_THRESHOLD_DAYS)
  const staleDateStr = staleDate.toISOString()

  // Find leads without assigned agents older than 7 days
  const { data: unassignedLeads, error: unassignedError } = await excludeConvertedLeads(
    supabase
      .from("leads")
      .select("id, first_name, last_name, email, lead_stage, created_at")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .lt("created_at", staleDateStr)
      .eq("is_active", true),
  )

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
      staleReason: "no_assignment",
      contactId: null,
    })
  }

  // Find leads with agents but no recent activity
  const { data: assignedLeads, error: assignedError } = await excludeConvertedLeads(
    supabase
      .from("leads")
      .select("id, first_name, last_name, email, lead_stage, agent_id")
      .eq("brokerage_id", brokerageId)
      .not("agent_id", "is", null)
      .eq("is_active", true),
  )

  if (assignedError) {
    console.error("[detectStaleLeads] Error fetching assigned leads:", assignedError)
    return staleLeads
  }

  // Check last activity for assigned leads
  for (const lead of assignedLeads || []) {
    const { data: lastEvent } = await supabase
      .from("lifecycle_events")
      .select("created_at")
      .eq("entity_id", lead.id)
      .eq("entity_type", "lead")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (lastEvent) {
      const lastActivityDate = new Date(lastEvent.created_at)
      const daysSinceActivity = Math.floor(
        (Date.now() - lastActivityDate.getTime()) / (1000 * 60 * 60 * 24)
      )
      if (daysSinceActivity >= STALE_THRESHOLD_DAYS) {
        staleLeads.push({
          id: lead.id,
          firstName: lead.first_name || "",
          lastName: lead.last_name || "",
          email: lead.email || "",
          leadStage: lead.lead_stage || "new",
          lastActivityDate: lastEvent.created_at,
          daysStale: daysSinceActivity,
          staleReason: "no_recent_activity",
          contactId: null,
        })
      }
    }
  }

  return staleLeads
}
