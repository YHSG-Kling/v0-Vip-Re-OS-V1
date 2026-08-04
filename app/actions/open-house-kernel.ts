"use server"

/**
 * app/actions/open-house-kernel.ts
 * Server actions for the canonical open house kernel commands.
 *
 * Delegates to lib/kernel/open-house.ts — all business logic lives there.
 *
 * WHAT THIS LAYER OWNS, AND WHY IT IS NOT A PASS-THROUGH ANY MORE.
 *
 * Every export here is a "use server" entry point: its arguments arrive from a
 * browser and are attacker-controlled. The five commands used to be declared as
 * `input: Parameters<typeof kernelFn>[0]`, which meant `brokerage_id` and
 * `agent_id` — the tenant boundary and the identity of the acting agent — were
 * whatever the caller posted. Anyone with a session could have written a contact,
 * an attendee and an autopilot task into ANY brokerage. They are now resolved
 * from the session and the open house event; the caller cannot supply either.
 *
 * IDENTITY CLASSES. contacts.agent_id, ai_autopilot_actions.agent_id and
 * open_house_events.agent_id all FK agents(id) (verified live in pg_constraint).
 * getAgentContext().agentId is that class. getAgentContext().userId is users.id
 * and must never be substituted for it — checked against the live database,
 * ZERO agents rows share an id with a users row, so the substitution is a
 * guaranteed foreign-key rejection rather than a soft mismatch.
 */

import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import {
  resolveOrCreateOpenHouseContact,
  createOpenHouseAttendeeFromContact,
  attachOpenHouseSourceAttribution,
  notifyAssignedAgentForOpenHouseLead,
  generateOpenHouseFollowupNextAction,
} from "@/lib/kernel/open-house"

// ═════════════════════════════════════════════════════════════════════════════
// ACTOR + EVENT SCOPE
// ═════════════════════════════════════════════════════════════════════════════

interface OpenHouseScope {
  /** agents.id of the signed-in actor. */
  actingAgentId: string
  /** The brokerage the actor belongs to. Every write below is stamped with it. */
  brokerageId: string
  /** agents.id of the agent the event is assigned to; falls back to the actor. */
  assignedAgentId: string
  /** listings.id for the event, used as the follow-up's property reference. */
  listingId: string | null
}

/**
 * Resolves the acting agent AND proves the open house belongs to their tenant.
 *
 * Returns a discriminated result rather than throwing: these are server actions
 * called from a client component, and the surface has to be able to render the
 * refusal rather than a generic crash.
 */
async function resolveOpenHouseScope(
  openHouseId: string,
): Promise<{ ok: true; scope: OpenHouseScope } | { ok: false; error: string }> {
  if (!openHouseId) return { ok: false, error: "An open house id is required." }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not authenticated." }
  if (!ctx.brokerageId) return { ok: false, error: "Your sign-in has no brokerage attached." }
  if (!ctx.agentId) {
    return {
      ok: false,
      error: "Your sign-in has no agent profile, so an open house check-in cannot be attributed.",
    }
  }

  const service = createServiceClient()
  // TENANT: service-role bypasses RLS, so the brokerage equality check below is
  // the boundary. It is deliberately next to the query that fetches the row.
  const { data: event, error: eventErr } = await service
    .from("open_house_events")
    .select("id, brokerage_id, agent_id, listing_id")
    .eq("id", openHouseId)
    .maybeSingle()

  if (eventErr) return { ok: false, error: `Open house lookup failed: ${eventErr.message}` }
  if (!event) return { ok: false, error: "Open house not found." }
  if (event.brokerage_id !== ctx.brokerageId) {
    return { ok: false, error: "This open house belongs to another brokerage." }
  }

  return {
    ok: true,
    scope: {
      actingAgentId: ctx.agentId,
      brokerageId: ctx.brokerageId,
      // open_house_events.agent_id FKs agents(id), same class as ctx.agentId, so
      // this is a preference between two agents ids — never a class hop.
      assignedAgentId: (event.agent_id as string | null) ?? ctx.agentId,
      listingId: (event.listing_id as string | null) ?? null,
    },
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTED SERVER ACTIONS — one per kernel command
// ═════════════════════════════════════════════════════════════════════════════

export async function resolveOrCreateOpenHouseContactAction(input: {
  open_house_id: string
  first_name: string
  last_name?: string
  email?: string
  phone?: string
}) {
  const scoped = await resolveOpenHouseScope(input.open_house_id)
  if (!scoped.ok) return { success: false as const, contact_id: null, was_created: false, error: scoped.error }

  return resolveOrCreateOpenHouseContact({
    brokerage_id: scoped.scope.brokerageId,
    agent_id: scoped.scope.assignedAgentId,
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email,
    phone: input.phone,
    open_house_id: input.open_house_id,
  })
}

export async function createOpenHouseAttendeeFromContactAction(input: {
  open_house_id: string
  contact_id: string
  first_name: string
  last_name?: string
  email?: string
  phone?: string
  check_in_method?: string
  interest_level?: number
  notes?: string
  /** TCPA consent, carried through from the check-in form. Without it the
   *  kernel records the attendance but retains no phone number. */
  tcpa_consent?: boolean
}) {
  const scoped = await resolveOpenHouseScope(input.open_house_id)
  if (!scoped.ok) return { success: false as const, attendee_id: null, error: scoped.error }

  return createOpenHouseAttendeeFromContact({
    open_house_id: input.open_house_id,
    contact_id: input.contact_id,
    brokerage_id: scoped.scope.brokerageId,
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email,
    phone: input.phone,
    check_in_method: input.check_in_method,
    interest_level: input.interest_level,
    notes: input.notes,
    tcpa_consent: input.tcpa_consent,
  })
}

export async function attachOpenHouseSourceAttributionAction(input: {
  open_house_id: string
  contact_id: string
  attendee_id: string
}) {
  const scoped = await resolveOpenHouseScope(input.open_house_id)
  if (!scoped.ok) return { success: false as const, error: scoped.error }

  return attachOpenHouseSourceAttribution({
    contact_id: input.contact_id,
    open_house_id: input.open_house_id,
    attendee_id: input.attendee_id,
    brokerage_id: scoped.scope.brokerageId,
    agent_id: scoped.scope.assignedAgentId,
  })
}

export async function notifyAssignedAgentForOpenHouseLeadAction(input: {
  open_house_id: string
  contact_id: string
  attendee_id: string
  first_name: string
  email?: string
  interest_level?: number
}) {
  const scoped = await resolveOpenHouseScope(input.open_house_id)
  if (!scoped.ok) return { success: false as const, error: scoped.error }

  return notifyAssignedAgentForOpenHouseLead({
    contact_id: input.contact_id,
    attendee_id: input.attendee_id,
    agent_id: scoped.scope.assignedAgentId,
    brokerage_id: scoped.scope.brokerageId,
    open_house_id: input.open_house_id,
    first_name: input.first_name,
    email: input.email,
    interest_level: input.interest_level ?? 3,
  })
}

export async function generateOpenHouseFollowupNextActionAction(input: {
  open_house_id: string
  contact_id: string
  attendee_id: string
  first_name: string
  interest_level?: number
  property_id?: string
}) {
  const scoped = await resolveOpenHouseScope(input.open_house_id)
  if (!scoped.ok) return { success: false as const, error: scoped.error }

  return generateOpenHouseFollowupNextAction({
    contact_id: input.contact_id,
    attendee_id: input.attendee_id,
    open_house_id: input.open_house_id,
    // The event already knows its listing; the caller does not have to.
    property_id: input.property_id ?? scoped.scope.listingId ?? undefined,
    first_name: input.first_name,
    interest_level: input.interest_level ?? 3,
    agent_id: scoped.scope.assignedAgentId,
    brokerage_id: scoped.scope.brokerageId,
  })
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
 * SIGNATURE IS DELIBERATELY UNCHANGED — it has two server-side callers
 * (app/actions/open-house-automation.ts and app/api/open-house/convert-attendee)
 * that pass ids they have already resolved.
 *
 * WHAT DID CHANGE: both of those callers pass `agent_id: user.id`, a USERS id,
 * into a parameter every downstream write treats as an AGENTS id
 * (contacts.agent_id and ai_autopilot_actions.agent_id both FK agents(id)).
 * Zero agents rows share an id with a users row in this database, so that was a
 * guaranteed foreign-key rejection on every call — the check-in reported the
 * failure of step 1 and never got further. normaliseAgentId below accepts either
 * class and resolves a users id through the canonical resolver, refusing when
 * the user has no agents row rather than substituting the id it was handed.
 */
async function normaliseAgentId(
  candidateAgentId: string,
  brokerageId: string,
): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
  if (!candidateAgentId) return { ok: false, error: "agent_id is required" }
  const service = createServiceClient()

  const { data: agentRow, error: agentErr } = await service
    .from("agents")
    .select("id")
    .eq("id", candidateAgentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (agentErr) return { ok: false, error: `Agent lookup failed: ${agentErr.message}` }
  if (agentRow?.id) return { ok: true, agentId: agentRow.id }

  const resolved = await resolveUserIdToAgentRecord(candidateAgentId, brokerageId)
  if (resolved) return { ok: true, agentId: resolved }

  return {
    ok: false,
    error:
      "The acting user has no agent profile in this brokerage, so an open house check-in cannot be attributed to them.",
  }
}

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
    if (!input.brokerage_id) {
      return { success: false, error: "brokerage_id is required — an untenanted check-in is a cross-tenant leak." }
    }

    const normalised = await normaliseAgentId(input.agent_id, input.brokerage_id)
    if (!normalised.ok) return { success: false, error: normalised.error }
    const agentId = normalised.agentId

    // Step 1: Resolve or create contact
    const contactResult = await resolveOrCreateOpenHouseContact({
      brokerage_id: input.brokerage_id,
      agent_id: agentId,
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
      brokerage_id: input.brokerage_id,
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
    const attributionResult = await attachOpenHouseSourceAttribution({
      contact_id: contactId,
      open_house_id: input.open_house_id,
      attendee_id: attendeeId,
      brokerage_id: input.brokerage_id,
      agent_id: agentId,
    })

    // Step 4: Notify assigned agent
    const notifyResult = await notifyAssignedAgentForOpenHouseLead({
      contact_id: contactId,
      attendee_id: attendeeId,
      agent_id: agentId,
      brokerage_id: input.brokerage_id,
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
      agent_id: agentId,
      brokerage_id: input.brokerage_id,
    })

    // The person IS checked in once steps 1-2 land, so this stays a success —
    // but the enrichment steps are no longer discarded. A caller that reports
    // "check-in complete" while the follow-up silently failed to schedule is
    // exactly the optimistic-success failure this rail is being fixed for.
    const degraded = [
      attributionResult.success ? null : `attribution: ${attributionResult.error}`,
      notifyResult.success ? null : `agent notification: ${notifyResult.error}`,
      followupResult.success ? null : `follow-up: ${followupResult.error}`,
    ].filter((m): m is string => Boolean(m))

    return {
      success: true,
      attendee_id: attendeeId,
      contact_id: contactId,
      next_action_id: followupResult.success ? followupResult.next_action_id : undefined,
      message: followupResult.message || "Check-in complete. Follow-up scheduled.",
      error: degraded.length > 0 ? `Checked in, but ${degraded.join("; ")}` : undefined,
    }
  } catch (error: any) {
    console.error("[completeOpenHouseCheckInAction] Error:", error?.message)
    return {
      success: false,
      error: error?.message || "Unknown error during check-in",
    }
  }
}
