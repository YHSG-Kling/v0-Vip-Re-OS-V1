// lib/ads/creative-fatigue-runner.ts
//
// Live side of the Creative-Fatigue Monitor: persist each ad CTR snapshot into the time-series
// (ad_performance_history), and detect fatigue per campaign — when a creative's CTR has decayed,
// the Ads Manager proposes a GATED refresh (persona-generated recommendation on the inter-manager
// bus). No false alarms on thin data (the pure engine gates that). Read-only on the ad tables.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { computeEngagementDecay, type CtrPoint, type EngagementDecay } from "./ad-engagement-decay"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

export interface AdSnapshot {
  brokerageId: string
  adCampaignId?: string | null
  adCreativeId?: string | null
  ctr?: number | null
  impressions?: number | null
  clicks?: number | null
  leads?: number | null
  costPerLead?: number | null
}

/** Append one CTR/cost reading to the time-series (call alongside ingestAdPerformance). */
export async function recordAdPerformanceSnapshot(snap: AdSnapshot, client?: Svc): Promise<boolean> {
  const svc = client ?? createServiceClient()
  try {
    const { error } = await svc.from("ad_performance_history").insert({
      brokerage_id: snap.brokerageId, ad_campaign_id: snap.adCampaignId ?? null, ad_creative_id: snap.adCreativeId ?? null,
      ctr: snap.ctr ?? null, impressions: snap.impressions ?? null, clicks: snap.clicks ?? null,
      leads: snap.leads ?? null, cost_per_lead: snap.costPerLead ?? null,
    })
    return !error
  } catch { return false }
}

async function loadCtrSeries(svc: Svc, brokerageId: string, adCampaignId: string, sinceDays: number): Promise<CtrPoint[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const { data } = await svc.from("ad_performance_history")
    .select("captured_at, ctr").eq("brokerage_id", brokerageId).eq("ad_campaign_id", adCampaignId)
    .gte("captured_at", since).order("captured_at", { ascending: true }).limit(200)
  return ((data ?? []) as { captured_at: string; ctr: number | null }[])
    .filter((r) => r.ctr != null).map((r) => ({ capturedAt: r.captured_at, ctr: r.ctr as number }))
}

export interface FatigueResult { decay: EngagementDecay; flagged: boolean; signalId?: string }

/** Detect creative fatigue for one campaign and, on a high-risk decay, propose a gated refresh. */
export async function detectCreativeFatigue(
  input: { brokerageId: string; adCampaignId: string; campaignName?: string | null; copyGenerator?: CopyGenerator; escalate?: boolean; sinceDays?: number },
  client?: Svc,
): Promise<FatigueResult> {
  const svc = client ?? createServiceClient()
  const series = await loadCtrSeries(svc, input.brokerageId, input.adCampaignId, input.sinceDays ?? 21)
  const decay = computeEngagementDecay(series)

  if (decay.fatigueRisk !== "high" || input.escalate === false) return { decay, flagged: false }

  const fallback = `Ad ${input.campaignName ?? "campaign"} is fatigued — ${decay.reason}. Refresh the hook/visual and test a new variant before more spend.`
  const draft = await generatePersonaCopy(
    {
      goal: "a short note to the agent that this ad campaign's engagement is decaying and to approve a fresh creative variant",
      facts: [decay.reason, `Down ${Math.round(decay.dropPct * 100)}% from its opening CTR over ${decay.daysLive.toFixed(0)} days`],
      channel: "portal", persona: { audience: "agent", situation: "ad creative fatigue" }, words: 50,
    },
    { body: fallback }, { generator: input.copyGenerator },
  )

  let signalId: string | undefined
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: "ads_manager", toManager: "campaign_orchestrator",
      signalType: "creative_fatigue", message: draft.body,
      entityType: "ad_campaign", entityId: input.adCampaignId,
      payload: { dropPct: decay.dropPct, decayPerDay: decay.decayPerDay, daysLive: decay.daysLive },
    }, svc)
    signalId = sig.signalId
  } catch { /* best-effort */ }

  return { decay, flagged: true, signalId }
}
