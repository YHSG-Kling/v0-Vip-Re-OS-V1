"use server"

/**
 * app/actions/portal-nl-search.ts — NATURAL-LANGUAGE property search for the
 * BUYER (owner rule: "buyers can search for properties from rentcast/idx
 * using natural language"). The engine already existed (searchPropertiesCore:
 * intent parser → our inventory + RentCast/IDX, Fair-Housing-sanitized
 * explanations) but only agents and the voice admin could reach it — this is
 * the buyer's own doorway on the portal search page. Contact-anchored like
 * every portal action (the buyer's portal user is not the agent); the search
 * logs to client_portal_activity so the "I saw you" recognition and search
 * signals see it.
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface PortalSearchResult {
  address: string | null
  city: string | null
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  headline: string | null
  source: string
  listingId: string | null
}

export async function portalNaturalSearchAction(input: {
  contactId: string
  query: string
}): Promise<{ ok: true; results: PortalSearchResult[] } | { ok: false; error: string }> {
  const query = (input.query ?? "").trim().slice(0, 300)
  if (query.length < 5) return { ok: false, error: "Tell me a little more — beds, price range, area…" }

  const svc = createServiceClient()
  // agent_id is selected because the activity row below is stamped with it; it is AGENTS-class,
  // the class that column FKs. The error is destructured because supabase-js RESOLVES a refused
  // read — "no contact" and "the read was refused" used to be the same answer here.
  const { data: contact, error: contactError } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id, has_login").eq("id", input.contactId).maybeSingle()
  if (contactError) {
    console.error("[portal-nl-search] contact read refused:", contactError.message)
    return { ok: false, error: "We couldn't reach your account just now — please try again." }
  }
  if (!contact) return { ok: false, error: "Contact not found" }

  const { searchPropertiesCore } = await import("@/lib/buyer-search")
  const r: any = await searchPropertiesCore({
    contactId: input.contactId,
    naturalLanguageQuery: query,
    options: { limit: 8, logSignals: true },
  }).catch(() => null)
  if (!r?.success) return { ok: false, error: "That search didn't run — try rephrasing (beds, price, area)." }

  // The engagement ledger the recognition + preference rails already read. TENANT-STAMPED: the
  // row's SELECT policy admits the agent side only via has_brokerage_access(brokerage_id) or
  // agent_id = current_user_agent_id(), so the unstamped version of this row told the agent
  // nothing about what their buyer is out there searching for — the one signal it exists to carry.
  // Both columns are nullable, so the insert succeeded and the loss was silent. `.then(ok, err)`
  // was standing in for an error check and could never fire: supabase-js RESOLVES a refused write.
  const searchActivityRow = {
    brokerage_id: (contact as { brokerage_id: string | null }).brokerage_id,
    contact_id: input.contactId,
    agent_id: (contact as { agent_id: string | null }).agent_id,
    activity_type: "nl_property_search",
    metadata: { query },
  }
  const { error: activityError } = await svc.from("client_portal_activity").insert(searchActivityRow)
  if (activityError) console.error("[portal-nl-search] portal activity NOT recorded:", activityError.message)

  const results: PortalSearchResult[] = ((r.results ?? []) as any[]).slice(0, 8).map((m) => ({
    address: m.address ?? null,
    city: m.city ?? null,
    price: m.price ?? null,
    bedrooms: m.bedrooms ?? null,
    bathrooms: m.bathrooms ?? null,
    headline: m.headline ?? null,
    source: String(m.source ?? "platform"),
    listingId: m.listing_id ?? null,
  }))
  return { ok: true, results }
}
