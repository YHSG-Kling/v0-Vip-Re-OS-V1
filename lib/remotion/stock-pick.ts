// lib/remotion/stock-pick.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE stock-asset picker for a render's FINISH pass.
//
// Extracted verbatim from render-coordinator's private pickStockAsset because
// the render cache needs the SAME answer the coordinator will reach: the cache
// key includes which intro/outro/music the finish pass will mux, so a second
// implementation of "which clip does this scope get" would make the key
// disagree with the video and the cache would serve the wrong branding. One
// picker, two callers.
//
// Walks the agent → team → brokerage cascade (resolveStockScopeOrder); most
// specific available wins. For music, a Director mood is PREFERRED across the
// whole cascade before falling back to any track, so a single-track library
// still works.

import "server-only"
import type { createServiceClient } from "@/lib/supabase/service"
import { resolveStockScopeOrder } from "./stock-scope"

/** The scope context a pick needs — the subset of RenderIntent that matters. */
export interface StockPickScope {
  brokerageId: string
  scopeType: "agent" | "team" | "brokerage"
  scopeId: string
}

export interface PickedStockAsset {
  id: string
  video_url: string
  music_volume_pct: number | null
  music_loop: boolean | null
}

export async function pickStockAsset(
  svc: ReturnType<typeof createServiceClient>,
  scope: StockPickScope,
  category: string,
  /** When category is "music" and a mood is supplied, PREFER a track tagged with
   *  it; if none in scope, fall back to any music track (mood-preferred, never
   *  mood-required, so single-track libraries still work). */
  moodPref?: string | null,
): Promise<PickedStockAsset | null> {
  const tryScope = async (scopeType: string, scopeId: string, mood?: string | null) => {
    let q = svc.from("video_assets")
      .select("id, video_url, music_volume_pct, music_loop")
      .eq("brokerage_id", scope.brokerageId)
      .eq("scope_type", scopeType)
      .eq("scope_id", scopeId)
      .eq("category", category)
      .not("video_url", "is", null)
    if (mood) q = q.contains("tags", [mood])
    const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle()
    return data as PickedStockAsset | null
  }

  // Resolve the agent's team so agent renders also inherit team-uploaded stock.
  let teamId: string | null = null
  if (scope.scopeType === "agent") {
    const { data: agentRow } = await svc.from("agents").select("team_id").eq("id", scope.scopeId).maybeSingle()
    teamId = (agentRow as { team_id?: string | null } | null)?.team_id ?? null
  }

  // Walk the agent → team → brokerage cascade; most specific available wins.
  const scopes = resolveStockScopeOrder(scope, teamId)

  // Pass 1: prefer a MOOD-tagged track across the whole cascade (the Director's
  // mood is honored before falling back). Pass 2: any track in the cascade.
  if (moodPref) {
    for (const ref of scopes) {
      const hit = await tryScope(ref.scopeType, ref.scopeId, moodPref)
      if (hit) return hit
    }
  }
  for (const ref of scopes) {
    const hit = await tryScope(ref.scopeType, ref.scopeId)
    if (hit) return hit
  }
  return null
}
