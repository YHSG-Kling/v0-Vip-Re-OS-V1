/**
 * lib/contact-promotion/acquisition-cost.ts
 *
 * THE LIVE half of the lead-cost formula whose PURE half is
 * lib/lead-pipeline/source-conversion-learning.ts::computeLeadAcquisitionCost.
 * Called once, at conversion (lib/contact-promotion/contact-creator.ts), to
 * resolve and WRITE `leads.acquisition_cost` (TENANT-paid only — lane 88B, below) before it is
 * carried onto the new contact — "...and where they came from for lead cost tracking" (owner
 * ruling, wave 65).
 *
 * THREE SOURCES, each read tenant-scoped and best-effort (a refused/absent
 * read degrades that part to null, never to a fabricated zero — see the pure
 * formula's header):
 *
 *   1. costPerRecord    — already on the lead row (leads.cost_per_record),
 *                          passed in, not re-fetched.
 *   2. enrichmentSpend   — SUM(vendor_usage_tracking.total_cost) booked for this
 *                          person before conversion: the lead_id column plus
 *                          the raw rows the lead came from
 *                          (request_metadata.rawRecordId). Writers name the
 *                          person through meterVendorSpend's `attribution`
 *                          (lane 87F); the one reader is
 *                          lib/lead-intelligence/person-spend.ts.
 *   3. campaignCostShare — ad_campaigns.lifetime_budget for this lead's
 *                          campaign_attribution_id, split evenly across every
 *                          OTHER lead in the same brokerage sharing that same
 *                          campaign id. Best-effort and approximate by
 *                          construction (an even split, not a click-weighted
 *                          one) — there is no per-lead attribution column on
 *                          ad_campaigns to do better, and an approximate share
 *                          beats an omitted one for a campaign-sourced lead.
 *
 * WHO PAID (lane 88B, wave 88 — owner verbatim: "spend should be what the tenant spent for that
 * lead, not what was included in their subscription like raw lead acquisition, enrichment which are
 * platform paid."). Parts 1 and 2 are PLATFORM-paid (lib/providers/tenancy-matrix.ts: scrapers and
 * enrichment vendors are platform_metered); part 3 is the TENANT's own ad spend. So:
 *   acquisitionCost  = TENANT-paid only (computeLeadAcquisitionCost) — the figure written to
 *                      leads/contacts.acquisition_cost and shown on every tenant surface;
 *   platformPaidCost = raw acquisition + enrichment (computePlatformPaidLeadCost) — returned for the
 *                      caller's log / platform view, NEVER written onto the tenant's lead cost.
 * Until this lane the three were summed into acquisition_cost, and contact-creator fell back to
 * cost_per_record when it was null — both put the platform's bill on the tenant's lead.
 *
 * NEVER THROWS. A cost that cannot be resolved is a null part, not a broken
 * conversion — this runs inside createContactFromLead's critical path.
 */

export interface AcquisitionCostInput {
  leadId: string
  brokerageId: string | null
  costPerRecord: number | null | undefined
  campaignAttributionId: string | null | undefined
}

export interface AcquisitionCostResult {
  /** TENANT-paid acquisition cost (lane 88B) — the only figure a tenant surface may show. */
  acquisitionCost: number | null
  /** PLATFORM-paid raw acquisition + enrichment — platform view only, never the tenant's lead cost. */
  platformPaidCost: number | null
  enrichmentSpend: number | null
  campaignCostShare: number | null
  warnings: string[]
}

export async function resolveLeadAcquisitionCost(
  supabase: any,
  input: AcquisitionCostInput,
): Promise<AcquisitionCostResult> {
  const warnings: string[] = []
  let enrichmentSpend: number | null = null
  let campaignCostShare: number | null = null

  // ── 1. Enrichment spend — every vendor_usage_tracking row booked for THIS person ─────
  // Lane 87F: was `.eq("lead_id", leadId)` alone, which saw only the $0 osint_free rows — no
  // meterVendorSpend booking ever set lead_id, and raw-stage spend (the PeopleData match bought before
  // the lead existed) was keyed on nothing. Now ONE reader (lib/lead-intelligence/person-spend.ts)
  // folds the lead_id column AND the raw rows this lead came from (request_metadata.rawRecordId).
  // Contact-keyed spend is AFTER conversion by definition and is not part of acquisition.
  try {
    const { resolvePersonRawRecordIds, readPersonVendorSpend } = await import("@/lib/lead-intelligence/person-spend")
    const lineage = await resolvePersonRawRecordIds(supabase, { leadIds: [input.leadId], brokerageId: input.brokerageId })
    warnings.push(...lineage.warnings.map((w) => `enrichment spend: ${w}`))
    const spend = await readPersonVendorSpend(supabase, {
      brokerageId: input.brokerageId, leadIds: [input.leadId], rawRecordIds: lineage.rawRecordIds, contactId: null,
    })
    warnings.push(...spend.warnings.map((w) => `enrichment spend not fully read: ${w}`))
    if (spend.rows.length > 0) {
      enrichmentSpend = Math.round(spend.rows.reduce((sum, r) => sum + r.costUsd, 0) * 100) / 100
    }
  } catch (e: any) {
    warnings.push(`enrichment spend read threw: ${e?.message ?? "unknown error"}`)
  }

  // ── 2. Campaign cost share — ad_campaigns.lifetime_budget ÷ leads sharing it ─
  if (input.campaignAttributionId && input.brokerageId) {
    try {
      const { data: campaign, error: campaignError } = await supabase
        .from("ad_campaigns")
        .select("lifetime_budget, daily_budget")
        .eq("id", input.campaignAttributionId)
        .eq("brokerage_id", input.brokerageId)
        .maybeSingle()
      if (campaignError) {
        warnings.push(`campaign cost share not read (ad_campaigns): ${campaignError.message}`)
      } else if (campaign) {
        const budget = (campaign as { lifetime_budget: number | null }).lifetime_budget
        if (typeof budget === "number" && budget > 0) {
          const { count, error: countError } = await supabase
            .from("leads")
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", input.brokerageId)
            .eq("campaign_attribution_id", input.campaignAttributionId)
          if (countError) {
            warnings.push(`campaign lead count not read: ${countError.message}`)
          } else {
            const denominator = Math.max(1, count ?? 1)
            campaignCostShare = Math.round((budget / denominator) * 100) / 100
          }
        }
        // No lifetime_budget (daily-budget-only campaign): an even per-day
        // share is not derivable without a flight-length figure this table
        // does not carry — left null (unresolved) rather than guessed.
      }
    } catch (e: any) {
      warnings.push(`campaign cost share read threw: ${e?.message ?? "unknown error"}`)
    }
  }

  const { computeLeadAcquisitionCost, computePlatformPaidLeadCost } = await import("@/lib/lead-pipeline/source-conversion-learning")
  const parts = { costPerRecord: input.costPerRecord, enrichmentSpend, campaignCostShare }
  const acquisitionCost = computeLeadAcquisitionCost(parts)
  const platformPaidCost = computePlatformPaidLeadCost(parts)

  return { acquisitionCost, platformPaidCost, enrichmentSpend, campaignCostShare, warnings }
}
