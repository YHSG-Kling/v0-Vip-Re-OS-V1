/**
 * lib/ads/ad-outcome-loop.ts
 *
 * THE AD OUTCOME LOOP — the first channel where creative, and budget are
 * driven by the ledger instead of regenerated from first principles every
 * week (the owner-approved pattern: every delivery decision is PROVEN —
 * learned from our own outcomes, with honest floors when evidence is thin).
 * Listing ads go first deliberately: the outcome cycle is days (spend →
 * clicks → consented ad-form leads → CPL), the ledgers already exist
 * (ad_performance snapshots, ad_performance_history per-creative
 * time-series, ad_lead_intake consent contacts), and what was missing is
 * exactly the two control pieces:
 *
 *   1. FEEDBACK-CONDITIONED GENERATION — the next creative leans on the
 *      proven winner: learnedCreativeEmphasis surfaces the best-performing
 *      variation (experiment-gated: real spend/impressions per arm, >25%
 *      lift) and the producer records the decision in
 *      ad_creative_variations.generated_from ('learned:<arm>' vs 'norm')
 *      so the flywheel is auditable like decidedBy/built_by everywhere else.
 *   2. DISTRIBUTION INTELLIGENCE — budget follows CPL: when one live
 *      campaign's cost-per-lead runs ≥2× another's on real spend, the Ads
 *      Manager proposes a GATED rebalance on the inter-manager bus (money
 *      moves only through a human, same governance as every client send).
 *
 * Nothing here spends or publishes — it reads ledgers, conditions the next
 * generation, and raises gated proposals. ads_manager owns the loop.
 */
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

export interface CreativeArmSample {
  arm: string
  spend: number
  impressions: number
  clicks: number
  leads: number
}

/** PURE: the experiment gate. An arm is READ (≥800 impressions or ≥$50
 *  spend); a winner needs ≥2 read arms and a >25% lift on the score —
 *  leads-per-$100 when the arms have real lead volume, CTR otherwise.
 *  Thin or ambiguous evidence returns null (the norm stands). */
export function decideWinningArm(samples: CreativeArmSample[]): { arm: string; basis: "cpl" | "ctr" } | null {
  const read = samples.filter((s) => s.impressions >= 800 || s.spend >= 50)
  if (read.length < 2) return null
  const totalLeads = read.reduce((s, x) => s + x.leads, 0)
  const useLeads = totalLeads >= 6 && read.every((s) => s.spend > 0)
  const score = (s: CreativeArmSample) =>
    useLeads ? (s.leads / s.spend) * 100 : s.impressions > 0 ? s.clicks / s.impressions : 0
  const ranked = [...read].sort((a, b) => score(b) - score(a))
  const [best, second] = ranked
  if (!best || !second) return null
  const bs = score(best), ss = score(second)
  if (bs <= 0) return null
  if (bs > ss * 1.25) return { arm: best.arm, basis: useLeads ? "cpl" : "ctr" }
  return null
}

/** Aggregate the per-creative time-series into variation arms for a
 *  brokerage (last 90 days), then run the experiment gate. Returns the
 *  winning variation row (headline/text as the style exemplar) or null. */
export async function learnedCreativeEmphasis(
  svc: any,
  brokerageId: string,
): Promise<{ arm: string; headline: string | null; primaryText: string | null; basis: string } | null> {
  try {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const { data: hist } = await svc.from("ad_performance_history")
      .select("ad_creative_id, impressions, clicks, leads, cost_per_lead")
      .eq("brokerage_id", brokerageId).gte("captured_at", since)
      .not("ad_creative_id", "is", null).limit(2000)
    const rows = (hist ?? []) as Array<{ ad_creative_id: string; impressions: number | null; clicks: number | null; leads: number | null; cost_per_lead: number | null }>
    if (rows.length === 0) return null

    const creativeIds = Array.from(new Set(rows.map((r) => r.ad_creative_id)))
    const { data: creatives } = await svc.from("ad_creative_variations")
      .select("id, variation_name, headline, primary_text")
      .in("id", creativeIds)
    const byId = new Map(((creatives ?? []) as Array<{ id: string; variation_name: string | null; headline: string | null; primary_text: string | null }>).map((c) => [c.id, c]))

    const arms = new Map<string, CreativeArmSample>()
    for (const r of rows) {
      const c = byId.get(r.ad_creative_id)
      if (!c) continue
      const arm = c.variation_name ?? "unnamed"
      const agg = arms.get(arm) ?? { arm, spend: 0, impressions: 0, clicks: 0, leads: 0 }
      agg.impressions += Number(r.impressions) || 0
      agg.clicks += Number(r.clicks) || 0
      agg.leads += Number(r.leads) || 0
      // spend approximated from CPL × leads when the series carries it
      if (r.cost_per_lead && r.leads) agg.spend += Number(r.cost_per_lead) * Number(r.leads)
      arms.set(arm, agg)
    }
    const winner = decideWinningArm([...arms.values()])
    if (!winner) return null
    const exemplar = ((creatives ?? []) as any[]).find((c) => (c.variation_name ?? "unnamed") === winner.arm)
    return {
      arm: winner.arm,
      headline: exemplar?.headline ?? null,
      primaryText: exemplar?.primary_text ?? null,
      basis: winner.basis,
    }
  } catch {
    return null
  }
}

export interface CampaignCplRow {
  campaignId: string
  campaignName: string | null
  spend: number
  leads: number
}

/** PURE: the rebalance decision. Both campaigns need real spend (≥$50) and
 *  the worst CPL must run ≥2× the best (or spend with ZERO leads against a
 *  producing sibling) before a proposal is worth a human's time. */
export function decideBudgetRebalance(rows: CampaignCplRow[]): { fromCampaignId: string; toCampaignId: string; reason: string } | null {
  const read = rows.filter((r) => r.spend >= 50)
  if (read.length < 2) return null
  const cpl = (r: CampaignCplRow) => (r.leads > 0 ? r.spend / r.leads : Number.POSITIVE_INFINITY)
  const ranked = [...read].sort((a, b) => cpl(a) - cpl(b))
  const best = ranked[0], worst = ranked[ranked.length - 1]
  if (best.campaignId === worst.campaignId) return null
  if (best.leads === 0) return null
  const bestCpl = cpl(best), worstCpl = cpl(worst)
  if (worstCpl === Number.POSITIVE_INFINITY) {
    return {
      fromCampaignId: worst.campaignId, toCampaignId: best.campaignId,
      reason: `"${worst.campaignName ?? "campaign"}" has spent $${Math.round(worst.spend)} with zero leads while "${best.campaignName ?? "campaign"}" produces at $${bestCpl.toFixed(0)}/lead`,
    }
  }
  if (worstCpl >= bestCpl * 2) {
    return {
      fromCampaignId: worst.campaignId, toCampaignId: best.campaignId,
      reason: `"${worst.campaignName ?? "campaign"}" runs at $${worstCpl.toFixed(0)}/lead vs $${bestCpl.toFixed(0)}/lead on "${best.campaignName ?? "campaign"}" (${(worstCpl / bestCpl).toFixed(1)}x)`,
    }
  }
  return null
}

/** GATED distribution intelligence: budget-shift proposals ride the
 *  inter-manager bus — a human approves before any money moves. One open
 *  proposal per (from,to) pair (dedup via the signal payload). */
export async function proposeBudgetRebalance(svc: any, brokerageId: string): Promise<{ proposed: boolean }> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: campaigns } = await svc.from("ad_campaigns")
    .select("id, campaign_name")
    .eq("brokerage_id", brokerageId).eq("status", "live").limit(50)
  const rows: CampaignCplRow[] = []
  for (const c of ((campaigns ?? []) as Array<{ id: string; campaign_name: string | null }>)) {
    const { data: perf } = await svc.from("ad_performance")
      .select("spend, leads")
      .eq("ad_campaign_id", c.id).gte("captured_at", since).limit(200)
    const spend = ((perf ?? []) as any[]).reduce((s, p) => s + (Number(p.spend) || 0), 0)
    const leads = ((perf ?? []) as any[]).reduce((s, p) => s + (Number(p.leads) || 0), 0)
    rows.push({ campaignId: c.id, campaignName: c.campaign_name, spend, leads })
  }
  const decision = decideBudgetRebalance(rows)
  if (!decision) return { proposed: false }

  // Dedup: an unactioned rebalance for the same pair inside 14 days stands.
  const dedupSince = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data: dup } = await svc.from("manager_signals")
    .select("id")
    .eq("brokerage_id", brokerageId).eq("signal_type", "budget_rebalance")
    .contains("payload", { from_campaign_id: decision.fromCampaignId, to_campaign_id: decision.toCampaignId })
    .gte("created_at", dedupSince).limit(1).maybeSingle()
  if (dup) return { proposed: false }

  await publishManagerSignal({
    brokerageId, fromManager: "ads_manager", toManager: "campaign_orchestrator",
    signalType: "budget_rebalance",
    message: `Budget follows performance: ${decision.reason}. Approve shifting daily budget from the lagging campaign to the producer.`,
    entityType: "ad_campaign", entityId: decision.toCampaignId,
    payload: { from_campaign_id: decision.fromCampaignId, to_campaign_id: decision.toCampaignId, reason: decision.reason },
  }, svc)
  return { proposed: true }
}

/** The weekly loop pass per brokerage with live campaigns. */
export async function runAdOutcomeLoop(svc: any): Promise<{ rebalancesProposed: number; loopErrors: number }> {
  const out = { rebalancesProposed: 0, loopErrors: 0 }
  const { data: rows } = await svc.from("ad_campaigns")
    .select("brokerage_id").eq("status", "live").limit(1000)
  const brokerages = Array.from(new Set(((rows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))
  for (const brokerageId of brokerages) {
    try {
      const r = await proposeBudgetRebalance(svc, brokerageId)
      if (r.proposed) out.rebalancesProposed++
    } catch { out.loopErrors++ }
  }
  return out
}
