
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

interface SendEmailParams {
  to: string
  subject: string
  htmlBody: string
  textBody?: string
  from?: string
  metadata?: any
}

interface SendSMSParams {
  to: string
  message: string
  metadata?: any
}

// TOMBSTONE (§1 orphan doctrine, DUPLICATES ROUND 5, lane 59C, 2026-09-12):
// sendEmail / sendSMS NO LONGER PUBLIC — the previous exported versions plus
// their message_provider_logs synchronous audit write (and the
// resolveAuditBrokerageId helper it used) are deleted. SURVIVOR for the send
// itself: lib/providers/messaging/index.ts's sendEmail (:268) / sendSMS (:51)
// — the actually-called send path (9 live callers; see that file's own
// header). What these thin, now-PRIVATE wrappers keep is exactly the field
// translation sendCalculatorResults / sendCollaborativeSearchInvite /
// sendAnniversaryMessage below need (htmlBody/textBody → html/text) — they
// have no callers outside this file, so nothing needed the public export
// (the lib/services barrel's re-export of these two names was removed as
// part of this same tombstone; it had zero importers). The audit-log
// capability these used to add is not carried forward: message_provider_logs
// already has live writers with STRONGER data (the SendGrid/Twilio status
// webhooks record the provider's ACTUAL delivery status, not an immediate
// "sent" guess), so no reader of that table loses a row class that only this
// path produced.
async function sendEmail(params: SendEmailParams) {
  try {
    return await providerSendEmail({
      to: params.to,
      subject: params.subject,
      html: params.htmlBody,
      text: params.textBody,
      from: params.from,
    })
  } catch (error) {
    console.error("[CommunicationService] Send email error:", error)
    return handleError(error, "sendEmail")
  }
}

async function sendSMS(params: SendSMSParams) {
  try {
    return await providerSendSMS({
      to: params.to,
      message: params.message,
    })
  } catch (error) {
    console.error("[CommunicationService] Send SMS error:", error)
    return handleError(error, "sendSMS")
  }
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
  /** approved_content_library id when the send used pre-approved content.
   *  Stamps was_approved_content on the audit row — the column the daily
   *  compliance cron's unapproved-content sweep reads. (Merged from the
   *  deleted logCommunicationWithComplianceService, lane E2 2026-08-28.) */
  approvedContentId?: string
}

// TOMBSTONE (§1 orphan doctrine, DUPLICATES ROUND 5, lane 59C, 2026-09-12):
// sendEmail / sendSMS / resolveAuditBrokerageId DELETED — zero in-tree
// callers (neither directly nor through the lib/services barrel re-export,
// also removed below). SURVIVOR: lib/providers/messaging/index.ts's
// sendEmail (:268) / sendSMS (:51) — the actually-called send path (9 live
// callers: app/actions/lender-status-request.ts, instant-property-alerts.ts,
// voice-call-bridge.ts, the weekly-income-digest cron, lib/contact-validation.ts,
// lib/transactions/deal-vendor-notify.ts, lib/kernel/vendors.ts, and
// lib/providers/dispatch.ts's dispatchEmail/dispatchSms, which these dead
// wrappers were NOT part of). The one thing these wrappers added over the
// survivor — a synchronous message_provider_logs audit row right after the
// send call — is not carried forward: message_provider_logs already has live
// writers with STRONGER data (app/api/webhooks/sendgrid-events/route.ts,
// app/api/webhooks/twilio-sms-status/route.ts record the provider's actual
// delivery status via webhook, not an immediate "sent" guess), so no reader
// of that table loses a row class that only this dead path produced.

// sendViaGHL was removed. GoHighLevel is NOT a message-send channel in
// this product — it's a one-way contact-data sync target (push). Outbound
// contact communication routes through email / sms / ai_social_dm / portal.
// GHL sync is owned by services/goHighLevelService.ts, reached through
// lib/crm/sync.ts:syncContactToCRM (lib/ghl-integration.ts, once named here,
// was deleted 2026-08-27 as a whole-module duplicate — tombstone at the top
// of services/goHighLevelService.ts). The other half of that sentence used to name
// lib/services/platform-sync.service.ts, which is DELETED — see the tombstone at
// lib/services/index.ts:29 for where each of its halves went.

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
    let contactRow: { agent_id: string | null; brokerage_id: string | null; lead_temperature: string | null } | null = null
    if (params.contactId && isValidUUID(params.contactId)) {
      const { data } = await supabase
        .from("contacts")
        .select("agent_id, brokerage_id, lead_temperature")
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

      // ── COLD-LEAD CHANNEL RULE (merged from the deleted
      // logCommunicationWithComplianceService, §1 keep-one, lane E2
      // 2026-08-28). Cold leads may only be reached via email or print mail.
      // The daily compliance cron (app/api/cron/compliance-monitoring)
      // sweeps communication_audit_log for lead_temperature='cold' rows
      // outside those channels — columns that previously had NO writer on any
      // reachable path, so the sweep could never fire. The temperature comes
      // from the CONTACT ROW, never from the caller.
      const leadTemperature = contactRow?.lead_temperature ?? null
      const coldChannelViolation =
        params.status === "sent" &&
        leadTemperature === "cold" &&
        !["email", "print"].includes(params.communicationType)
      if (coldChannelViolation) {
        const { error: flagError } = await supabase.from("compliance_flags").insert({
          brokerage_id: auditBrokerageId,
          agent_id: params.agentId ?? contactRow?.agent_id ?? null,
          contact_id: params.contactId ?? null,
          content_type: params.communicationType,
          violation_type: "cold_lead_channel_violation",
          flagged_content: {
            channel_used: params.communicationType,
            lead_temperature: leadTemperature,
            allowed_channels: ["email", "print"],
          },
          severity: "high",
          status: "flagged",
          detected_at: new Date().toISOString(),
        })
        if (flagError) {
          console.error("[CommunicationService] cold-lead compliance_flags row refused:", flagError.message)
        }
      }

      // communication_audit_log.lead_id (m611 FK, unapplied) — WRITERLESS
      // until now: this insert never set it, so lib/contact-promotion/
      // history-carry.ts's REPOINTED_HISTORY_TABLES re-point
      // (`.eq("lead_id", leadId)` at conversion time) always matched zero
      // rows here. contacts and leads are disjoint (CLAUDE.md §4) and linked
      // only via `leads.contact_id = contacts.id` (the LINK stamped by
      // history-carry.ts on conversion) — never via contacts.contact_id,
      // which is an unrelated secondary uuid on the SAME table (§3 trap).
      // Best-effort reverse lookup: a contact can in principle trace back to
      // more than one lead after a dedup merge, so this picks the most
      // recently converted one; a miss (never a lead, e.g. a direct contact
      // import) leaves lead_id null exactly as before.
      let auditLeadId: string | null = null
      if (params.contactId && isValidUUID(params.contactId)) {
        const { data: leadRow } = await supabase
          .from("leads")
          .select("id")
          .eq("contact_id", params.contactId)
          .eq("brokerage_id", auditBrokerageId)
          .order("converted_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        auditLeadId = (leadRow?.id as string | undefined) ?? null
      }

      const { error: auditLogError } = await supabase.from("communication_audit_log").insert({
        brokerage_id: auditBrokerageId,
        contact_id: params.contactId ?? null,
        lead_id: auditLeadId,
        agent_id: params.agentId ?? contactRow?.agent_id ?? null,
        communication_type: params.communicationType,
        channel,
        subject: params.subject ?? null,
        body_snippet: params.content.slice(0, 500),
        lead_temperature: leadTemperature,
        was_approved_content: !!params.approvedContentId,
        compliance_passed: coldChannelViolation ? false : params.status === "sent" ? true : null,
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
