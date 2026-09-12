"use server"

/**
 * app/actions/mls-check.ts
 *
 * The agent-facing door onto lib/listings/mls-rule-check.ts. That validator's
 * own header (:19-21) promises every rule returns "a fixHint the UI can render
 * directly" — and until this action + the MlsCheckPanel on the listing
 * lifecycle page, no UI rendered any of it; the sole consumer was
 * POST /api/listings/mls-check, a route nothing in the tree addressed. Built
 * per CLAUDE.md §1.2: the capability is wanted (it heads off the 24-48h MLS
 * resubmit cycle), no duplicate surface exists, so the missing half is built.
 *
 * Session-gated and tenancy-checked exactly like the route (:18, :40-42): the
 * listing must belong to the caller's session brokerage, and a listing outside
 * it reads as "not found" — never as another tenant's data. Every read
 * destructures { data, error } and a refused read is reported, not rendered as
 * a clean check (§3/§4 — a gate that cannot run must refuse).
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import {
  checkMlsRules,
  type MlsRuleCheckResult,
} from "@/lib/listings/mls-rule-check"

export type MlsCheckActionResult =
  | { ok: true; result: MlsRuleCheckResult; checkedAt: string }
  | { ok: false; error: string }

export async function runMlsRuleCheck(
  listingId: string,
): Promise<MlsCheckActionResult> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not signed in." }
  // §4: the tenant comes from the SESSION. No brokerage → no scope to read under.
  if (!ctx.brokerageId) {
    return { ok: false, error: "Your session has no brokerage — the check cannot be scoped." }
  }
  if (!listingId?.trim()) return { ok: false, error: "Missing listing id." }

  const supabase = await createClient()

  // Structural fields live on listings. Unlike the route (which needed callers
  // to pass overrides), the columns this page already renders — public_remarks,
  // property_type, year_built — exist on the live listings table (the lifecycle
  // page selects them), so the fair-housing and remarks-length rules run
  // against the real copy the MLS would see.
  const { data: listing, error: listingErr } = await supabase
    .from("listings")
    .select(
      "id, brokerage_id, list_price, bedrooms, bathrooms, sqft, year_built, property_type, public_remarks, showing_instructions",
    )
    .eq("id", listingId)
    .maybeSingle()

  if (listingErr) {
    return { ok: false, error: `Listing read was refused: ${listingErr.message}` }
  }
  // Tenancy check, same shape as the route's :40-42 — outside-tenant is
  // indistinguishable from absent.
  if (!listing || listing.brokerage_id !== ctx.brokerageId) {
    return { ok: false, error: "Listing not found." }
  }

  const { count: photoCount, error: photoErr } = await supabase
    .from("listing_media")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listing.id)
    .eq("media_type", "photo")

  if (photoErr) {
    // A refused count must not run the photo-minimum rule against a phantom 0 —
    // that would accuse a fully-photographed listing of having none.
    return { ok: false, error: `Photo count read was refused: ${photoErr.message}` }
  }

  const result = checkMlsRules({
    // No per-board MLS code is stored on listings — the per-MLS registry rules
    // (NWMLS/BRIGHT) only run when a board code is known. Universal + common
    // rules always run.
    mlsCode: null,
    listPrice: listing.list_price,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    sqft: listing.sqft,
    sqftSource: null,
    yearBuilt: (listing as { year_built?: number | null }).year_built ?? null,
    propertyType: (listing as { property_type?: string | null }).property_type ?? null,
    description: null,
    publicRemarks: (listing as { public_remarks?: string | null }).public_remarks ?? null,
    photoCount: photoCount ?? 0,
    hasVirtualTour: false,
    schoolDistrict: null,
    showsSchoolNames: /\bschool\b/i.test((listing as { public_remarks?: string | null }).public_remarks ?? ""),
    lockboxType: null,
    showingInstructions: listing.showing_instructions,
  })

  return { ok: true, result, checkedAt: new Date().toISOString() }
}
