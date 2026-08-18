
// SERVICE CLIENT for the audit writes, on purpose (m483): this shared service
// is reachable from CONSUMER sessions (app/actions/calculators.ts
// sendCalculatorResults, app/actions/collaborative-search.ts
// sendCollaborativeSearchInvite), and the message_provider_logs /
// communication_audit_log / activities rows it appends are post-send AUDIT
// records — the calling route/action's own gate is the authorization, and the
// audit row must not depend on the caller's RLS seat (the staff-seat-tightened
// INSERT policies rightly refuse a consumer seat). The provider SEND itself is
// unchanged.
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import {
  sendSMS as providerSendSMS,
  sendEmail as providerSendEmail,
} from "@/lib/providers/messaging"

/**
 * Unified Communication Service
 * Handles email, SMS, and notification sending across the platform
 * Replaces scattered TODO: Send email/SMS comments throughout codebase
 */

export interface SendEmailParams {
  to: string
  subject: string
  htmlBody: string
  textBody?: string
  from?: string
  replyTo?: string
  metadata?: any
  /** Optional audit context. Required to land a row in
   *  message_provider_logs (brokerage_id is NOT NULL there). If neither
   *  is supplied, the email still sends — the audit log is just skipped. */
  brokerageId?: string
  contactId?: string
  /** agents.id — recorded but not strictly required. */
  agentId?: string
}

export interface SendSMSParams {
  to: string
  message: string
  from?: string
  metadata?: any
  brokerageId?: string
  contactId?: string
  agentId?: string
}

export interface LogCommunicationParams {
  contactId?: string
  /** agents.id of the sending agent. OPTIONAL — outbound to a raw `lead`
   *  has no assigned agent (ISA owns those); outbound to a `contact`
   *  may have one. Audit row stores agent_id as nullable. */
  agentId?: string
  /** Communication channels supported in this product:
   *  email, sms — transactional + agent ↔ contact
   *  ai_social_dm — outbound AI DM on IG/FB/LinkedIn/Twitter
   *  portal — agent ↔ client message in the client portal
   *  notification — push-style in-app notification
   *  GHL is intentionally NOT a channel — it's a one-way contact-data
   *  sync target (push), not a message transport. */
  communicationType: "email" | "sms" | "ai_social_dm" | "portal" | "notification"
  subject?: string
  content: string
  status: "sent" | "failed" | "queued"
  metadata?: any
}

// Resolve brokerage_id from explicit param, falling back to a contact lookup.
// Returns null when neither path yields a brokerage; callers MUST skip the
// audit-log INSERT in that case (message_provider_logs.brokerage_id NOT NULL).
async function resolveAuditBrokerageId(
  supabase: any,
  brokerageId?: string,
  contactId?: string,
): Promise<string | null> {
  if (brokerageId) return brokerageId
  if (!contactId) return null
  const { data } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  return data?.brokerage_id ?? null
}

/**
 * Send email through the configured provider chain (personal email →
 * SendGrid) and append a message_provider_logs row when brokerage context
 * is supplied. The send itself runs regardless; audit is best-effort.
 */
export async function sendEmail(params: SendEmailParams) {
  try {
    const result = await providerSendEmail({
      to: params.to,
      subject: params.subject,
      html: params.htmlBody,
      text: params.textBody,
      from: params.from,
    })

    // Audit. Skip entirely if we can't resolve a brokerage — the table's
    // brokerage_id is NOT NULL and fabricating a value would corrupt
    // tenancy. The provider send already happened above.
    const supabase = createServiceClient()
    const brokerageId = await resolveAuditBrokerageId(
      supabase, params.brokerageId, params.contactId,
    )
    if (brokerageId) {
      const { error: auditError } = await supabase.from("message_provider_logs").insert({
        brokerage_id: brokerageId,
        channel: "email",
        direction: "outbound",
        provider_key: result.provider ?? "sendgrid",
        provider_status: result.success ? "sent" : "failed",
        error_message: result.success ? null : (result.error ?? null),
        sent_at: result.success ? new Date().toISOString() : null,
        provider_response: { recipient: params.to, subject: params.subject, ...(params.metadata ?? {}) },
      })
      if (auditError) {
        console.error("[CommunicationService] message_provider_logs (email) audit row refused:", auditError.message)
      }
    }

    return result
  } catch (error) {
    console.error("[CommunicationService] Send email error:", error)
    return handleError(error, "sendEmail")
  }
}

/**
 * Send SMS through the configured provider chain. Audit-logs to
 * message_provider_logs when brokerage context can be resolved.
 */
export async function sendSMS(params: SendSMSParams) {
  try {
    const result = await providerSendSMS({
      to: params.to,
      message: params.message,
    })

    const supabase = createServiceClient()
    const brokerageId = await resolveAuditBrokerageId(
      supabase, params.brokerageId, params.contactId,
    )
    if (brokerageId) {
      const providerKey = ((result as any)?.provider as string | undefined) ?? "twilio"
      const { error: auditError } = await supabase.from("message_provider_logs").insert({
        brokerage_id: brokerageId,
        channel: "sms",
        direction: "outbound",
        provider_key: providerKey,
        provider_status: result.success ? "sent" : "failed",
        error_message: result.success ? null : (result.error ?? null),
        sent_at: result.success ? new Date().toISOString() : null,
        provider_response: { recipient: params.to, message_excerpt: params.message.slice(0, 200), ...(params.metadata ?? {}) },
      })
      if (auditError) {
        console.error("[CommunicationService] message_provider_logs (sms) audit row refused:", auditError.message)
      }
    }

    return result
  } catch (error) {
    console.error("[CommunicationService] Send SMS error:", error)
    return handleError(error, "sendSMS")
  }
}

// sendViaGHL was removed. GoHighLevel is NOT a message-send channel in
// this product — it's a one-way contact-data sync target (push). Outbound
// contact communication routes through email / sms / ai_social_dm / portal.
// GHL sync is owned by lib/services/platform-sync.service.ts and
// lib/ghl-integration.ts (PUT/POST contact updates to GHL's REST API).

/**
 * Log communication to database and optionally to contact interactions
 */
export async function logCommunication(params: LogCommunicationParams) {
  try {
    // Audit-only function — same service-client rationale as the header note.
    const supabase = createServiceClient()

    // Write to communication_audit_log (the canonical communication content
    // audit table — carries subject/body_snippet/channel/compliance state).
    // brokerage_id is NOT NULL there; look it up from the contact when the
    // caller didn't supply it.
    let auditBrokerageId: string | null = null
    let contactRow: { agent_id: string | null; brokerage_id: string | null } | null = null
    if (params.contactId && isValidUUID(params.contactId)) {
      const { data } = await supabase
        .from("contacts")
        .select("agent_id, brokerage_id")
        .eq("id", params.contactId)
        .maybeSingle()
      contactRow = data ?? null
      auditBrokerageId = contactRow?.brokerage_id ?? null
    }

    if (auditBrokerageId) {
      // channel column is free-text; pass the canonical value through.
      // `notification` is mapped to in_app for transport consistency with
      // message_provider_logs.channel CHECK.
      const channel =
        params.communicationType === "notification" ? "in_app" : params.communicationType
      const { error: auditLogError } = await supabase.from("communication_audit_log").insert({
        brokerage_id: auditBrokerageId,
        contact_id: params.contactId ?? null,
        agent_id: params.agentId ?? contactRow?.agent_id ?? null,
        communication_type: params.communicationType,
        channel,
        subject: params.subject ?? null,
        body_snippet: params.content.slice(0, 500),
        compliance_passed: params.status === "sent" ? true : null,
        sent_at: params.status === "sent" ? new Date().toISOString() : null,
      })
      if (auditLogError) {
        console.error("[CommunicationService] communication_audit_log row refused:", auditLogError.message)
      }
    }

    // Also log as an activity (the agent-facing communication-event log)
    // when both agent_id and brokerage_id can be resolved from the contact.
    if (params.contactId && isValidUUID(params.contactId)) {

      const agentId = (params.agentId && isValidUUID(params.agentId))
        ? params.agentId
        : contactRow?.agent_id ?? null
      const brokerageId = contactRow?.brokerage_id ?? null
      const channel =
        params.communicationType === "notification" ? "in_app" : params.communicationType
      const notes = params.subject || params.content.substring(0, 100)

      if (agentId && brokerageId) {
        const { error: activityError } = await supabase.from("activities").insert({
          contact_id: params.contactId,
          agent_id: agentId,
          brokerage_id: brokerageId,
          entity_type: "contact",
          activity_type: `communication_${channel}`,
          channel,
          title: notes,
          notes,
          outcome: params.status === "sent" ? "completed" : "failed",
          status: params.status === "sent" ? "completed" : "failed",
        })
        if (activityError) {
          console.error("[CommunicationService] communication activity row refused:", activityError.message)
        }
      }
    }

    return { success: true }
  } catch (error) {
    return handleError(error, "logCommunication")
  }
}

/**
 * Send calculator results via email
 */
export async function sendCalculatorResults(params: {
  email: string
  calculationType: string
  results: any
  calculationId: string
}) {
  const htmlBody = `
    <html>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Your ${params.calculationType} Results</h2>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <pre style="white-space: pre-wrap;">${JSON.stringify(params.results, null, 2)}</pre>
        </div>
        <p>
          <a href="${process.env.NEXT_PUBLIC_APP_URL}/calculators/${params.calculationId}" 
             style="background: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
            View Full Results
          </a>
        </p>
      </body>
    </html>
  `

  return await sendEmail({
    to: params.email,
    subject: `Your ${params.calculationType} Results`,
    htmlBody,
    textBody: `View your ${params.calculationType} results at ${process.env.NEXT_PUBLIC_APP_URL}/calculators/${params.calculationId}`,
    metadata: { calculationId: params.calculationId },
  })
}

/**
 * Send collaborative search invitation
 */
export async function sendCollaborativeSearchInvite(params: {
  email: string
  inviterName: string
  inviteToken: string
  searchId: string
}) {
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL}/search/join?token=${params.inviteToken}`

  const htmlBody = `
    <html>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You're Invited to Collaborate on a Property Search!</h2>
        <p>${params.inviterName} has invited you to join their property search.</p>
        <p>
          <a href="${inviteUrl}" 
             style="background: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
            Join Search
          </a>
        </p>
        <p style="color: #666; font-size: 14px;">
          This invitation link expires in 7 days.
        </p>
      </body>
    </html>
  `

  return await sendEmail({
    to: params.email,
    subject: `${params.inviterName} invited you to collaborate on a property search`,
    htmlBody,
    textBody: `Join the search: ${inviteUrl}`,
    metadata: { searchId: params.searchId, inviteToken: params.inviteToken },
  })
}

/**
 * Send anniversary/touchpoint message to past client
 */
export async function sendAnniversaryMessage(params: {
  contactId: string
  email?: string
  phone?: string
  message: string
  occasionType: string
}) {
  const results = []

  // Send email if available
  if (params.email) {
    const emailResult = await sendEmail({
      to: params.email,
      subject: `Happy ${params.occasionType}!`,
      htmlBody: `
        <html>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Happy ${params.occasionType}!</h2>
            <p style="font-size: 16px; line-height: 1.6;">${params.message}</p>
          </body>
        </html>
      `,
      metadata: { contactId: params.contactId, occasionType: params.occasionType },
    })
    results.push(emailResult)
  }

  // Send SMS if available
  if (params.phone) {
    const smsResult = await sendSMS({
      to: params.phone,
      message: params.message,
      metadata: { contactId: params.contactId, occasionType: params.occasionType },
    })
    results.push(smsResult)
  }

  return { success: true, results }
}

// (The vendor booking-confirmation twin was retired — zero callers; the live
// rail is lib/communications/vendor-communications.tsx, which now sends
// through dispatchEmail and logs the delivery ledger. Keep-one.)
