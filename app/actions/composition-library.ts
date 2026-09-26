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

// ─── Per-row render history ──────────────────────────────────────────────────
// Lane M2. This module's header has promised "per-row render-history
// inspection" since wave 39 and never shipped the reader: the render ledger's
// error_message (WHY a render failed), requested_via (which door asked for
// it — asset_manager / ad_creator / cron / manual / api), the per-asset
// attribution the coordinator stamps after upload (used_intro_asset_id /
// used_outro_asset_id / used_music_asset_id — which brand assets are actually
// baked into the file the brokerage is distributing) and used_voiceover were
// all written and read by nothing. This is that promised half.

export interface CompositionRenderHistoryRow {
  id:                string
  render_status:     string | null
  requested_via:     string | null
  error_message:     string | null
  used_voiceover:    boolean | null
  used_did_avatar:   boolean | null
  output_url:        string | null
  completed_at:      string | null
  created_at:        string | null
  /** Asset ids resolved to their video_assets titles; id shown when the asset is gone. */
  used_intro_title:  string | null
  used_outro_title:  string | null
  used_music_title:  string | null
}

export async function getCompositionRenderHistory(
  compositionId: string,
): Promise<{ success: true; renders: CompositionRenderHistoryRow[] } | { success: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  // Same gate as the snapshot above — this is the same broker surface.
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditBrokerage) {
    return { success: false, error: "Forbidden — brokerage admin only" }
  }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("remotion_composition_renders")
    .select(
      "id, render_status, requested_via, error_message, used_intro_asset_id, used_outro_asset_id, used_music_asset_id, used_voiceover, used_did_avatar, output_url, completed_at, created_at",
    )
    .eq("brokerage_id", ctx.brokerageId)
    .eq("composition_id", compositionId)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error) return { success: false, error: error.message }

  type RenderRow = {
    id: string
    render_status: string | null
    requested_via: string | null
    error_message: string | null
    used_intro_asset_id: string | null
    used_outro_asset_id: string | null
    used_music_asset_id: string | null
    used_voiceover: boolean | null
    used_did_avatar: boolean | null
    output_url: string | null
    completed_at: string | null
    created_at: string | null
  }
  const rows = (data ?? []) as RenderRow[]

  // Resolve the attributed assets to their human titles in ONE read. The
  // error is read (§3): a refused lookup degrades to showing the raw id,
  // never to claiming no asset was used.
  const assetIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.used_intro_asset_id, r.used_outro_asset_id, r.used_music_asset_id])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ]
  const titleById = new Map<string, string>()
  if (assetIds.length > 0) {
    const { data: assets, error: assetsErr } = await svc
      .from("video_assets")
      .select("id, title")
      .eq("brokerage_id", ctx.brokerageId)
      .in("id", assetIds)
    if (assetsErr) {
      console.error("[composition-library] video_assets title read refused:", assetsErr.message)
    } else {
      for (const a of (assets ?? []) as Array<{ id: string; title: string | null }>) {
        if (a.title) titleById.set(a.id, a.title)
      }
    }
  }
  const title = (id: string | null): string | null =>
    id ? (titleById.get(id) ?? id.slice(0, 8)) : null

  return {
    success: true,
    renders: rows.map((r) => ({
      id: r.id,
      render_status: r.render_status,
      requested_via: r.requested_via,
      error_message: r.error_message,
      used_voiceover: r.used_voiceover,
      used_did_avatar: r.used_did_avatar,
      output_url: r.output_url,
      completed_at: r.completed_at,
      created_at: r.created_at,
      used_intro_title: title(r.used_intro_asset_id),
      used_outro_title: title(r.used_outro_asset_id),
      used_music_title: title(r.used_music_asset_id),
    })),
  }
}
