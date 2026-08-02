import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

/**
 * Open-house communications.
 *
 * WHAT THIS FILE USED TO BE, because it explains every choice below. All four
 * exports built a message payload into a local variable and then never read it
 * again — the send site was an empty comment. Three of them nevertheless wrote
 * an `activities` row with `outcome: "completed"` and a title reading "Open
 * house invitation sent for 123 Main St", and returned `{ success: true }`
 * unconditionally. Nothing was ever transmitted.
 *
 * That is worse than a broken button. `activities` is not an inert log: the
 * kernel's conversation memory (lib/kernel/conversation-memory.ts) reads
 * channel/outcome/title straight into the AI's contact memory, so a fabricated
 * "we already invited them" became ground truth the assistant reasoned from and
 * suppressed real follow-up with. It is also the row a broker would hand a
 * regulator as evidence of what was sent. Manufacturing compliance evidence for
 * a message that does not exist is the most damaging form of the defect this
 * sweep exists to remove.
 *
 * THE RULES THIS FILE NOW FOLLOWS:
 *
 *  1. Every send goes through lib/providers/dispatch — the canonical gate. It
 *     runs suppression, DNC, quiet hours, opt-out, de-confliction, content
 *     safety and the vendor budget preflight before a provider is touched. The
 *     old code bypassed all of it and would have messaged contacts with no
 *     consent check whatsoever. Voice/SMS is Twilio; nothing here knows any
 *     other vendor.
 *
 *  2. An evidence row is written AFTER the dispatch and reports what the
 *     dispatch actually returned. `completed_at` stays null unless a provider
 *     accepted the message. A refusal is recorded as a refusal, with the
 *     reason, because "we tried and the contact is on the DNC list" is a fact
 *     the agent needs and the old code erased.
 *
 *  3. dispatchEmail/dispatchSms RETURN { success: false, error } — they do not
 *     throw. A try/catch around them is dead code. Every call site here reads
 *     the returned result.
 *
 * IDENTITY. `contacts.agent_id` FKs agents(id) (m114 repointed it off users),
 * and `activities.agent_id` FKs agents(id) as well, so the value carries across
 * unchanged and no resolve is needed. The one place a resolve IS needed is the
 * weather alert, which is addressed to the agent's own mailbox — see there.
 */

export interface SendInvitationParams {
  contactId: string
  eventId: string
  method: "email" | "sms" | "both"
  personalizedMessage?: string
  /**
   * The AI-written SMS body. generatePersonalizedInvite returns email_subject,
   * email_body, sms_message and reasoning per contact — and sms_message was read
   * by nothing in the repo, so a contact whose preference resolved to SMS got
   * the generic template while their personalisation sat unused in the response.
   * Falls back to the template when absent; never silently discarded.
   */
  personalizedSms?: string
}

export interface SendFeedbackRequestParams {
  contactId: string
  eventId: string
  feedbackUrl: string
}

/** What a channel attempt actually did. `null` = the channel was not requested. */
export interface ChannelOutcome {
  delivered: boolean
  error?: string
}

export interface SendInvitationResult {
  success: boolean
  email?: ChannelOutcome
  sms?: ChannelOutcome
  error?: string
}

/**
 * Record the attempt on the contact timeline. Called once per channel ACTUALLY
 * attempted, and it tells the truth about the attempt — including a failure,
 * which is more useful to the agent than silence.
 */
async function logChannelAttempt(
  supabase: Awaited<ReturnType<typeof createClient>>,
  args: {
    contactId: string
    agentId: string | null
    brokerageId: string | null
    activityType: string
    channel: "email" | "sms"
    subject: string
    delivered: boolean
    error?: string
    providerKey?: string
    messageId?: string
    eventId: string
  },
) {
  // activities.agent_id FKs agents(id) and brokerage_id is NOT NULL; without
  // both, the row cannot be written. Skipping the row is correct — inventing a
  // tenant to satisfy the insert is how a log stops meaning anything.
  if (!args.agentId || !args.brokerageId) return

  await supabase.from("activities").insert({
    contact_id: args.contactId,
    agent_id: args.agentId,
    brokerage_id: args.brokerageId,
    entity_type: "contact",
    activity_type: args.activityType,
    channel: args.channel,
    title: args.delivered ? args.subject : `${args.subject} — not delivered`,
    notes: args.delivered ? null : (args.error ?? "The provider did not accept the message"),
    outcome: args.delivered ? "completed" : "failed",
    status: args.delivered ? "completed" : "failed",
    // There is no sent_at on activities; completed_at is the honest timestamp,
    // and it stays null when nothing went out.
    completed_at: args.delivered ? new Date().toISOString() : null,
    metadata: {
      event_id: args.eventId,
      provider_key: args.providerKey ?? null,
      provider_message_id: args.messageId ?? null,
    },
  })
}

/**
 * Send an open house invitation over the requested channel(s).
 *
 * NOT transactional. An open-house invitation is unsolicited marketing, so the
 * SMS path deliberately leaves `transactional` unset and the express-written-
 * consent rule applies in full. Expect the gate to refuse a real share of
 * recipients — that refusal is the product working, and it is reported rather
 * than hidden.
 */
export async function sendOpenHouseInvitation(params: SendInvitationParams): Promise<SendInvitationResult> {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()
  const { dispatchEmail, dispatchSms } = await import("@/lib/providers/dispatch")

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, listings(*)")
      .eq("id", params.eventId)
      .single()

    const { data: contact } = await supabase.from("contacts").select("*").eq("id", params.contactId).single()

    if (!event || !contact) {
      return { success: false, error: "Event or contact not found" }
    }
    if (!contact.brokerage_id) {
      return { success: false, error: "This contact has no brokerage, so the send cannot be billed or gated" }
    }

    const property = event.listings
    const eventDate = new Date(event.event_date).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    })

    let email: ChannelOutcome | undefined
    let sms: ChannelOutcome | undefined

    if (params.method === "email" || params.method === "both") {
      if (!contact.email) {
        email = { delivered: false, error: "No email address on file" }
      } else {
        const subject = `You're Invited: Open House at ${property.address}`
        const res = await dispatchEmail({
          brokerageId: contact.brokerage_id,
          contactId: params.contactId,
          agentId: contact.agent_id ?? undefined, // agents.id — contacts.agent_id FKs agents (m114)
          to: contact.email,
          subject,
          html: generateInvitationEmailHTML({
            contactName: `${contact.first_name} ${contact.last_name}`,
            propertyAddress: property.address,
            eventDate,
            eventTime: `${event.start_time} - ${event.end_time}`,
            propertyImage: property.featured_image || "",
            rsvpLink: `${process.env.NEXT_PUBLIC_APP_URL}/open-house/rsvp/${event.id}`,
            personalizedOpening: params.personalizedMessage,
          }),
          channelPurpose: "campaign",
          systemSource: "open_house_invitation",
        })
        email = { delivered: res.success, error: res.success ? undefined : (res.error ?? "Email was not delivered") }
        await logChannelAttempt(supabase, {
          contactId: params.contactId,
          agentId: contact.agent_id,
          brokerageId: contact.brokerage_id,
          activityType: "open_house_invitation_email",
          channel: "email",
          subject: `Open house invitation emailed for ${property.address}`,
          delivered: res.success,
          error: res.error,
          providerKey: res.providerKey,
          eventId: params.eventId,
        })
      }
    }

    if (params.method === "sms" || params.method === "both") {
      if (!contact.phone) {
        sms = { delivered: false, error: "No phone number on file" }
      } else {
        const res = await dispatchSms({
          brokerageId: contact.brokerage_id,
          contactId: params.contactId,
          agentId: contact.agent_id ?? undefined,
          to: contact.phone,
          message:
            params.personalizedSms?.trim() ||
            `Hi ${contact.first_name}! You're invited to our open house at ${property.address} on ${eventDate} from ${event.start_time} to ${event.end_time}. RSVP: ${process.env.NEXT_PUBLIC_APP_URL}/open-house/rsvp/${event.id}`,
          systemSource: "open_house_invitation",
        })
        sms = { delivered: res.success, error: res.success ? undefined : (res.error ?? "Text was not delivered") }
        await logChannelAttempt(supabase, {
          contactId: params.contactId,
          agentId: contact.agent_id,
          brokerageId: contact.brokerage_id,
          activityType: "open_house_invitation_sms",
          channel: "sms",
          subject: `Open house invitation texted for ${property.address}`,
          delivered: res.success,
          error: res.error,
          providerKey: res.providerKey,
          messageId: res.messageId,
          eventId: params.eventId,
        })
      }
    }

    const delivered = Boolean(email?.delivered || sms?.delivered)
    return {
      success: delivered,
      email,
      sms,
      error: delivered
        ? undefined
        : [email?.error, sms?.error].filter(Boolean).join("; ") || "No channel delivered",
    }
  } catch (error) {
    console.error("[open-house] Send invitation error:", error)
    return { success: false, error: "Failed to send invitation" }
  }
}

/**
 * Ask an attendee what they thought.
 *
 * Both channels are attempted and each gets its OWN evidence row. The previous
 * version built an email payload AND an SMS payload, sent neither, and wrote a
 * single row claiming channel "email" — so even the shape of the claim was
 * wrong. Still not marked transactional: the recipient walked through a house,
 * which is not the same as asking to be texted.
 */
export async function sendFeedbackRequest(params: SendFeedbackRequestParams): Promise<SendInvitationResult> {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()
  const { dispatchEmail, dispatchSms } = await import("@/lib/providers/dispatch")

  try {
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, listings(*)")
      .eq("id", params.eventId)
      .single()

    const { data: contact } = await supabase.from("contacts").select("*").eq("id", params.contactId).single()

    if (!event || !contact) {
      return { success: false, error: "Event or contact not found" }
    }
    if (!contact.brokerage_id) {
      return { success: false, error: "This contact has no brokerage, so the send cannot be billed or gated" }
    }

    const property = event.listings
    let email: ChannelOutcome | undefined
    let sms: ChannelOutcome | undefined

    if (contact.email) {
      const res = await dispatchEmail({
        brokerageId: contact.brokerage_id,
        contactId: params.contactId,
        agentId: contact.agent_id ?? undefined,
        to: contact.email,
        subject: `How was the open house at ${property.address}?`,
        html: generateFeedbackEmailHTML({
          contactName: `${contact.first_name} ${contact.last_name}`,
          propertyAddress: property.address,
          feedbackUrl: params.feedbackUrl,
        }),
        channelPurpose: "conversation",
        systemSource: "open_house_feedback_request",
      })
      email = { delivered: res.success, error: res.success ? undefined : (res.error ?? "Email was not delivered") }
      await logChannelAttempt(supabase, {
        contactId: params.contactId,
        agentId: contact.agent_id,
        brokerageId: contact.brokerage_id,
        activityType: "open_house_feedback_request",
        channel: "email",
        subject: `Feedback request emailed for open house at ${property.address}`,
        delivered: res.success,
        error: res.error,
        providerKey: res.providerKey,
        eventId: params.eventId,
      })
    } else {
      email = { delivered: false, error: "No email address on file" }
    }

    if (contact.phone) {
      const res = await dispatchSms({
        brokerageId: contact.brokerage_id,
        contactId: params.contactId,
        agentId: contact.agent_id ?? undefined,
        to: contact.phone,
        message: `Hi ${contact.first_name}! Thanks for visiting ${property.address}. We'd love your feedback: ${params.feedbackUrl}`,
        systemSource: "open_house_feedback_request",
      })
      sms = { delivered: res.success, error: res.success ? undefined : (res.error ?? "Text was not delivered") }
      await logChannelAttempt(supabase, {
        contactId: params.contactId,
        agentId: contact.agent_id,
        brokerageId: contact.brokerage_id,
        activityType: "open_house_feedback_request",
        channel: "sms",
        subject: `Feedback request texted for open house at ${property.address}`,
        delivered: res.success,
        error: res.error,
        providerKey: res.providerKey,
        messageId: res.messageId,
        eventId: params.eventId,
      })
    } else {
      sms = { delivered: false, error: "No phone number on file" }
    }

    const delivered = Boolean(email?.delivered || sms?.delivered)
    return {
      success: delivered,
      email,
      sms,
      error: delivered
        ? undefined
        : [email?.error, sms?.error].filter(Boolean).join("; ") || "No channel delivered",
    }
  } catch (error) {
    console.error("[open-house] Send feedback request error:", error)
    return { success: false, error: "Failed to send feedback request" }
  }
}

/**
 * Tell the agent the forecast is against them.
 *
 * THE IDENTITY BUG THIS FIXES, which made the function unreachable rather than
 * merely silent: it looked the agent up with `.from("users").eq("id", agentId)`
 * while its only caller passes `open_house_events.agent_id`, which FKs
 * agents(id). An agents id never matches a users id, so the lookup returned
 * null and every single invocation exited at "Agent or event not found" —
 * before reaching the (empty) send site. Crossing the two classes is a RESOLVE,
 * never a coincidence.
 *
 * This one IS transactional: it goes to the agent's own mailbox about their own
 * event. No contactId is passed, so the consumer-protection gates correctly do
 * not engage — they exist to protect the recipient, and here the recipient is
 * the sender's own team.
 */
export async function sendWeatherAlertToAgent(params: { eventId: string; agentId: string; weatherData: any }) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { resolveUserIdForAgentRecord } = await import("@/lib/kernel/agent-identity")
    const agentUserId = await resolveUserIdForAgentRecord(supabase, params.agentId)
    if (!agentUserId) {
      return { success: false, error: "That agent has no linked user account, so there is no mailbox to alert" }
    }

    const { data: agent } = await supabase
      .from("users")
      .select("id, email, first_name")
      .eq("id", agentUserId)
      .maybeSingle()

    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, listings(*)")
      .eq("id", params.eventId)
      .single()

    if (!agent || !event) {
      return { success: false, error: "Agent or event not found" }
    }
    if (!agent.email) {
      return { success: false, error: "That agent has no email address on file" }
    }
    if (!event.brokerage_id) {
      return { success: false, error: "This event has no brokerage, so the alert cannot be billed" }
    }

    const address = event.listings?.address ?? "your listing"
    const alertMessage = `Weather Alert: ${params.weatherData?.condition ?? "poor conditions"} expected at your open house on ${event.event_date} at ${address}. Consider rescheduling or preparing indoor viewing areas.`

    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const res = await dispatchEmail({
      brokerageId: event.brokerage_id,
      userId: agentUserId,
      to: agent.email,
      subject: `Weather alert for your open house at ${address}`,
      html: `<p>Hi ${agent.first_name ?? "there"},</p><p>${alertMessage}</p>`,
      text: alertMessage,
      channelPurpose: "transactional",
      systemSource: "open_house_weather_alert",
    })

    return res.success
      ? { success: true }
      : { success: false, error: res.error ?? "The weather alert was not delivered" }
  } catch (error) {
    console.error("[open-house] Send weather alert error:", error)
    return { success: false, error: "Failed to send weather alert" }
  }
}

// HTML Email Templates
function generateInvitationEmailHTML(data: {
  contactName: string
  propertyAddress: string
  eventDate: string
  eventTime: string
  propertyImage: string
  rsvpLink: string
  personalizedOpening?: string
}) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        .content { background: #f9fafb; padding: 30px; }
        .property-image { width: 100%; height: 300px; object-fit: cover; border-radius: 8px; margin: 20px 0; }
        .cta-button { display: inline-block; background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .details { background: white; padding: 20px; border-left: 4px solid #667eea; margin: 20px 0; }
        .personalized { background: white; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; font-style: italic; color: #4b5563; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>You're Invited to Our Open House!</h1>
        </div>
        <div class="content">
          <p>Hi ${data.contactName},</p>
          ${data.personalizedOpening
            ? `<div class="personalized">${data.personalizedOpening}</div>`
            : `<p>We're excited to invite you to an exclusive open house event at a beautiful property we think you'll love!</p>`
          }

          ${data.propertyImage ? `<img src="${data.propertyImage}" alt="Property" class="property-image" />` : ""}

          <div class="details">
            <h3>Event Details</h3>
            <p><strong>📍 Location:</strong> ${data.propertyAddress}</p>
            <p><strong>📅 Date:</strong> ${data.eventDate}</p>
            <p><strong>⏰ Time:</strong> ${data.eventTime}</p>
          </div>

          <p>Join us to explore this amazing property and discover if it's the perfect fit for you!</p>

          <a href="${data.rsvpLink}" class="cta-button">RSVP Now</a>

          <p>We look forward to seeing you there!</p>
        </div>
      </div>
    </body>
    </html>
  `
}

function generateFeedbackEmailHTML(data: { contactName: string; propertyAddress: string; feedbackUrl: string }) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #667eea; color: white; padding: 20px; text-align: center; }
        .content { background: #f9fafb; padding: 30px; }
        .cta-button { display: inline-block; background: #10b981; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Thanks for Visiting!</h2>
        </div>
        <div class="content">
          <p>Hi ${data.contactName},</p>
          <p>Thank you for attending the open house at ${data.propertyAddress}!</p>
          <p>We'd love to hear your thoughts about the property. Your feedback helps us serve you better.</p>
          <a href="${data.feedbackUrl}" class="cta-button">Share Your Feedback</a>
          <p>It only takes 2 minutes, and we truly appreciate your time!</p>
        </div>
      </div>
    </body>
    </html>
  `
}
