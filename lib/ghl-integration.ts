
/**
 * GoHighLevel (GHL) Integration for AI Chat
 * Syncs chat conversations and contact data with GHL CRM
 */

import { createServiceClient } from "./supabase/service"

/**
 * Queue a contact for background enrichment via the database.
 * Avoids importing from app/actions — the enrichment worker reads this queue.
 */
async function queueContactEnrichment(contactId: string, metadata: Record<string, any> = {}): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase.from('lead_enrichment_queue').insert({
      contact_id: contactId,
      source: metadata.source ?? 'ghl_sync',
      metadata: JSON.stringify(metadata),
      status: 'pending',
      created_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[GHL] Failed to queue enrichment:', err)
  }
}

interface GHLContact {
  id?: string
  firstName: string
  lastName: string
  email?: string
  phone?: string
  tags?: string[]
  customFields?: Record<string, any>
  source?: string
}

interface GHLConversation {
  contactId: string
  locationId: string
  type: "SMS" | "Email" | "WhatsApp" | "GMB" | "FB" | "IG"
  message: string
  direction: "inbound" | "outbound"
}

export class GHLIntegration {
  private apiKey: string
  private baseUrl = "https://rest.gohighlevel.com/v1"

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.GHL_API_KEY || ""
  }

  async syncContactFromGHL(ghlContactData: any): Promise<{ success: boolean; contactId?: string; error?: string }> {
    try {
      const supabase = createServiceClient()

      // Check if contact already exists by GHL ID
      const { data: existingContact } = await supabase
        .from("contacts")
        .select("id, enriched_at")
        .eq("ghl_contact_id", ghlContactData.id)
        .single()

      if (existingContact) {
        // Update existing contact
        await supabase
          .from("contacts")
          .update({
            first_name: ghlContactData.firstName,
            last_name: ghlContactData.lastName,
            email: ghlContactData.email,
            phone: ghlContactData.phone,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingContact.id)

        // Queue for enrichment if not already enriched
        if (!existingContact.enriched_at) {
          queueContactEnrichment(existingContact.id, { source: "ghl_sync" })
        }

        return { success: true, contactId: existingContact.id }
      }

      // Create new contact
      const { data: newContact, error } = await supabase
        .from("contacts")
        .insert({
          first_name: ghlContactData.firstName,
          last_name: ghlContactData.lastName,
          email: ghlContactData.email,
          phone: ghlContactData.phone,
          ghl_contact_id: ghlContactData.id,
          source: "ghl_sync",
          status: "active",
          stage: "New Lead",
        })
        .select()
        .single()

      if (error || !newContact) {
        return { success: false, error: error?.message || "Failed to create contact" }
      }

      // Queue new contact for background enrichment
      queueContactEnrichment(newContact.id, { source: "ghl_sync" })

      return { success: true, contactId: newContact.id }
    } catch (error) {
      console.error("[GHL] Sync from GHL error:", error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * Sync contact from Supabase to GHL
   */
  async syncContactToGHL(contactId: string): Promise<{ success: boolean; ghlContactId?: string; error?: string }> {
    try {
      const supabase = createServiceClient()

      // Get contact from Supabase
      const { data: contact, error } = await supabase.from("contacts").select("*").eq("id", contactId).single()

      if (error || !contact) {
        return { success: false, error: "Contact not found" }
      }

      // Prepare GHL contact data
      const ghlContact: GHLContact = {
        firstName: contact.first_name,
        lastName: contact.last_name,
        email: contact.email,
        phone: contact.phone,
        tags: [contact.status, contact.intent, "ai-chat"].filter(Boolean),
        customFields: {
          themFirstScore: contact.them_first_score,
          leadTemperature: contact.temperature,
          aiChatEnabled: true,
        },
        source: "ai-chat-system",
      }

      // Check if contact exists in GHL
      if (contact.ghl_contact_id) {
        // Update existing contact
        const response = await fetch(`${this.baseUrl}/crm/contacts/${contact.ghl_contact_id}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(ghlContact),
        })

        if (!response.ok) {
          throw new Error(`GHL API error: ${response.statusText}`)
        }

        return { success: true, ghlContactId: contact.ghl_contact_id }
      } else {
        // Create new contact
        const response = await fetch(`${this.baseUrl}/crm/contacts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(ghlContact),
        })

        if (!response.ok) {
          throw new Error(`GHL API error: ${response.statusText}`)
        }

        const result = await response.json()

        // Save GHL contact ID back to Supabase
        await supabase.from("contacts").update({ ghl_contact_id: result.contact.id }).eq("id", contactId)

        return { success: true, ghlContactId: result.contact.id }
      }
    } catch (error) {
      console.error("[v0] GHL sync error:", error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * Sync chat message to GHL conversation
   */
  async syncMessageToGHL(messageId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const supabase = createServiceClient()

      // Get message and session
      const { data: message, error: msgError } = await supabase
        .from("messages")
        .select("*, chat_sessions(*)")
        .eq("id", messageId)
        .single()

      if (msgError || !message) {
        return { success: false, error: "Message not found" }
      }

      // Get contact
      const { data: contact } = await supabase
        .from("contacts")
        .select("ghl_contact_id")
        .eq("id", message.chat_sessions.contact_id)
        .single()

      if (!contact?.ghl_contact_id) {
        // Sync contact first
        const syncResult = await this.syncContactToGHL(message.chat_sessions.contact_id)
        if (!syncResult.success) {
          return syncResult
        }
      }

      // Send message to GHL
      const ghlMessage: GHLConversation = {
        contactId: contact?.ghl_contact_id ?? "",
        locationId: process.env.GHL_LOCATION_ID || "",
        type: "SMS", // Can be configured based on channel
        message: message.message,
        direction: message.sender_type === "agent" ? "outbound" : "inbound",
      }

      const response = await fetch(`${this.baseUrl}/conversations/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(ghlMessage),
      })

      if (!response.ok) {
        throw new Error(`GHL API error: ${response.statusText}`)
      }

      // Mark message as synced
      await supabase.from("messages").update({ ghl_synced: true }).eq("id", messageId)

      return { success: true }
    } catch (error) {
      console.error("[v0] GHL message sync error:", error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * Webhook handler for incoming GHL messages
   */
  async handleIncomingMessage(webhookData: any): Promise<{ success: boolean; error?: string }> {
    try {
      const supabase = createServiceClient()

      // Find contact by GHL ID
      const { data: contact } = await supabase
        .from("contacts")
        .select("id")
        .eq("ghl_contact_id", webhookData.contactId)
        .single()

      if (!contact) {
        return { success: false, error: "Contact not found" }
      }

      // Find or create chat session
      let sessionId: string

      const { data: existingSession } = await supabase
        .from("conversations")
        .select("id")
        .eq("contact_id", contact.id)
        .eq("status", "active")
        .single()

      if (existingSession) {
        sessionId = existingSession.id
      } else {
        const { data: newSession } = await supabase
          .from("conversations")
          .insert({
            contact_id: contact.id,
            agent_id: webhookData.agentId || null,
            channel: "ghl",
            status: "active",
          })
          .select()
          .single()

        sessionId = newSession.id
      }

      // Create message in database
      await supabase.from("messages").insert({
        session_id: sessionId,
        sender_type: "contact",
        message: webhookData.message,
        channel: "ghl",
        ghl_synced: true,
        ghl_message_id: webhookData.messageId,
      })

      return { success: true }
    } catch (error) {
      console.error("[v0] GHL webhook error:", error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * Send compliance-approved email via GHL
   * Only sends content that has passed compliance review
   */
  async sendComplianceApprovedEmail(data: {
    contactId: string
    ghlContactId?: string
    subject: string
    body: string
    fromEmail?: string
    complianceMetadata: {
      approvalId?: string
      contentId?: string
      agentId?: string
      userId?: string
    }
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const supabase = createServiceClient()

      // Get GHL contact ID if not provided
      let ghlContactId = data.ghlContactId
      if (!ghlContactId) {
        const { data: contact } = await supabase
          .from("contacts")
          .select("ghl_contact_id")
          .eq("id", data.contactId)
          .single()

        ghlContactId = contact?.ghl_contact_id
      }

      if (!ghlContactId) {
        // Try to sync contact first
        const syncResult = await this.syncContactToGHL(data.contactId)
        if (!syncResult.success) {
          return { success: false, error: "Contact not synced to GHL" }
        }
        ghlContactId = syncResult.ghlContactId
      }

      // Send email via GHL
      const response = await fetch(`${this.baseUrl}/conversations/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "Email",
          contactId: ghlContactId,
          subject: data.subject,
          message: data.body,
          emailFrom: data.fromEmail || process.env.GHL_DEFAULT_EMAIL,
        }),
      })

      if (!response.ok) {
        throw new Error(`GHL API error: ${response.statusText}`)
      }

      const result = await response.json()

      // Log the communication with compliance metadata
      await supabase.from("communication_audit_log").insert({
        user_id: data.complianceMetadata.userId,
        agent_id: data.complianceMetadata.agentId,
        contact_id: data.contactId,
        communication_type: "email",
        content_id: data.complianceMetadata.contentId,
        was_approved_content: !!data.complianceMetadata.approvalId,
        content_snapshot: data.body,
        compliance_check_passed: true,
        sent_via: "ghl",
        ghl_message_id: result.messageId,
      })

      return { success: true, messageId: result.messageId }
    } catch (error) {
      console.error("[v0] GHL compliance email error:", error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * Log communication for compliance audit
   */
  async logComplianceNote(data: {
    ghlContactId: string
    communicationType: string
    message: string
    compliancePassed: boolean
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await fetch(`${this.baseUrl}/crm/contacts/${data.ghlContactId}/notes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: `[Compliance ${data.compliancePassed ? "PASSED" : "FAILED"}] ${data.communicationType}: ${data.message.slice(0, 200)}...`,
          userId: "system",
        }),
      })

      return { success: true }
    } catch (error) {
      console.error("[v0] GHL compliance note error:", error)
      return { success: false, error: String(error) }
    }
  }
}

// Export singleton instance
export const ghlIntegration = new GHLIntegration()
