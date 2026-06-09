"use server"
/**
 * app/actions/price-reduction-campaign.ts
 *
 * Wave 51 — MANUAL price-reduction marketing launch (agent-initiated).
 *
 * Advertising a price drop is sensitive: many agents don't want it broadcast and
 * the seller may not want the market to read "reduced" as "desperate". So unlike
 * just-listed / just-sold (which auto-handoff), price-reduction marketing is NEVER
 * auto-fired by the system reactor (see lib/kernel/event-reactor.ts §G note). The
 * agent decides — this action is the manual trigger.
 *
 * What it produces is still DELIVERABLE-GATED: a DRAFT paid-ad creative lands in the
 * Command Center ad_creative queue (the one human gate before any spend), and the
 * promo video / direct-mail dispatch is human-initiated (bypassPolicy) but its
 * social posts / mail pieces remain approval-gated downstream. Nothing reaches the
 * public or spends a dollar without a human releasing it.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

export interface LaunchPriceReductionResult {
  ok: boolean
  creativeId?: string
  campaignId?: string
  promoDispatched?: boolean
  alreadyProduced?: boolean
  error?: string
}

export async function launchPriceReductionCampaign(listingId: string): Promise<LaunchPriceReductionResult> {
  if (!listingId) return { ok: false, error: "listingId required" }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "not authenticated" }
  if (!["agent", "admin", "broker", "superadmin", "team_lead"].includes(ctx.role)) {
    return { ok: false, error: "not authorized" }
  }

  const svc = createServiceClient()

  // Tenant ownership — the listing must belong to the caller's brokerage.
  const { data: listing } = await svc.from("listings")
    .select("id, brokerage_id, agent_id").eq("id", listingId).maybeSingle()
  const l = listing as { id: string; brokerage_id: string | null; agent_id: string | null } | null
  if (!l || l.brokerage_id !== ctx.brokerageId) return { ok: false, error: "listing not found in your brokerage" }

  // 1) Deliverable-gated paid-ad creative (DRAFT → ad_creative approval queue).
  const { produceListingAdCampaign } = await import("@/lib/ads/listing-ad-producer")
  const ad = await produceListingAdCampaign(ctx.brokerageId, listingId, "price_reduction", svc)
  if (!ad.produced && !ad.campaignId) return { ok: false, error: ad.reason ?? "ad creative production failed" }

  // 2) Human-initiated promo video + direct mail (bypassPolicy: the agent chose this).
  //    Downstream social posts / mail pieces are still approval-gated; best-effort.
  let promoDispatched = false
  let agentUserId: string | null = ctx.userId
  if (l.agent_id) {
    try {
      const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
      agentUserId = (await resolveAgentRecordToUserId(l.agent_id)) ?? ctx.userId
    } catch { /* fall back to caller */ }
  }
  try {
    const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
    const r = await dispatchListingPromoVideo({
      brokerageId: ctx.brokerageId, listingId, agentUserId,
      eventType: "price_reduction" as Parameters<typeof dispatchListingPromoVideo>[0]["eventType"],
      bypassPolicy: true,
    })
    promoDispatched = !!r.ok
  } catch { /* promo dispatch is best-effort */ }
  try {
    const { dispatchLifecycleMail } = await import("@/lib/direct-mail/listing-lifecycle-mail-reactor")
    // Direct mail stays scope-gated (physical, expensive) — only sends if the
    // brokerage enabled lifecycle mail for price_reduction.
    void dispatchLifecycleMail({
      brokerageId: ctx.brokerageId, listingId, agentUserId,
      eventType: "price_reduction" as Parameters<typeof dispatchLifecycleMail>[0]["eventType"],
    })
  } catch { /* direct-mail dispatch is best-effort */ }

  revalidatePath("/dashboard/admin/command-center")
  return {
    ok: true,
    creativeId: ad.creativeId,
    campaignId: ad.campaignId,
    promoDispatched,
    alreadyProduced: !ad.produced && !!ad.campaignId,
  }
}
