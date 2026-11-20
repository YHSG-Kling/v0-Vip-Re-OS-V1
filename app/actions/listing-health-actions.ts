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

  // WAVE 155 (lane 155S1) — THE SAME GATE AS THE ROUTE'S MANUAL RESCAN (app/api/cron/listing-health-scan/route.ts POST,
  // commit 119ac6b4). This action relied on the row policy alone, which admits ANY agent of the tenant (not the listing's
  // own agent only). Now: the caller is the SESSION (requireCaller); the seat must be tenant staff (isCrmContactStaff —
  // lib/auth/crm-contact-staff.ts, the derived back-office roster; a vendor, lender, title or Contact seat is not tenant
  // staff); the listing is read through the SESSION client PINNED to the session's tenant; and an AGENT seat rescans only
  // its OWN listing (listings.agent_id is an agents.id, crossed from the session user through the canonical resolver — the id
  // spaces are disjoint, CLAUDE.md §3). Another tenant's listing, an unknown id and a listing the caller may not open all
  // answer the same "Listing not found"; a read that is refused refuses.
  const { requireCaller } = await import("@/lib/auth/require-caller")
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.reason === "unauthenticated" ? "Unauthorized" : caller.error }
  const { isCrmContactStaff } = await import("@/lib/auth/crm-contact-staff")
  if (!isCrmContactStaff(caller.userType)) return { success: false, error: "Listing not found" }
  const { data: listing, error: listingErr } = await caller.supabase
    .from("listings")
    .select("id, brokerage_id, agent_id")
    .eq("id", params.listingId)
    .eq("brokerage_id", caller.brokerageId)
    .maybeSingle()
  if (listingErr) return { success: false, error: "Your access to this listing could not be confirmed. Try again in a moment." }
  if (!listing) return { success: false, error: "Listing not found" }
  if (String(caller.userType).toLowerCase() === "agent") {
    const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
    const ownAgentId = await resolveUserIdToAgentRecord(caller.userId, caller.brokerageId)
    if (!ownAgentId || (listing as { agent_id?: string | null }).agent_id !== ownAgentId) return { success: false, error: "Listing not found" }
  }

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

  const write = async (): Promise<{ success: boolean; error?: string }> => {
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
  // WAVE 155 (155R14): the receipt — the SESSION's tenant (one read); a seat with no tenant runs exactly as before.
  const { data: callerRow } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!callerRow?.brokerage_id) return write()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId: callerRow.brokerage_id, action: "listing.health_intervention.resolve", actor: { type: "user", userId: user.id }, subject: { type: "listing_health_intervention", id: params.interventionId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { listing_id: row.listing_id ?? null } }, write)
}
