// lib/agents/vendor-loop-producer.ts
//
// VENDOR MARKETPLACE LOOP — two governed deliverables around a vendor booking, each
// proposed into the client-message gate (human approves → sends; never autonomous):
//   1. INTRO (Deal Coordinator) — when a vendor is booked for a client, propose a
//      client intro: who's coming, what for, how to reach them. Reduces the "who is
//      this at my door?" friction every transaction has.
//   2. REVIEW REQUEST (Sphere Manager) — when the service completes, propose a request
//      for the client to rate the vendor. Compounds the marketplace's trust signal and
//      keeps the sphere relationship warm.
// Both idempotent (one intro + one review request per booking). Pure copy builders are
// unit-tested; the producers are live-probed.

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun, sanitizePhoneField } from "@/lib/compliance/client-text-guard"

type Svc = ReturnType<typeof createServiceClient>

export interface VendorIntroFacts {
  vendorName: string
  vendorCategory: string | null
  vendorPhone: string | null
  serviceType: string | null
  scheduledDate: string | null
}

/** Pure: client-safe vendor intro copy. EVERY interpolated field is sanitized — service_type arrives
 *  from portal booking requests and vendor rows (externally influenced), and a phone column is free
 *  text, so both are injection surfaces into CLIENT-facing copy, not trusted facts. */
export function buildVendorIntro(facts: VendorIntroFacts, agentName: string): { subject: string; body: string } {
  const v = sanitizeProperNoun(facts.vendorName, 80) ?? "your service provider"
  const who = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  const svc = sanitizeProperNoun(facts.serviceType, 40) ?? sanitizeProperNoun(facts.vendorCategory, 40) ?? "service"
  const when = facts.scheduledDate ? ` on ${new Date(facts.scheduledDate).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}` : ""
  const safePhone = sanitizePhoneField(facts.vendorPhone)
  const phone = safePhone ? ` You can reach them directly at ${safePhone}.` : ""
  return {
    subject: `Your ${svc} appointment — meet ${v}`,
    body: [
      `Hi,`,
      `I've arranged ${v} for your ${svc}${when}.${phone}`,
      `They come recommended, and I'll be tracking everything on my end. Reply here with any questions.`,
      `— ${who}`,
    ].join("\n\n"),
  }
}

/** Pure: client-safe vendor review request copy (service_type sanitized — same injection surface).
 *  The ask is a DEEP LINK to the portal rating control, not "reply with a 1–5": until 2026-09-01 the
 *  copy requested a number with nowhere to put it (no reply parser exists, and portal messages are
 *  one-way agent→client here), so vendor_bookings.client_rating aggregated an always-empty set. The
 *  link lands on the booking's own row anchor in /portal/[contactId]/vendors, where RateBookingStars
 *  renders exactly when the booking is completed and unrated. */
export function buildVendorReviewRequest(
  vendorName: string, serviceType: string | null, agentName: string,
  link: { contactId: string; bookingId: string },
): { subject: string; body: string } {
  const v = sanitizeProperNoun(vendorName, 80) ?? "the provider"
  const who = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  const svc = sanitizeProperNoun(serviceType, 40) ?? "service"
  const portalLink = `/portal/${link.contactId}/vendors#booking-${link.bookingId}`
  return {
    subject: `How did your ${svc} go?`,
    body: [
      `Hi,`,
      `Now that your ${svc} with ${v} is complete, I'd love a quick rating — it helps me keep only the best providers in your corner (and helps other clients too).`,
      `Tap the stars on your services page to rate it (takes ten seconds): ${portalLink}`,
      `— ${who}`,
    ].join("\n\n"),
  }
}

async function loadBookingContext(supabase: Svc, brokerageId: string, bookingId: string): Promise<{
  booking: { id: string; contact_id: string | null; transaction_id: string | null; listing_id: string | null; service_type: string | null; scheduled_date: string | null; status: string }
  vendor: { name: string; category: string | null; phone: string | null }
  agentName: string
} | null> {
  const { data: b } = await supabase
    .from("vendor_bookings")
    .select("id, brokerage_id, vendor_id, contact_id, transaction_id, listing_id, service_type, scheduled_date, status")
    .eq("id", bookingId).eq("brokerage_id", brokerageId).maybeSingle()
  const booking = b as any
  if (!booking) return null

  const { data: v } = await supabase.from("vendors").select("name, category, phone").eq("id", booking.vendor_id).maybeSingle()
  const vendor = (v as any) ?? { name: "your provider", category: null, phone: null }

  // Agent name via the contact's agent (best-effort).
  let agentName = "Your Agent"
  if (booking.contact_id) {
    const { data: c } = await supabase.from("contacts").select("agent_id").eq("id", booking.contact_id).maybeSingle()
    const agentId = (c as { agent_id?: string | null } | null)?.agent_id ?? null
    if (agentId) {
      const { data: a } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
      const uid = (a as { user_id?: string | null } | null)?.user_id ?? null
      if (uid) {
        const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
        const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
        if (full) agentName = full
      }
    }
  }
  return { booking, vendor, agentName }
}

/** Has this manager already proposed a message for this booking? (idempotency key:
 *  intro = deal_coordinator, review = sphere_of_influence — one of each per booking). */
async function alreadyProposed(supabase: Svc, brokerageId: string, bookingId: string, agentKind: string): Promise<boolean> {
  const { data } = await supabase
    .from("agent_client_messages")
    .select("id")
    .eq("brokerage_id", brokerageId).eq("entity_type", "vendor_booking").eq("entity_id", bookingId)
    .eq("agent_kind", agentKind)
    .limit(1).maybeSingle()
  return !!data
}

/** Propose a client vendor-intro into the gate (Deal Coordinator). Idempotent per booking. */
export async function produceVendorIntro(
  brokerageId: string, bookingId: string, client?: Svc,
): Promise<{ proposed: boolean; reason?: string }> {
  const supabase = client ?? createServiceClient()
  const ctx = await loadBookingContext(supabase, brokerageId, bookingId)
  if (!ctx) return { proposed: false, reason: "booking not found" }
  if (!ctx.booking.contact_id) return { proposed: false, reason: "no client contact on booking" }
  if (await alreadyProposed(supabase, brokerageId, bookingId, "deal_coordinator")) return { proposed: false, reason: "intro already proposed" }

  const msg = buildVendorIntro({
    vendorName: ctx.vendor.name, vendorCategory: ctx.vendor.category, vendorPhone: ctx.vendor.phone,
    serviceType: ctx.booking.service_type, scheduledDate: ctx.booking.scheduled_date,
  }, ctx.agentName)
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage({
    brokerageId, agentKind: "deal_coordinator", entityType: "vendor_booking", entityId: bookingId,
    recipientContactId: ctx.booking.contact_id, audience: "buyer",
    subject: msg.subject, body: msg.body,
    rationale: `Vendor intro for ${sanitizeProperNoun(ctx.vendor.name, 60) ?? "a provider"} — review/edit before it reaches the client.`,
    channel: "portal",
  }, supabase)
  return res.ok ? { proposed: true } : { proposed: false, reason: res.error }
}

/** Propose a client vendor review request into the gate (Sphere). Idempotent per booking. */
export async function produceVendorReviewRequest(
  brokerageId: string, bookingId: string, client?: Svc,
): Promise<{ proposed: boolean; reason?: string }> {
  const supabase = client ?? createServiceClient()
  const ctx = await loadBookingContext(supabase, brokerageId, bookingId)
  if (!ctx) return { proposed: false, reason: "booking not found" }
  if (ctx.booking.status !== "completed") return { proposed: false, reason: `booking not completed (${ctx.booking.status})` }
  if (!ctx.booking.contact_id) return { proposed: false, reason: "no client contact on booking" }
  if (await alreadyProposed(supabase, brokerageId, bookingId, "sphere_of_influence")) return { proposed: false, reason: "review request already proposed" }

  const msg = buildVendorReviewRequest(ctx.vendor.name, ctx.booking.service_type, ctx.agentName, {
    contactId: ctx.booking.contact_id, // non-null: guarded two lines up
    bookingId,
  })
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const res = await proposeClientMessage({
    brokerageId, agentKind: "sphere_of_influence", entityType: "vendor_booking", entityId: bookingId,
    recipientContactId: ctx.booking.contact_id, audience: "buyer",
    subject: msg.subject, body: msg.body,
    rationale: `Vendor review request for ${sanitizeProperNoun(ctx.vendor.name, 60) ?? "a provider"} (service complete) — review/edit before it sends.`,
    channel: "portal",
  }, supabase)
  return res.ok ? { proposed: true } : { proposed: false, reason: res.error }
}

/** Sweep completed bookings lacking a review request and propose one for each. */
export async function sweepCompletedVendorBookings(
  brokerageId: string, client?: Svc,
): Promise<{ proposed: number; scanned: number }> {
  const supabase = client ?? createServiceClient()
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: rows } = await supabase
    .from("vendor_bookings")
    .select("id")
    .eq("brokerage_id", brokerageId).eq("status", "completed")
    .not("contact_id", "is", null)
    .gte("completed_at", weekAgo)
    .limit(200)
  const bookings = (rows ?? []) as Array<{ id: string }>
  let proposed = 0
  for (const b of bookings) {
    const r = await produceVendorReviewRequest(brokerageId, b.id, supabase)
    if (r.proposed) proposed += 1
  }
  return { proposed, scanned: bookings.length }
}
