"use server"

/**
 * app/actions/strategy-session.ts — the strategy-session flow (concierge
 * list #24): detect the moment from the REAL deal state, compose the
 * auto-prepared agenda + invite (pure, lib/kernel/strategy-session.ts),
 * and on confirm create the agent's task carrying the whole packet.
 * Gated by the same contact-access check every contact surface runs.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { assertCanActOnContact } from "@/lib/auth/contact-access"
import { resolveAddressing } from "@/lib/kernel/addressing"
import {
  composeStrategySession,
  inferStrategyMoment,
  type StrategySession,
} from "@/lib/kernel/strategy-session"

export async function getStrategySessionAction(input: { contactId: string }): Promise<
  | { ok: true; session: StrategySession | null; listingId?: string | null }
  | { ok: false; error: string }
> {
  const gate = await assertCanActOnContact(input.contactId)
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()

  const { data: c } = await svc.from("contacts")
    .select("first_name, last_name, preferred_name, salutation_style, buyer_stage, budget_min, budget_max")
    .eq("id", input.contactId).maybeSingle()
  if (!c) return { ok: false, error: "Contact not found" }

  // Their active listing (seller side) — either linkage column counts.
  const { data: listing } = await svc.from("listings")
    .select("id, address, list_price, listing_date, go_live_date, showing_count, status, seller_walkaway_price")
    .or(`seller_contact_id.eq.${input.contactId},contact_id.eq.${input.contactId}`)
    .in("status", ["active", "coming_soon", "pending"])
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle()

  // Offers awaiting a response on that listing — deterministic, vocabulary-free:
  // an offer with no responded_at is on the table.
  let offersAwaiting = 0
  let topOfferPrice: number | null = null
  let sellerNetEstimate: number | null = null
  let responseDeadline: string | null = null
  if (listing?.id) {
    const { data: offers } = await svc.from("offers")
      .select("offer_price, seller_net_estimate, response_deadline")
      .eq("listing_id", (listing as any).id)
      .is("responded_at", null)
      .order("offer_price", { ascending: false })
      .limit(10)
    const rows = (offers ?? []) as Array<{ offer_price: number | null; seller_net_estimate: number | null; response_deadline: string | null }>
    offersAwaiting = rows.length
    topOfferPrice = rows[0]?.offer_price ?? null
    sellerNetEstimate = rows[0]?.seller_net_estimate ?? null
    responseDeadline = rows[0]?.response_deadline ?? null
  }

  const listedAt = (listing as any)?.go_live_date ?? (listing as any)?.listing_date ?? null
  const daysOnMarket = listedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(listedAt).getTime()) / 86_400_000))
    : null

  const moment = inferStrategyMoment({
    buyerStage: (c as any).buyer_stage ?? null,
    hasActiveListing: !!listing,
    daysOnMarket,
    offersAwaitingResponse: offersAwaiting,
  })
  if (!moment) return { ok: true, session: null, listingId: null }

  const session = composeStrategySession({
    moment,
    clientName: resolveAddressing({
      firstName: (c as any).first_name ?? null,
      lastName: (c as any).last_name ?? null,
      preferredName: (c as any).preferred_name ?? null,
      namePronunciation: null,
      salutationStyle: (c as any).salutation_style ?? null,
    }).addressAs,
    listingAddress: (listing as any)?.address ?? null,
    listPrice: (listing as any)?.list_price ?? null,
    daysOnMarket,
    showingCount: (listing as any)?.showing_count ?? null,
    offersAwaitingResponse: offersAwaiting,
    topOfferPrice,
    sellerNetEstimate,
    responseDeadline,
    budgetMin: (c as any).budget_min ?? null,
    budgetMax: (c as any).budget_max ?? null,
    buyerStage: (c as any).buyer_stage ?? null,
    sellerWalkawayPrice: (listing as any)?.seller_walkaway_price ?? null,
  })
  return { ok: true, session, listingId: ((listing as any)?.id as string | null) ?? null }
}

export async function scheduleStrategySessionAction(input: {
  contactId: string
  session: StrategySession
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertCanActOnContact(input.contactId)
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()

  // tasks.assigned_to_agent_id is NOT NULL (live contract) — the contact's
  // agent owns the session; an agent-less contact falls to the caller's own
  // agents row; no agent at all = an honest refusal, never a broken insert.
  let agentId = (gate.contact as any).agent_id ?? null
  if (!agentId) {
    const { data: me } = await svc.from("agents").select("id").eq("user_id", gate.userId).maybeSingle()
    agentId = (me as any)?.id ?? null
  }
  if (!agentId) return { ok: false, error: "No agent to assign the session to — assign an agent to this contact first" }

  const { error } = await svc.from("tasks").insert({
    brokerage_id: (gate.contact as any).brokerage_id,
    contact_id: input.contactId,
    assigned_to_agent_id: agentId,
    title: input.session.title,
    description: [
      `Send the invite: "${input.session.inviteLine}"`,
      "",
      `AGENDA (${input.session.durationMin} min):`,
      ...input.session.agenda.map((a, i) => `${i + 1}. ${a}`),
      "",
      "PREP:",
      ...input.session.agentPrep.map((p) => `- ${p}`),
    ].join("\n"),
    due_date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    assignee_type: "agent",
    source: "strategy_session",
    status: "pending",
    created_at: new Date().toISOString(),
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}


export async function setSellerFloorAction(input: {
  listingId: string
  /** the seller's walk-away floor in dollars; null clears it. */
  floor: number | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await (await import("@/lib/supabase/server")).createClient().then(async (sb) => {
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return null
    const { data: me } = await sb.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    return (me as any)?.brokerage_id ? { brokerageId: (me as any).brokerage_id as string } : null
  })
  if (!gate) return { ok: false, error: "Not authenticated" }
  const svc = createServiceClient()
  const { data: listing } = await svc.from("listings")
    .select("id, brokerage_id").eq("id", input.listingId).maybeSingle()
  if (!listing || (listing as any).brokerage_id !== gate.brokerageId) return { ok: false, error: "Listing not found" }
  const floor = input.floor != null && input.floor > 0 ? Math.round(input.floor) : null
  const { error } = await svc.from("listings")
    .update({ seller_walkaway_price: floor }).eq("id", input.listingId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
