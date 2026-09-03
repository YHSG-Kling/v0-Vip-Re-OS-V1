import { createServiceClient } from "@/lib/supabase/service"
import { RAW_PROCESSING_STATUSES } from "@/lib/lead-pipeline/processing-status"

/**
 * Raw-lead pipeline statistics — THE ONE COMPUTATION behind two doors.
 *
 * Before this module the queries lived inline in the GET handler of
 * app/api/leads/process-pipeline/route.ts and nothing in the app rendered them:
 * the route was a complete, well-gated answer with no in-tree reader. The Lead
 * Intake Cockpit (./page.tsx) is a SERVER component and can call this directly,
 * so it does — an in-process call, not a same-origin self-fetch that would have
 * to forward cookies to its own API. The route keeps wrapping this same function
 * as the external door, behind the same two gates it always had.
 *
 * NO GATE HERE, ON PURPOSE. Both callers gate first (the route through
 * requireBrokerAuth + resolveLeadVisibility, the page through isAdminOrBroker +
 * resolveLeadVisibility) and both REFUSE a true team scope: raw_scraped_leads
 * has no agent linkage, so these totals are brokerage-level and cannot be
 * narrowed to a team. This module reads on the service client and trusts the
 * brokerageId it is handed, so it must only ever be handed a SESSION-resolved
 * one (CLAUDE.md §4).
 *
 * Two corrections carried over from the inline version:
 *   · by-status counts iterate the ONE vocabulary (RAW_PROCESSING_STATUSES)
 *     rather than a hand-copied five-value subset — the drift
 *     lib/lead-pipeline/processing-status.ts exists to end.
 *   · `duplicates_found` is scoped to the brokerage. The inline count had NO
 *     tenant predicate and reported every tenant's dedup skips to whoever asked.
 *   · every count reads its `error` (§3): a refused count used to resolve as
 *     `count: null` → 0, indistinguishable from an empty bench.
 */
export interface RawPipelineStats {
  raw_scraped_leads: { total: number } & Record<string, number>
  deduplication: { duplicates_found: number }
  vendor_costs: Record<string, number>
}

export async function loadRawPipelineStats(
  brokerageId: string,
): Promise<{ ok: true; stats: RawPipelineStats } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "No brokerage context" }
  const supabase = createServiceClient()

  const countRaw = (status?: string) => {
    let q = supabase
      .from("raw_scraped_leads")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
    if (status) q = q.eq("processing_status", status)
    return q
  }

  const [totalRes, dupRes, vendorRes, ...statusRes] = await Promise.all([
    countRaw(),
    // Deduplication skips logged during the dedup gates — THIS tenant's only.
    supabase
      .from("lead_deduplication_log")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("action_taken", "skipped"),
    supabase
      .from("vendor_usage_tracking")
      .select("vendor_name, total_cost")
      .eq("brokerage_id", brokerageId),
    ...RAW_PROCESSING_STATUSES.map((s) => countRaw(s)),
  ])

  const refused = [totalRes, dupRes, vendorRes, ...statusRes].find((r) => r.error)
  if (refused?.error) return { ok: false, error: refused.error.message }

  const byStatus: Record<string, number> = {}
  RAW_PROCESSING_STATUSES.forEach((s, i) => { byStatus[s] = statusRes[i].count ?? 0 })

  const costsByVendor: Record<string, number> = {}
  for (const v of (vendorRes.data ?? []) as Array<{ vendor_name: string; total_cost: number | string | null }>) {
    costsByVendor[v.vendor_name] = (costsByVendor[v.vendor_name] || 0) + Number(v.total_cost ?? 0)
  }

  return {
    ok: true,
    stats: {
      raw_scraped_leads: { total: totalRes.count ?? 0, ...byStatus },
      deduplication: { duplicates_found: dupRes.count ?? 0 },
      vendor_costs: costsByVendor,
    },
  }
}
