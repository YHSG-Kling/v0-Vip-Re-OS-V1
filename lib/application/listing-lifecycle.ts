// lib/application/listing-lifecycle.ts
// Library service layer — NOT a Server Action entrypoint.
// Imported by both app/actions/ and lib/kernel/. Do NOT add "use server" here.

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import {
  getStageDefinition,
  entersFromAnyStage,
  normalizeLifecycleRole,
  type ListingStage,
  type RequiredRole,
} from "@/lib/listing-lifecycle/lifecycle-definitions"
import { validateStageTransition } from "@/lib/listing-lifecycle/transition-validator"
import { evaluateReadinessChecks } from "@/lib/listing-lifecycle/readiness-checker"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"
import { statusForStage, isGatedStage, type ListingStatusGate } from "@/lib/listings/listing-status-sync"

// =====================================================
// LISTING LIFECYCLE APPLICATION SERVICE
// All business logic lives here
// =====================================================

// ─────────────────────────────────────────────────────────────────────────────
// THE STAGE GATE
// ─────────────────────────────────────────────────────────────────────────────
/**
 * A STAGE GATE THAT PERFORMED NO VALIDATION AT ALL.
 *
 * advanceListingStageService read the listing and then wrote
 * `listings.lifecycle_stage = toStage`. No readiness check, no role check, no
 * stage-machine check — and it is the LIVE path: the stage pipeline
 * (app/components/dashboard/listings/lifecycle/stage-pipeline.tsx) and the AI
 * chat tool both reach it through app/actions/listing-lifecycle.ts. The only
 * gate on a normal advance was the client-side filter in the pipeline
 * component, which is not a gate: any caller can invoke the server action
 * directly with any target stage.
 *
 * Nothing downstream catches it either. lib/kernel/lifecycle.ts's
 * transitionLifecycle writes the state column UNCONDITIONALLY and records
 * `fromState` in metadata as a claim it never verifies — so a pre-gate is the
 * only enforcement of stage order that exists anywhere in the system.
 *
 * THE GATE IS DERIVED FROM THE STAGE TABLE, NEVER HAND-WRITTEN. It reads the
 * listing's OWN `listings.lifecycle_stage` and hands the target's declared
 * `allowedFrom` / `readinessChecks` / `requiredRoles` — straight out of
 * LISTING_LIFECYCLE_STAGES — to the canonical validator. There is no stage list
 * in this file to drift from the table; adding a stage updates both at once.
 * This follows the pattern already established by `requireListingStage` in
 * app/actions/seller-listing/execution-engine.ts.
 *
 * THE OWNER'S RULING IS ENFORCED BY CONSTRUCTION, not by a special case. A
 * listing opens as a DRAFT (lib/kernel/listings.ts::createListingRecord writes
 * status 'draft' at LISTING_AGREEMENT_INITIATED) and every route through the
 * allowedFrom graph to a publicly-live stage — COMING_SOON_ACTIVE or MLS_ACTIVE
 * — passes through LISTING_AGREEMENT_SIGNED, whose own readinessChecks are
 * ["dotloop_signatures", "documents_verified"]. Because every advance on this
 * path is now a single validated step, there is no way to arrive at a live
 * stage without having satisfied that one. NO OVERRIDE PARAMETER IS ADDED HERE:
 * the only override path in the product stays the role-gated, audited one at
 * the action layer (requireOverrideActor).
 *
 * TENANT SCOPE: the listing is read and written with an explicit
 * `brokerage_id` filter, so the gate is still correct if it is ever handed a
 * service-role client (which bypasses RLS entirely).
 */
interface ListingStageGateContext {
  listingId: string
  brokerageId: string
  fromStage: ListingStage | null
  /** The AUTHENTICATED actor — a users.id. Authority never comes from a parameter. */
  actorUserId: string
  actorRole: RequiredRole
  readinessPassed: string[]
  readinessFailed: string[]
  /** listings.agent_id — an AGENTS id (pg_constraint: listings_agent_id_fkey → agents.id). */
  listingAgentRecordId: string | null
  stageEnteredAt: string | null
}

type ListingStageGateResult =
  | ({ ok: true } & ListingStageGateContext)
  | { ok: false; error: string }

async function requireListingStageAdvance(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
  target: string,
): Promise<ListingStageGateResult> {
  // 1. The target must be a stage the TABLE declares. listings_lifecycle_stage_check
  //    admits exactly these values live, so an unknown one is a write the database
  //    would refuse — and an unrefused refusal is how a stage change becomes a no-op.
  const def = getStageDefinition(target as ListingStage)
  if (!def) return { ok: false, error: `Unknown listing stage "${target}"` }

  // 2. Identity from the SESSION. A caller-supplied id can name whoever it likes;
  //    role authority must not be derivable from a parameter.
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError) return { ok: false, error: `Not authenticated: ${authError.message}` }
  const actor = authData?.user
  if (!actor) return { ok: false, error: "Not authenticated" }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", actor.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: `Could not read your profile: ${profileError.message}` }
  if (!profile) return { ok: false, error: "User profile not found" }
  if (!profile.brokerage_id) return { ok: false, error: "No brokerage found for this user" }

  const rawUserType = (profile.user_type as string | null) || (profile.role as string | null) || ""
  const actorRole = normalizeLifecycleRole(rawUserType)
  if (!actorRole) {
    return {
      ok: false,
      error:
        `Role "${rawUserType || "unknown"}" is not authorized to change a listing's lifecycle stage. ` +
        `Stage authority is held by: agent, team_lead, broker, broker_owner, admin, superadmin.`,
    }
  }

  // 3. The listing's OWN stage — tenant-anchored.
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id, lifecycle_stage, stage_entered_at")
    .eq("id", listingId)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  // A GATE THAT COULD NOT READ IS NOT A GATE THAT PASSED. supabase-js resolves a
  // failed query, so without this a refusal would be indistinguishable from a
  // listing sitting in the wrong stage.
  if (listingError) return { ok: false, error: `Could not read the listing's stage: ${listingError.message}` }
  if (!listing) return { ok: false, error: "Listing not found in your brokerage" }

  const fromStage = ((listing.lifecycle_stage as string | null)?.trim() || null) as ListingStage | null
  if (!fromStage) {
    // listings.lifecycle_stage is NOT NULL with DEFAULT 'LEAD' live, so an empty
    // one is an anomaly. Defaulting it to LEAD here would invent a predecessor
    // and let the gate pass on a guess.
    return { ok: false, error: "This listing has no lifecycle stage recorded, so it cannot be advanced" }
  }

  // 4. Readiness — the checks the TARGET declares, evaluated against live data.
  const readiness = await evaluateReadinessChecks(supabase, listingId, def.readinessChecks)

  // 5. The canonical validator does role authority + predecessor + readiness, all
  //    read out of the stage definition. `entersFromAnyStage` is the table's own
  //    rule for the terminal exit stages that declare no allowedFrom (see
  //    LISTING_CANCELLED); expressing it as "no predecessor requirement" is
  //    exactly the branch the validator already has, and role + readiness still
  //    apply to those stages.
  const validation = validateStageTransition({
    currentStage: entersFromAnyStage(target as ListingStage) ? null : fromStage,
    targetStage: target as ListingStage,
    userRole: actorRole,
    userId: actor.id,
    listingId,
    completedReadinessChecks: readiness.passedChecks,
    // NO BYPASS ON THIS PATH. The audited override lives at the action layer.
    isAdminOverride: false,
  })
  if (!validation.allowed) {
    return { ok: false, error: validation.reason ?? `Cannot advance from "${fromStage}" to "${target}"` }
  }

  return {
    ok: true,
    listingId,
    brokerageId: profile.brokerage_id as string,
    fromStage,
    actorUserId: actor.id,
    actorRole,
    readinessPassed: readiness.passedChecks,
    readinessFailed: readiness.failedChecks,
    listingAgentRecordId: (listing.agent_id as string | null) ?? null,
    stageEnteredAt: (listing.stage_entered_at as string | null) ?? null,
  }
}

/**
 * IDENTITY CLASSES. `listing_stage_history.completed_by` FKs users(id)
 * (pg_constraint: listing_stage_history_completed_by_fkey), while
 * `listings.agent_id` FKs agents(id). Callers of advanceListingStage pass
 * whichever they have — the stage pipeline passes a users id, the AI-chat tool
 * passes `listing.agent_id`, an AGENTS id — so the supplied value is RESOLVED
 * through the canonical helper instead of being written straight into a users
 * FK, where it would be refused and (undestructured) leave no history at all.
 * `supplied ?? session.id` without the resolution step is the bug this avoids.
 */
/**
 * The signed-in caller's brokerage, or null.
 *
 * These services take only an entity id, and the request-scoped client means RLS
 * applies — but RLS is not a sufficient tenant boundary in this schema: several
 * policies read `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`,
 * so an untenanted row satisfies the predicate for EVERY brokerage. The explicit
 * filter is the boundary; the policy is the backstop, not the reverse.
 */
async function callerBrokerageId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return null
  const { data: profile, error } = await supabase
    .from("users").select("brokerage_id").eq("id", auth.user.id).maybeSingle()
  if (error || !profile?.brokerage_id) return null
  return profile.brokerage_id as string
}

async function resolveHistoryActorUserId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  suppliedId: string | null | undefined,
  sessionUserId: string,
  brokerageId: string,
): Promise<string> {
  if (!suppliedId || suppliedId === sessionUserId) return sessionUserId

  const { data: asUser, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("id", suppliedId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (!userError && asUser?.id) return asUser.id as string

  const resolved = await resolveAgentRecordToUserId(suppliedId)
  if (!resolved) return sessionUserId

  // The resolved user must be in the same tenant before it is written.
  const { data: sameTenant, error: tenantError } = await supabase
    .from("users")
    .select("id")
    .eq("id", resolved)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (tenantError || !sameTenant?.id) return sessionUserId
  return sameTenant.id as string
}

export async function scheduleListingAppointmentService(
  params: {
    listing_id: string
    contact_id: string
    appointment_date: string
    appointment_time: string
    notes?: string
    /** "zoom" → attempt a REAL Zoom meeting on the booking agent's connected
     *  scope (agent → team → brokerage). Honest in-person default otherwise. */
    meeting_mode?: "zoom" | "in_person"
  },
  agentId: string,
  brokerageId: string
) {
  const supabase = await createClient()

  // The seller listing-presentation appointment is a FIRST-CLASS calendar event
  // (flows to the agent's daily briefing, calendar view, and Google sync), with the
  // listing carrying the denormalized time + a FK to the event for the listing card.
  // (Previously written to phantom listings.appointment_date/_time/notes — silently failed.)
  const appointmentAt = new Date(`${params.appointment_date}T${params.appointment_time}`).toISOString()

  // ── Zoom branch (additive, round 39) — never blocks the booking ────────────
  let zoomLocation: string | null = null
  let zoomMetadata: Record<string, unknown> = {}
  if (params.meeting_mode === "zoom") {
    try {
      const { ensureZoomMeetingForAppointment } = await import("@/lib/connections/zoom")
      const { connectionScopeForUserType } = await import("@/lib/connections/field-spec")
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      // TENANT SCOPE: `svc` is a service-role client and bypasses RLS, so the
      // booker lookup carries the brokerage explicitly. A refused read used to
      // fall through to an empty user_type and silently pick the wrong Zoom
      // host scope.
      // platform_role rides along (§4): a platform-staff booker resolves to the
      // platform host scope only through BOTH identity columns.
      const { data: booker, error: bookerError } = await svc
        .from("users").select("user_type, platform_role, team_id, brokerage_id")
        .eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
      if (bookerError) throw new Error(`booker lookup failed: ${bookerError.message}`)
      const scope = connectionScopeForUserType(
        (booker?.user_type as string) ?? "",
        (booker?.platform_role as string | null) ?? null,
      ).scope
      const start = new Date(appointmentAt)
      const outcome = await ensureZoomMeetingForAppointment(svc, {
        host: {
          scope: scope as any,
          agentUserId: agentId,
          teamId: (booker?.team_id as string | null) ?? null,
          brokerageId: (booker?.brokerage_id as string | null) ?? brokerageId,
        },
        topic: "Listing Appointment",
        startAt: start,
        endAt: new Date(start.getTime() + 60 * 60_000),
      })
      if (outcome.created) {
        zoomLocation = outcome.joinUrl
        zoomMetadata = {
          zoom: {
            meeting_id: outcome.meetingId,
            join_url: outcome.joinUrl,
            start_url: outcome.startUrl,
            host_owner_type: outcome.hostOwnerType,
            host_owner_id: outcome.hostOwnerId,
          },
        }
      } else {
        zoomMetadata = { zoom_outcome: { created: false, reason: outcome.reason, detail: outcome.detail } }
      }
    } catch (e: any) {
      zoomMetadata = { zoom_outcome: { created: false, reason: "api_error", detail: e?.message ?? "Zoom lane error" } }
    }
  }

  const { data: calEvent, error: calErr } = await supabase
    .from("calendar_events")
    .insert({
      brokerage_id: brokerageId,
      entity_type: "listing",
      entity_id: params.listing_id,
      event_type: "listing_appointment",
      start_at: appointmentAt,
      is_system_generated: false,
      // agent_user_id lets the Zoom transcript lane resolve the agent later.
      agent_user_id: agentId,
      ...(zoomLocation ? { location: zoomLocation } : {}),
      metadata: { contact_id: params.contact_id, agent_id: agentId, notes: params.notes ?? null, ...zoomMetadata },
    })
    .select("id")
    .single()
  if (calErr) throw calErr

  const { data, error } = await supabase
    .from("listings")
    .update({
      appointment_at:       appointmentAt,
      appointment_notes:    params.notes ?? null,
      appointment_event_id: calEvent.id,
      lifecycle_stage:      "APPOINTMENT_SET",
      updated_at:           new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .select()
    .single()

  if (error) throw error

  // NOTE: orchestration (the listing-appt-prep chain: CMA → presentation → chapter videos → drip →
  // pre-listing postcard) is triggered explicitly by the scheduleListingAppointment server action via
  // triggerChainsForEvent("listing.appointment_set"), which carries the listing's property_data. This
  // service used to emit a separate logListingAppointmentSet('listing_appointment_scheduled') event
  // that matched NO chain/handler — removed (drift consolidated onto the single canonical trigger).
  return { success: true, listing: data, appointmentEventId: calEvent.id }
}

// markListingSignedService + markListingLiveService were RETIRED — they duplicated the stage spine but
// fired orphaned underscore events the dotted dispatcher never matched. The UI drives every stage
// change through advanceListingStage; canonical-stage automations run at the action layer
// (fireStageAutomations), and the MLS packet queues there on MLS_ACTIVE. No remaining caller.

/**
 * The SECOND ungated writer of listings.lifecycle_stage in this file. It is
 * reachable from the exported server action app/actions/listing-lifecycle.ts
 * ::updateListingStage, so gating only advanceListingStageService would have
 * left the front door locked and this one open. Same derived gate, same rules.
 * Kept (not folded into advance) because it is a distinct exported capability
 * with its own caller — this is a fix, not a consolidation.
 */
export async function updateListingStageService(params: {
  listing_id: string
  stage: string
  notes?: string
}) {
  const supabase = await createClient()

  const gate = await requireListingStageAdvance(supabase, params.listing_id, params.stage)
  if (!gate.ok) return { success: false as const, error: gate.error }

  // listings.status is kept in lockstep with the stage machine — the same rule
  // lib/kernel/lifecycle.ts applies on its path. Without it a listing advanced
  // through this writer reaches MLS_ACTIVE while status is still 'draft', and
  // buyer search / the public pages never see it. (There is no `notes` column on
  // listings.) This note sits above the statement, not inside the chain, so the
  // brokerage filter stays visibly attached to the write it scopes.
  // Same gate as the advance path below — only a gated target stage pays for a read.
  const statusGate = await resolveListingStatusGate(supabase, params.stage, params.listing_id, gate.brokerageId)

  const { data, error } = await supabase
    .from("listings")
    .update({
      lifecycle_stage: params.stage,
      ...(statusForStage(params.stage, statusGate) ? { status: statusForStage(params.stage, statusGate) } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .eq("brokerage_id", gate.brokerageId)
    .select()
    .single()

  if (error) throw error

  return { success: true as const, listing: data, fromStage: gate.fromStage, stage: params.stage }
}


/**
 * Resolve the gate verdict the status map needs — ONCE, for both writers in this file.
 *
 * WHY IT IS A FUNCTION AND NOT TWO INLINE BLOCKS: this file has two writers of
 * listings.lifecycle_stage, and a second copy of "did compliance pass?" is exactly the
 * two-spellings defect §6 forbids. The verdict itself is not computed here either — it comes
 * from lib/listings/listing-activation-gate.ts, which owns the question.
 *
 * COST: returns undefined immediately for an ungated stage, so the overwhelming majority of
 * transitions do no I/O at all. isGatedStage is derived from the map, never a hardcoded stage
 * name (§2 — a hardcoded name is a waypoint that stops paying attention the day the map grows).
 *
 * FAIL CLOSED (§4): a refused read yields `false`, which the pure map treats as NOT PROVEN and
 * answers with undefined — status untouched. The refusal is logged as UNKNOWN and explicitly not
 * as "compliance has not passed", because the two send a transaction coordinator to different
 * places and only one of them is a real errand.
 */
async function resolveListingStatusGate(
  supabase: Awaited<ReturnType<typeof createClient>>,
  toStage: string,
  listingId: string,
  brokerageId: string,
): Promise<ListingStatusGate | undefined> {
  if (!isGatedStage(toStage)) return undefined
  const { listingAgreementComplianceState } = await import("@/lib/listings/listing-activation-gate")
  const state = await listingAgreementComplianceState(supabase as any, { listingId, brokerageId })
  if (state === "unknown") {
    console.error(
      `[listing-lifecycle] listing ${listingId} → ${toStage}: the listing-agreement compliance read was REFUSED, so the gate could not run. listings.status is left untouched — this is NOT "compliance has not passed" and must not be chased as one`,
    )
  }
  return { listingAgreementCompliancePassed: state === "passed" }
}

export async function advanceListingStageService(
  listingId: string,
  toStage: string,
  agentId: string,
  notes?: string
) {
  const supabase = await createClient()

  // THE GATE. Derived from LISTING_LIFECYCLE_STAGES — see
  // requireListingStageAdvance above. Everything below this line runs only on a
  // transition the stage table, the readiness checks and the actor's role all
  // admit.
  const gate = await requireListingStageAdvance(supabase, listingId, toStage)
  if (!gate.ok) {
    return { success: false, error: gate.error }
  }

  const now = new Date().toISOString()
  const completedBy = await resolveHistoryActorUserId(supabase, agentId, gate.actorUserId, gate.brokerageId)

  // Close the currently-open history row. Every write below is error-checked:
  // an unchecked write is how a stage advance reports success while the audit
  // trail it claims to keep was refused. Live proof that this mattered:
  // listing_stage_history holds 0 rows.
  const { error: closeError } = await supabase
    .from("listing_stage_history")
    .update({
      exited_at: now,
      duration_days: Math.floor(
        (new Date().getTime() - new Date(gate.stageEnteredAt || now).getTime()) / (1000 * 60 * 60 * 24),
      ),
    })
    .eq("listing_id", listingId)
    .eq("brokerage_id", gate.brokerageId)
    .is("exited_at", null)
  if (closeError) {
    return { success: false, error: `Could not close the previous stage record: ${closeError.message}` }
  }

  // listing_stage_history is a separate table — its own entered_at/exited_at
  // columns are NOT the listings.* columns being deprecated; keep these.
  // brokerage_id was omitted, so every row this path wrote was tenant-unscoped
  // (its RLS insert policy permits a NULL brokerage_id, which is why nobody
  // noticed). from_stage / readiness_passed / readiness_failed are real columns
  // that nothing was filling; the gate now has honest values for all three.
  const { error: historyError } = await supabase.from("listing_stage_history").insert({
    brokerage_id: gate.brokerageId,
    listing_id: listingId,
    stage_name: toStage,
    from_stage: gate.fromStage,
    entered_at: now,
    completed_by: completedBy, // FK → users(id); resolved, never the raw agents id
    is_override: false,
    readiness_passed: gate.readinessPassed,
    readiness_failed: gate.readinessFailed,
    notes,
  })
  if (historyError) {
    return { success: false, error: `Could not record the stage change: ${historyError.message}` }
  }

  // ── THE RULING'S GATE (owner 2026-09-05) ────────────────────────────────────
  // Only a GATED target stage pays for a read; isGatedStage is derived from the map
  // itself, so an ungated advance costs exactly what it did before. `gate.brokerageId`
  // here is the one this service already authorized against — the tenant is not
  // re-derived from anything a caller supplied (§4).
  const statusGate = await resolveListingStatusGate(supabase, toStage, listingId, gate.brokerageId)

  const { error: stageError } = await supabase
    .from("listings")
    .update({
      lifecycle_stage:   toStage,
      stage_entered_at:  now,
      // Keep the coarse listings.status in lockstep with the stage machine —
      // the same rule lib/kernel/lifecycle.ts applies on its path, from the
      // same shared map, so the two writers cannot disagree about whether a
      // listing is publicly live. `statusGate` is resolved above, and only when
      // the target stage is gated.
      ...(statusForStage(toStage, statusGate) ? { status: statusForStage(toStage, statusGate) } : {}),
      updated_at:        now,
    })
    .eq("id", listingId)
    .eq("brokerage_id", gate.brokerageId)
  if (stageError) {
    return { success: false, error: `Could not advance the listing's stage: ${stageError.message}` }
  }

  // Stage automations run at the ACTION layer keyed on the CANONICAL stages
  // (app/actions/listing-lifecycle.ts::fireStageAutomations). The old triggerStageActions switch +
  // its exclusively-used helpers (generateSellerVideo / postListingToSocial / enrollLifetimeCustomer /
  // scheduleReviewRequests / trackClosingGift / notifySeller) were RETIRED: they never fired (legacy
  // lowercase stage vocabulary vs the canonical UPPERCASE stages) and were redundant with the canonical
  // flows (kernel transaction-close owns lifetime/reviews; marketing agents + crons own social/video).

  revalidatePath(`/listings/${listingId}`)

  return { success: true, stage: toStage, fromStage: gate.fromStage }
}

export async function scheduleClosingGift(listingId: string) {
  const supabase = await createClient()
  const brokerageId = await callerBrokerageId(supabase)
  if (!brokerageId) {
    return { success: false, error: "Not authenticated, or no brokerage on this account" }
  }
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("estimated_close_date, seller_contact_id, agent_id")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // A refused read used to leave `listing` undefined and this function would
  // return having quietly scheduled nothing — indistinguishable from a listing
  // with no close date.
  if (listingError) {
    console.error("[scheduleClosingGift] could not read the listing:", listingError.message)
    return { success: false, error: listingError.message }
  }
  if (!listing?.estimated_close_date) {
    return { success: false, error: "Listing has no estimated close date — no gift scheduled" }
  }

  const closeDate = new Date(listing.estimated_close_date)
  const orderDate = new Date(closeDate.getTime() - 7 * 24 * 60 * 60 * 1000)
  // closing_gifts.agent_id — listings.agent_id is an AGENTS id and is carried
  // through as one; it is not re-labelled as a user.
  const { error: giftError } = await supabase.from("closing_gifts").insert({
    listing_id: listingId,
    contact_id: listing.seller_contact_id,
    agent_id: listing.agent_id,
    gift_description: "Closing gift basket",
    price_cents: 7500,
    order_date: orderDate.toISOString(),
    delivery_date: closeDate.toISOString(),
    status: "scheduled",
  })
  if (giftError) {
    console.error("[scheduleClosingGift] closing_gifts insert failed:", giftError.message)
    return { success: false, error: giftError.message }
  }
  return { success: true }
}

/**
 * THE ONE LISTING-TIMELINE READ.
 *
 * There were TWO. app/actions/listings.ts carried a byte-for-byte copy of this
 * query against a service-role client, and because they were two the fix landed
 * on one of them: this twin had already been repointed off `profiles`, while the
 * action twin still embedded it and therefore still failed on every call. The
 * action is now a thin wrapper over this function, so there is one query to fix
 * and one place a phantom relation can hide.
 *
 * ABSORBED FROM THE ACTION TWIN — its tenant ownership check. That twin read
 * with a SERVICE-ROLE client (RLS bypassed), so its `listings.brokerage_id !==
 * caller's brokerage -> Forbidden` gate was the only thing standing between a
 * caller and any brokerage's stage history. Delegating without carrying that
 * gate here would have deleted a real access control. It is kept — and made
 * stronger, because listing_stage_history's RLS SELECT policy is
 * `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`: a row
 * written without the tenant stamp is readable by EVERY tenant, so the explicit
 * `.eq("brokerage_id", …)` below is what actually scopes this read.
 *
 * `completed_by:profiles(...)` embedded a table that DOES NOT EXIST in the live
 * database (information_schema has no public.profiles) — so this query failed on
 * every call, and with the error undestructured the caller received
 * `{ timeline: undefined }`, which every consumer renders as "no history".
 * listing_stage_history.completed_by FKs users(id), so users is the embed.
 */
export async function getListingTimelineService(
  listingId: string,
): Promise<{ timeline: any[]; error?: string }> {
  const supabase = await createClient()
  const brokerageId = await callerBrokerageId(supabase)
  if (!brokerageId) {
    return { timeline: [], error: "Not authenticated, or no brokerage on this account" }
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", listingId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  // A refused read is not "no such listing" — reporting it as Forbidden would
  // tell the caller their own listing is somebody else's.
  if (listingError) {
    console.error("[getListingTimelineService] listing lookup failed:", listingError.message)
    return { timeline: [], error: listingError.message }
  }
  if (!listing) return { timeline: [], error: "Forbidden" }

  const { data: history, error } = await supabase
    .from("listing_stage_history")
    .select("*, completed_by:users(first_name, last_name)")
    .eq("listing_id", listingId)
    .eq("brokerage_id", brokerageId)
    .order("entered_at", { ascending: true })

  if (error) {
    console.error("[getListingTimelineService] timeline read failed:", error.message)
    return { timeline: [], error: error.message }
  }

  return { timeline: history ?? [] }
}

export async function getListingTasksService(listingId: string) {
  const supabase = await createClient()
  const brokerageId = await callerBrokerageId(supabase)
  if (!brokerageId) return { tasks: [], error: "Not authenticated, or no brokerage on this account" }
  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("listing_id", listingId)
    .eq("brokerage_id", brokerageId)
    .order("due_date", { ascending: true })

  // A refused read is not an empty task list.
  if (error) {
    console.error("[getListingTasksService] task read failed:", error.message)
    return { tasks: [], error: error.message }
  }

  return { tasks: tasks ?? [] }
}

export async function completeListingTaskService(taskId: string) {
  const supabase = await createClient()
  const brokerageId = await callerBrokerageId(supabase)
  if (!brokerageId) return { success: false, error: "Not authenticated, or no brokerage on this account" }
  const { error } = await supabase
    .from("tasks")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("brokerage_id", brokerageId)

  // The UI ticked the task off on an unchecked write; a refused update looked
  // exactly like a completed one until the page reloaded.
  if (error) {
    console.error("[completeListingTaskService] task update failed:", error.message)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard")
  return { success: true }
}


// ── PASS 5 (NOT NULL contract): tasks requires brokerage_id +
// assigned_to_agent_id. Every handler below used to insert with only
// listing_id — ALWAYS rejected, so no listing-lifecycle task ever landed.
// The listing's own agent is the honest assignee; no agent → honest skip.
async function listingTaskContext(
  supabase: any,
  listingId: string,
): Promise<{ brokerageId: string; agentId: string } | null> {
  const { data, error } = await supabase
    .from("listings")
    .select("brokerage_id, agent_id") // listings.agent_id FKs agents(id)
    .eq("id", listingId)
    .maybeSingle()
  // A refused read reported itself as "this listing has no agent/brokerage",
  // sending whoever read the message to fix an assignment that was never wrong.
  if (error) {
    console.error(`[listing-lifecycle] listingTaskContext read failed for ${listingId}:`, error.message)
    return null
  }
  if (!data?.brokerage_id || !data?.agent_id) return null
  return { brokerageId: data.brokerage_id, agentId: data.agent_id }
}

/**
 * Insert a batch of auto-generated listing tasks, REPORTING what was refused.
 * Every one of these handlers used to loop over `await supabase.insert(...)`
 * with the outcome discarded — the tasks CHECK constraints and the NOT NULL
 * contract could reject every row and the handler still returned
 * `{ success: true }`.
 */
/**
 * THE WRITER OWNS THE TENANT STAMP.
 *
 * This used to trust each caller to have put brokerage_id on every row. `tasks`
 * RLS permits a NULL brokerage_id, so one unstamped row inserts successfully and
 * is then invisible to every scoped reader — the same silent shape that left
 * listing_stage_history tenant-unscoped for its whole life. Taking the brokerage
 * as a parameter and stamping it here means a caller CANNOT forget, and the
 * anchor is visible at the write rather than several functions away.
 */
async function insertListingTasks(
  supabase: any,
  brokerageId: string,
  rows: Record<string, unknown>[],
): Promise<{ success: boolean; inserted: number; error?: string }> {
  let inserted = 0
  const failures: string[] = []
  if (!brokerageId) {
    return { success: false, inserted: 0, error: "No brokerage on the caller — refusing to write untenanted tasks" }
  }
  for (const row of rows) {
    const { error } = await supabase.from("tasks").insert({ ...row, brokerage_id: brokerageId })
    if (error) {
      console.error("[listing-lifecycle] task insert failed:", error.message, row.title)
      failures.push(`${String(row.title ?? "task")}: ${error.message}`)
    } else {
      inserted += 1
    }
  }
  if (failures.length > 0) {
    return { success: false, inserted, error: `${failures.length} of ${rows.length} tasks were refused — ${failures.join("; ")}` }
  }
  return { success: true, inserted }
}

export async function handleListingAppointmentBookedService(payload: any) {
  const supabase = await createClient()
  const { listing_id, contact_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Prepare CMA for consultation", dueDays: 1 },
    { title: "Research comparable sales", dueDays: 1 },
    { title: "Review property info", dueDays: 0 },
  ]
  return insertListingTasks(supabase, taskCtx.brokerageId, tasks.map((task) => ({
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    contact_id,
    title: task.title,
    due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
    priority: task.dueDays === 0 ? "urgent" : "high",
    auto_generated: true,
  })))
}

export async function handleListingAgreementSignedService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Order professional photography", dueDays: 1 },
    { title: "Write compelling listing description", dueDays: 2 },
    { title: "Set up lockbox", dueDays: 3 },
    { title: "Input listing into MLS", dueDays: 3 },
    { title: "Create marketing materials", dueDays: 2 },
  ]
  return insertListingTasks(supabase, taskCtx.brokerageId, tasks.map((task) => ({
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: task.title,
    due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
    priority: "high",
    auto_generated: true,
  })))
}

export async function handleListingLiveService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Share on social media", dueDays: 0 },
    { title: "Send to sphere of influence", dueDays: 1 },
    { title: "Schedule first open house", dueDays: 3 },
    { title: "Create video tour", dueDays: 2 },
  ]
  return insertListingTasks(supabase, taskCtx.brokerageId, tasks.map((task) => ({
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: task.title,
    due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
    priority: task.dueDays === 0 ? "urgent" : "high",
    auto_generated: true,
  })))
}

export async function handlePriceReductionService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  return insertListingTasks(supabase, taskCtx.brokerageId, [{
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: "Update all marketing with new price",
    due_date: new Date().toISOString(),
    priority: "urgent",
    auto_generated: true,
  }])
}

export async function handleOfferReceivedService(payload: any) {
  const supabase = await createClient()
  const { listing_id, offer_amount, buyer_name } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  return insertListingTasks(supabase, taskCtx.brokerageId, [{
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: `Review offer from ${buyer_name || "buyer"} - $${(offer_amount || 0).toLocaleString()}`,
    due_date: new Date().toISOString(),
    priority: "urgent",
    auto_generated: true,
  }])
}

export async function handleContingencyClearedService(payload: any) {
  const supabase = await createClient()
  const { listing_id, contingency_type } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  return insertListingTasks(supabase, taskCtx.brokerageId, [{
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: `${contingency_type} contingency cleared - update transaction status`,
    due_date: new Date().toISOString(),
    priority: "high",
    auto_generated: true,
  }])
}

export async function handleClosingApproachingService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Confirm final walkthrough scheduled", dueDays: 0 },
    { title: "Verify closing disclosure sent", dueDays: 0 },
    { title: "Confirm wire instructions with title", dueDays: 1 },
  ]
  return insertListingTasks(supabase, taskCtx.brokerageId, tasks.map((task) => ({
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: task.title,
    due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
    priority: "urgent",
    auto_generated: true,
  })))
}

export async function triggerReviewSequenceService(payload: any) {
  const supabase = await createClient()
  const { contact_id } = payload
  // review_requests is contact-keyed, one row per platform. listing_id /
  // scheduled_send_date / platforms were phantom columns.
  const platforms = ["google", "zillow", "facebook"]
  const failures: string[] = []
  for (const platform of platforms) {
    const { error } = await supabase.from("review_requests").insert({
      contact_id,
      platform,
      status: "scheduled",
    })
    // review_requests.status is CHECK-constrained; an unchecked insert here
    // returned success over three refused rows.
    if (error) {
      console.error(`[triggerReviewSequenceService] ${platform} review request refused:`, error.message)
      failures.push(`${platform}: ${error.message}`)
    }
  }
  if (failures.length > 0) {
    return { success: false, error: `${failures.length} of ${platforms.length} review requests were refused — ${failures.join("; ")}` }
  }
  return { success: true }
}

export async function sendReviewRequestService(requestId: string, platform: string) {
  const supabase = await createClient()

  const { data: request, error: requestError } = await supabase
    .from("review_requests")
    .select("*, contact:contacts(*), transaction:listings(*)")
    .eq("id", requestId)
    .maybeSingle()

  if (requestError) {
    console.error("[sendReviewRequestService] review_requests read failed:", requestError.message)
    return { success: false, error: requestError.message }
  }
  if (!request) return { success: false, error: "Review request not found" }

  const reviewLinks: Record<string, string> = {
    google: `https://g.page/r/YOUR_GOOGLE_PLACE_ID/review`,
    zillow: `https://zillow.com/profile/YOUR_AGENT_ID/reviews`,
    facebook: `https://facebook.com/YOUR_PAGE/reviews`,
  }

  const message = `Hi ${request.contact?.first_name}! Hope you're loving your new home at ${request.transaction?.address}! Your feedback means everything. Would you mind sharing your experience? Takes 60 seconds: ${reviewLinks[platform]}`

  if (request.contact?.phone) {
    // Route through the gate (consent/opt-out/DNC/quiet-hours/de-confliction) — no raw send.
    const { dispatchSms } = await import("@/lib/providers/dispatch")
    const smsResult = await dispatchSms({
      brokerageId: (request.contact as any).brokerage_id ?? "",
      to: request.contact.phone,
      message,
      contactId: request.contact_id,
      systemSource: "review_request",
    })
    if (!smsResult.success) {
      console.error("[listing-lifecycle] SMS send failed:", smsResult.error)
    }
  }

  const { error: markSentError } = await supabase
    .from("review_requests")
    .update({ sent_at: new Date().toISOString(), status: "sent" })
    .eq("id", requestId)

  // If this write is refused the request stays 'scheduled' and the next sweep
  // sends the same review request again. Silence here is a duplicate-send bug.
  if (markSentError) {
    console.error("[sendReviewRequestService] could not mark the request sent:", markSentError.message)
    return { success: false, error: markSentError.message }
  }

  return { success: true }
}
