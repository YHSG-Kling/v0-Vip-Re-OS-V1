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
  const { data: contact } = await svc.from("contacts")
    .select("id, brokerage_id, has_login").eq("id", input.contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }

  const { searchPropertiesCore } = await import("@/lib/buyer-search")
  const r: any = await searchPropertiesCore({
    contactId: input.contactId,
    naturalLanguageQuery: query,
    options: { limit: 8, logSignals: true },
  }).catch(() => null)
  if (!r?.success) return { ok: false, error: "That search didn't run — try rephrasing (beds, price, area)." }

  // The engagement ledger the recognition + preference rails already read.
  await svc.from("client_portal_activity").insert({
    contact_id: input.contactId,
    activity_type: "nl_property_search",
    metadata: { query },
  }).then(() => {}, () => {})

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
