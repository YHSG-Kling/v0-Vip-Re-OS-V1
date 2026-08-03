"use server"

/**
 * app/actions/open-house-kernel.ts
 * Server action wrapper for canonical open house kernel commands
 * 
 * Delegates to lib/kernel/open-house.ts
 * All business logic is in the kernel module, this just provides async boundary.
 */

import {
  resolveOrCreateOpenHouseContact,
  createOpenHouseAttendeeFromContact,
  attachOpenHouseSourceAttribution,
  notifyAssignedAgentForOpenHouseLead,
  generateOpenHouseFollowupNextAction,
} from "@/lib/kernel/open-house"

export async function resolveOrCreateOpenHouseContactAction(input: Parameters<typeof resolveOrCreateOpenHouseContact>[0]) {
  return resolveOrCreateOpenHouseContact(input)
}

export async function createOpenHouseAttendeeFromContactAction(input: Parameters<typeof createOpenHouseAttendeeFromContact>[0]) {
  return createOpenHouseAttendeeFromContact(input)
}

export async function attachOpenHouseSourceAttributionAction(input: Parameters<typeof attachOpenHouseSourceAttribution>[0]) {
  return attachOpenHouseSourceAttribution(input)
}

export async function notifyAssignedAgentForOpenHouseLeadAction(input: Parameters<typeof notifyAssignedAgentForOpenHouseLead>[0]) {
  return notifyAssignedAgentForOpenHouseLead(input)
}

export async function generateOpenHouseFollowupNextActionAction(input: Parameters<typeof generateOpenHouseFollowupNextAction>[0]) {
  return generateOpenHouseFollowupNextAction(input)
}

/**
 * Convenience wrapper: complete end-to-end open house check-in flow
 * 
 * This orchestrates all 5 kernel commands in order:
 * 1. Resolve or create contact
 * 2. Create attendee record
 * 3. Attach source attribution
 * 4. Notify assigned agent
 * 5. Generate follow-up next action
 * 
 * Input:
 * {
 *   brokerage_id: uuid
 *   agent_id: uuid
 *   open_house_id: uuid
 *   property_id?: uuid
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
 *   attendee_id?: uuid
 *   contact_id?: uuid
 *   next_action_id?: uuid
 *   message?: string
 *   error?: string
 * }
 */
export async function completeOpenHouseCheckInAction(input: {
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
}): Promise<{
  success: boolean
  attendee_id?: string
  contact_id?: string
  next_action_id?: string
  message?: string
  error?: string
}> {
  try {
    // Step 1: Resolve or create contact
    const contactResult = await resolveOrCreateOpenHouseContact({
      brokerage_id: input.brokerage_id,
      agent_id: input.agent_id,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone,
      open_house_id: input.open_house_id,
    })

    if (!contactResult.success || !contactResult.contact_id) {
      return {
        success: false,
        error: `Failed to resolve or create contact: ${contactResult.error}`,
      }
    }

    const contactId = contactResult.contact_id

    // Step 2: Create attendee record
    const attendeeResult = await createOpenHouseAttendeeFromContact({
      open_house_id: input.open_house_id,
      contact_id: contactId,
      first_name: input.first_name,
      last_name: input.last_name,
      email: input.email,
      phone: input.phone,
      check_in_method: input.check_in_method,
      interest_level: input.interest_level,
      notes: input.notes,
    })

    if (!attendeeResult.success || !attendeeResult.attendee_id) {
      return {
        success: false,
        contact_id: contactId,
        error: `Failed to create attendee: ${attendeeResult.error}`,
      }
    }

    const attendeeId = attendeeResult.attendee_id

    // Step 3: Attach source attribution
    await attachOpenHouseSourceAttribution({
      contact_id: contactId,
      open_house_id: input.open_house_id,
      attendee_id: attendeeId,
      brokerage_id: input.brokerage_id,
      agent_id: input.agent_id,
    })

    // Step 4: Notify assigned agent
    await notifyAssignedAgentForOpenHouseLead({
      contact_id: contactId,
      attendee_id: attendeeId,
      agent_id: input.agent_id,
      open_house_id: input.open_house_id,
      first_name: input.first_name,
      email: input.email,
      interest_level: input.interest_level ?? 3,
    })

    // Step 5: Generate follow-up next action
    const followupResult = await generateOpenHouseFollowupNextAction({
      contact_id: contactId,
      attendee_id: attendeeId,
      open_house_id: input.open_house_id,
      property_id: input.property_id,
      first_name: input.first_name,
      interest_level: input.interest_level ?? 3,
      agent_id: input.agent_id,
    })

    return {
      success: true,
      attendee_id: attendeeId,
      contact_id: contactId,
      next_action_id: followupResult.success ? followupResult.next_action_id : undefined,
      message: followupResult.message || "Check-in complete. Follow-up scheduled.",
    }
  } catch (error: any) {
    console.error("[completeOpenHouseCheckInAction] Error:", error?.message)
    return {
      success: false,
      error: error?.message || "Unknown error during check-in",
    }
  }
}
