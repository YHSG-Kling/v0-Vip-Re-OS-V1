
/**
 * GoHighLevel (GHL) Integration for AI Chat
 * Syncs chat conversations and contact data with GHL CRM
 */

import { createServiceClient } from "./supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// DELETED — a private `queueContactEnrichment(contactId, metadata)`.
// Survivor: lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment.
//
// It was a fourth private copy of the queue write and it carried NOTHING the
// survivor lacks — no freshness check, no already-pending check, no live-deal
// suppression. What it did carry was a defect: it omitted `brokerage_id`.
// lead_enrichment_queue.brokerage_id is nullable so the INSERT succeeded, but
// the drain (lib/lead-pipeline/enrichment-orchestrator.ts:processEnrichmentQueue)
// selects `.eq('brokerage_id', brokerageId)` — every row it wrote was invisible
// to every drain, forever. Per the burn-down method the bad implementation is
// not ported; the class is fixed at the survivor, which REQUIRES the tenant and
// refuses without it rather than writing an un-processable row.
//
// It also had no caller. That is not why it is gone — the surface it belongs to
// is INBOUND CRM import, and that surface is already wired: lib/crm/import-pull.ts
// (the GoHighLevel puller included) feeds processImportRows →
// lib/contact-pipeline/contact-capture.ts:captureContact →
// queueContactEnrichmentAndScore, which now calls the survivor. The capability
// this function was reaching for is finished and connected; this copy is the
// redundant one.

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

  /** All egress through the connector-gateway with bearer auth. */
  private async request<T = any>(
    path: string,
    method: "GET" | "POST" | "PUT",
    body?: unknown,
  ): Promise<{ ok: boolean; data: T | null; error: string | null }> {
    const res = await callConnector<T>({
      connector: "ghl",
      baseUrl: this.baseUrl,
      path,
      method,
      auth: { style: "bearer", token: this.apiKey },
      ...(body !== undefined ? { body } : {}),
    })
    return { ok: res.ok, data: res.data, error: res.error }
  }

  // DISABLED: GHL is SYNC-OUT ONLY. The app pushes contact/detail updates OUT to GoHighLevel
  // and never ingests contacts from a CRM (no CRM syncs into the app — product decision).
  async syncContactFromGHL(_ghlContactData: any): Promise<{ success: boolean; contactId?: string; error?: string }> {
    return { success: false, error: "Inbound CRM sync is disabled — GHL is sync-out only" }
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
        const response = await this.request(`/crm/contacts/${contact.ghl_contact_id}`, "PUT", ghlContact)

        if (!response.ok) {
          throw new Error(`GHL API error: ${response.error ?? "request failed"}`)
        }

        return { success: true, ghlContactId: contact.ghl_contact_id }
      } else {
        // Create new contact
        const response = await this.request<{ contact?: { id?: string } }>("/crm/contacts", "POST", ghlContact)

        if (!response.ok) {
          throw new Error(`GHL API error: ${response.error ?? "request failed"}`)
        }

        const result = response.data ?? {}

        // Save GHL contact ID back to Supabase
        // The error is READ. This is the ONLY link back to the row just created in
        // GHL — a refusal returns success with a ghlContactId the platform never
        // stored, so the next sync creates a SECOND GHL contact for the same person.
        const { error: ghlLinkError } = await supabase.from("contacts").update({ ghl_contact_id: result.contact?.id }).eq("id", contactId)
        if (ghlLinkError) {
          console.error(`[ghl] ghl_contact_id link-back REFUSED for contact ${contactId}:`, ghlLinkError.message)
        }

        return { success: true, ghlContactId: result.contact?.id }
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
        message: message.body,
        direction: message.sender_type === "agent" ? "outbound" : "inbound",
      }

      const response = await this.request("/conversations/messages", "POST", ghlMessage)

      if (!response.ok) {
        throw new Error(`GHL API error: ${response.error ?? "request failed"}`)
      }

      // Mark message as synced
      await supabase.from("messages").update({ metadata: { ghl_synced: true } }).eq("id", messageId)

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
    // GHL is configured as ONE-WAY sync OUT for contact data — it is not an
    // inbound message channel. Inbound conversations flow through email, sms,
    // ai_social_dm, and portal channels only. Accepting GHL inbound webhooks
    // here would duplicate the existing inbound channels and create
    // cross-channel attribution drift. The previous implementation also
    // wrote to conversations.channel and messages.session_id/sender_type/
    // message/channel/ghl_synced/ghl_message_id — none of which exist on the
    // live schema — so every call was a silent failure anyway.
    //
    // No-op: acknowledge receipt so GHL stops retrying the webhook, but do
    // not persist anything. Log for observability.
    console.warn(
      "[ghl-integration] handleIncomingMessage no-op — GHL is one-way OUT only",
      { contactId: webhookData?.contactId, messageId: webhookData?.messageId },
    )
    return { success: true }
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
      const response = await this.request<{ messageId?: string }>("/conversations/messages", "POST", {
        type: "Email",
        contactId: ghlContactId,
        subject: data.subject,
        message: data.body,
        emailFrom: data.fromEmail || process.env.GHL_DEFAULT_EMAIL,
      })

      if (!response.ok) {
        throw new Error(`GHL API error: ${response.error ?? "request failed"}`)
      }

      const result = response.data ?? {}

      // Log the communication with compliance metadata.
      // Live schema columns: brokerage_id, agent_id, user_id, contact_id,
      // lead_id, communication_type, lead_temperature, was_approved_content,
      // channel, subject, body_snippet, compliance_passed, sent_at, created_at.
      // brokerage_id is required for tenant isolation — resolve from the contact.
      const { data: contactRow } = await supabase
        .from("contacts")
        .select("brokerage_id")
        .eq("id", data.contactId)
        .maybeSingle()
      await supabase.from("communication_audit_log").insert({
        brokerage_id: contactRow?.brokerage_id ?? null,
        user_id: data.complianceMetadata.userId,
        agent_id: data.complianceMetadata.agentId,
        contact_id: data.contactId,
        communication_type: "email",
        was_approved_content: !!data.complianceMetadata.approvalId,
        channel: "email",
        subject: data.subject,
        body_snippet: data.body?.slice(0, 500) ?? null,
        compliance_passed: true,
        sent_at: new Date().toISOString(),
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
      await this.request(`/crm/contacts/${data.ghlContactId}/notes`, "POST", {
        body: `[Compliance ${data.compliancePassed ? "PASSED" : "FAILED"}] ${data.communicationType}: ${data.message.slice(0, 200)}...`,
        userId: "system",
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
