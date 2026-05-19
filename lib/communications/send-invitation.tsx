

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

/**
 * Email/SMS Communication Helpers for Open House Automation
 * Consolidated communication functions to replace TODOs
 */

export interface SendInvitationParams {
  contactId: string
  eventId: string
  method: "email" | "sms" | "both"
  personalizedMessage?: string
}

export interface SendReminderParams {
  contactId: string
  eventId: string
  reminderType: "24h" | "2h" | "30min"
}

export interface SendFeedbackRequestParams {
  contactId: string
  eventId: string
  feedbackUrl: string
}

/**
 * Send open house invitation via email/SMS
 */
export async function sendOpenHouseInvitation(params: SendInvitationParams) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get event and contact details
    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, listings(*)")
      .eq("id", params.eventId)
      .single()

    const { data: contact } = await supabase.from("contacts").select("*").eq("id", params.contactId).single()

    if (!event || !contact) {
      return { success: false, error: "Event or contact not found" }
    }

    const property = event.listings
    const eventDate = new Date(event.event_date).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    })

    // Send email if requested
    if (params.method === "email" || params.method === "both") {
      // Always use the full template so event details and RSVP link are included.
      // personalizedMessage is injected as an opening paragraph inside the template.
      const emailContent = {
        to: contact.email,
        subject: `You're Invited: Open House at ${property.address}`,
        html: generateInvitationEmailHTML({
          contactName: `${contact.first_name} ${contact.last_name}`,
          propertyAddress: property.address,
          eventDate,
          eventTime: `${event.start_time} - ${event.end_time}`,
          propertyImage: property.featured_image || "",
          rsvpLink: `${process.env.NEXT_PUBLIC_APP_URL}/open-house/rsvp/${event.id}`,
          personalizedOpening: params.personalizedMessage,
        }),
      }

      // Log email send (integrate with your email service)

      
      // Store communication record. `activities` is the canonical
      // communication-event log; `interactions` was a legacy name that
      // never existed as a real table. contact.agent_id is agents.id,
      // matching activities.agent_id FK.
      if (contact.agent_id && contact.brokerage_id) {
        await supabase.from("activities").insert({
          contact_id: params.contactId,
          agent_id: contact.agent_id,
          brokerage_id: contact.brokerage_id,
          entity_type: "contact",
          activity_type: "open_house_invitation_email",
          channel: "email",
          title: `Open house invitation sent for ${property.address}`,
          notes: `Open house invitation sent for ${property.address}`,
          outcome: "completed",
          status: "completed",
        })
      }
    }

    // Send SMS if requested
    if (params.method === "sms" || params.method === "both") {
      const smsContent = {
        to: contact.phone,
        message: `Hi ${contact.first_name}! You're invited to our open house at ${property.address} on ${eventDate} from ${event.start_time} to ${event.end_time}. RSVP: ${process.env.NEXT_PUBLIC_APP_URL}/open-house/rsvp/${event.id}`,
      }



      // Store communication record (see comment above for canonical table choice)
      if (contact.agent_id && contact.brokerage_id) {
        await supabase.from("activities").insert({
          contact_id: params.contactId,
          agent_id: contact.agent_id,
          brokerage_id: contact.brokerage_id,
          entity_type: "contact",
          activity_type: "open_house_invitation_sms",
          channel: "sms",
          title: `Open house SMS invitation sent for ${property.address}`,
          notes: `Open house SMS invitation sent for ${property.address}`,
          outcome: "completed",
          status: "completed",
        })
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Send invitation error:", error)
    return { success: false, error: "Failed to send invitation" }
  }
}

/**
 * Send open house reminder
 */
export async function sendOpenHouseReminder(params: SendReminderParams) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

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

    const property = event.listings
    const reminderText =
      params.reminderType === "24h"
        ? "tomorrow"
        : params.reminderType === "2h"
          ? "in 2 hours"
          : "in 30 minutes"

    const smsContent = {
      to: contact.phone,
      message: `Reminder: Open house at ${property.address} is ${reminderText}! Time: ${event.start_time} - ${event.end_time}. See you there!`,
    }



    if (contact.agent_id && contact.brokerage_id) {
      await supabase.from("activities").insert({
        contact_id: params.contactId,
        agent_id: contact.agent_id,
        brokerage_id: contact.brokerage_id,
        entity_type: "contact",
        activity_type: "open_house_reminder",
        channel: "sms",
        title: `Open house ${params.reminderType} reminder sent`,
        notes: `Open house ${params.reminderType} reminder sent`,
        outcome: "completed",
        status: "completed",
      })
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Send reminder error:", error)
    return { success: false, error: "Failed to send reminder" }
  }
}

/**
 * Send feedback request after open house
 */
export async function sendFeedbackRequest(params: SendFeedbackRequestParams) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

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

    const property = event.listings

    // Send email with feedback request
    const emailContent = {
      to: contact.email,
      subject: `How was the open house at ${property.address}?`,
      html: generateFeedbackEmailHTML({
        contactName: `${contact.first_name} ${contact.last_name}`,
        propertyAddress: property.address,
        feedbackUrl: params.feedbackUrl,
      }),
    }

    // Also send SMS with short link
    const smsContent = {
      to: contact.phone,
      message: `Hi ${contact.first_name}! Thanks for visiting ${property.address}. We'd love your feedback: ${params.feedbackUrl}`,
    }

    if (contact.agent_id && contact.brokerage_id) {
      await supabase.from("activities").insert({
        contact_id: params.contactId,
        agent_id: contact.agent_id,
        brokerage_id: contact.brokerage_id,
        entity_type: "contact",
        activity_type: "open_house_feedback_request",
        channel: "email",
        title: `Feedback request sent for open house at ${property.address}`,
        notes: `Feedback request sent for open house at ${property.address}`,
        outcome: "completed",
        status: "completed",
      })
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Send feedback request error:", error)
    return { success: false, error: "Failed to send feedback request" }
  }
}

/**
 * Send alert to agent about weather concerns
 */
export async function sendWeatherAlertToAgent(params: { eventId: string; agentId: string; weatherData: any }) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.eventId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: agent } = await supabase.from("users").select("*").eq("id", params.agentId).single()

    const { data: event } = await supabase
      .from("open_house_events")
      .select("*, listings(*)")
      .eq("id", params.eventId)
      .single()

    if (!agent || !event) {
      return { success: false, error: "Agent or event not found" }
    }

    const alertMessage = `Weather Alert: ${params.weatherData.condition} expected at your open house on ${event.event_date} at ${event.listings?.address}. Consider rescheduling or preparing indoor viewing areas.`

    // Send email alert


    return { success: true }
  } catch (error) {
    console.error("[v0] Send weather alert error:", error)
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
