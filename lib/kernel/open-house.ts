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
 *
 * TOMBSTONE (§1.3 + §2, 2026-08-31, lane M4): lib/kernel/OPEN-HOUSE-PATCH-DOCS.ts
 * deleted. It was a prose status report wearing a .ts extension — 291 lines of
 * comment plus one waypoint const (IMPLEMENTATION_COMPLETE = true) that nothing
 * imported and no guard asserted. §2 forbids pinning to a waypoint: "complete"
 * was a statement about one 2026 patch session, permanently stale the moment the
 * code moved on. The capability it described survives as THIS module plus
 * app/actions/open-house-kernel.ts, proven by test:open-house-consolidation and
 * test:open-house-lead-routing — running guards, not a self-declared checklist.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.
import { KernelEvent } from "./events"
import type { WelcomeOrigin } from "@/lib/contact-promotion/welcome-situation"

// ═════════════════════════════════════════════════════════════════════════════
// THE WELCOME `origin` — shared by every reader that hands an open-house-sourced
// contact to deliverConversionWelcome (owner ruling 2026-09-10, wave 51: "contact
// came from open house — same welcome email but mentions the open house").
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the them-first open-house facts (listing address + date) for
 * `WelcomeOrigin`, given the open_house_events.id.
 *
 * NEVER a guess: `open_house_events` carries `property_address` and `event_date`
 * directly — no join to `listings` needed. Returns null (no origin) when either
 * is missing rather than inventing a placeholder date/address — the welcome still
 * sends, it simply says nothing about the visit.
 */
export async function resolveOpenHouseWelcomeOrigin(
  supabase: ReturnType<typeof createServiceClient>,
  openHouseId: string | null | undefined,
): Promise<WelcomeOrigin | null> {
  if (!openHouseId) return null
  const { data } = await supabase
    .from("open_house_events")
    .select("property_address, event_date")
    .eq("id", openHouseId)
    .maybeSingle()
  const row = data as { property_address?: string | null; event_date?: string | null } | null
  if (!row?.property_address || !row.event_date) return null
  return { kind: "open_house", listingAddress: row.property_address, openHouseDate: row.event_date }
}

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
  /** Wave 148Z: true when the contact was ALREADY checked in to this event (m925's unique index answered 23505). */
  already_checked_in?: boolean
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

    // ONE DOOR (wave 148, lane 148B — owner ruling 4; lane 147Z Still open 1). TOMBSTONE (orphan doctrine §1.1): the exact
    // email-then-phone lookup and the contacts INSERT that stood here were a SECOND contact writer beside THE one survivor,
    // lib/contact-pipeline/contact-capture.ts captureContact. Merged onto it, with the semantics this kernel held preserved:
    //   · a refused dedupe read ABORTS (never falls through to an insert) — captureContact's dedupe now throws on a refused
    //     read, so the refusal comes back below as success:false with the reason;
    //   · an existing contact is RESOLVED, never overwritten — captureContact's merge is fill-if-empty (a conflicting value is
    //     kept in notes), and the same email is the same person even with a different phone;
    //   · a new walk-in is a buyer-side contact (the visit is to a for-sale listing), source open_house, status active, the
    //     event's agent as owner AND creator (contacts.source_agent_id — ruling 12, assigned back to them);
    //   · enrichment is queued (captureContact's create path), and the welcome + portal invite ride the one welcome path.
    // NO CONSENT IS CLAIMED: this kernel command is the AGENT typing a walk-in's details — not the person's own box. A visitor
    // who signs in themselves goes through the kiosk / event-day doors, which record what they ticked (C8 + C15).
    const { data: agentRow, error: agentRowErr } = await supabase.from("agents").select("user_id").eq("id", agent_id).eq("brokerage_id", brokerage_id).maybeSingle()
    if (agentRowErr) {
      return { success: false, contact_id: null, was_created: false, error: `Agent lookup failed: ${agentRowErr.message}` }
    }
    const { captureContact } = await import("@/lib/contact-pipeline/contact-capture")
    let captured: Awaited<ReturnType<typeof captureContact>>
    try {
      captured = await captureContact({
        brokerageId: brokerage_id,
        ownerAgentId: agent_id,
        creatorUserId: (agentRow as { user_id?: string | null } | null)?.user_id ?? null,
        source: "open_house",
        contact_type: "buyer",
        status: "active",
        first_name: first_name.trim(),
        last_name: (last_name || "").trim() || null,
        email: email ? email.trim().toLowerCase() : null,
        phone: phone ? phone.trim() : null,
        tcpa_consent: false,
        metadata: open_house_id ? { open_house_id } : null,
      }, { client: supabase })
    } catch (e) {
      return {
        success: false,
        contact_id: null,
        was_created: false,
        error: `Failed to resolve or create contact: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    console.log(
      `[Kernel] ${captured.action === "created" ? "Created new" : "Resolved existing"} contact ${captured.contactId} (open_house: ${open_house_id})`
    )

    return {
      success: true,
      contact_id: captured.contactId,
      was_created: captured.action === "created",
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
  /**
   * TENANT STAMP — NOT OPTIONAL.
   * open_house_attendees RLS reads
   *   ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))
   * on select, update AND delete (verified live in pg_policies). An attendee
   * row written without a brokerage_id is therefore readable — and editable —
   * by EVERY brokerage on the platform, not merely untidy. This insert used to
   * omit the column entirely.
   */
  brokerage_id: string
  first_name: string
  last_name?: string
  email?: string
  phone?: string
  check_in_method?: string
  interest_level?: number
  notes?: string
  /**
   * TCPA CONSENT — MOVED HERE FROM app/actions/open-house.ts:recordAttendee,
   * which is being retired. That function gated phone storage on consent
   * (`phone: tcpaConsent ? phone : null`) and this one did not, so repointing
   * the walk-in surface at the kernel would have started storing a walk-in's
   * mobile number with tcpa_consent recorded as FALSE — capturing a number the
   * OS then knows it has no permission to dial or text. The column is NOT NULL
   * DEFAULT false, so omitting it does not fail loudly; it just quietly records
   * the absence of consent next to the number it should have suppressed.
   *
   * The rule is the same one the public kiosk route enforces: no consent, no
   * phone number retained. Name, email and the attendance record are all still
   * captured — declining consent costs the lead nothing except the phone.
   */
  tcpa_consent?: boolean
}): Promise<CreateAttendeeResult> {
  const supabase = createServiceClient()

  try {
    const {
      open_house_id,
      contact_id,
      brokerage_id,
      first_name,
      last_name,
      email,
      phone,
      check_in_method = "manual",
      interest_level = 3,
      notes,
      tcpa_consent = false,
    } = input

    // Validate required fields
    if (!open_house_id || !contact_id) {
      return {
        success: false,
        attendee_id: null,
        error: "open_house_id and contact_id are required",
      }
    }
    if (!brokerage_id) {
      return {
        success: false,
        attendee_id: null,
        error: "brokerage_id is required — an untenanted attendee row is readable by every brokerage",
      }
    }

    // Insert attendee record
    const { data: attendee, error: insertErr } = await supabase
      .from("open_house_attendees")
      .insert({
        event_id: open_house_id,
        contact_id,
        brokerage_id,
        name: `${first_name.trim()} ${(last_name || "").trim()}`.trim(),
        email: email ? email.trim().toLowerCase() : null,
        // NO CONSENT, NO NUMBER. Storing the digits while recording
        // tcpa_consent false is the worst of both: the OS holds a number it is
        // not permitted to dial or text, and every downstream consent check
        // reads false and suppresses it anyway. Drop it at the write.
        phone: tcpa_consent && phone ? phone.replace(/\D/g, "") : null,
        tcpa_consent,
        // interest_level is CHECK-constrained (hot|warm|cold|no_interest); map the numeric 1-5 input.
        interest_level:
          interest_level == null ? "warm"
          : interest_level >= 4 ? "hot"
          : interest_level >= 3 ? "warm"
          : interest_level >= 2 ? "cold" : "no_interest",
        check_in_time: new Date().toISOString(),
        notes,
      })
      .select("id")
      .single()

    // A REPEAT WALK-IN (wave 148, 148Z — lane 148H Outside-lane 3): since m925's uq_open_house_attendees_event_contact the
    // same contact checking in twice at one event answers 23505. That is "already checked in", not a failure — read back THE
    // existing attendee (tenant-pinned) and return it, as the public kiosk route already does. A refused read-back is said.
    if (insertErr?.code === "23505") {
      const { data: prior, error: priorErr } = await supabase
        .from("open_house_attendees").select("id")
        .eq("event_id", open_house_id).eq("contact_id", contact_id).eq("brokerage_id", brokerage_id)
        .maybeSingle()
      if (priorErr || !prior?.id) {
        return { success: false, attendee_id: null, error: `already checked in, but the existing attendee could not be read back: ${priorErr?.message ?? "no row in this tenant"}` }
      }
      console.log(`[Kernel] contact ${contact_id} is already checked in to open_house ${open_house_id} (attendee ${prior.id})`)
      return { success: true, attendee_id: prior.id as string, already_checked_in: true }
    }
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
    // IDENTITY AT CHECK-IN (wave 147, lane 147F — ruling 7). Every agent-side check-in reaches this ONE writer (the walk-in
    // completeOpenHouseCheckInAction, the /dashboard/open-houses step flow, the mobile walk-in) — and none of them linked
    // the contact + attendee to the person record the kiosk links. Through the ONE check-in identity helper; best-effort.
    const { linkOpenHouseCheckInIdentity } = await import("@/lib/open-house/instant-greeting")
    await linkOpenHouseCheckInIdentity(supabase, {
      brokerageId: brokerage_id, contactId: contact_id, attendeeId: attendee.id as string, eventId: open_house_id,
      firstName: first_name, lastName: last_name ?? null, email: email ?? null, phone: tcpa_consent ? phone ?? null : null,
      source: "open_house_walk_in",
    })
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

    if (!brokerage_id) {
      return { success: false, error: "brokerage_id is required for the attribution event" }
    }

    // Emit the kernel event — audit row + reactor.
    // The error was previously not destructured, so a refused insert resolved
    // quietly and this function reported success with no audit row written —
    // the attribution "succeeded" and the trail it exists to leave was absent.
    // emitKernelEvent reports the refusal in `error`; it is read here the same way.
    const { emitKernelEvent } = await import("./emit")
    const { error: eventErr } = await emitKernelEvent({
      entityType: "contact",
      entityId: contact_id,
      contactId: contact_id,
      event: KernelEvent.OPEN_HOUSE_CONTACT_RESOLVED,
      brokerageId: brokerage_id,
      // lifecycle_events.agent_id is agents-class (the column exists and is
      // nullable); actor_user_id is the users-class one and is deliberately
      // left alone here — an agents.id in it is an FK violation.
      agentId: agent_id,
      metadata: {
        attendee_id,
        // open_house_id rides in metadata so the reactor can resolve the welcome's
        // `origin` (listing address + date, owner ruling 2026-09-10 wave 51) without
        // a second lookup through the attendee row — see resolveOpenHouseWelcomeOrigin.
        open_house_id,
        agent_id,
        resolved_at: new Date().toISOString(),
      },
    })

    if (eventErr) {
      console.error(`[Kernel] attribution lifecycle_events insert failed:`, eventErr)
      return { success: false, error: `Failed to record open house attribution: ${eventErr}` }
    }

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
  /** AGENTS-CLASS. ai_autopilot_actions.agent_id FKs agents(id) — verified live
   *  in pg_constraint. A users.id here is rejected outright: no agents row's id
   *  is also a users id in this database (checked: zero overlap). */
  agent_id: string
  /** ai_autopilot_actions.brokerage_id FKs brokerages(id) and the dashboard read
   *  path (app/dashboard/agent/page.tsx) and every brokerage-scoped rollup key
   *  off it. It was omitted, so these rows landed untenanted. */
  brokerage_id: string
  open_house_id: string
  first_name: string
  email?: string
  interest_level: number
}): Promise<NotifyAgentResult> {
  const supabase = createServiceClient()

  try {
    const { contact_id, attendee_id, agent_id, brokerage_id, open_house_id, first_name, email, interest_level } = input

    if (!agent_id || !brokerage_id) {
      return { success: false, error: "agent_id (agents.id) and brokerage_id are both required" }
    }

    // Queue an AI next action for the agent's follow-up dashboard.
    // NOTE: this is an INTERNAL queue row, not an egress. Nothing is sent to the
    // attendee here, so no consent or channel-preference gate applies or is
    // bypassed — the agent reads it on their own dashboard.
    const { error: actionErr } = await supabase
      .from("ai_autopilot_actions")
      .insert({
        agent_id,
        brokerage_id,
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

    if (actionErr) {
      // This used to log and then `return { success: true }` regardless — the
      // one behaviour the brief calls a silent no-op that reports success. The
      // notification IS the deliverable of this command; if the row did not
      // land, the agent was never notified and the caller must be told.
      console.error(`[Kernel] Failed to create next action:`, actionErr.message)
      return { success: false, error: `Agent notification could not be queued: ${actionErr.message}` }
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
  /** AGENTS-CLASS — see notifyAssignedAgentForOpenHouseLead. */
  agent_id: string
  /** Tenant stamp for ai_autopilot_actions; see the same note. */
  brokerage_id: string
}): Promise<GenerateFollowupResult> {
  const supabase = createServiceClient()

  try {
    const { contact_id, attendee_id, open_house_id, property_id, first_name, interest_level, agent_id, brokerage_id } = input

    if (!agent_id || !brokerage_id) {
      return { success: false, error: "agent_id (agents.id) and brokerage_id are both required" }
    }

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
        brokerageId: brokerage_id,
        agentId: agent_id,
        // Lane 86D: was `model: "openai/gpt-4o-mini"` — a field the routed
        // lane IGNORES, so this ran on the Sonnet default. The pin now lives
        // in AI_TASK_ROUTING.open_house_followup_draft (lib/ai/models.ts).
        feature: "open_house_followup_draft",
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
        brokerage_id,
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
