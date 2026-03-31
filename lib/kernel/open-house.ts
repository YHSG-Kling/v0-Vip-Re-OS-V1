/**
 * lib/kernel/open-house.ts
 * Canonical Open House Contact Resolution & Attendee Management
 * 
 * Kernel Commands (explicit input/output contracts):
 * - resolveOrCreateOpenHouseContact()
 * - createOpenHouseAttendeeFromContact()
 * - attachOpenHouseSourceAttribution()
 * - notifyAssignedAgentForOpenHouseLead()
 * - generateOpenHouseFollowupNextAction()
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "./events"

// ═════════════════════════════════════════════════════════════════════════════
// TYPES
// ═════════════════════════════════════════════════════════════════════════════

export interface OpenHouseCheckInInput {
  brokerage_id: string
  agent_id: string
  open_house_id: string
  property_id?: string
  first_name: string
  last_name?: string
  email?: string
  phone?: string
  check_in_method?: string
  interest_level?: number
  notes?: string
}

export interface ResolveOrCreateContactResult {
  success: boolean
  contact_id: string | null
  was_created: boolean
  error?: string
}

export interface CreateAttendeeResult {
  success: boolean
  attendee_id: string | null
  error?: string
}

export interface AttachAttributionResult {
  success: boolean
  error?: string
}

export interface NotifyAgentResult {
  success: boolean
  error?: string
}

export interface GenerateFollowupResult {
  success: boolean
  next_action_id?: string
  message?: string
  scheduled_for?: string
  error?: string
}

// ═════════════════════════════════════════════════════════════════════════════
// KERNEL COMMANDS
// ═════════════════════════════════════════════════════════════════════════════


/**
 * resolveOrCreateOpenHouseContact
 * 
 * Business Rule:
 * 1. If attendee email/phone matches an existing contact in brokerage, use that contact.
 * 2. If no contact exists, create a minimal contact with source=open_house.
 * 3. Return contact_id for downstream attendee creation.
 * 
 * Input:
 * {
 *   brokerage_id: uuid
 *   agent_id: uuid
 *   first_name: string (required)
 *   last_name: string (optional)
 *   email: string (optional but preferred for resolution)
 *   phone: string (optional)
 *   open_house_id: uuid (for metadata)
 * }
 * 
 * Output:
 * {
 *   success: boolean
 *   contact_id: uuid | null (null only on failure)
 *   was_created: boolean (true if new contact, false if matched existing)
 *   error?: string
 * }
 */
export async function resolveOrCreateOpenHouseContact(input: {
  brokerage_id: string
  agent_id: string
  first_name: string
  last_name?: string
  email?: string
  phone?: string
  open_house_id?: string
}): Promise<ResolveOrCreateContactResult> {
  const supabase = createServiceClient()

  try {
    const { brokerage_id, agent_id, first_name, last_name, email, phone, open_house_id } = input

    // Validate required fields
    if (!brokerage_id || !agent_id || !first_name) {
      return {
        success: false,
        contact_id: null,
        was_created: false,
        error: "brokerage_id, agent_id, and first_name are required",
      }
    }

    // Try to find existing contact by email or phone
    let existingContact = null
    if (email) {
      const { data } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", brokerage_id)
        .eq("email", email)
        .maybeSingle()
      existingContact = data
    }

    // If not found by email, try phone
    if (!existingContact && phone) {
      const { data } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", brokerage_id)
        .eq("phone", phone)
        .maybeSingle()
      existingContact = data
    }

    // Return existing contact if found
    if (existingContact?.id) {
      console.log(
        `[Kernel] Resolved existing contact ${existingContact.id} for ${email || phone} (open_house: ${open_house_id})`
      )
      return {
        success: true,
        contact_id: existingContact.id,
        was_created: false,
      }
    }

    // Create new contact
    const { data: newContact, error: createErr } = await supabase
      .from("contacts")
      .insert({
        brokerage_id,
        agent_id,
        first_name: first_name.trim(),
        last_name: (last_name || "").trim(),
        email: email ? email.trim().toLowerCase() : null,
        phone: phone ? phone.replace(/\D/g, "") : null,
        contact_type: "buyer",
        source: "open_house",
        status: "active",
      })
      .select("id")
      .single()

    if (createErr || !newContact?.id) {
      console.error(`[Kernel] Contact creation failed:`, createErr?.message)
      return {
        success: false,
        contact_id: null,
        was_created: false,
        error: `Failed to create contact: ${createErr?.message}`,
      }
    }

    console.log(
      `[Kernel] Created new contact ${newContact.id} from open_house attendee (open_house: ${open_house_id})`
    )
    return {
      success: true,
      contact_id: newContact.id,
      was_created: true,
    }
  } catch (error: any) {
    console.error(`[Kernel] resolveOrCreateOpenHouseContact error:`, error?.message)
    return {
      success: false,
      contact_id: null,
      was_created: false,
      error: error?.message || "Unknown error",
    }
  }
}

/**
 * createOpenHouseAttendeeFromContact
 * 
 * Business Rule:
 * - Insert attendee record with resolved contact_id and source attribution.
 * - Never skip due to missing contact_id.
 * 
 * Input:
 * {
 *   open_house_id: uuid
 *   contact_id: uuid (from resolveOrCreateOpenHouseContact)
 *   first_name: string
 *   last_name?: string
 *   email?: string
 *   phone?: string
 *   check_in_method?: string (qr_code, manual, tablet)
 *   interest_level?: number (1-5)
 *   notes?: string
 * }
 * 
 * Output:
 * {
 *   success: boolean
 *   attendee_id: uuid | null
 *   error?: string
 * }
 */
export async function createOpenHouseAttendeeFromContact(input: {
  open_house_id: string
  contact_id: string
  first_name: string
  last_name?: string
  email?: string
  phone?: string
  check_in_method?: string
  interest_level?: number
  notes?: string
}): Promise<CreateAttendeeResult> {
  const supabase = createServiceClient()

  try {
    const {
      open_house_id,
      contact_id,
      first_name,
      last_name,
      email,
      phone,
      check_in_method = "manual",
      interest_level = 3,
      notes,
    } = input

    // Validate required fields
    if (!open_house_id || !contact_id) {
      return {
        success: false,
        attendee_id: null,
        error: "open_house_id and contact_id are required",
      }
    }

    // Insert attendee record
    const { data: attendee, error: insertErr } = await supabase
      .from("open_house_attendees")
      .insert({
        open_house_id,
        contact_id,
        first_name: first_name.trim(),
        last_name: (last_name || "").trim(),
        email: email ? email.trim().toLowerCase() : null,
        phone: phone ? phone.replace(/\D/g, "") : null,
        check_in_method,
        property_interest_level: interest_level,
        checked_in: true,
        check_in_time: new Date().toISOString(),
        rsvp_status: "confirmed",
        notes,
      })
      .select("id")
      .single()

    if (insertErr || !attendee?.id) {
      console.error(`[Kernel] Attendee creation failed:`, insertErr?.message)
      return {
        success: false,
        attendee_id: null,
        error: `Failed to create attendee: ${insertErr?.message}`,
      }
    }

    console.log(
      `[Kernel] Created attendee ${attendee.id} for contact ${contact_id} in open_house ${open_house_id}`
    )
    return {
      success: true,
      attendee_id: attendee.id,
    }
  } catch (error: any) {
    console.error(`[Kernel] createOpenHouseAttendeeFromContact error:`, error?.message)
    return {
      success: false,
      attendee_id: null,
      error: error?.message || "Unknown error",
    }
  }
}

/**
 * attachOpenHouseSourceAttribution
 * 
 * Business Rule:
 * - Link contact to open_house source for analytics and follow-up routing.
 * - Create lifecycle event for audit trail.
 * 
 * Input:
 * {
 *   contact_id: uuid
 *   open_house_id: uuid
 *   attendee_id: uuid (for tracking)
 *   brokerage_id: uuid
 *   agent_id: uuid
 * }
 * 
 * Output:
 * {
 *   success: boolean
 *   error?: string
 * }
 */
export async function attachOpenHouseSourceAttribution(input: {
  contact_id: string
  open_house_id: string
  attendee_id: string
  brokerage_id: string
  agent_id: string
}): Promise<AttachAttributionResult> {
  const supabase = createServiceClient()

  try {
    const { contact_id, open_house_id, attendee_id, brokerage_id, agent_id } = input

    // Emit lifecycle event for audit trail
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type: "contact",
        entity_id: contact_id,
        event_type: KernelEvent.OPEN_HOUSE_CONTACT_RESOLVED,
        brokerage_id,
        metadata: {
          open_house_id,
          attendee_id,
          agent_id,
          resolved_at: new Date().toISOString(),
        },
        created_at: new Date().toISOString(),
      })
      .catch(() => {}) // Don't fail if event emission fails

    console.log(`[Kernel] Attached open_house attribution to contact ${contact_id}`)
    return { success: true }
  } catch (error: any) {
    console.error(`[Kernel] attachOpenHouseSourceAttribution error:`, error?.message)
    return {
      success: false,
      error: error?.message || "Unknown error",
    }
  }
}

/**
 * notifyAssignedAgentForOpenHouseLead
 * 
 * Business Rule:
 * - Immediately notify assigned agent that a new attendee checked in.
 * - Generate next action for follow-up queue.
 * 
 * Input:
 * {
 *   contact_id: uuid
 *   attendee_id: uuid
 *   agent_id: uuid
 *   open_house_id: uuid
 *   first_name: string
 *   email?: string
 *   interest_level: number (1-5)
 * }
 * 
 * Output:
 * {
 *   success: boolean
 *   error?: string
 * }
 */
export async function notifyAssignedAgentForOpenHouseLead(input: {
  contact_id: string
  attendee_id: string
  agent_id: string
  open_house_id: string
  first_name: string
  email?: string
  interest_level: number
}): Promise<NotifyAgentResult> {
  const supabase = createServiceClient()

  try {
    const { contact_id, attendee_id, agent_id, open_house_id, first_name, email, interest_level } = input

    // Queue an AI next action for the agent's follow-up dashboard
    const { error: actionErr } = await supabase
      .from("ai_autopilot_actions")
      .insert({
        agent_id,
        entity_type: "contact",
        entity_id: contact_id,
        action_type: "open_house_follow_up",
        title: `Follow up: ${first_name} - Open House Check-in`,
        description: `${first_name} checked in to your open house (interest: ${interest_level}/5)`,
        priority: interest_level >= 4 ? "high" : interest_level >= 3 ? "medium" : "low",
        metadata: {
          attendee_id,
          open_house_id,
          email,
          interest_level,
        },
        scheduled_for: new Date(Date.now() + 30 * 60000).toISOString(), // 30 min from now
      })
      .catch((err) => ({ error: err }))

    if (actionErr) {
      console.error(`[Kernel] Failed to create next action:`, actionErr?.message)
      // Don't fail overall if this fails
    }

    console.log(`[Kernel] Notified agent ${agent_id} about open_house lead from contact ${contact_id}`)
    return { success: true }
  } catch (error: any) {
    console.error(`[Kernel] notifyAssignedAgentForOpenHouseLead error:`, error?.message)
    return {
      success: false,
      error: error?.message || "Unknown error",
    }
  }
}

/**
 * generateOpenHouseFollowupNextAction
 * 
 * Business Rule:
 * - AI generates personalized follow-up message based on attendee interest and property.
 * - Schedule follow-up for appropriate time (hot: immediate, cold: next week).
 * 
 * Input:
 * {
 *   contact_id: uuid
 *   attendee_id: uuid
 *   open_house_id: uuid
 *   property_id: uuid
 *   first_name: string
 *   interest_level: number (1-5)
 *   agent_id: uuid
 * }
 * 
 * Output:
 * {
 *   success: boolean
 *   next_action_id?: uuid
 *   message?: string
 *   scheduled_for?: timestamp
 *   error?: string
 * }
 */
export async function generateOpenHouseFollowupNextAction(input: {
  contact_id: string
  attendee_id: string
  open_house_id: string
  property_id?: string
  first_name: string
  interest_level: number
  agent_id: string
}): Promise<GenerateFollowupResult> {
  const supabase = createServiceClient()

  try {
    const { contact_id, attendee_id, open_house_id, property_id, first_name, interest_level, agent_id } = input

    // Determine urgency and delay based on interest level
    const urgencyMap = {
      5: { priority: "high", delay_hours: 0.5 }, // 30 min
      4: { priority: "high", delay_hours: 2 },
      3: { priority: "medium", delay_hours: 24 },
      2: { priority: "low", delay_hours: 48 },
      1: { priority: "low", delay_hours: 72 },
    }

    const urgency = urgencyMap[Math.min(5, Math.max(1, interest_level)) as keyof typeof urgencyMap]
    const scheduledFor = new Date(Date.now() + urgency.delay_hours * 60 * 60 * 1000)

    // AI generates follow-up message (optional, can be generic for now)
    let aiMessage = ""
    try {
      const { text } = await generateTextRouted({
        model: "openai/gpt-4o-mini",
        prompt: `Generate a brief, personalized follow-up message to ${first_name} after they attended our open house (interest level: ${interest_level}/5). Keep it under 100 words, warm and conversational.`,
      })
      aiMessage = text || ""
    } catch (err) {
      console.warn("[Kernel] AI message generation failed, using generic:", err)
      aiMessage = `Hi ${first_name}! Thanks for visiting our open house. We'd love to discuss this property further with you!`
    }

    // Create next action record
    const { data: nextAction, error: actionErr } = await supabase
      .from("ai_autopilot_actions")
      .insert({
        agent_id,
        entity_type: "contact",
        entity_id: contact_id,
        action_type: "open_house_follow_up_message",
        title: `Send follow-up: ${first_name}`,
        description: aiMessage,
        priority: urgency.priority,
        metadata: {
          attendee_id,
          open_house_id,
          property_id,
          interest_level,
          suggested_message: aiMessage,
        },
        scheduled_for: scheduledFor.toISOString(),
      })
      .select("id")
      .single()

    if (actionErr || !nextAction?.id) {
      console.error(`[Kernel] Failed to create follow-up next action:`, actionErr?.message)
      return {
        success: false,
        error: `Failed to schedule follow-up: ${actionErr?.message}`,
      }
    }

    console.log(
      `[Kernel] Generated follow-up next action ${nextAction.id} for contact ${contact_id} (urgency: ${urgency.priority})`
    )
    return {
      success: true,
      next_action_id: nextAction.id,
      message: aiMessage,
      scheduled_for: scheduledFor.toISOString(),
    }
  } catch (error: any) {
    console.error(`[Kernel] generateOpenHouseFollowupNextAction error:`, error?.message)
    return {
      success: false,
      error: error?.message || "Unknown error",
    }
  }
}
