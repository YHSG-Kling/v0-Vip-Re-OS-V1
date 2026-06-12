/**
 * lib/ai-isa/book-seller-appointment.ts
 *
 * THE listing-APPOINTMENT milestone — a SEPARATE, LATER step from conversion.
 *
 * CORRECTED business process: a seller LEAD converts to a CONTACT on POSITIVE
 * INTENT (a positive ISA conversation, or a CMA / info request) via the canonical
 * handoff — see convert-seller-lead-on-intent.ts. By the time a listing
 * appointment is booked, conversion has USUALLY ALREADY HAPPENED. This module is
 * therefore the APPOINTMENT milestone, NOT the conversion gate:
 *
 *   1. CONVERT (safety only) the lead → contact IF it isn't a contact yet.
 *      Most of the time the contact already exists (converted on intent), so this
 *      is a no-op idempotent safety net — never a double-convert, never a second
 *      welcome. We only fire the welcome (CONTACT_AGENT_ASSIGNED) when THIS call
 *      is the one that actually performs a fresh conversion.
 *   2. SCHEDULE the listing appointment (reuse scheduleISAAppointment — it
 *      honestly REFUSES a lead under representation, logs the ISA activity, and
 *      emits ISA_APPOINTMENT_SCHEDULED).
 *   3. CHAIN — fire listing.appointment_set → the flagship listing-appt-prep
 *      chain (CMA → presentation → D-ID chapters → drip) against the contact.
 *      Idempotent via the engine's run-dedupe keyed on (chain, entity, trigger).
 *
 * Reuse, don't rebuild: every converter/event/chain here already existed — this
 * module only CONNECTS them in the right order for the appointment milestone with
 * honest guards and idempotency. No new tables.
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
  /** The seller LEAD being booked. Usually ALREADY converted to a contact. */
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
  /** contacts.id the appointment belongs to. */
  contactId?: string
  /** workflow_runs.id of the listing-appt-prep chain run (or the reused run). */
  chainRunId?: string
  /** True when the chain run was reused (idempotent rerun) rather than freshly started. */
  chainDeduped?: boolean
  /** True when the contact already existed (converted on intent earlier) — no second
   *  conversion / welcome happened here. */
  alreadyConverted?: boolean
  error?: string
}

export async function bookSellerListingAppointment(
  params: BookSellerListingAppointmentParams,
): Promise<BookSellerListingAppointmentResult> {
  const svc = createServiceClient()

  // ── Step 0: REFUSE a lead under representation (honest guard) ────────────────
  // scheduleISAAppointment owns this guard for leads, but once converted we book on
  // the contact (the lead may already be inactive). Check the lead's representation
  // state up front so a lead under representation is refused either way.
  const { data: preLead } = await svc
    .from("leads")
    .select("contact_id, is_active, lifecycle_state")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (preLead?.lifecycle_state === "representation") {
    return { success: false, error: "Cannot book listing appointment: lead is under representation" }
  }

  // ── Step 1: CONVERT (idempotent safety only) ────────────────────────────────
  // Most of the time the contact ALREADY exists (converted on positive intent via
  // convertSellerLeadOnIntent). promoteLeadToContactService is idempotent: a
  // re-run on an already-inactive lead returns the existing contact, never a second.
  // We detect a FRESH conversion (to gate the one-time welcome) by reading whether
  // the lead was already linked to a contact BEFORE this call.
  const wasAlreadyConverted = !!preLead?.contact_id

  const promotion = await promoteLeadToContactService(params.leadId)
  if (!promotion.success || !promotion.contactId) {
    return {
      success: false,
      error: `Lead conversion failed: ${promotion.message}`,
    }
  }
  const contactId = promotion.contactId
  const alreadyConverted = wasAlreadyConverted

  // Link the lead → its contact on the canonical leads.contact_id column (best-effort).
  if (!alreadyConverted) {
    await svc
      .from("leads")
      .update({ contact_id: contactId })
      .eq("id", params.leadId)
      .then(() => null, () => null)
  }

  // ── Step 2: WELCOME — fire CONTACT_AGENT_ASSIGNED ONLY on a fresh safety-convert ─
  // When the contact already existed (the common path — converted on intent), the
  // welcome / meet-your-agent intro already fired at conversion time; we MUST NOT
  // fire it again here (no double-welcome). Only a fresh safety-convert needs it.
  if (!alreadyConverted) {
    try {
      await processKernelEvent({
        event: KernelEvent.CONTACT_AGENT_ASSIGNED,
        brokerageId: params.brokerageId,
        entityType: "contact",
        entityId: contactId,
        metadata: { agent_id: params.agentId, source: "seller_appt_safety_convert" },
      })
    } catch (err) {
      console.error("[book-seller-appointment] CONTACT_AGENT_ASSIGNED dispatch failed:", err)
    }
  }

  // ── Step 3: SCHEDULE the listing appointment ────────────────────────────────
  // Book on the CONTACT once it exists (post-conversion the lead is inactive and the
  // appointment belongs to the relationship). scheduleISAAppointment emits
  // ISA_APPOINTMENT_SCHEDULED and logs the ISA activity.
  let calendarEventId: string
  try {
    calendarEventId = await scheduleISAAppointment({
      brokerageId: params.brokerageId,
      contactId,
      agentId: params.agentId,
      startAt: params.startAt,
      endAt: params.endAt,
      timezoneName: params.timezoneName,
      location: params.location,
      notes: params.notes,
    })
  } catch (err) {
    return {
      success: false,
      contactId,
      alreadyConverted,
      error: err instanceof Error ? err.message : "Failed to schedule appointment",
    }
  }

  // ── Step 4: CHAIN — fire listing.appointment_set → listing-appt-prep ─────────
  // The contact exists, so the chain's prep_seller_portal + CMA steps have a target.
  // The engine's run-dedupe keyed on (chain, entity, trigger) makes a rerun reuse the
  // same run instead of double-rendering the (expensive) D-ID chapter videos.
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
