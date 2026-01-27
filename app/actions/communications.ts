"use server"

// =====================================================
// UNIFIED COMMUNICATIONS SERVICE
// =====================================================
// All communications route through Go High Level
// This ensures contact history is always updated

import {
  sendGHLSMS,
  sendGHLEmail,
  logGHLCall,
  syncContactToGHL,
  getContactConversationHistory,
  addGHLContactNote,
  triggerGHLWorkflow,
  createGHLSocialPost,
  createGHLCalendarEvent,
} from "@/services/goHighLevelService"
import { supabaseService } from "@/services/supabaseService"
import { createClient } from "@/lib/supabase/server"

// =====================================================
// SEND SMS (via GHL)
// =====================================================

export async function sendSMS(params: {
  contactId: string
  message: string
  templateId?: string
  trackingData?: Record<string, any>
}) {
  // Get contact details from Supabase
  const contact = await supabaseService.getContactById(params.contactId)

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  // Ensure contact is synced to GHL
  const ghlSync = await syncContactToGHL({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
    tags: [contact.contact_type, contact.status].filter(Boolean),
    source: contact.source || "vipos",
  })

  const ghlContactId = ghlSync.contactId || params.contactId

  // Send SMS via GHL
  const result = await sendGHLSMS({
    contactId: ghlContactId,
    message: params.message,
    phone: contact.phone || undefined,
  })

  // Log to Supabase for local tracking
  if (result.success) {
    await supabaseService.logActivity({
      contact_id: params.contactId,
      activity_type: "sms_sent",
      description: `SMS sent: ${params.message.substring(0, 50)}...`,
      metadata: {
        ghl_message_id: result.messageId,
        ghl_contact_id: ghlContactId,
        mock: result.mock,
        ...params.trackingData,
      },
    })
  }

  return result
}

// =====================================================
// SEND EMAIL (via GHL)
// =====================================================

export async function sendEmail(params: {
  contactId: string
  subject: string
  html: string
  text?: string
  templateId?: string
  attachments?: Array<{ url: string; filename: string }>
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

  // Send via GHL
  const result = await sendGHLEmail({
    contactId: ghlContactId,
    subject: params.subject,
    html: params.html,
    text: params.text,
    attachments: params.attachments,
  })

  // Log locally
  if (result.success) {
    await supabaseService.logActivity({
      contact_id: params.contactId,
      activity_type: "email_sent",
      description: `Email sent: ${params.subject}`,
      metadata: {
        ghl_message_id: result.messageId,
        ghl_contact_id: ghlContactId,
        mock: result.mock,
      },
    })
  }

  return result
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
      .from("communications")
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
      .from("communications")
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

  // In production, this would:
  // 1. Send push notification via Firebase/OneSignal
  // 2. Send SMS if priority is high
  // 3. Send email if urgent
  // 4. Create in-app notification

  // For now, log the notification
  console.log(`[v0] Notification to ${user.email}:`, notification)

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
    notificationId: `notif_${Date.now()}`,
    mock: true,
  }
}
