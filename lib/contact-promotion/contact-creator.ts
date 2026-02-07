/**
 * Creates a contact record from a promoted lead
 * 
 * Critical Rules:
 * - Only copy relationship-safe data
 * - Do NOT copy internal intelligence fields (lead_score, enrichment_status)
 * - Associate with agent and brokerage
 * - Contacts represent active relationships
 */

export interface ContactCreationData {
  leadId: string
  lead: any
  agentId: string
  brokerageId: string
}

export async function createContactFromLead(
  supabase: any,
  data: ContactCreationData
): Promise<{ contactId?: string; error?: string }> {
  
  try {
    // Map lead data to contact schema
    // Only copy relationship-safe fields
    const contactData = {
      // Basic identity
      first_name: data.lead.first_name,
      last_name: data.lead.last_name,
      email: data.lead.email,
      phone: data.lead.phone,
      
      // Attribution
      source: data.lead.source || 'lead_promotion',
      
      // Relationship context
      agent_id: data.agentId,
      brokerage_id: data.brokerageId,
      
      // Contact type and persona (if available)
      contact_type: data.lead.lead_type || 'prospect',
      contact_persona: data.lead.contact_persona,
      
      // Intent indicators (if available)
      timeline: data.lead.timeline,
      intent_score: data.lead.intent_score,
      
      // Status
      status: 'active',
      
      // Metadata
      notes: `Promoted from lead ${data.leadId}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { data: contact, error } = await supabase
      .from("contacts")
      .insert(contactData)
      .select()
      .single()

    if (error) {
      throw new Error(`Failed to create contact: ${error.message}`)
    }

    console.log(`[v0] Contact ${contact.id} created from lead ${data.leadId}`)

    return { contactId: contact.id }

  } catch (error: any) {
    console.error("[createContactFromLead] Error:", error)
    return {
      error: error.message || "Failed to create contact"
    }
  }
}
