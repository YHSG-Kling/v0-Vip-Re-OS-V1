"use server"

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createClient } from "@/lib/supabase/server"
import {
  scheduleListingAppointmentService,
  advanceListingStageService,
  getListingTimelineService,
  getListingTasksService,
  completeListingTaskService,
  sendReviewRequestService,
} from "@/lib/application/listing-lifecycle"

// TOMBSTONE — `export { getListings, createListing }` was REMOVED here.
//
// This file is `"use server"`, so those two lines were not re-exports: they were
// PUBLIC HTTP ENDPOINTS. And they aliased the RAW lib-layer services
// (`getListingsService` / `createListingService`), which take their tenant from a
// PARAMETER — so a browser could POST `{ brokerageId: "<any uuid>" }` and name the
// tenant it wanted, the IDOR shape CLAUDE.md §4 names. The gated survivors had
// already been built and this door bypassed both of them:
//
//   getListings   → app/actions/listings.ts:62 — session-derived tenant via
//                   getAgentContext, agent id may only NARROW, and only for a
//                   broker/admin inside their own tenant
//   createListing → app/actions/listings.ts:134 — stamps the session's brokerage
//                   on the row (the adjacent fix noted in
//                   lib/dashboard/data-survivors.ts:103, which recorded the same
//                   defect as already merged onto that survivor)
//
// the actions barrel (app/actions/index, deleted this wave):106-113 already exports BOTH names from "./listings", so
// nothing imported them from here and no caller changes. The comment these lines
// carried — "Re-exports moved to direct imports from listings.ts" — says the move
// happened; only the deletion was missed.

// =====================================================
// LISTING LIFECYCLE SERVER ACTIONS
// Thin wrappers: validate → authenticate → delegate
// =====================================================

export async function scheduleListingAppointment(params: {
  listing_id: string
  contact_id: string
  appointment_date: string
  appointment_time: string
  notes?: string
  /** "zoom" attempts a REAL Zoom meeting on the booker's connected scope
   *  (agent → team → brokerage); honest in-person default when not connected. */
  meeting_mode?: "zoom" | "in_person"
}) {
  if (!params.listing_id || !params.contact_id) throw new Error("listing_id and contact_id are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  const result = await scheduleListingAppointmentService(params, user.id, profile.brokerage_id)

  // THE BOOKING STARTS THE SELLER'S LISTING-PRESENTATION PREP (lane 87B, owner wave 87:
  // "listing presentation prep which inlcudes the cma needs to be for a seller as this is
  // started from the listing appointmtent booking"). The service just wrote the consult's
  // calendar_events row (appointmentEventId); the listing-appt-prep chain's own trigger
  // (fireListingAppointmentSetForBooking — the original chain is the survivor, lane 88D)
  // reads THAT row, proves the contact is the seller (the listing's seller, or a
  // seller-typed contact), takes the property from the listing row and the agent's
  // users.id from the row, all inside the row's tenant — which must be this SESSION's —
  // and records ONE listing.appointment_set event per booking, so the stage pipeline and
  // the cron safety net collapse onto the same event and the same run. Best-effort — the
  // appointment is already booked even if the prep cannot start.
  try {
    const appointmentEventId = (result as { appointmentEventId?: string } | null)?.appointmentEventId ?? null
    if (appointmentEventId) {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { fireListingAppointmentSetForBooking } = await import("@/lib/workflow-orchestrator/chains/listing-appt-prep")
      const prep = await fireListingAppointmentSetForBooking(createServiceClient(), {
        calendarEventId: appointmentEventId,
        expectedBrokerageId: profile.brokerage_id,
        listingId: params.listing_id,
        origin: "listing_consult",
      })
      if (prep.status === "error") console.error("[scheduleListingAppointment] listing prep did not start:", prep.reason)
    }
  } catch (err) {
    console.error("[scheduleListingAppointment] listing prep start threw:", err)
  }

  return result
}

// markListingSigned + markListingLive RETIRED — the UI drives go-live / agreement-signed through
// advanceListingStage (triggerStageActions owns those stage cases + the MLS packet queue). These
// duplicated that with orphaned-event side effects that never fired.

// updateListingStage RETIRED (2026-09-09, wave 46) — a THIRD writer of listings.lifecycle_stage with no
// UI caller. Survivor: advanceListingStage below → lib/application/listing-lifecycle.ts::advanceListingStageService,
// which runs the same gate, keeps listings.status in lockstep, writes stage history, emits the kernel events and
// fires the seller-to-lifetime transition. The service half (updateListingStageService) was deleted with it.

export async function advanceListingStage(
  listingId: string,
  toStage: string,
  agentId: string,
  notes?: string,
  /** Manual override — requires broker / admin / superadmin / compliance role
   *  + min 10-char reason. Bypasses stage prerequisite checks; writes audit
   *  row with the override reason + actor for compliance. */
  overrideReason?: string,
) {
  if (!listingId || !toStage || !agentId) throw new Error("listingId, toStage, and agentId are required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  if (overrideReason) {
    const { requireOverrideActor, PortalAuthError } = await import("@/lib/kernel/portal-auth")
    let overrideCtx
    try {
      overrideCtx = await requireOverrideActor(overrideReason)
    } catch (err) {
      if (err instanceof PortalAuthError) throw err
      throw err
    }

    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    // Verify listing scope
    const { data: listing } = await svc
      .from("listings")
      .select("id, brokerage_id, lifecycle_stage")
      .eq("id", listingId)
      .eq("brokerage_id", overrideCtx.brokerageId)
      .maybeSingle()
    if (!listing) throw new Error("Listing not found in your brokerage")

    // Force stage transition
    const { error: updateErr } = await svc
      .from("listings")
      .update({ lifecycle_stage: toStage, updated_at: new Date().toISOString() })
      .eq("id", listingId)
      .eq("brokerage_id", overrideCtx.brokerageId)
    if (updateErr) throw updateErr

    // Audit trail
    await sentinelWrite(svc, svc.from("lifecycle_events").insert({
      brokerage_id:  overrideCtx.brokerageId,
      entity_type:   "listing",
      entity_id:     listingId,
      event_type:    "listing.stage_overridden",
      actor_user_id: overrideCtx.userId,
      metadata: {
        from_stage:           listing.lifecycle_stage,
        to_stage:             toStage,
        override_reason:      overrideCtx.reason,
        override_actor:       overrideCtx.userId,
        override_user_type:   overrideCtx.userType,
        notes:                notes ?? null,
      },
      created_at: new Date().toISOString(),
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    // A manual override still RUNS the stage's automations — the listing IS now at this stage, so its
    // managers must act (prep chain, packet, …). The override only bypassed the PREREQUISITE gates.
    await fireStageAutomations(listingId, toStage, overrideCtx.userId)

    return { success: true, listingId, fromStage: listing.lifecycle_stage, toStage }
  }

  const result = await advanceListingStageService(listingId, toStage, agentId, notes)

  // AUTOMATIONS FOLLOW A REAL ADVANCE, NEVER A REFUSED ONE. The service now
  // gates on the stage table (readiness / role / allowedFrom) and reports a
  // refusal by RETURNING { success: false } rather than throwing — firing the
  // prep chain or queueing the MLS packet after a refusal would act on a stage
  // the listing is not in.
  if (!result?.success) return result

  // Run the canonical-stage automations (prep chain, packet) — see fireStageAutomations.
  await fireStageAutomations(listingId, toStage, user.id)

  return result
}

/**
 * Canonical-stage automations, fired at the ACTION layer in BOTH the normal and override paths.
 *
 * WHY HERE (not triggerStageActions): triggerStageActions (lib/application) switches on a LEGACY
 * lowercase stage vocabulary ("appointment_scheduled", "mls_active", "cma_prepared", …) that no longer
 * matches the canonical UPPERCASE lifecycle stages ("APPOINTMENT_SET", "MLS_ACTIVE", …), so it hits
 * `default` for every real UI stage advance — the stage automations there are dead. Reconciling that
 * whole legacy switch is a dedicated pass; meanwhile the highest-value automations are fired here on
 * the CANONICAL stage names so they actually run. A manual OVERRIDE bypasses prerequisites, not these
 * consequences — the stage IS now that stage, so its automations must reflect reality.
 */
async function fireStageAutomations(listingId: string, toStage: string, actorUserId: string): Promise<void> {
  try {
    const { stageAutomationFor } = await import("@/lib/listing-lifecycle/stage-automations")
    const automation = stageAutomationFor(toStage)
    if (!automation) return

    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()

    if (automation === "listing_appt_prep") {
      // Flagship pre-listing prep, STARTED FROM THE BOOKING (lane 87B, owner wave 87).
      // A stage flip to APPOINTMENT_SET is not itself a booking: the prep starts
      // from the listing's calendar_events row (listings.appointment_event_id, written
      // by scheduleListingAppointmentService) through the chain's own trigger
      // (fireListingAppointmentSetForBooking), which proves the seller, resolves the
      // seller's property and the agent's users.id inside the row's tenant, and records
      // ONE listing.appointment_set event per booking — so this path, the consult
      // booking itself and the cron safety net collapse onto ONE run. With no booking
      // row there is no appointment date for the drip to count down to (enroll_drip
      // refused "Missing appointment_date" on every such run), so nothing is started
      // and the reason is logged — book the consult to start the prep.
      const { data: listing, error: listingErr } = await svc
        .from("listings")
        .select("brokerage_id, appointment_event_id")
        .eq("id", listingId)
        .maybeSingle()
      if (listingErr) {
        console.error(`[fireStageAutomations] listing ${listingId} read refused — listing prep not started: ${listingErr.message}`)
      } else if (!listing?.appointment_event_id) {
        console.warn(`[fireStageAutomations] listing ${listingId} reached APPOINTMENT_SET with no booked appointment — listing prep starts from the booking`)
      } else {
        const { fireListingAppointmentSetForBooking } = await import("@/lib/workflow-orchestrator/chains/listing-appt-prep")
        const prep = await fireListingAppointmentSetForBooking(svc, {
          calendarEventId: listing.appointment_event_id,
          expectedBrokerageId: listing.brokerage_id ?? null,
          listingId,
          origin: "listing_stage_pipeline",
        })
        if (prep.status === "error") console.error(`[fireStageAutomations] listing prep did not start: ${prep.reason}`)
      }
    } else if (automation === "mls_packet") {
      // TOMBSTONE — the bare `listing_packet_jobs` INSERT (job_type 'mls_packet',
      // status 'pending', config of include* flags, NO content) that used to live
      // here is GONE. Nothing in the tree ever processed a 'pending' packet job,
      // so every row this queued was permanently stuck: never generated, never
      // rendered, never downloadable. The survivor is the REAL generator —
      // autoGeneratePacketOnLive → generateListingPacket
      // (app/actions/ai-listing-packet.ts), the same one launchListingAction
      // dispatches at go-live (app/actions/listings-kernel.ts:697-698). This is
      // NOT a duplicate of that kernel dispatch: the stage pipeline
      // (stage-pipeline.tsx → advanceListingStage → here) reaches MLS_ACTIVE
      // without ever passing through launchListingAction, so this path must fire
      // the generator itself. The two paths are idempotent against each other via
      // the same existing-full_packet guard the kernel uses; generateListingPacket's
      // own MLS-live gate passes because advanceListingStageService writes
      // status='active' for MLS_ACTIVE in the same update (statusForStage,
      // lib/application/listing-lifecycle.ts:470). Tenant comes from the SESSION
      // inside generateListingPacket (requireCaller + listing-ownership check) —
      // no tenant stamping needed here anymore.
      const { data: existing, error: existingError } = await svc
        .from("listing_packet_jobs")
        .select("id")
        .eq("listing_id", listingId)
        .eq("job_type", "full_packet")
        .limit(1)
        .maybeSingle()
      // A refused read is not "no packet yet" — treating it as one re-spends six
      // GPT-4o generations.
      if (existingError) {
        console.error("[fireStageAutomations] could not check for an existing listing packet:", existingError.message)
        return
      }
      if (!existing) {
        // DISPATCHED, not awaited — same pattern as the kernel's go-live call:
        // the stage advance must not wait on six document generations.
        const { autoGeneratePacketOnLive } = await import("@/app/actions/ai-listing-packet")
        void autoGeneratePacketOnLive(listingId, actorUserId).then((r) => {
          if (!r?.success) {
            console.error("[fireStageAutomations] listing packet NOT generated:", r?.error)
          }
        })
      }
    }
  } catch (err) {
    console.error("[fireStageAutomations] failed:", err)
  }
}

// The session check and the brokerage ownership gate live in the service (which
// is now the ONE timeline read — app/actions/listings.ts used to hold a second
// copy that embedded a `profiles` table the database does not have). Do not
// re-inline the query here.
export async function getListingTimeline(listingId: string) {
  if (!listingId) throw new Error("listingId is required")
  return getListingTimelineService(listingId)
}

export async function getListingTasks(listingId: string) {
  if (!listingId) throw new Error("listingId is required")
  return getListingTasksService(listingId)
}

export async function completeListingTask(taskId: string) {
  if (!taskId) throw new Error("taskId is required")

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  return completeListingTaskService(taskId)
}

// TOMBSTONE (lane 86F, orphan doctrine §1.1) — the eight "EVENT HANDLERS -
// Called by orchestrator" wrappers LIVED HERE and are gone:
// handleListingAppointmentBooked, handleListingAgreementSigned,
// handleListingLive, handlePriceReduction, handleOfferReceived,
// handleContingencyCleared, handleClosingApproaching, triggerReviewSequence.
// Each was a "use server" export — a PUBLIC HTTP endpoint with no gate at all —
// that forwarded a caller's payload to a lib service on the COOKIE client; the
// one real caller (lib/orchestrator/internal.ts EVENT_HANDLERS, dispatched
// from cron and webhooks) has no cookie, so every one of them read nothing.
// SURVIVOR: lib/listing-lifecycle/lifecycle-event-tasks.ts (server-only; the
// service client with the EVENT row's tenant), which the orchestrator now calls
// directly. Seven had no browser caller, so no public door was kept for them;
// handlePriceReduction DOES (app/dashboard/listings/[id]/components/
// price-reduction-sheet.tsx), so it stays — below — as a SESSION door onto the
// same core.

/**
 * The price-reduction sheet's "marketing follow-up task" — the SESSION door onto
 * lib/listing-lifecycle/lifecycle-event-tasks.ts::priceReductionTasks (the same
 * core the orchestrator's listing.price_reduction event runs). Gated here (it was
 * an ungated public endpoint), the tenant is the SESSION's and the core refuses
 * a listing outside it; only `listing_id` is read from the payload — the sheet's
 * agentId / brokerageId fields are ignored (CLAUDE.md §4).
 */
export async function handlePriceReduction(payload: { listing_id?: string } & Record<string, unknown>) {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { priceReductionTasks } = await import("@/lib/listing-lifecycle/lifecycle-event-tasks")
  return priceReductionTasks(createServiceClient(), ctx.brokerageId, { listing_id: payload?.listing_id ?? null })
}

/**
 * 🚨 THIS SENDS AN SMS, AND IT WAS AN ANONYMOUS ENDPOINT.
 *
 * `"use server"` export → public HTTP endpoint. Neither this wrapper nor
 * `lib/application/listing-lifecycle.ts:sendReviewRequestService` had any auth
 * gate. The service reads `review_requests` by a caller-supplied uuid joined to
 * `contact:contacts(*)` — the FULL contact record, phone number included — and
 * then dispatches an SMS to that number. So a bare request uuid was enough to
 * (a) read another brokerage's client PII and (b) make the platform text that
 * client. `dispatchSms` still applies consent/DNC/quiet-hours, which bounds the
 * abuse but does not authorize the caller.
 *
 * `completeListingTask` immediately above already does `auth.getUser()`, and
 * `getListingTasks`'s service carries its own `callerBrokerageId` gate — the file
 * header's contract is "validate → authenticate → delegate". This one skipped the
 * middle step. Gated here, at the endpoint, and scoped: the request must belong to
 * the caller's brokerage before the service is allowed to touch it.
 */
export async function sendReviewRequest(requestId: string, platform: string) {
  if (!requestId || !platform) throw new Error("requestId and platform are required")

  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const { data: reviewRequest, error: readError } = await supabase
    .from("review_requests")
    .select("id, brokerage_id")
    .eq("id", requestId)
    .maybeSingle()

  // A refused read is not "no rows" — both fail closed, before anything is sent.
  if (readError) return { success: false, error: "Could not load that review request" }
  // review_requests.brokerage_id is nullable, so compare explicitly and refuse an
  // untenanted row: an unprovable owner must not authorize an outbound message.
  if (!reviewRequest || reviewRequest.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Review request not found" }
  }

  return sendReviewRequestService(requestId, platform)
}

// TOMBSTONE (lane 63B, CLAUDE.md §1) — `export { scheduleClosingGift }` was REMOVED
// here. This file is `"use server"`, so a bare re-export was itself a §4 hazard
// (every export is a public HTTP endpoint and must be async). Its only consumer,
// lib/orchestrator/internal.ts, now imports the survivor directly — since lane
// 86F lib/listing-lifecycle/lifecycle-event-tasks.ts::scheduleClosingGiftForListing
// (the lib/application copy was cookie-bound and refused every event dispatch).

// ─── Portal Visibility ────────────────────────────────────────────────────────

/**
 * Set portal_visible flag on the most recent lifecycle_event for a given stage.
 * Agents use this to share milestone updates with the buyer/seller portal.
 */
export async function setMilestonePortalVisibility(
  listingId: string,
  stage: string,
  visible: boolean
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

  // Verify the listing belongs to caller's brokerage before changing portal visibility
  const { data: listing } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { success: false, error: "Listing not found" }
  if (listing.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }

  // Find the most recent event for this stage — scoped to caller's brokerage.
  //
  // THIS READ COULD NEVER MATCH. It filtered entity_type = "listing", but a
  // STAGE is not what that entity type records. ENTITY_MAP in
  // lib/kernel/lifecycle.ts is explicit — and carries its own warning not to
  // merge the two:
  //   listing               -> listings.status          (MLS status only)
  //   listing_stage_machine -> listings.lifecycle_stage  (the stage machine)
  // This function's `stage` argument is a lifecycle_stage, so every event it
  // wanted was written under listing_stage_machine and it was looking at the
  // MLS-status stream instead. Result: EVERY portal-visibility toggle returned
  // "Event not found" and the milestone silently never became visible to the
  // client — a control that reports a specific, plausible failure while being
  // structurally incapable of succeeding.
  //
  // Both entity types are read rather than swapping to one, matching the
  // precedent set when loadListingWorkspace hit this same split: the two
  // streams have DIFFERENT producers, and to_state disambiguates them anyway
  // (an MLS status can never equal a lifecycle stage), so reading both cannot
  // mismatch and cannot miss a producer added later.
  const { data: evt, error: fetchError } = await supabase
    .from("lifecycle_events")
    .select("id, metadata")
    .in("entity_type", ["listing_stage_machine", "listing"])
    .eq("entity_id", listingId)
    .eq("brokerage_id", callerRow.brokerage_id)
    .eq("metadata->>to_state", stage)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (fetchError) {
    // A refused read is not "no such milestone" — say which it was.
    return { success: false, error: `Could not load the stage event: ${fetchError.message}` }
  }
  if (!evt) {
    return {
      success: false,
      error: `No recorded transition into "${stage}" for this listing, so there is no milestone to show or hide yet.`,
    }
  }

  const updatedMetadata = { ...(evt.metadata ?? {}), portal_visible: visible }

  const { error: updateError } = await supabase
    .from("lifecycle_events")
    .update({ metadata: updatedMetadata })
    .eq("id", evt.id)
    .eq("brokerage_id", callerRow.brokerage_id)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  return { success: true }
}
