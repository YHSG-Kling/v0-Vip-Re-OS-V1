/**
 * lib/listing-presentation/section-drip.ts
 *
 * Wave 39 — the seller-facing pre-listing drip. Splits the full listing
 * presentation (CMA mixed in) into ordered SECTIONS and schedules them to drip
 * to the seller via email + portal across the window between now and the
 * listing appointment — selling the relationship + the market before the
 * meeting.
 *
 * HARD RULE: every section is seller-safe (price_withheld). The CMA section
 * presents MARKET context only and defers the home's valuation to the in-person
 * meeting (scrubbed via lib/cma/customer-facing-guard).
 *
 * The pure planner (planPresentationSections) is unit-tested; materialize uses
 * the service client. Not server-only — never import from a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { scrubSuggestedPriceKeys } from "@/lib/cma/customer-facing-guard"

export interface SectionSpec { key: string; title: string; body: Record<string, unknown> }

/** Canonical seller-facing section sequence (relationship + market sell; the
 *  home's value is deferred to the meeting). */
export const SECTION_SEQUENCE: SectionSpec[] = [
  { key: "intro",       title: "Meet Your Listing Team",   body: { kind: "intro" } },
  { key: "market",      title: "Your Market Right Now",    body: { kind: "market", shows: ["price_trend", "comparable_sales", "days_on_market"] } },
  { key: "credibility", title: "Why Sellers Choose Us",    body: { kind: "credibility" } },
  { key: "marketing",   title: "How We Sell Your Home",    body: { kind: "marketing" } },
  { key: "process",     title: "What To Expect",           body: { kind: "process" } },
  { key: "cma",         title: "Your Home's Analysis",     body: { kind: "cma", market_only: true, note: "Your home's value will be presented at our meeting." } },
  { key: "closing",     title: "Let's Talk Strategy",      body: { kind: "closing" } },
]

export interface PlanInput {
  presentationId: string
  brokerageId:    string
  contactId?:     string | null
  appointmentAt:  string | Date
  now?:           Date
  sections?:      SectionSpec[]
  bufferHoursBeforeAppt?: number
  channel?:       "email" | "portal" | "both"
  /** Market narrative (price-free) merged into the CMA section. */
  marketNarrative?: string | null
}

export interface PlannedSection {
  presentation_id: string
  brokerage_id:    string
  contact_id:      string | null
  section_key:     string
  section_order:   number
  title:           string
  body:            Record<string, unknown>
  channel:         "email" | "portal" | "both"
  price_withheld:  true
  status:          "scheduled"
  scheduled_for:   string
}

/**
 * Pure: plan the seller-safe sections + their drip schedule. Sections are
 * spread evenly between `now` and `appointmentAt - buffer` so the last lands
 * comfortably before the meeting. If the appointment is too soon (or past),
 * everything is scheduled immediately. Every body is scrubbed of price keys.
 */
export function planPresentationSections(input: PlanInput): PlannedSection[] {
  const sections = input.sections ?? SECTION_SEQUENCE
  const now = input.now ?? new Date()
  const appt = new Date(input.appointmentAt)
  const bufferMs = (input.bufferHoursBeforeAppt ?? 12) * 3_600_000
  const channel = input.channel ?? "both"
  const N = sections.length

  const endMs = (Number.isFinite(appt.getTime()) ? appt.getTime() : now.getTime()) - bufferMs
  const windowMs = endMs - now.getTime()

  return sections.map((s, i) => {
    const fraction = (i + 1) / N
    const at = windowMs > 0 ? now.getTime() + fraction * windowMs : now.getTime()
    // Merge the market narrative into the CMA section, then scrub any price keys.
    const rawBody = s.key === "cma" && input.marketNarrative
      ? { ...s.body, market_narrative: input.marketNarrative }
      : s.body
    return {
      presentation_id: input.presentationId,
      brokerage_id:    input.brokerageId,
      contact_id:      input.contactId ?? null,
      section_key:     s.key,
      section_order:   i,
      title:           s.title,
      body:            scrubSuggestedPriceKeys(rawBody) as Record<string, unknown>,
      channel,
      price_withheld:  true as const,
      status:          "scheduled" as const,
      scheduled_for:   new Date(at).toISOString(),
    }
  })
}

export interface MaterializeResult { ok: boolean; inserted: number; error?: string }

/**
 * Read a listing_presentations row, plan its seller-safe sections, and insert
 * them. Idempotent on (presentation_id, section_key). Schedules against the
 * presentation's appointment_at (falls back to a 5-day window from now).
 */
export async function materializePresentationSections(
  presentationId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<MaterializeResult> {
  const supabase = client ?? createServiceClient()

  const { data: pres, error } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, contact_id, appointment_at, cma_narrative")
    .eq("id", presentationId)
    .maybeSingle()
  if (error || !pres) return { ok: false, inserted: 0, error: error?.message ?? "presentation not found" }
  if (!pres.brokerage_id) return { ok: false, inserted: 0, error: "presentation has no brokerage_id" }

  const appointmentAt = pres.appointment_at ?? new Date(Date.now() + 5 * 86_400_000).toISOString()
  const planned = planPresentationSections({
    presentationId,
    brokerageId:     pres.brokerage_id,
    contactId:       pres.contact_id ?? null,
    appointmentAt,
    marketNarrative: pres.cma_narrative ?? null,
  })

  const { data: inserted, error: insErr } = await supabase
    .from("presentation_sections")
    .upsert(planned, { onConflict: "presentation_id,section_key", ignoreDuplicates: true })
    .select("id")
  if (insErr) return { ok: false, inserted: 0, error: insErr.message }

  // Best-effort: render EVERY section as an animated video — the CMA section as
  // a seller-safe CMAReel data video, the others as branded ListingSectionReel
  // slides ("why this brokerage/agent/team"). A render failure must not fail
  // section materialization — the section still drips (as a card until rendered).
  try {
    const { renderSectionsForPresentation } = await import("./section-render")
    await renderSectionsForPresentation(presentationId, supabase)
    // Then narrate: the agent's cloned voice (+ avatar when available) over each
    // section. Degrades gracefully — no clone → on-screen copy only; the video
    // still renders. Best-effort; never blocks materialization.
    const { narratePresentationSections } = await import("./section-narration-orchestrator")
    await narratePresentationSections(presentationId, supabase)
  } catch { /* section render + narration are best-effort */ }

  return { ok: true, inserted: inserted?.length ?? 0 }
}

export interface DeliverResult { delivered: number; considered: number }

/**
 * Deliver every section whose scheduled_for has arrived: post a seller-facing
 * portal card (writePortalUpdate, PRESENTATION_SECTION_DELIVERED) and advance
 * the section scheduled → delivered. The portal write is best-effort — a
 * delivery-channel failure must not strand the section in 'scheduled'. The
 * drip cron is a thin wrapper over this. Atomic per row (the status guard in
 * the update prevents a double-send across overlapping cron ticks).
 */
export async function deliverDueSections(
  opts: { now?: Date; limit?: number } = {},
  client?: ReturnType<typeof createServiceClient>,
): Promise<DeliverResult> {
  const supabase = client ?? createServiceClient()
  const nowIso = (opts.now ?? new Date()).toISOString()

  // GATE 2: a section is delivered only after a human RELEASED its presentation
  // (listing_presentations.delivery_approved_at). An inner join + not-null filter
  // keeps held (un-reviewed) presentations out of the drip entirely.
  const { data: due } = await supabase
    .from("presentation_sections")
    .select("id, presentation_id, brokerage_id, contact_id, title, listing_presentations!inner(delivery_approved_at)")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .not("listing_presentations.delivery_approved_at", "is", null)
    .order("scheduled_for", { ascending: true })
    .limit(opts.limit ?? 25)

  const rows = due ?? []
  let delivered = 0
  for (const s of rows as Array<{ id: string; presentation_id: string; brokerage_id: string; contact_id: string | null; title: string | null }>) {
    // Claim the row first (scheduled → delivered) so an overlapping tick can't double-send.
    const { data: claimed } = await supabase
      .from("presentation_sections")
      .update({ status: "delivered", delivered_at: new Date().toISOString() })
      .eq("id", s.id)
      .eq("status", "scheduled")
      .select("id")
      .maybeSingle()
    if (!claimed) continue
    delivered++

    if (s.contact_id) {
      try {
        const { writePortalUpdate } = await import("@/lib/kernel/event-fanout")
        const { KernelEvent } = await import("@/lib/kernel/events")
        await writePortalUpdate(
          {
            event:       KernelEvent.PRESENTATION_SECTION_DELIVERED,
            brokerageId: s.brokerage_id,
            entityType:  "listing_presentation",
            entityId:    s.presentation_id,
            metadata:    { section_title: s.title ?? "Your listing plan" },
          } as Parameters<typeof writePortalUpdate>[0],
          [s.contact_id],
        )
      } catch { /* portal delivery is best-effort; the section is already delivered */ }
    }
  }
  return { delivered, considered: rows.length }
}
