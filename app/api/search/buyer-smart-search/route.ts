// app/api/search/buyer-smart-search/route.ts
//
// The buyer portal's natural-language property search endpoint. SmartSearchWidget GETs
// /api/search/buyer-smart-search?q=...&contact_id=... and renders the returned cards. The route is a
// thin, auth-gated adapter: it runs the NL search (searchPropertiesWithNaturalLanguage — the gate lives
// inside it), attaches the buyer's existing saved/dismissed state from the live saved_properties table,
// and maps to the widget's card shape via the pure toPortalCards. No business logic here.

import { NextResponse } from "next/server"
import { searchPropertiesWithNaturalLanguage } from "@/app/actions/buyer-property-search"
import { createServiceClient } from "@/lib/supabase/service"
import { toPortalCards, savedRowToInterest, type PortalInterestLevel } from "@/lib/buyer-search/portal-cards"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get("q") ?? "").trim()
  const contactId = (searchParams.get("contact_id") ?? "").trim()

  if (!contactId) return NextResponse.json({ error: "contact_id required" }, { status: 400 })
  if (q.length < 5) return NextResponse.json({ results: [], total: 0 })

  // The action auth-gates (buyer-self or same-brokerage staff) before touching any data.
  const res = await searchPropertiesWithNaturalLanguage({ contactId, naturalLanguageQuery: q, options: { limit: 24 } })
  if (!res.success) {
    const status = res.error === "Unauthorized" ? 401 : res.error === "Forbidden" ? 403 : 400
    return NextResponse.json({ error: res.error ?? "Search failed" }, { status })
  }

  const results = (res as any).results ?? []

  // Attach the buyer's current interest from the live saved_properties table (read-only).
  const interestByListing: Record<string, PortalInterestLevel> = {}
  try {
    const ids = results.map((r: any) => r.listing_id).filter(Boolean)
    if (ids.length > 0) {
      const svc = createServiceClient()
      const { data: saved } = await svc
        .from("saved_properties")
        .select("listing_id, dismissed, added_to_tour")
        .eq("contact_id", contactId)
        .in("listing_id", ids)
      for (const row of (saved ?? []) as Array<{ listing_id: string | null; dismissed: boolean | null; added_to_tour: boolean | null }>) {
        if (row.listing_id) interestByListing[row.listing_id] = savedRowToInterest(row)
      }
    }
  } catch {
    // best-effort — the widget also tracks optimistic state client-side
  }

  const cards = toPortalCards(results, interestByListing)
  return NextResponse.json({ results: cards, total: cards.length })
}
