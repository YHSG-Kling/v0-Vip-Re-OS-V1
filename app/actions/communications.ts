"use server"

// =====================================================
// UNIFIED COMMUNICATIONS SERVICE
// =====================================================
// SMS and Email route through the kernel dispatch layer.
// Provider resolution cascade: user → team → brokerage → superadmin → system default.
// GHL-specific functions (logCall, notes, workflows, social, calendar) remain
// wired directly since they are GHL-only features with no provider alternative.

import {
  logGHLCall,
  syncContactToGHL,
  getContactConversationHistory,
  addGHLContactNote,
  triggerGHLWorkflow,
  createGHLSocialPost,
  createGHLCalendarEvent,
} from "@/services/goHighLevelService"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { dispatchSms, dispatchEmail } from "@/lib/providers/dispatch"
import { supabaseService } from "@/services/supabaseService"
import { checkSuppression } from "@/lib/kernel/compliance/check-suppression"

// =====================================================
// SEND SMS (via kernel dispatch — Twilio or GHL based on provider resolution)
// =====================================================

export async function sendSMS(params: {
  contactId: string
  message: string
  templateId?: string
  trackingData?: Record<string, any>
}) {
  const supabase = await createClient()

  // Look up contact for phone number and brokerage context
  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, phone, email, contact_type, status, source, brokerage_id, agent_id")
    .eq("id", params.contactId)
    .single()

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  if (!contact.phone) {
    return { success: false, error: "Contact has no phone number" }
  }

  // Suppression check — hard stop before dispatch
  const suppression = await checkSuppression({
    brokerageId: contact.brokerage_id,
    contactId: params.contactId,
    channel: "sms",
    phone: contact.phone,
  })
  if (suppression.suppressed) {
    return { success: false, error: `SMS suppressed: ${suppression.reason}`, suppressed: true }
  }

  const result = await dispatchSms({
    to: contact.phone,
    message: params.message,
    brokerageId: contact.brokerage_id,
    agentId: contact.agent_id ?? undefined,
    systemSource: "communications",
    leadId: params.contactId,
    metadata: params.trackingData,
  })

  // Log to activities for local tracking
  if (result.success) {
    await supabase.from("activities").insert({
      brokerage_id: contact.brokerage_id,
      agent_id: contact.agent_id,
      contact_id: params.contactId,
      activity_type: "sms_sent",
      title: `SMS sent to contact`,
      description: `SMS sent: ${params.message.substring(0, 100)}`,
      notes: JSON.stringify({ message_id: result.messageId, provider: result.providerKey }),
      status: "completed",
      entity_type: "contact",
    })
  }

  return { ...result, providerKey: result.providerKey }
}

// =====================================================
// SEND EMAIL (via kernel dispatch — SendGrid or GHL based on provider resolution)
// =====================================================

export async function sendEmail(params: {
  contactId: string
  subject: string
  html: string
  text?: string
  from?: string
  templateId?: string
  attachments?: Array<{ url: string; filename: string }>
  /** Controls unsubscribe block in assembled email. Default: 'conversation' */
  channelPurpose?: 'conversation' | 'campaign' | 'update' | 'transactional'
}) {
  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, brokerage_id, agent_id")
    .eq("id", params.contactId)
    .single()

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  if (!contact.email) {
    return { success: false, error: "Contact has no email address" }
  }

  // Suppression check — hard stop before dispatch
  const suppression = await checkSuppression({
    brokerageId: contact.brokerage_id,
    contactId: params.contactId,
    channel: "email",
    email: contact.email,
  })
  if (suppression.suppressed) {
    return { success: false, error: `Email suppressed: ${suppression.reason}`, suppressed: true }
  }

  // Kernel OS email assembly runs inside dispatchEmail() via assembleEmail().
  // Pass raw body HTML — do NOT call assembleEmail() here; that would double-assemble.
  const result = await dispatchEmail({
    to: contact.email,
    from: params.from ?? "",
    subject: params.subject,
    html: params.html,
    text: params.text,
    channelPurpose: params.channelPurpose ?? "conversation",
    brokerageId: contact.brokerage_id,
    agentId: contact.agent_id ?? undefined,
    systemSource: "communications",
    leadId: params.contactId,
  })

  if (result.success) {
    await supabase.from("activities").insert({
      brokerage_id: contact.brokerage_id,
      agent_id: contact.agent_id,
      contact_id: params.contactId,
      activity_type: "email_sent",
      title: `Email sent: ${params.subject}`,
      description: `Email sent: ${params.subject}`,
      notes: JSON.stringify({ message_id: result.messageId, provider: result.providerKey }),
      status: "completed",
      entity_type: "contact",
    })
  }

  return { ...result, providerKey: result.providerKey }
}

// =====================================================
// LOG CALL (via GHL)
// =====================================================

export async function logCall(params: {
  contactId: string
  direction: "inbound" | "outbound"
  duration?: number
  recordingUrl?: string
  notes?: string
  outcome?: "answered" | "voicemail" | "no_answer" | "busy"
}) {
  const contact = await supabaseService.getContactById(params.contactId)

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  // Sync to GHL
  const ghlSync = await syncContactToGHL({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
  })

  const ghlContactId = ghlSync.contactId || params.contactId

  // Log call to GHL
  const result = await logGHLCall({
    contactId: ghlContactId,
    direction: params.direction,
    duration: params.duration,
    recordingUrl: params.recordingUrl,
    notes: params.notes,
    outcome: params.outcome,
  })

  // Log locally
  if (result.success) {
    await supabaseService.logActivity({
      contact_id: params.contactId,
      activity_type: `call_${params.direction}`,
      description: `${params.direction} call - ${params.outcome || "answered"}${params.duration ? ` (${Math.floor(params.duration / 60)}m ${params.duration % 60}s)` : ""}`,
      metadata: {
        ghl_call_id: result.callId,
        ghl_contact_id: ghlContactId,
        duration: params.duration,
        outcome: params.outcome,
        recording_url: params.recordingUrl,
        mock: result.mock,
      },
    })
  }

  return result
}

// =====================================================
// GET CONTACT HISTORY (from GHL)
// =====================================================

export async function getContactHistory(contactId: string) {
  // Try to get from GHL first
  const ghlHistory = await getContactConversationHistory(contactId)

  // Also get local activity log
  const localActivities = await supabaseService.getContactActivities(contactId)

  return {
    success: true,
    ghlHistory: ghlHistory.history,
    localActivities,
    mock: ghlHistory.mock,
  }
}

export async function getCommunicationStats(params?: { agentId?: string; startDate?: string; endDate?: string }) {
  try {
    const supabase = await createClient()
    
    let query = supabase
      .from("messages")
      .select("*")

    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.startDate) query = query.gte("sent_at", params.startDate)
    if (params?.endDate) query = query.lte("sent_at", params.endDate)

    const { data, error } = await query

    if (error) throw error

    // Calculate stats
    const stats = {
      total: data?.length || 0,
      sms: data?.filter((c: any) => c.type === "sms").length || 0,
      email: data?.filter((c: any) => c.type === "email").length || 0,
      call: data?.filter((c: any) => c.type === "call").length || 0,
      byDay: data?.reduce((acc: any, c: any) => {
        const day = new Date(c.sent_at).toISOString().split('T')[0]
        acc[day] = (acc[day] || 0) + 1
        return acc
      }, {})
    }

    return { success: true, stats }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getRecentCommunications(contactId: string, limit = 20) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("sent_at", { ascending: false })
      .limit(limit)

    if (error) throw error

    return { success: true, communications: data || [] }
  } catch (error: any) {
    return { success: false, error: error.message, communications: [] }
  }
}

// =====================================================
// ADD NOTE (synced to GHL)
// =====================================================

export async function addContactNote(params: {
  contactId: string
  note: string
  category?: string
}) {
  const contact = await supabaseService.getContactById(params.contactId)

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  // Sync to GHL
  const ghlSync = await syncContactToGHL({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
  })

  const ghlContactId = ghlSync.contactId || params.contactId

  // Add note to GHL
  const ghlResult = await addGHLContactNote(ghlContactId, params.note)

  // Also save locally
  const localResult = await supabaseService.addContactNote({
    contact_id: params.contactId,
    note: params.note,
    category: params.category,
    ghl_note_id: ghlResult.noteId,
  })

  return {
    success: true,
    noteId: localResult.id,
    ghlNoteId: ghlResult.noteId,
  }
}

// =====================================================
// SOCIAL MEDIA POSTING (via GHL)
// =====================================================

export async function publishSocialPost(params: {
  content: string
  platforms: Array<"facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "google">
  mediaUrls?: string[]
  scheduledTime?: string
  agentId?: string
}) {
  // Create post via GHL Social Planner
  const result = await createGHLSocialPost({
    content: params.content,
    platforms: params.platforms,
    mediaUrls: params.mediaUrls,
    scheduledTime: params.scheduledTime,
  })

  // Log locally
  if (result.success) {
    await supabaseService.logActivity({
      activity_type: "social_post_created",
      description: `Social post ${params.scheduledTime ? "scheduled" : "published"} to ${params.platforms.join(", ")}`,
      metadata: {
        ghl_post_id: result.postId,
        platforms: params.platforms,
        scheduled_time: params.scheduledTime,
        mock: result.mock,
      },
    })
  }

  return result
}

// =====================================================
// SCHEDULE APPOINTMENT (via GHL Calendar)
// =====================================================

export async function scheduleAppointment(params: {
  contactId: string
  calendarId: string
  title: string
  startTime: string
  endTime: string
  meetingType?: "in_person" | "video" | "phone"
  notes?: string
  assignedUserId?: string
}) {
  const contact = await supabaseService.getContactById(params.contactId)

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  // Sync contact to GHL
  const ghlSync = await syncContactToGHL({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
  })

  const ghlContactId = ghlSync.contactId || params.contactId

  // Create calendar event in GHL
  const result = await createGHLCalendarEvent({
    contactId: ghlContactId,
    calendarId: params.calendarId,
    title: params.title,
    startTime: params.startTime,
    endTime: params.endTime,
    meetingType: params.meetingType,
    notes: params.notes,
    assignedUserId: params.assignedUserId,
  })

  // Log locally
  if (result.success) {
    await supabaseService.logActivity({
      contact_id: params.contactId,
      activity_type: "appointment_scheduled",
      description: `${params.title} scheduled for ${new Date(params.startTime).toLocaleString()}`,
      metadata: {
        ghl_event_id: result.eventId,
        ghl_contact_id: ghlContactId,
        meeting_type: params.meetingType,
        mock: result.mock,
      },
    })
  }

  return result
}

// =====================================================
// TRIGGER GHL AUTOMATION
// =====================================================

export async function triggerAutomation(params: {
  contactId: string
  workflowId: string
  eventName?: string
  eventData?: Record<string, any>
}) {
  const contact = await supabaseService.getContactById(params.contactId)

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  // Sync to GHL
  const ghlSync = await syncContactToGHL({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
  })

  const ghlContactId = ghlSync.contactId || params.contactId

  // Trigger workflow
  const result = await triggerGHLWorkflow({
    contactId: ghlContactId,
    workflowId: params.workflowId,
    eventData: params.eventData,
  })

  // Log locally
  await supabaseService.logActivity({
    contact_id: params.contactId,
    activity_type: "workflow_triggered",
    description: `GHL workflow ${params.workflowId} triggered${params.eventName ? ` (${params.eventName})` : ""}`,
    metadata: {
      workflow_id: params.workflowId,
      event_name: params.eventName,
      ghl_contact_id: ghlContactId,
      mock: result.mock,
    },
  })

  return result
}

// =====================================================
// SEND NOTIFICATION TO AGENT (Push/SMS/Email)
// =====================================================

export async function sendNotificationToAgent(
  userId: string,
  notification: {
    title: string
    message: string
    priority?: "low" | "medium" | "high"
    actionUrl?: string
  },
) {
  // Get user details
  const user = await supabaseService.getUserById(userId)

  if (!user) {
    console.error(`[v0] User not found: ${userId}`)
    return { success: false, error: "User not found" }
  }

  // Write in-app notification to notifications table
  const { data: notifRecord, error: notifError } = await supabaseService.client
    .from("notifications")
    .insert({
      user_id: userId,
      type: "agent_notification",
      title: notification.title,
      body: notification.message,
      priority: notification.priority || "medium",
      is_read: false,
      channel: "in_app",
    })
    .select("id")
    .single()

  if (notifError) {
    console.error("[v0] Failed to write notification:", notifError.message)
  }

  // Log to activity table
  await supabaseService.logActivity({
    user_id: userId,
    activity_type: "notification_sent",
    description: `${notification.priority?.toUpperCase() || "MEDIUM"}: ${notification.title}`,
    metadata: {
      title: notification.title,
      message: notification.message,
      priority: notification.priority || "medium",
      action_url: notification.actionUrl,
    },
  })

  return {
    success: true,
    notificationId: notifRecord?.id ?? `notif_${Date.now()}`,
  }
}
