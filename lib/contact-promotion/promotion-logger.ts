// Agent task (correct location, no changes) — activity_type: lead_promotion
/**
 * Logs lead-to-contact promotion events
 * 
 * This creates the canonical activity that marks:
 * - The formal start of the relationship lifecycle
 * - The first event in the contact's history
 * - Attribution from lead to contact
 */

export interface PromotionLogData {
  leadId: string
  contactId: string
  agentId: string
  brokerageId: string
  reason: string
}

export async function logPromotionActivity(
  supabase: any,
  data: PromotionLogData
): Promise<{ success: boolean; error?: string }> {
  
  try {
    await supabase.from("activities").insert({
      contact_id: data.contactId,
      agent_id: data.agentId,
      brokerage_id: data.brokerageId,
      activity_type: "lead_promotion",
      title: "Lead Promoted to Contact",
      description: `Lead ${data.leadId} promoted to contact. Reason: ${data.reason}. Relationship lifecycle formally begins.`,
      status: "completed",
      created_at: new Date().toISOString()
    })

    console.log(`[PromotionLogger] Promotion logged for contact ${data.contactId}`)

    return { success: true }

  } catch (error: any) {
    console.error("[logPromotionActivity] Error:", error)
    return {
      success: false,
      error: error.message || "Failed to log promotion activity"
    }
  }
}
