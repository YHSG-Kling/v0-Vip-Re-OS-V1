"use server"

/**
 * app/actions/composition-library.ts
 *
 * Wave 39 — read-side server actions for the composition library
 * admin page. The Asset Manager OWNS write actions (deprecate /
 * promote / flag) via the existing asset_manager_actions queue;
 * this surface is broker-facing READ + per-row render-history
 * inspection so the broker can see what the Asset Manager sees
 * before approving any action it proposes.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { createServiceClient } from "@/lib/supabase/service"
import {
  listAllCompositions,
  estimateCompositionCost,
  canAccessComposition,
  type RemotionCompositionRow,
  type CompositionTier,
} from "@/lib/remotion/registry"
import { resolvePlanTier } from "@/lib/billing/plan-tier"

export interface CompositionLibraryRow extends RemotionCompositionRow {
  /** Lifetime render count for THIS brokerage. NULL when no renders. */
  brokerage_render_count:  number
  /** Last successful render timestamp for this brokerage. */
  brokerage_last_rendered: string | null
  /** Forecast spend per render. */
  cost_per_render_usd:     number
  /** Is the composition reachable to this brokerage's tier? */
  reachable_for_tier:      boolean
}

export interface CompositionLibrarySnapshot {
  rows:               CompositionLibraryRow[]
  brokerageTier:      CompositionTier
  /** Stock-video inventory the bookend pipeline reads from. */
  stockIntroCount:    number
  stockOutroCount:    number
  stockBrollCount:    number
}

export async function getCompositionLibrarySnapshot(): Promise<{
  success: true; snapshot: CompositionLibrarySnapshot
} | { success: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage) {
    return { success: false, error: "Forbidden — brokerage admin only" }
  }

  const svc = createServiceClient()

  // The tier from plan_tier — the column with writers. This read
  // brokerages.subscription_tier, which nothing maintains (m306 drops it).
  const brokerageTier = (await resolvePlanTier(svc, ctx.brokerageId)) as CompositionTier

  const [allCompositions, rendersAggR, stockR] = await Promise.all([
    listAllCompositions(),
    svc.from("remotion_composition_renders")
      .select("composition_id, render_status, completed_at")
      .eq("brokerage_id", ctx.brokerageId),
    svc.from("video_assets")
      .select("id, category")
      .eq("brokerage_id", ctx.brokerageId),
  ])

  const rendersByComp = new Map<string, { count: number; lastSucceeded: string | null }>()
  for (const r of (rendersAggR.data ?? []) as Array<{
    composition_id: string; render_status: string; completed_at: string | null
  }>) {
    const agg = rendersByComp.get(r.composition_id) ?? { count: 0, lastSucceeded: null }
    agg.count++
    if (r.render_status === "succeeded" && r.completed_at) {
      if (agg.lastSucceeded === null || r.completed_at > agg.lastSucceeded) {
        agg.lastSucceeded = r.completed_at
      }
    }
    rendersByComp.set(r.composition_id, agg)
  }

  const rows: CompositionLibraryRow[] = allCompositions.map((c) => {
    const agg = rendersByComp.get(c.composition_id) ?? { count: 0, lastSucceeded: null }
    // The tier ladder used to be re-implemented here ("mirror
    // registry.canAccessComposition shape") — a second copy of the rule that
    // decides what a tenant may render. It agreed with the registry today and
    // was one edit away from not agreeing, and the library is the surface a
    // broker trusts to tell them what they have. One implementation.
    const reachable = canAccessComposition(brokerageTier, c)
    return {
      ...c,
      brokerage_render_count:  agg.count,
      brokerage_last_rendered: agg.lastSucceeded,
      cost_per_render_usd:     estimateCompositionCost(c).totalUsd,
      reachable_for_tier:      reachable,
    }
  })

  const stock = (stockR.data ?? []) as Array<{ category: string | null }>
  return {
    success: true,
    snapshot: {
      rows,
      brokerageTier,
      stockIntroCount: stock.filter((r) => r.category === "brand_intro").length,
      stockOutroCount: stock.filter((r) => r.category === "logo_outro").length,
      stockBrollCount: stock.filter((r) => r.category === "neighborhood" || r.category === "b_roll").length,
    },
  }
}
