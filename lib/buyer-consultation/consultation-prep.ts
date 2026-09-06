/**
 * lib/buyer-consultation/consultation-prep.ts
 *
 * The COMPOSER a booked buyer consultation fires: builds the buyer deck row and
 * its dripped slide sections — the buyer twin of what
 * app/api/cron/listing-presentation-prep does for listing appointments.
 *
 * ENTITY REUSE (task ruling, verified against the live schema 2026-09-01):
 * listing_presentations carries presentation_type (nullable TEXT, NO CHECK —
 * only `status` is constrained), so a row with
 * presentation_type='buyer_consultation' rides appointment_id idempotency,
 * Gate 2 (delivery_approved_at), the section drip, and delivery UNCHANGED.
 * The live table's one hard constraint that matters here is `state` NOT NULL
 * (information_schema, project hrvaqgvukzxfskkcrwbt) — resolved from the
 * buyer's own contact row or their saved properties; a buyer with no
 * resolvable state REFUSES the deck with the reason recorded, nothing invented.
 *
 * Exposed as a plain callable so the cron trigger
 * (app/api/cron/buyer-consultation-prep) and any future dispatch point (e.g.
 * the appointment intent-router) share one composer.
 *
 * Not server-only. Never import from a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { BUYER_SECTION_SEQUENCE } from "@/lib/buyer-consultation/consultation-render"

export type ComposeDeckResult =
  | { ok: true; presentationId: string; created: boolean; rendered: number; skippedSlides: number }
  | { ok: false; skipped: string }

export interface ComposeDeckInput {
  brokerageId:   string
  /** USERS-class id (listing_presentations.agent_user_id FKs users). */
  agentUserId:   string | null
  contactId:     string
  /** calendar_events.id — the idempotency anchor (one deck per appointment). */
  appointmentId: string
  appointmentAt: string | null
}

/**
 * Resolve the NOT-NULL `state` for the deck row from the buyer's own records:
 * their contact row first, then the most recent saved property. {error} read on
 * every leg — a refused read is reported, never treated as "no state on file".
 */
async function resolveBuyerState(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  contactId: string,
): Promise<{ state: string | null; error?: string }> {
  const { data: contact, error: cErr } = await svc
    .from("contacts")
    .select("state, mailing_state")
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (cErr) return { state: null, error: `contacts read: ${cErr.message}` }
  const fromContact = (contact as any)?.state ?? (contact as any)?.mailing_state ?? null
  if (typeof fromContact === "string" && fromContact.trim()) return { state: fromContact.trim() }

  const { data: saved, error: sErr } = await svc
    .from("saved_properties")
    .select("state, saved_at")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .not("state", "is", null)
    .order("saved_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (sErr) return { state: null, error: `saved_properties read: ${sErr.message}` }
  const fromSaved = (saved as any)?.state ?? null
  return { state: typeof fromSaved === "string" && fromSaved.trim() ? fromSaved.trim() : null }
}

/**
 * Build (idempotently) the buyer-consultation deck for one appointment:
 * one listing_presentations row per appointment_id, sections from
 * BUYER_SECTION_SEQUENCE on the drip's one timetable, each slide rendered as a
 * BuyerConsultationSlide. The deck stays HELD (delivery_approved_at null) until
 * a human releases it through the same Gate 2 the listing drip uses.
 */
export async function composeBuyerConsultationDeck(
  input: ComposeDeckInput,
  client?: ReturnType<typeof createServiceClient>,
): Promise<ComposeDeckResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.contactId || !input.appointmentId) {
    return { ok: false, skipped: "missing brokerageId/contactId/appointmentId" }
  }

  // Idempotency — one deck per appointment. An unreadable row is NOT absent:
  // building on a failed read is how one buyer gets two decks and two drips.
  // Tenant predicate is REQUIRED here (§4): this is a service client, so RLS
  // does not scope the read — without it a cross-tenant appointment_id
  // collision would suppress this brokerage's deck.
  const { data: existing, error: existErr } = await svc
    .from("listing_presentations")
    .select("id")
    .eq("appointment_id", input.appointmentId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (existErr) return { ok: false, skipped: `idempotency read failed: ${existErr.message}` }
  if (existing?.id) {
    return { ok: true, presentationId: (existing as { id: string }).id, created: false, rendered: 0, skippedSlides: 0 }
  }

  const stateRes = await resolveBuyerState(svc, input.brokerageId, input.contactId)
  if (stateRes.error) return { ok: false, skipped: `state lookup refused: ${stateRes.error}` }
  if (!stateRes.state) {
    // listing_presentations.state is NOT NULL — nothing on file names one, and
    // nothing is invented to get past the constraint.
    return { ok: false, skipped: "no state on file for this buyer (contact + saved properties empty)" }
  }

  const { data: pres, error: presErr } = await svc
    .from("listing_presentations")
    .insert({
      brokerage_id:      input.brokerageId,
      agent_user_id:     input.agentUserId,
      contact_id:        input.contactId,
      appointment_id:    input.appointmentId,
      appointment_at:    input.appointmentAt,
      presentation_type: "buyer_consultation",
      // A buyer consultation has no subject property — the column is nullable
      // live, and a fabricated address would be a claim.
      property_address:  null,
      state:             stateRes.state,
      status:            "draft",
    })
    .select("id")
    .single()
  if (presErr || !pres) return { ok: false, skipped: `presentation insert refused: ${presErr?.message ?? "no row"}` }
  const presentationId = (pres as { id: string }).id

  // ONE materializer, ONE timetable (§6): the drip's own planner spreads the
  // six buyer slides between now and the appointment, and the buyer branch of
  // materializePresentationSections routes rendering to the buyer producer.
  const { materializePresentationSections } = await import("@/lib/listing-presentation/section-drip")
  const mat = await materializePresentationSections(presentationId, svc, {
    sections:         BUYER_SECTION_SEQUENCE,
    presentationType: "buyer_consultation",
  })
  if (!mat.ok) return { ok: false, skipped: `sections not materialized: ${mat.error ?? "unknown"}` }

  // Report what the renderer actually did — the renderer already ran inside
  // materialize (best-effort); re-read the sections for an honest count.
  const { data: secs, error: secErr } = await svc
    .from("presentation_sections")
    .select("render_id")
    .eq("presentation_id", presentationId)
  if (secErr) {
    console.warn(`[consultation-prep] section count unreadable for ${presentationId}: ${secErr.message}`)
    return { ok: true, presentationId, created: true, rendered: 0, skippedSlides: 0 }
  }
  const rows = (secs ?? []) as Array<{ render_id: string | null }>
  const rendered = rows.filter((r) => !!r.render_id).length
  return { ok: true, presentationId, created: true, rendered, skippedSlides: rows.length - rendered }
}
