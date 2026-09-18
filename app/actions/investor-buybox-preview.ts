"use server"

/**
 * app/actions/investor-buybox-preview.ts
 *
 * LISTING-CONCIERGE READER for lib/external/batchdata-mcp.ts::investorBuyboxPreview (wave 69
 * orphan-export wire-up — owner ruling verbatim: "scraping is not frozen so those six scraping
 * frozen orphan exports should not be blocked").
 *
 * lib/kernel/listings-batchdata-feed.ts::runBuyBoxMatchingForMarket already turns a listing's
 * Buy Box matches into raw BUYER leads (the autonomous, brokerage-wide sweep). This action is the
 * ON-DEMAND, CHEAP, no-charge COMPANION for a single listing's detail page: "how many investor
 * buyers currently match THIS listing?" — a preview sample count, never a billed page pull, and
 * never a substitute for the sweep's own ingest.
 *
 * AGENT/BROKERAGE-SIDE ONLY (CLAUDE.md §5 + wave 68 owner ruling: "these investors should not get
 * the owners information" — the symmetric fact holds here too: a BUYER must never see how many
 * OTHER investors are circling a listing, or any investor-identifying detail at all). Gated by
 * getAgentContext + tenant predicate on the listing read, same as every other listing-detail
 * server action in this file's sibling actions.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { isValidUUID } from "@/lib/validations"
import { investorBuyboxPreview } from "@/lib/external/batchdata-mcp"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"

export interface InvestorBuyboxPreviewResult {
  success: boolean
  matchedCount?: number
  unconfigured?: boolean
  error?: string
}

/**
 * On-demand preview: "N investor buyers matched" for one of THIS brokerage's own active listings.
 * A no-charge MCP sample — never the billed page pull (that stays inside the autonomous sweep,
 * runBuyBoxMatchingForMarket, which also now runs its own investorBuyboxCount pre-flight before
 * paying for a page). Never called for a listing this session's brokerage does not own.
 */
export async function getInvestorBuyboxPreviewForListing(params: {
  listingId: string
}): Promise<InvestorBuyboxPreviewResult> {
  if (!isValidUUID(params.listingId)) return { success: false, error: "Invalid listing ID" }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  try {
    const supabase = await createClient()
    // Tenant comes from the SESSION (CLAUDE.md §4) — the listing read is scoped to the acting
    // agent's own brokerage, never to a body/param-supplied id.
    const { data: listing, error } = await supabase
      .from("listings")
      .select("id, address, city, state, zip")
      .eq("id", params.listingId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (error) return { success: false, error: error.message }
    if (!listing) return { success: false, error: "Listing not found for this brokerage" }

    const preview = await investorBuyboxPreview({
      address: (listing as any).address, city: (listing as any).city,
      state: (listing as any).state, zip: (listing as any).zip,
    })
    // Metered even at zero marginal cost (repo convention — every outbound provider call
    // belongs in the vendor ledger, an unmetered egress path is not allowed).
    void logVendorUsage({
      vendorName: "batchdata", usageType: "investor_buybox_preview", unitCount: 1, estimatedCost: 0,
      systemSource: "listing_concierge_buybox_preview", brokerageId: ctx.brokerageId,
      metadata: { listing_id: params.listingId, matched: preview.ok ? preview.rows.length : null },
    }).catch(() => null)

    if (preview.unconfigured) return { success: false, unconfigured: true, error: "BatchData MCP is not configured" }
    if (!preview.ok) return { success: false, error: preview.error ?? "Buy Box preview failed" }
    return { success: true, matchedCount: preview.rows.length }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}
