/**
 * lib/contact-promotion/acquisition-cost.ts
 *
 * THE LIVE half of the lead-cost formula whose PURE half is
 * lib/lead-pipeline/source-conversion-learning.ts::computeLeadAcquisitionCost.
 * Called once, at conversion (lib/contact-promotion/contact-creator.ts), to
 * resolve and WRITE `leads.acquisition_cost` before it is carried onto the new
 * contact — "...and where they came from for lead cost tracking" (owner
 * ruling, wave 65).
 *
 * THREE SOURCES, each read tenant-scoped and best-effort (a refused/absent
 * read degrades that part to null, never to a fabricated zero — see the pure
 * formula's header):
 *
 *   1. costPerRecord    — already on the lead row (leads.cost_per_record),
 *                          passed in, not re-fetched.
 *   2. enrichmentSpend   — SUM(vendor_usage_tracking.total_cost) WHERE lead_id
 *                          = this lead. trackVendorUsageService
 *                          (lib/vendor-governance/track-vendor-usage.ts) is the
 *                          one writer that stamps lead_id — see
 *                          lib/lead-pipeline/enrichment-orchestrator.ts:690-696.
 *   3. campaignCostShare — ad_campaigns.lifetime_budget for this lead's
 *                          campaign_attribution_id, split evenly across every
 *                          OTHER lead in the same brokerage sharing that same
 *                          campaign id. Best-effort and approximate by
 *                          construction (an even split, not a click-weighted
 *                          one) — there is no per-lead attribution column on
 *                          ad_campaigns to do better, and an approximate share
 *                          beats an omitted one for a campaign-sourced lead.
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
  acquisitionCost: number | null
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

  // ── 1. Enrichment spend — vendor_usage_tracking keyed on THIS lead_id ─────
  try {
    const { data, error } = await supabase
      .from("vendor_usage_tracking")
      .select("total_cost")
      .eq("lead_id", input.leadId)
    if (error) {
      warnings.push(`enrichment spend not read (vendor_usage_tracking): ${error.message}`)
    } else {
      const rows = (data ?? []) as Array<{ total_cost: number | null }>
      if (rows.length > 0) {
        enrichmentSpend = rows.reduce((sum, r) => sum + (r.total_cost ?? 0), 0)
      }
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

  const { computeLeadAcquisitionCost } = await import("@/lib/lead-pipeline/source-conversion-learning")
  const acquisitionCost = computeLeadAcquisitionCost({
    costPerRecord: input.costPerRecord,
    enrichmentSpend,
    campaignCostShare,
  })

  return { acquisitionCost, enrichmentSpend, campaignCostShare, warnings }
}
