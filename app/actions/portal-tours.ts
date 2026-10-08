"use server"

/**
 * Buyer-portal tour reader — the gate that finally puts a buyer's tours in
 * front of the buyer.
 *
 * WHY THIS EXISTS: the portal showings page read `tours` with the RLS-bound
 * client. The live policies on `tours` are `tours_agent_own`
 * (agent_id = current_user_agent_id()) and `tours_broker_admin` — a CONTACT
 * seat matches neither, so the buyer's own itinerary came back as an empty
 * list on every visit (and the page never destructured the error, so the
 * refusal read as "no tours"). Tours were being "sent to the portal"
 * (finalizeTour, tour_recap cards deep-link here) and the portal could not
 * show them.
 *
 * PATTERN (owner ruling #185 — contacts see only their own work): the shared
 * requireContactAccess gate (lib/portal/require-contact-access.ts — the
 * isContactSelf pattern every portal action uses) authorizes the caller as the
 * contact themselves or same-brokerage staff, then a SERVICE read is scoped to
 * exactly that contact's rows. Identity is server-resolved; the caller-supplied
 * contactId grants nothing by itself.
 *
 * PRIVACY: intentionally OMITS listing_agent_* contact fields and per-stop
 * access codes/instructions — the buyer is represented by their agent and must
 * not see other-brokerage agent contact info; door codes stay with the agent
 * until tour day. The agent-side tour-confirm-tab is the only surface for those.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { isValidUUID } from "@/lib/validations"

export interface PortalTourStop {
  id: string
  property_address: string | null
  city: string | null
  state: string | null
  zip: string | null
  list_price: number | null
  primary_photo_url: string | null
  suggested_time: string | null
  suggested_duration_minutes: number | null
  drive_time_from_prev_minutes: number | null
  confirmed_time: string | null
  is_confirmed: boolean | null
  buyer_interest_level: string | null
  buyer_note: string | null
  order_index: number | null
}

export interface PortalTour {
  id: string
  tour_date: string | null
  start_time: string | null
  start_address: string | null
  status: string | null
  all_confirmed: boolean | null
  total_duration_minutes: number | null
  total_drive_time_minutes: number | null
  agent_approved_at: string | null
  report_sent_at: string | null
  report_url: string | null
  ai_plan_narrative: string | null
  notes: string | null
  tour_stops: PortalTourStop[]
}

export async function getPortalBuyerTours(
  contactId: string,
): Promise<{ success: true; tours: PortalTour[] } | { success: false; error: string }> {
  if (!isValidUUID(contactId)) return { success: false, error: "Invalid contact ID" }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("tours")
    .select(
      `id, tour_date, start_time, start_address, status, all_confirmed,
       total_duration_minutes, total_drive_time_minutes,
       agent_approved_at, report_sent_at, report_url,
       ai_plan_narrative, notes,
       tour_stops(id, property_address, city, state, zip,
                  list_price, primary_photo_url,
                  suggested_time, suggested_duration_minutes,
                  drive_time_from_prev_minutes,
                  confirmed_time, is_confirmed,
                  buyer_interest_level, buyer_note,
                  order_index)`,
    )
    .eq("contact_id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .order("tour_date", { ascending: false })

  // Refusal reported as a refusal — never as "no tours".
  if (error) return { success: false, error: error.message }

  return { success: true, tours: (data ?? []) as unknown as PortalTour[] }
}
