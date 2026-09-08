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
    // The refusal used to be swallowed into `false` with no message — a PGRST204
    // (absent column) and an RLS refusal were indistinguishable from each other
    // and from a network blip. Name it.
    if (error) console.error("[creative-fatigue-runner] ad_performance_history insert refused:", error.message)
    return !error
  } catch (e) {
    console.error("[creative-fatigue-runner] ad_performance_history insert threw:", (e as Error).message)
    return false
  }
}

async function loadCtrSeries(svc: Svc, brokerageId: string, adCampaignId: string, sinceDays: number): Promise<CtrPoint[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const { data } = await svc.from("ad_performance_history")
    .select("captured_at, ctr").eq("brokerage_id", brokerageId).eq("ad_campaign_id", adCampaignId)
    .gte("captured_at", since).order("captured_at", { ascending: true }).limit(200)
  return ((data ?? []) as { captured_at: string; ctr: number | null }[])
    .filter((r) => r.ctr != null).map((r) => ({ capturedAt: r.captured_at, ctr: r.ctr as number }))
}

export interface FatigueResult { decay: EngagementDecay; flagged: boolean; signalId?: string; refreshCreativeId?: string }

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

  // THE REFRESH ITSELF (was a writer with no reader): the feed message told the
  // agent to "approve a fresh creative variant" but nothing ever generated one —
  // the fatigue alert was pure narration with no actionable draft behind it.
  // Stage the replacement creative the same way proposeCompetitorInspiredCreative
  // (lib/ads/ad-creative-engine.ts) does — AI gateway + a Fair-Housing-safe
  // deterministic fallback — landing as a DRAFT in the SAME ad_creative approval
  // queue a human already reviews.
  let refreshCreativeId: string | undefined
  try {
    const refresh = await proposeFatigueRefreshCreative(input.brokerageId, input.adCampaignId, input.campaignName ?? null, decay, svc)
    refreshCreativeId = refresh.creativeId
  } catch (e) {
    console.error("[creative-fatigue-runner] refresh proposal failed:", (e as Error).message)
  }

  let signalId: string | undefined
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: "ads_manager", toManager: "campaign_orchestrator",
      signalType: "creative_fatigue", message: draft.body,
      entityType: "ad_campaign", entityId: input.adCampaignId,
      payload: { dropPct: decay.dropPct, decayPerDay: decay.decayPerDay, daysLive: decay.daysLive, refresh_creative_id: refreshCreativeId ?? null },
    }, svc)
    signalId = sig.signalId
  } catch { /* best-effort */ }

  return { decay, flagged: true, signalId, refreshCreativeId }
}

export interface GeneratedFatigueCreative { variationName: string; headline: string; primaryText: string; description: string; callToAction: string }
export interface FatigueRefreshResult { proposed: boolean; creativeId?: string; reason?: string }

/** Pure deterministic fallback when the AI gateway is unavailable — seller-safe and
 *  Fair-Housing-clean, deliberately a different angle than any prior creative. */
export function fallbackRefreshCreative(campaignName: string | null): GeneratedFatigueCreative {
  return {
    variationName: `Fresh angle — ${campaignName ?? "campaign"} refresh`,
    headline: "New Listings Just Hit the Market",
    primaryText: "See what's new in your area this week and what it could mean for your next move — no pressure, just insight.",
    description: "Fresh local market angle",
    callToAction: "LEARN_MORE",
  }
}

/** Pure: the prompt asking for a NEW angle that avoids the fatigued creative's hook. */
export function buildFatigueRefreshPrompt(
  campaignName: string | null, brokerageName: string,
  priorHeadline: string | null, priorPrimaryText: string | null, decay: EngagementDecay,
): string {
  return [
    `You are a senior real-estate ad copywriter for the brokerage "${brokerageName}".`,
    `The running ad creative for campaign "${campaignName ?? "this campaign"}" has FATIGUED: ${decay.reason} (down ${Math.round(decay.dropPct * 100)}% from its opening CTR over ${decay.daysLive.toFixed(0)} days live).`,
    priorHeadline ? `The fatigued headline (for contrast only — do NOT reuse it): "${priorHeadline}"` : "",
    priorPrimaryText ? `The fatigued body (for contrast only — do NOT reuse it): "${priorPrimaryText.slice(0, 300)}"` : "",
    `Write ONE fresh ad creative with a DIFFERENT hook/angle than the fatigued one, aimed at the same audience.`,
    `HARD RULES: Fair Housing compliant (no language about protected classes or who "should" live somewhere); no fabricated claims/prices; concise.`,
    `Return STRICT JSON only: {"variationName":string,"headline":string<=40 chars,"primaryText":string<=125 chars,"description":string<=30 chars,"callToAction":one of LEARN_MORE|SIGN_UP|CONTACT_US|GET_OFFER}`,
  ].filter(Boolean).join("\n")
}

/**
 * Stage a fresh, DIFFERENT-angle ad creative for a fatigued campaign as a draft in the
 * ad_creative approval queue. Idempotent — one open (draft/pending_review) refresh per
 * campaign at a time, so a repeated HIGH-risk read on the same fatigue episode doesn't
 * spam the queue.
 */
export async function proposeFatigueRefreshCreative(
  brokerageId: string, adCampaignId: string, campaignName: string | null, decay: EngagementDecay, client?: Svc,
): Promise<FatigueRefreshResult> {
  const svc = client ?? createServiceClient()
  const { data: dupe } = await svc.from("ad_creative_variations").select("id")
    .eq("ad_campaign_id", adCampaignId).eq("generated_from", "fatigue_refresh")
    .in("approval_status", ["draft", "pending_review"]).limit(1).maybeSingle()
  if (dupe) return { proposed: false, reason: "a refresh is already staged for this campaign" }

  const { data: prior } = await svc.from("ad_creative_variations")
    .select("headline, primary_text").eq("ad_campaign_id", adCampaignId).eq("approval_status", "approved")
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  const priorRow = prior as { headline: string | null; primary_text: string | null } | null

  const { data: brk } = await svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  const brokerageName = (brk as { name?: string } | null)?.name ?? "Your Brokerage"

  let creative: GeneratedFatigueCreative = fallbackRefreshCreative(campaignName)
  try {
    const { generateAIText } = await import("@/lib/ai/generate")
    const { text } = await generateAIText(
      buildFatigueRefreshPrompt(campaignName, brokerageName, priorRow?.headline ?? null, priorRow?.primary_text ?? null, decay),
      { feature: "ad_creative_fatigue_refresh", temperature: 0.7, maxTokens: 400 },
    )
    const parsed = JSON.parse((text.match(/\{[\s\S]*\}/)?.[0]) ?? "{}")
    if (parsed.headline && parsed.primaryText) {
      creative = {
        variationName: String(parsed.variationName ?? creative.variationName).slice(0, 80),
        headline: String(parsed.headline).slice(0, 60),
        primaryText: String(parsed.primaryText).slice(0, 300),
        description: String(parsed.description ?? "").slice(0, 60),
        callToAction: ["LEARN_MORE", "SIGN_UP", "CONTACT_US", "GET_OFFER"].includes(parsed.callToAction) ? parsed.callToAction : "LEARN_MORE",
      }
    }
  } catch { /* fall back to the deterministic creative */ }

  const { data, error } = await svc.from("ad_creative_variations").insert({
    brokerage_id: brokerageId, ad_campaign_id: adCampaignId, variation_name: creative.variationName,
    headline: creative.headline, primary_text: creative.primaryText, description: creative.description,
    call_to_action: creative.callToAction, generated_from: "fatigue_refresh", approval_status: "draft",
  }).select("id").maybeSingle()
  if (error) {
    console.error("[creative-fatigue-runner] refresh creative insert refused:", error.message)
    return { proposed: false, reason: error.message }
  }
  return { proposed: true, creativeId: (data as { id: string } | null)?.id }
}
