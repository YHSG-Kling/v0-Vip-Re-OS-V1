"use server"

// app/actions/offer-intents.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE READER HALF of `offer_intents` (m619 APPLIED). The writer half —
// app/actions/buyer-offer-tools.ts::recordOfferIntent — records a buyer's
// portal "submit an offer" click; the kernel reactor (lib/kernel/event-reactor.ts
// case 7b, wired to lib/kernel/manager-signals.ts
// "shopping_agent:buyer_offer_submit_requested") notifies the buyer's agent and
// opens a task, but NOTHING let the agent see the durable list of pending
// intents or act on one (acknowledge / dismiss / start the real offer). That is
// what this file builds (census: opposite-missing-census.ts 1a
// offer_intents.source, readerless-write-census.ts).
//
// TENANCY (CLAUDE.md §4): every export resolves the caller's own
// brokerage/agent identity from the SESSION, never from a parameter. An agent
// sees only intents where `agent_id` resolves to their own `agents.id`; a
// brokerage admin (TENANT_ADMIN_USER_TYPES) sees every intent in their tenant.
// This mirrors offer_intents_select / offer_intents_update in
// supabase/migrations/m619-buyer-portal-offer-intent.sql exactly — a caller
// this file admits is a caller the RLS policy would also admit, so the
// service-client bypass here never grants more than a direct client read
// could have gotten if RLS had been left in place.
//
// BRIDGE: the "start offer" action does not write `offer_id` / status=converted
// itself — that write belongs to the agent's offer-creation action
// (app/actions/buyer-offers.ts::createOffer), which is the one place a real
// `offers` row is minted, and is wired to close the loop server-side once the
// wizard actually creates the offer (see createOffer's OFFER_INTENT BRIDGE
// block). This file only reads the intent forward into that flow.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { isValidUUID } from "@/lib/validations"

export interface OfferIntentRow {
  id: string
  contact_id: string
  contact_name: string
  listing_id: string | null
  property_address: string | null
  status: "requested" | "acknowledged" | "converted" | "dismissed"
  source: string
  offer_id: string | null
  created_at: string
  acknowledged_at: string | null
}

type CallerScope =
  | { ok: true; brokerageId: string; userId: string; agentId: string | null; isAdmin: boolean }
  | { ok: false; error: string }

/** Resolve who is calling and how wide their offer_intents view is allowed to
 *  be — same two-tier shape (assigned agent OR brokerage admin) the m619
 *  UPDATE policy already encodes; never derived from anything the caller sent. */
async function resolveCallerScope(): Promise<CallerScope> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const svc = createServiceClient()
  const { data: profile, error } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (error) return { ok: false, error: "Could not verify the caller" }
  const brokerageId = (profile?.brokerage_id ?? null) as string | null
  if (!brokerageId) return { ok: false, error: "Brokerage not configured" }

  const agentId = await resolveAgentId(svc, user.id)
  const isAdmin = isAdminOrBroker({ user_type: profile?.user_type ?? "" })
  if (!agentId && !isAdmin) return { ok: false, error: "Forbidden" }

  return { ok: true, brokerageId, userId: user.id, agentId, isAdmin }
}

/**
 * listPendingOfferIntentsForAgent — THE AGENT'S OWN WORK QUEUE across every
 * assigned buyer. Status defaults to the two open states ('requested',
 * 'acknowledged'); an admin sees the whole tenant's queue, an agent sees only
 * intents where `offer_intents.agent_id` is their own `agents.id` — exactly
 * the m619 SELECT policy's agent branch (`agent_id = current_user_agent_id()`).
 */
export async function listPendingOfferIntentsForAgent(): Promise<
  { success: true; intents: OfferIntentRow[] } | { success: false; error: string }
> {
  const scope = await resolveCallerScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const svc = createServiceClient()
  let q = svc
    .from("offer_intents")
    .select("id, contact_id, listing_id, property_address, status, source, offer_id, created_at, acknowledged_at")
    .eq("brokerage_id", scope.brokerageId)
    .in("status", ["requested", "acknowledged"])
    .order("created_at", { ascending: false })
    .limit(100)
  // Admins see the whole tenant queue; a plain agent sees only their own buyers.
  if (!scope.isAdmin) {
    if (!scope.agentId) return { success: true, intents: [] }
    q = q.eq("agent_id", scope.agentId)
  }
  const { data, error } = await q
  if (error) {
    console.error("[offer-intents] listPendingOfferIntentsForAgent read refused:", error.message)
    return { success: false, error: "Could not load offer requests" }
  }
  const rows = (data ?? []) as any[]
  if (rows.length === 0) return { success: true, intents: [] }

  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))]
  const { data: contacts } = await svc
    .from("contacts").select("id, first_name, last_name")
    .in("id", contactIds.length ? contactIds : ["00000000-0000-0000-0000-000000000000"])
  const nameById = new Map(
    ((contacts ?? []) as any[]).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || "Buyer"]),
  )

  return {
    success: true,
    intents: rows.map((r) => ({
      id: r.id,
      contact_id: r.contact_id,
      contact_name: nameById.get(r.contact_id) ?? "Buyer",
      listing_id: r.listing_id ?? null,
      property_address: r.property_address ?? null,
      status: r.status,
      source: r.source,
      offer_id: r.offer_id ?? null,
      created_at: r.created_at,
      acknowledged_at: r.acknowledged_at ?? null,
    })),
  }
}

/**
 * listOfferIntentsForContact — the SAME queue scoped to one buyer, for the
 * per-contact offers surface (`app/crm/contacts/[contactId]/offers`), which is
 * where "Create New Offer" already lives. Open states only, oldest first (the
 * agent works through them in the order the buyer asked).
 */
export async function listOfferIntentsForContact(
  contactId: string,
): Promise<{ success: true; intents: OfferIntentRow[] } | { success: false; error: string }> {
  if (!isValidUUID(contactId)) return { success: false, error: "Invalid contact ID" }
  const scope = await resolveCallerScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const svc = createServiceClient()
  const { data: contact, error: contactError } = await svc
    .from("contacts").select("id, first_name, last_name, brokerage_id, agent_id")
    .eq("id", contactId).eq("brokerage_id", scope.brokerageId).maybeSingle()
  if (contactError) return { success: false, error: "Could not verify the buyer" }
  if (!contact) return { success: false, error: "Buyer not found" }
  if (!scope.isAdmin && contact.agent_id !== scope.agentId) return { success: false, error: "Forbidden" }

  const { data, error } = await svc
    .from("offer_intents")
    .select("id, contact_id, listing_id, property_address, status, source, offer_id, created_at, acknowledged_at")
    .eq("contact_id", contactId).eq("brokerage_id", scope.brokerageId)
    .in("status", ["requested", "acknowledged"])
    .order("created_at", { ascending: true })
  if (error) {
    console.error("[offer-intents] listOfferIntentsForContact read refused:", error.message)
    return { success: false, error: "Could not load offer requests" }
  }
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Buyer"
  return {
    success: true,
    intents: ((data ?? []) as any[]).map((r) => ({
      id: r.id, contact_id: r.contact_id, contact_name: name,
      listing_id: r.listing_id ?? null, property_address: r.property_address ?? null,
      status: r.status, source: r.source, offer_id: r.offer_id ?? null,
      created_at: r.created_at, acknowledged_at: r.acknowledged_at ?? null,
    })),
  }
}

/** Shared write path for acknowledge/dismiss — both are a status transition on
 *  a row the caller is already proven to be allowed to act on (own buyer, or
 *  admin). CLAUDE.md §3: `.select()` the UPDATE and COUNT what came back — an
 *  UPDATE that matches nothing (wrong tenant, already-resolved intent, a
 *  status a caller may not set) resolves with `error: null` exactly like one
 *  that worked, so zero rows updated is reported as a refusal, never silently
 *  treated as success. */
async function transitionIntent(
  intentId: string,
  toStatus: "acknowledged" | "dismissed",
  fromStatuses: string[],
): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(intentId)) return { success: false, error: "Invalid request ID" }
  const scope = await resolveCallerScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const svc = createServiceClient()
  let q = svc
    .from("offer_intents")
    .update({
      status: toStatus,
      updated_at: new Date().toISOString(),
      ...(toStatus === "acknowledged" ? { acknowledged_at: new Date().toISOString() } : {}),
    })
    .eq("id", intentId)
    .eq("brokerage_id", scope.brokerageId)
    .in("status", fromStatuses)
  if (!scope.isAdmin) {
    if (!scope.agentId) return { success: false, error: "Forbidden" }
    q = q.eq("agent_id", scope.agentId)
  }
  const { data, error } = await q.select("id")
  if (error) {
    console.error(`[offer-intents] transition to '${toStatus}' NOT applied:`, error.message)
    return { success: false, error: "Could not update this request" }
  }
  if (!data || data.length === 0) {
    return { success: false, error: "This request was already handled, or you don't have access to it." }
  }
  return { success: true }
}

/** acknowledgeOfferIntent — "I saw this, I'm on it." Does not create an offer. */
export async function acknowledgeOfferIntent(intentId: string): Promise<{ success: boolean; error?: string }> {
  return transitionIntent(intentId, "acknowledged", ["requested"])
}

/** dismissOfferIntent — the agent handled this another way (phone call, the
 *  buyer changed their mind) and it should leave the open queue. Terminal;
 *  never converts to an offer from here. */
export async function dismissOfferIntent(intentId: string): Promise<{ success: boolean; error?: string }> {
  return transitionIntent(intentId, "dismissed", ["requested", "acknowledged"])
}
