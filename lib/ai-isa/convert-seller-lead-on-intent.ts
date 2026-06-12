/**
 * lib/ai-isa/convert-seller-lead-on-intent.ts
 *
 * CONVERSION ON POSITIVE INTENT — the CORRECT seller-lead conversion gate.
 *
 * Business process (corrected): a seller LEAD converts to a CONTACT the moment
 * it shows POSITIVE ENGAGEMENT / INTENT — a positive ISA conversation, or an
 * explicit request for info like a CMA. The listing APPOINTMENT is a SEPARATE,
 * LATER milestone (see book-seller-appointment.ts); conversion has usually
 * already happened by the time an appointment is booked. Many positive leads
 * want a CMA / more info but are NOT ready for a listing appointment yet — they
 * STILL convert.
 *
 * On conversion:
 *   1. CONVERT   the lead → contact via the CANONICAL handoff
 *                (acceptAIISAHandoff → consented → assigned → createContactFromLead).
 *                This is the SAME path positive ISA conversations / qualification
 *                readiness already use — NOT a new converter. It sets
 *                ai_isa_owner=false (ISA goes DORMANT) and fires
 *                CONTACT_AGENT_ASSIGNED (portal + meet-your-agent intro).
 *   2. NOTIFY    the AGENT of a new contact to reach out to.
 *   3. CMA       when the intent was a CMA request, PROPOSE the CMA the lead asked
 *                for (a draft cma_reports row on the converted contact) so the
 *                agent has the info value teed up — WITHOUT scheduling a listing
 *                appointment or firing the listing-appt-prep chain.
 *
 * What this module does NOT do (decoupled from the appointment milestone):
 *   - it does NOT schedule a listing appointment
 *   - it does NOT emit listing.appointment_set
 *   - it does NOT run the listing-appt-prep flagship chain
 *
 * A converted-but-no-appointment seller contact is then kept alive by the
 * existing dormant→re-engage loop (stale-contact-detector + ghost-reengagement),
 * because createContactFromLead lands it with isa_reengage_allowed=true and a
 * null last_contacted_at (immediately stale-eligible).
 *
 * Reuse, don't rebuild: the converter, the handoff, the agent notification and
 * the CMA pipeline all already exist — this only orchestrates intent → the
 * canonical conversion. No new tables.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { acceptAIISAHandoff } from "@/app/actions/ai-isa/accept-handoff"

export type SellerIntentReason = "cma_request" | "positive_reply" | "appointment_request"

export interface ConvertSellerLeadOnIntentParams {
  brokerageId: string
  /** The seller LEAD that showed positive intent. */
  leadId: string
  /** Why we're converting — drives whether a CMA is proposed / an appt is booked. */
  reason: SellerIntentReason
  /** Property data the requested CMA / appointment chain runs against (when
   *  reason === 'cma_request' or 'appointment_request'). When absent we derive a
   *  minimal {address} from the lead's address. */
  propertyData?: Record<string, any>
  /** Appointment slot — REQUIRED when reason === 'appointment_request'. Some leads
   *  ask for a listing appointment right away (an intent case): convert (canonical)
   *  THEN immediately book the listing appointment via bookSellerListingAppointment,
   *  which fires listing.appointment_set → the listing-appt-prep chain. */
  appointment?: {
    startAt: Date
    endAt: Date
    timezoneName: string
    location?: string
    notes?: string
  }
}

export interface ConvertSellerLeadOnIntentResult {
  success: boolean
  /** contacts.id the lead converted into. */
  contactId?: string
  /** True when the lead was already a contact before this call (idempotent rerun). */
  alreadyConverted?: boolean
  /** True when the agent was freshly notified of the new contact. */
  agentNotified?: boolean
  /** cma_reports.id of the proposed CMA (only when reason === 'cma_request'). */
  cmaReportId?: string
  /** calendar_events.id of the booked listing appointment (appointment_request only). */
  calendarEventId?: string
  /** workflow_runs.id of the listing-appt-prep chain (appointment_request only). */
  chainRunId?: string
  error?: string
}

export async function convertSellerLeadOnIntent(
  params: ConvertSellerLeadOnIntentParams,
): Promise<ConvertSellerLeadOnIntentResult> {
  const svc = createServiceClient()

  // ── Pre-read: was this lead ALREADY converted? (idempotent path detection) ──
  const { data: preLead } = await svc
    .from("leads")
    .select("id, contact_id, is_active, agent_id, address, city, state, zip_code, property_zip_code")
    .eq("id", params.leadId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!preLead) {
    return { success: false, error: "Lead not found" }
  }
  const wasAlreadyConverted = !!preLead.contact_id

  // ── Step 1: CONVERT via the CANONICAL handoff ───────────────────────────────
  // acceptAIISAHandoff IS the positive-intent conversion: consent → qualified →
  // Engine 2 assignment → lossless contact, ai_isa_owner=false (ISA dormant). It is
  // idempotent — when leads.contact_id is already set it returns that contact. We
  // call it as the trusted server-side ISA caller (actorUserId='system').
  const handoff = await acceptAIISAHandoff({
    leadId: params.leadId,
    brokerageId: params.brokerageId,
    actorUserId: "system",
  })
  if (!handoff.success || !handoff.contactId) {
    return { success: false, error: handoff.error ?? "Conversion failed" }
  }
  const contactId = handoff.contactId

  // Resolve the contact's agent (for the notification + CMA proposal).
  const { data: contactRow } = await svc
    .from("contacts")
    .select("agent_id, address, city, state, zip_code")
    .eq("id", contactId)
    .maybeSingle()
  const agentId = (contactRow as any)?.agent_id ?? preLead.agent_id ?? null

  // ── Step 2: NOTIFY the agent of a new contact to reach out to ───────────────
  // Only on a FRESH conversion — a rerun's agent was already notified. The agent's
  // notification feed keys off the agent's users.id, so resolve agents.id → user_id.
  let agentNotified = false
  if (!wasAlreadyConverted && agentId) {
    const { data: agentUser } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .maybeSingle()
    const agentUserId = (agentUser as any)?.user_id ?? null
    if (agentUserId) {
      const { error: notifyErr } = await svc.from("notifications").insert({
        brokerage_id: params.brokerageId,
        user_id: agentUserId,
        contact_id: contactId,
        type: "seller_intent_converted",
        title: "New seller contact — ready for follow-up",
        body:
          params.reason === "cma_request"
            ? "A seller lead asked for a CMA and converted to a contact. Reach out — a CMA has been proposed."
            : params.reason === "appointment_request"
            ? "A seller lead asked for a listing appointment and converted to a contact. The appointment is being booked and the prep chain is running."
            : "A seller lead engaged positively and converted to a contact. Reach out to keep the conversation alive.",
        entity_type: "contact",
        entity_id: contactId,
        priority: "high",
      })
      agentNotified = !notifyErr
    }
  }

  // ── Step 3: CMA — propose the CMA the lead asked for (cma_request only) ──────
  // We PROPOSE (a draft cma_reports row on the converted contact), not generate —
  // the full AI valuation (generateAICMA) is session-gated and burns inference; the
  // agent (or the chain at appointment time) finalizes it. This gives the
  // "wants a CMA, not an appt" lead the info value WITHOUT a listing appointment
  // and WITHOUT firing the listing-appt-prep chain.
  let cmaReportId: string | undefined
  if (params.reason === "cma_request" && agentId && !wasAlreadyConverted) {
    const pd = params.propertyData ?? {}
    const propertyAddress =
      pd.address ??
      (contactRow as any)?.address ??
      preLead.address ??
      null
    if (propertyAddress) {
      const { data: cma, error: cmaErr } = await svc
        .from("cma_reports")
        .insert({
          brokerage_id: params.brokerageId,
          contact_id: contactId,
          agent_id: agentId,
          property_address: propertyAddress,
          property_zip:
            pd.zip ?? pd.zip_code ?? (contactRow as any)?.zip_code ?? preLead.zip_code ?? preLead.property_zip_code ?? null,
          // Property facts come from the LEAD's scraped data (params.propertyData)
          // — contacts carries no property_type/bed/bath/sqft columns.
          property_type: pd.propertyType ?? pd.property_type ?? null,
          bedrooms: pd.bedrooms ?? null,
          bathrooms: pd.bathrooms ?? null,
          square_feet: pd.sqft ?? pd.square_feet ?? null,
          // 'draft' = PROPOSED (requested, not yet valued). The agent / chain finalizes.
          status: "draft",
        })
        .select("id")
        .single()
      if (!cmaErr && cma) {
        cmaReportId = (cma as any).id as string
      }
    }
  }

  // ── Step 4: APPOINTMENT — book the listing appointment milestone (intent case) ─
  // Some seller leads ask for a listing appointment right away. That's a distinct
  // intent: convert (canonical, done above) THEN immediately book the listing
  // appointment via the existing milestone helper (bookSellerListingAppointment).
  // It is idempotent and detects the contact already exists (converted above) →
  // NO second convert / NO second welcome — it just schedules + fires
  // listing.appointment_set → the listing-appt-prep chain.
  let calendarEventId: string | undefined
  let chainRunId: string | undefined
  if (params.reason === "appointment_request" && params.appointment && agentId) {
    const { bookSellerListingAppointment } = await import("./book-seller-appointment")
    const appt = await bookSellerListingAppointment({
      brokerageId: params.brokerageId,
      leadId: params.leadId,
      agentId,
      startAt: params.appointment.startAt,
      endAt: params.appointment.endAt,
      timezoneName: params.appointment.timezoneName,
      location: params.appointment.location ?? params.propertyData?.address ?? undefined,
      notes: params.appointment.notes,
      propertyData: params.propertyData,
    })
    if (appt.success) {
      calendarEventId = appt.calendarEventId
      chainRunId = appt.chainRunId
    } else {
      // Surface the booking failure but keep the (successful) conversion — the
      // contact exists and the agent was notified; only the appt step failed.
      return {
        success: false,
        contactId,
        alreadyConverted: wasAlreadyConverted,
        agentNotified,
        error: `Converted, but appointment booking failed: ${appt.error}`,
      }
    }
  }

  return {
    success: true,
    contactId,
    alreadyConverted: wasAlreadyConverted,
    agentNotified,
    cmaReportId,
    calendarEventId,
    chainRunId,
  }
}
