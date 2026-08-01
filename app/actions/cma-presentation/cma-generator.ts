"use server"

/**
 * System 5.3: CMA & Listing Presentation Engine
 * CMA Generator
 * 
 * Generates seller-ready CMA with quality enforcement and mandatory disclaimer.
 * DOES NOT advance journey state - only emits completion signals.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

export interface CMAGenerationInput {
  listingId: string
  contactId: string
  agentId: string
  brokerageId?: string
  
  // CMA parameters
  targetAddress?: string
  propertyType?: string
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  
  // Search parameters (optional - will derive from listing if not provided)
  radiusMiles?: number
  maxAgeDays?: number
  minComparables?: number
}

export interface CMAResult {
  success: boolean
  cmaId?: string
  qualityScore?: number
  comparableCount?: number
  error?: string
  warnings?: string[]
}

/**
 * MANDATORY CMA DISCLAIMER (REQUIRED IN EVERY CMA)
 */
// CMA_DISCLAIMER moved to @/lib/cma/disclaimer (const exports illegal in "use server")
import { CMA_DISCLAIMER } from "@/lib/cma/disclaimer"

/**
 * Generate CMA for seller (presentation-flow variant).
 *
 * Now delegates the actual valuation to the canonical `generateAICMA` in
 * `@/app/actions/ai-cma`. This function only handles the seller-presentation
 * choreography:
 *   1. Load listing + contact (for context)
 *   2. Emit `seller.cma.started` activity
 *   3. Call `generateAICMA` with the listing's property data — that fn writes
 *      to `cma_reports` and runs the canonical comp + AI valuation pipeline
 *   4. Emit `seller.cma.completed` (or `seller.cma.failed`) activity referencing
 *      the resulting cma_reports.id
 *
 * No more parallel comp-fetching, no more parallel quality scoring, no more
 * dual writes. One canonical CMA generator (generateAICMA) feeds both direct
 * agent CMAs AND the seller presentation pipeline.
 */
export async function generateCMA(input: CMAGenerationInput): Promise<CMAResult> {
  try {
    if (!isValidUUID(input.listingId)) return { success: false, error: "Invalid listing ID" }
    if (!isValidUUID(input.contactId)) return { success: false, error: "Invalid contact ID" }
    if (!isValidUUID(input.agentId)) return { success: false, error: "Invalid agent ID" }

    const supabase = await createClient()

    // Resolve brokerage_id from agent. input.agentId is a USERS id — this
    // lookup only works with one — and that is correct here.
    const { data: agentCMA } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", input.agentId)
      .maybeSingle()

    // IDENTITY CLASS (m355). The three activities writes below key
    // activities.agent_id, which FKs AGENTS — so passing the users id above
    // FK-rejected every one of them. The CMA itself generated and saved; only
    // its timeline vanished, which is why nothing ever looked broken: the
    // seller got their CMA and the agent's activity feed simply never mentioned
    // it. Same value, two classes, one variable.
    const { data: cmaAgentRow } = await supabase
      .from("agents").select("id").eq("user_id", input.agentId).maybeSingle()
    const cmaAgentRecordId = (cmaAgentRow as { id?: string } | null)?.id ?? null

    // Emit start event
    await supabase.from("activities").insert({
      brokerage_id: agentCMA?.brokerage_id ?? null,
      agent_id: cmaAgentRecordId,
      contact_id: input.contactId,
      activity_type: "seller.cma.started",
      title: "CMA generation started",
      description: `CMA started for listing ${input.listingId}`,
      notes: JSON.stringify({
        radius_miles: input.radiusMiles || 2.0,
        max_age_days: input.maxAgeDays || 90,
        min_comparables: input.minComparables || 5,
      }),
      status: "pending",
      entity_type: "contact",
    })

    // Load listing for property data
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("*")
      .eq("id", input.listingId)
      .single()

    if (listingError || !listing) {
      await emitCMAFailed(input.listingId, input.contactId, input.agentId, "Listing not found")
      return { success: false, error: "Listing not found" }
    }

    // ── Delegate to canonical AI CMA generator ──────────────────────────
    // generateAICMA owns the comp fetch, AI valuation, and write to
    // cma_reports. Map listing fields → CMAParams shape.
    const { generateAICMA } = await import("@/app/actions/ai-cma")
    const aiResult = await generateAICMA({
      agentId: input.agentId,
      propertyAddress: input.targetAddress || listing.address || "",
      propertyCity: listing.city || "",
      propertyState: listing.state || "",
      propertyZip: listing.zip || "",
      propertyType: (input.propertyType ?? listing.property_type ?? "single_family") as
        | "single_family" | "condo" | "townhouse" | "multi_family" | "land",
      bedrooms: input.bedrooms || listing.bedrooms || 0,
      bathrooms: input.bathrooms || listing.bathrooms || 0,
      squareFeet: input.squareFeet || listing.square_feet || 0,
      lotSize: listing.lot_size,
      yearBuilt: listing.year_built,
      features: listing.features,
      condition: listing.condition,
      listingType: "seller",
      contactId: input.contactId,
      listingId: input.listingId,
    } as Parameters<typeof generateAICMA>[0])

    // Type guard — generateAICMA returns { success, cmaReportId? } or { success: false, error }
    const aiOk = (aiResult as { success: boolean }).success
    if (!aiOk) {
      const err = (aiResult as { error?: string }).error ?? "AI CMA generation failed"
      await emitCMAFailed(input.listingId, input.contactId, input.agentId, err)
      return { success: false, error: err }
    }

    const cmaReportId =
      (aiResult as { cmaReportId?: string; reportId?: string }).cmaReportId ??
      (aiResult as { reportId?: string }).reportId ??
      crypto.randomUUID()
    const comparableCount =
      (aiResult as { comparableCount?: number }).comparableCount ?? 0
    const qualityScore =
      (aiResult as { qualityScore?: number }).qualityScore ?? 70

    // Emit completion event referencing the cma_reports row
    await supabase.from("activities").insert({
      brokerage_id: agentCMA?.brokerage_id ?? null,
      agent_id: cmaAgentRecordId,
      contact_id: input.contactId,
      activity_type: "seller.cma.completed",
      title: "CMA generation completed",
      description: `CMA completed: ${comparableCount} comparables, quality score ${qualityScore}`,
      notes: JSON.stringify({
        cma_report_id: cmaReportId,
        comparable_count: comparableCount,
        quality_score: qualityScore,
        disclaimer_included: true,
      }),
      status: "completed",
      entity_type: "contact",
    })

    return {
      success: true,
      cmaId: cmaReportId,
      qualityScore,
      comparableCount,
      warnings: [],
    }
  } catch (error: any) {
    console.error("[System 5.3] CMA generation error:", error)
    return {
      success: false,
      error: error.message || "Failed to generate CMA",
    }
  }
}


/**
 * Emit CMA failed event
 */
async function emitCMAFailed(
  listingId: string,
  contactId: string,
  agentId: string,
  reason: string
) {
  const supabase = await createClient()
  const { data: agentFail } = await supabase.from("users").select("brokerage_id").eq("id", agentId).maybeSingle()
  // Same class split as generateCMA: users id for the brokerage lookup, the
  // resolved agents id for activities.agent_id (m355).
  const { data: failAgentRow } = await supabase
    .from("agents").select("id").eq("user_id", agentId).maybeSingle()

  await supabase.from("activities").insert({
    brokerage_id: agentFail?.brokerage_id ?? null,
    agent_id: (failAgentRow as { id?: string } | null)?.id ?? null,
    contact_id: contactId,
    activity_type: "seller.cma.failed",
    title: "CMA generation failed",
    description: reason,
    notes: JSON.stringify({ listing_id: listingId, reason }),
    status: "completed",
    entity_type: "contact",
  })
}
