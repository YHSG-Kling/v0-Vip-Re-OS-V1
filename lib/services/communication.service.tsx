
import { createClient } from "@/lib/supabase/server"
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
}

export interface SendSMSParams {
  to: string
  message: string
  from?: string
  metadata?: any
}

export interface LogCommunicationParams {
  contactId?: string
  agentId?: string
  communicationType: "email" | "sms" | "notification"
  subject?: string
  content: string
  status: "sent" | "failed" | "queued"
  metadata?: any
}

/**
 * Send email via your email provider (SendGrid, Resend, etc.)
 * Currently logs to database - integrate with actual provider
 */
export async function sendEmail(params: SendEmailParams) {
  try {
    // Delegate to lib/providers/messaging (SendGrid)
    const result = await providerSendEmail({
      to: params.to,
      subject: params.subject,
      html: params.htmlBody,
      text: params.textBody,
      from: params.from,
    })

    // Log to communications table regardless of provider outcome
    const supabase = await createClient()
    await supabase.from("communications_log").insert({
      recipient: params.to,
      type: "email",
      subject: params.subject,
      content: params.htmlBody,
      status: result.success ? "sent" : "failed",
      sent_at: new Date().toISOString(),
      metadata: params.metadata,
    })

    return result
  } catch (error) {
    console.error("[CommunicationService] Send email error:", error)
    return handleError(error, "sendEmail")
  }
}

/**
 * Send SMS via your SMS provider (Twilio, GHL, etc.)
 * Currently logs to database - integrate with actual provider
 */
export async function sendSMS(params: SendSMSParams) {
  try {
    // Delegate to lib/providers/messaging (Twilio)
    const result = await providerSendSMS({
      to: params.to,
      message: params.message,
    })

    // Log to communications table regardless of provider outcome
    const supabase = await createClient()
    await supabase.from("communications_log").insert({
      recipient: params.to,
      type: "sms",
      content: params.message,
      status: result.success ? "sent" : "failed",
      sent_at: new Date().toISOString(),
      metadata: params.metadata,
    })

    return result
  } catch (error) {
    console.error("[CommunicationService] Send SMS error:", error)
    return handleError(error, "sendSMS")
  }
}

/**
 * Send via GoHighLevel (if integrated)
 */
export async function sendViaGHL(params: {
  contactId: string
  type: "email" | "sms"
  message: string
  subject?: string
}) {
  try {
    const supabase = await createClient()

    // Get GHL contact ID
    const { data: contact } = await supabase
      .from("contacts")
      .select("ghl_contact_id, email, phone")
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      throw new Error("Contact not found")
    }

    console.log(`[v0] Sending ${params.type} via GHL to contact ${params.contactId}`)

    // TODO: Replace with actual GHL API integration
    /*
    const ghlResponse = await fetch('https://rest.gohighlevel.com/v1/conversations/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: params.type,
        contactId: contact.ghl_contact_id,
        message: params.message,
      }),
    })
    */

    // Log the communication
    await supabase.from("communications_log").insert({
      contact_id: params.contactId,
      recipient: params.type === "email" ? contact.email : contact.phone,
      type: params.type,
      subject: params.subject,
      content: params.message,
      status: "sent",
      sent_at: new Date().toISOString(),
      provider: "gohighlevel",
    })

    return { success: true }
  } catch (error) {
    return handleError(error, "sendViaGHL")
  }
}

/**
 * Log communication to database and optionally to contact interactions
 */
export async function logCommunication(params: LogCommunicationParams) {
  try {
    const supabase = await createClient()

    await supabase.from("communications_log").insert({
      contact_id: params.contactId || null,
      agent_id: params.agentId || null,
      type: params.communicationType,
      subject: params.subject,
      content: params.content,
      status: params.status,
      sent_at: new Date().toISOString(),
      metadata: params.metadata,
    })

    // Also log as interaction if contact is specified
    if (params.contactId && isValidUUID(params.contactId)) {
      await supabase.from("interactions").insert({
        contact_id: params.contactId,
        interaction_type: params.communicationType === "email" ? "email" : "sms",
        interaction_date: new Date().toISOString(),
        notes: params.subject || params.content.substring(0, 100),
        outcome: params.status === "sent" ? "completed" : "failed",
      })
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

/**
 * Send vendor booking confirmation
 */
export async function sendVendorBookingConfirmation(params: {
  vendorEmail: string
  vendorName: string
  serviceType: string
  bookingDetails: any
}) {
  const htmlBody = `
    <html>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Booking Request</h2>
        <p>Hello ${params.vendorName},</p>
        <p>You have received a new booking request for ${params.serviceType}.</p>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3>Booking Details:</h3>
          <pre style="white-space: pre-wrap;">${JSON.stringify(params.bookingDetails, null, 2)}</pre>
        </div>
        <p>Please confirm your availability as soon as possible.</p>
      </body>
    </html>
  `

  return await sendEmail({
    to: params.vendorEmail,
    subject: `New Booking Request - ${params.serviceType}`,
    htmlBody,
    metadata: { serviceType: params.serviceType },
  })
}
