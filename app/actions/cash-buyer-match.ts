"use server"

/**
 * Cash-Buyer Disposition Match — agent-facing actions for the listing detail page.
 *   - findCashBuyersAction({ listingId })  — source + rank nearby cash investors for a hard listing
 *   - getCashBuyerMatchAction({ listingId }) — read the persisted match for display
 *
 * The heavy lifting (BatchData investor-buybox + ranking + persist) lives in the runner; these wrap it
 * with auth + brokerage scope. Provider-gated: when BatchData isn't configured the action returns an
 * honest "not available" instead of a fabricated list. Nothing auto-sends — the match is intelligence
 * the agent reviews before staging any outreach.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"
import { runCashBuyerMatch, getCashBuyerMatch } from "@/lib/disposition/cash-buyer-match-runner"
import type { SubjectProperty } from "@/lib/disposition/investor-match"

async function loadScopedListing(listingId: string) {
  if (!isValidUUID(listingId)) return { listing: null as any, error: "Invalid listing id" as const }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { listing: null as any, error: "Unauthorized" as const }
  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id, address, city, state, zip, bedrooms, bathrooms, sqft, year_built, property_type")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return { listing: null as any, error: "Listing not found" as const }
  return { listing, error: null }
}

export async function findCashBuyersAction(params: {
  listingId: string
}): Promise<{ success: boolean; reason?: string; candidateCount?: number; qualifiedCount?: number; error?: string }> {
  const { listing, error } = await loadScopedListing(params.listingId)
  if (!listing) return { success: false, error: error ?? undefined }
  if (!listing.address) return { success: false, error: "Listing has no street address to match on" }

  const subject: SubjectProperty = {
    street: listing.address,
    city: listing.city ?? null,
    state: listing.state ?? null,
    zip: listing.zip ?? null,
    bedrooms: listing.bedrooms ?? null,
    bathrooms: listing.bathrooms ?? null,
    livingAreaSqft: listing.sqft ?? null,
    yearBuilt: listing.year_built ?? null,
    propertyTypeDetail: listing.property_type ?? null,
  }

  const result = await runCashBuyerMatch(createServiceClient() as any, {
    brokerageId: listing.brokerage_id,
    listingId: listing.id,
    subject,
  })
  revalidatePath(`/dashboard/listings/${params.listingId}`)

  if (!result.ok) {
    const why: Record<string, string> = {
      provider_unconfigured: "Cash-buyer sourcing (BatchData) isn't connected yet — add the BatchData MCP credentials to enable it.",
      provider_error: "Couldn't reach the cash-buyer data source right now. Try again shortly.",
      no_subject: "Listing is missing the address details needed to find matching investors.",
    }
    return { success: false, reason: result.reason, error: why[result.reason] ?? "No match produced." }
  }
  return { success: true, reason: result.reason, candidateCount: result.candidateCount, qualifiedCount: result.qualifiedCount }
}

export async function getCashBuyerMatchAction(params: {
  listingId: string
}): Promise<{ success: boolean; match?: any; error?: string }> {
  const { listing, error } = await loadScopedListing(params.listingId)
  if (!listing) return { success: false, error: error ?? undefined }
  const match = await getCashBuyerMatch(createServiceClient() as any, { listingId: listing.id, brokerageId: listing.brokerage_id })
  return { success: true, match }
}
