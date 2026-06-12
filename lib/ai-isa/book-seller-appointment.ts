/**
 * lib/ai-isa/book-seller-appointment.ts
 *
 * THE seller-lead-journey orchestration — wires the previously-disconnected links
 * so a qualified SELLER LEAD flows end to end the moment the AI ISA books a
 * listing appointment:
 *
 *   1. SCHEDULE   the listing appointment (reuse scheduleISAAppointment — it
 *                 honestly REFUSES a lead under representation, advances
 *                 lead.lifecycle_state → 'appointment', logs the ISA activity,
 *                 and emits ISA_APPOINTMENT_SCHEDULED).
 *   2. CONVERT    the lead → contact via the canonical promoteLeadToContactService
 *                 (lossless; assigns the agent → the contacts.agent_id write fires
 *                 the m122 DB trigger → CONTACT_AGENT_ASSIGNED lifecycle row; the
 *                 contact now HAS a portal). Idempotent — re-runs return the
 *                 existing contact, never double-convert.
 *   3. WELCOME    fire CONTACT_AGENT_ASSIGNED through the kernel reactor so the
 *                 welcome / meet-your-agent intro video actually dispatches NOW.
 *                 (The m122 trigger only writes the audit row; nothing sweeps
 *                 unprocessed lifecycle_events into the reactor synchronously, so
 *                 without this the intro never fired on conversion. Idempotent via
 *                 the agent_intro_videos unique index — safe even though the trigger
 *                 also logged the same event.)
 *   4. CHAIN      ensure listing.appointment_set runs the flagship listing-appt-prep
 *                 chain (CMA → presentation → D-ID chapters → drip) against the
 *                 freshly-converted contact. Ordered AFTER conversion so the contact
 *                 (and its portal) exists before the chain's first step needs it.
 *                 Idempotent via the engine's run-dedupe keyed on
 *                 (chain, entity, trigger).
 *
 * Reuse, don't rebuild: every converter/event/chain here already existed and is
 * battle-tested — this module only CONNECTS them in the right order with honest
 * guards and idempotency. No new tables.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { scheduleISAAppointment } from "./appointment-scheduler"
import { promoteLeadToContactService } from "@/lib/contact-promotion"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { resolveAgentRecordToUserId } from "@/lib/kernel/agent-identity-resolver"
import { startRun } from "@/lib/workflow-orchestrator/engine"

export interface BookSellerListingAppointmentParams {
  brokerageId: string
  /** The qualified seller LEAD being booked + converted. */
  leadId: string
  /** agents.id of the agent the relationship begins with (contacts.agent_id space). */
  agentId: string
  startAt: Date
  endAt: Date
  timezoneName: string
  location?: string
  notes?: string
  /** Property data the listing-appt-prep chain runs its CMA / presentation against.
   *  When absent we derive a minimal {address} from `location` so the chain still
   *  runs (its CMA step surfaces missing data to the agent rather than silently
   *  skipping). */
  propertyData?: Record<string, any>
}

export interface BookSellerListingAppointmentResult {
  success: boolean
  /** calendar_events.id of the booked appointment. */
  calendarEventId?: string
  /** contacts.id the lead converted into. */
  contactId?: string
  /** workflow_runs.id of the listing-appt-prep chain run (or the reused run). */
  chainRunId?: string
  /** True when the chain run was reused (idempotent rerun) rather than freshly started. */
  chainDeduped?: boolean
  /** True when the lead was already converted (idempotent rerun) — no second contact created. */
  alreadyConverted?: boolean
  error?: string
}

export async function bookSellerListingAppointment(
  params: BookSellerListingAppointmentParams,
): Promise<BookSellerListingAppointmentResult> {
  const svc = createServiceClient()

  // ── Step 1: SCHEDULE ────────────────────────────────────────────────────────
  // scheduleISAAppointment owns the honest guards: it throws when the lead is under
  // representation (refuse) or missing, advances lifecycle_state → 'appointment',
  // logs the ISA activity, and emits ISA_APPOINTMENT_SCHEDULED. Let its throw
  // propagate as a clean failure result — we do NOT convert a lead we couldn't book.
  let calendarEventId: string
  try {
    calendarEventId = await scheduleISAAppointment({
      brokerageId: params.brokerageId,
      leadId: params.leadId,
      agentId: params.agentId,
      startAt: params.startAt,
      endAt: params.endAt,
      timezoneName: params.timezoneName,
      location: params.location,
      notes: params.notes,
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to schedule appointment" }
  }

  // ── Step 2: CONVERT lead → contact (canonical, lossless, idempotent) ─────────
  // promoteLeadToContactService assigns the agent (contacts.agent_id) → the m122
  // DB trigger emits CONTACT_AGENT_ASSIGNED; the contact now has a portal. A re-run
  // (lead already inactive) returns the existing contact instead of creating a second.
  // Detect the idempotent path by reading is_active BEFORE promoting.
  const { data: preLead } = await svc
    .from("leads")
    .select("is_active")
    .eq("id", params.leadId)
    .maybeSingle()
  const wasAlreadyInactive = preLead?.is_active === false

  const promotion = await promoteLeadToContactService(params.leadId)
  if (!promotion.success || !promotion.contactId) {
    return {
      success: false,
      calendarEventId,
      error: `Lead conversion failed: ${promotion.message}`,
    }
  }
  const contactId = promotion.contactId
  const alreadyConverted = wasAlreadyInactive

  // Link the lead → its contact on the canonical leads.contact_id column. The
  // converter records provenance only in contacts.notes ("Promoted from lead {id}");
  // stamping leads.contact_id makes the hop queryable both directions (minimal
  // missing link). Best-effort — never undo a successful conversion over this.
  if (!alreadyConverted) {
    await svc
      .from("leads")
      .update({ contact_id: contactId })
      .eq("id", params.leadId)
      .then(() => null, () => null)
  }

  // ── Step 3: WELCOME — fire CONTACT_AGENT_ASSIGNED through the reactor NOW ─────
  // The m122 trigger wrote a contact_agent_assigned lifecycle_events row, but nothing
  // sweeps unprocessed lifecycle rows into the reactor synchronously — so without this
  // the welcome / meet-your-agent intro video never dispatched on conversion. Firing
  // processKernelEvent (which fans into dispatchKernelEvent branch (E) →
  // dispatchAssignmentIntroVideo) makes the intro fire immediately. We do NOT insert a
  // second lifecycle_events row (processKernelEvent only notifies + fans out, the
  // trigger already logged the audit row); the intro is idempotent via the
  // agent_intro_videos unique index, so even a double-fire produces one intro.
  // Only fire on a FRESH conversion — a re-run's contact already had its intro queued.
  if (!alreadyConverted) {
    try {
      await processKernelEvent({
        event: KernelEvent.CONTACT_AGENT_ASSIGNED,
        brokerageId: params.brokerageId,
        entityType: "contact",
        entityId: contactId,
        metadata: { agent_id: params.agentId, source: "seller_appt_conversion" },
      })
    } catch (err) {
      // The welcome path is best-effort — a reactor failure must never strand a booked,
      // converted seller. The safety-net cron + the m122 audit row remain.
      console.error("[book-seller-appointment] CONTACT_AGENT_ASSIGNED dispatch failed:", err)
    }
  }

  // ── Step 4: CHAIN — run listing-appt-prep against the converted contact ──────
  // The contact (and its portal) now exists, so the chain's prep_seller_portal +
  // CMA steps have a target. We call the engine's startRun directly (the session-gated
  // app-action triggerChainsForEvent can't run in this server-side ISA context); the
  // engine's run-dedupe keyed on (chain, entity, trigger) makes a rerun reuse the same
  // run instead of double-rendering the (expensive) D-ID chapter videos.
  const agentUserId = await resolveAgentRecordToUserId(params.agentId)
  const propertyData =
    params.propertyData ??
    (params.location ? { address: params.location } : {})

  let chainRunId: string | undefined
  let chainDeduped: boolean | undefined
  try {
    const run = await startRun({
      chainKey: "listing-appt-prep",
      brokerageId: params.brokerageId,
      contactId,
      agentUserId: agentUserId ?? undefined,
      triggerEvent: "listing.appointment_set",
      triggerEventId: calendarEventId, // stable per-appointment key → idempotent rerun
      metadata: {
        appointment_id: calendarEventId,
        appointment_date: params.startAt.toISOString(),
        property_data: propertyData,
      },
    })
    chainRunId = run.runId
    chainDeduped = run.deduped
  } catch (err) {
    // The chain is best-effort relative to the booking+conversion — a chain failure must
    // not undo a real appointment + a real contact. Surface it but keep success=true.
    console.error("[book-seller-appointment] listing-appt-prep chain start failed:", err)
  }

  return {
    success: true,
    calendarEventId,
    contactId,
    chainRunId,
    chainDeduped,
    alreadyConverted,
  }
}
