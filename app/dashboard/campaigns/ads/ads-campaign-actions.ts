"use server"

// app/dashboard/campaigns/ads/ads-campaign-actions.ts
//
// The browser door to lib/kernel/ads.ts:updateAdCampaign.
//
// WHY THIS FILE EXISTS. The kernel command edits an ad campaign's name, budget,
// schedule and targeting, and refuses on a live/launching campaign — the only
// editor for those fields anywhere in the product. It could not be reached from
// the Ads dashboard, because the dashboard is a client component and
// lib/kernel/ads.ts is deliberately NOT "use server" (Layer 1: kernel commands
// run on the service client with RLS bypassed and scope purely on
// ctx.brokerageId). Layer 2 is where the session becomes the tenant, and that
// is what this is.
//
// THE TENANT COMES FROM THE SESSION, NEVER THE CALLER. Handing the kernel a
// caller-supplied brokerageId would let any authenticated user rewrite any
// tenant's ad budgets and targeting — the same hole lib/ads/facebook-audience-sync.ts
// closed for audiences. `AdsActorContext` is built here from getAgentContext()
// and nothing on the wire contributes to it.

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { updateAdCampaign, type AdsActorContext, type TargetingConfig } from "@/lib/kernel/ads"
import { revalidatePath } from "next/cache"

// NOT exported — a "use server" module may only export async functions, and this
// is an internal gate, not an endpoint.
async function resolveAdsActor(): Promise<
  { ok: true; ctx: AdsActorContext } | { ok: false; error: string }
> {
  const session = await getAgentContext()
  if (!session.isAuthenticated) return { ok: false, error: "Not authenticated" }
  if (!session.brokerageId) return { ok: false, error: "No brokerage on this account" }
  // agentId is OMITTED when the session has none (brokers/admins have no `agents`
  // row). It is never back-filled from users.id — agents.id and users.id are
  // disjoint id spaces — and updateAdCampaign does not read it.
  const ctx = {
    brokerageId: session.brokerageId,
    userId: session.userId,
    ...(session.agentId ? { agentId: session.agentId } : {}),
  } as AdsActorContext
  return { ok: true, ctx }
}

export interface UpdateAdCampaignFields {
  campaignName?: string
  dailyBudget?: number
  lifetimeBudget?: number
  startDate?: string
  endDate?: string
  targetingConfig?: TargetingConfig
}

/**
 * Edit a draft / paused / approved ad campaign.
 *
 * The kernel refuses `live` and `launching` campaigns — a campaign that is
 * already spending must not have its budget and targeting rewritten underneath
 * it — and reports "Campaign not found" for a row outside the caller's
 * brokerage, so a foreign campaign id is inert here.
 */
export async function updateAdCampaignAction(
  campaignId: string,
  updates: UpdateAdCampaignFields,
): Promise<{ success: boolean; error?: string }> {
  const actor = await resolveAdsActor()
  if (!actor.ok) return { success: false, error: actor.error }

  if (!campaignId) return { success: false, error: "campaignId required" }

  // A budget of 0 is not "unset" — it is a campaign that can never deliver, and
  // the kernel's own rule 6 requires one of the two budgets to be a real number.
  if (updates.dailyBudget !== undefined && !(updates.dailyBudget > 0)) {
    return { success: false, error: "Daily budget must be greater than zero" }
  }
  if (updates.lifetimeBudget !== undefined && !(updates.lifetimeBudget > 0)) {
    return { success: false, error: "Lifetime budget must be greater than zero" }
  }
  if (updates.campaignName !== undefined && !updates.campaignName.trim()) {
    return { success: false, error: "Campaign name cannot be empty" }
  }
  if (updates.startDate && updates.endDate && updates.endDate < updates.startDate) {
    return { success: false, error: "End date cannot be before the start date" }
  }

  const result = await updateAdCampaign({
    ctx: actor.ctx,
    campaignId,
    updates: {
      ...(updates.campaignName !== undefined ? { campaignName: updates.campaignName.trim() } : {}),
      ...(updates.dailyBudget !== undefined ? { dailyBudget: updates.dailyBudget } : {}),
      ...(updates.lifetimeBudget !== undefined ? { lifetimeBudget: updates.lifetimeBudget } : {}),
      ...(updates.startDate !== undefined ? { startDate: updates.startDate } : {}),
      ...(updates.endDate !== undefined ? { endDate: updates.endDate } : {}),
      ...(updates.targetingConfig !== undefined ? { targetingConfig: updates.targetingConfig } : {}),
    },
  })

  if (!result.success) return { success: false, error: result.error ?? "Update failed" }

  revalidatePath("/dashboard/campaigns/ads")
  return { success: true }
}
