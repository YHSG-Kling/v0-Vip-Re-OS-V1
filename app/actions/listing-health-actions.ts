"use server"

/**
 * Listing Health — agent-facing actions used by the listing detail page
 * to close the loop on the Active Listing Health Radar.
 *
 *   - rescanListingHealthAction({ listingId })         — on-demand rescan
 *   - resolveListingInterventionAction({ interventionId }) — clear an item
 *
 * Both reuse canonical infrastructure (listing_health_scores +
 * listing_health_interventions tables, calculateListingHealth scorer).
 * Mirrors the deal-health-actions pattern.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"
import { calculateListingHealth } from "@/lib/listing-health/health-scorer"

// ─── On-demand listing health rescan ────────────────────────────────────────

export async function rescanListingHealthAction(params: {
  listingId: string
}): Promise<{
  success:       boolean
  error?:        string
  overallScore?: number
  riskLevel?:    string
  scoreDelta?:   number | null
}> {
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // RLS confirms brokerage gating; we still bounce the request if the listing
  // doesn't resolve under the caller's auth scope.
  const { data: listing } = await supabase
    .from("listings")
    .select("id")
    .eq("id", params.listingId)
    .maybeSingle()
  if (!listing) return { success: false, error: "Listing not found" }

  try {
    const result = await calculateListingHealth({ listingId: params.listingId })
    revalidatePath(`/dashboard/listings/${params.listingId}`)
    return {
      success:      true,
      overallScore: result.overallScore,
      riskLevel:    result.riskLevel,
      scoreDelta:   result.scoreDelta,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Rescan failed",
    }
  }
}

// ─── Resolve a listing-health intervention ──────────────────────────────────

export async function resolveListingInterventionAction(params: {
  interventionId: string
  resolutionNote?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.interventionId)) {
    return { success: false, error: "Invalid intervention id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: row } = await supabase
    .from("listing_health_interventions")
    .select("id, listing_id, resolved")
    .eq("id", params.interventionId)
    .maybeSingle()
  if (!row) return { success: false, error: "Intervention not found" }
  if (row.resolved) return { success: true }  // idempotent

  const { error } = await supabase
    .from("listing_health_interventions")
    .update({
      resolved:        true,
      resolved_at:     new Date().toISOString(),
      resolved_by:     user.id,
      resolution_note: params.resolutionNote ?? null,
    })
    .eq("id", params.interventionId)

  if (error) return { success: false, error: error.message }

  if (row.listing_id) {
    revalidatePath(`/dashboard/listings/${row.listing_id}`)
  }
  return { success: true }
}
