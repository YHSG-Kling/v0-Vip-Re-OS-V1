"use server"

/**
 * app/actions/stock-library.ts
 *
 * Wave 39 — server actions for the stock library upload UI. The
 * BrollPicker.tsx UI already lists video_assets for the brokerage;
 * this surface adds the missing UPLOAD path so an admin or agent
 * can add their own intro / outro / b-roll / music without going
 * through a developer.
 *
 * Tier scope mirrors lifecycle_promo_policy + direct_mail_presets:
 *   solo agent uploads to scope_type='agent' (their personal brand)
 *   team lead   uploads to scope_type='team'
 *   broker admin uploads to scope_type='brokerage' (shared library)
 *
 * The render coordinator walks the cascade — caller scope first,
 * then brokerage fallback — so a solo agent's personal intro plays
 * over the brokerage's default when both exist.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolvePolicyScopeAccess } from "@/lib/identity/policy-scope"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

export type StockCategory =
  | "brand_intro"
  | "logo_outro"
  | "b_roll"
  | "neighborhood"
  | "music"

const ALL_CATEGORIES: StockCategory[] = [
  "brand_intro", "logo_outro", "b_roll", "neighborhood", "music",
]

export interface StockAssetRow {
  id:                  string
  title:               string
  description:         string | null
  video_url:           string
  thumbnail_url:       string | null
  category:            string
  scope_type:          "agent" | "team" | "brokerage"
  scope_id:            string
  duration_seconds:    number | null
  music_volume_pct:    number | null
  music_loop:          boolean | null
  license_url:         string | null
  license_attribution: string | null
  created_at:          string
}

export async function listStockAssets(): Promise<{
  success: true; assets: StockAssetRow[]
} | { success: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const access = await resolvePolicyScopeAccess()
  if (!access.canEditAgent && !access.canEditTeam && !access.canEditBrokerage) {
    return { success: false, error: "No scope available" }
  }

  const svc = createServiceClient()
  // Build the scope OR filter — every (scope_type, scope_id) tuple
  // the caller can see across the cascade. Same pattern direct-mail
  // presets uses.
  const filters: string[] = []
  if (access.canEditAgent && access.agentScopeId)
    filters.push(`and(scope_type.eq.agent,scope_id.eq.${access.agentScopeId})`)
  for (const teamId of access.teamScopeIds)
    filters.push(`and(scope_type.eq.team,scope_id.eq.${teamId})`)
  if (access.canEditBrokerage && access.brokerageScopeId)
    filters.push(`and(scope_type.eq.brokerage,scope_id.eq.${access.brokerageScopeId})`)
  if (filters.length === 0) return { success: true, assets: [] }

  const { data, error } = await svc.from("video_assets")
    .select("id, title, description, video_url, thumbnail_url, category, scope_type, scope_id, duration_seconds, music_volume_pct, music_loop, license_url, license_attribution, created_at")
    .eq("brokerage_id", ctx.brokerageId)
    .or(filters.join(","))
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) return { success: false, error: error.message }
  return { success: true, assets: (data ?? []) as StockAssetRow[] }
}

export interface UploadStockAssetInput {
  title:           string
  description?:    string
  category:        StockCategory
  scope_type:      "agent" | "team" | "brokerage"
  scope_id?:       string
  /** URL the file has already been uploaded to (Vercel Blob).
   *  The UI handles the actual file upload; this server action
   *  registers the metadata. */
  video_url:       string
  thumbnail_url?:  string
  duration_seconds?: number
  // Music-only:
  music_volume_pct?: number
  music_loop?:       boolean
  // License fields — required for music, recommended for others.
  license_url?:        string
  license_attribution?: string
}

export async function registerStockAsset(input: UploadStockAssetInput): Promise<{
  success: boolean; assetId?: string; error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }
  const access = await resolvePolicyScopeAccess()
  if (!ALL_CATEGORIES.includes(input.category)) {
    return { success: false, error: "invalid_category" }
  }
  if (!input.title.trim()) return { success: false, error: "title required" }
  if (!input.video_url.trim()) return { success: false, error: "video_url required" }
  // Music license is non-negotiable — defends royalty claims.
  if (input.category === "music" && !input.license_url?.trim()) {
    return { success: false, error: "license_url required for music tracks" }
  }

  // Tier-gate the scope. Mirrors the direct-mail-presets pattern.
  let scopeId = input.scope_id
  if (input.scope_type === "agent") {
    if (!access.canEditAgent) return { success: false, error: "agent_scope_forbidden" }
    scopeId = scopeId ?? access.agentScopeId ?? undefined
    if (!scopeId) return { success: false, error: "agent_scope_unresolved" }
  } else if (input.scope_type === "team") {
    if (!access.canEditTeam) return { success: false, error: "team_scope_forbidden" }
    if (!scopeId || !access.teamScopeIds.includes(scopeId)) {
      if (access.teamScopeIds.length === 1) scopeId = access.teamScopeIds[0]
      else return { success: false, error: "team_scope_id_required" }
    }
  } else {
    if (!access.canEditBrokerage) return { success: false, error: "brokerage_scope_forbidden" }
    scopeId = scopeId ?? access.brokerageScopeId ?? ctx.brokerageId
  }

  const svc = createServiceClient()
  const { data, error } = await svc.from("video_assets")
    .insert({
      brokerage_id:      ctx.brokerageId,
      created_by:        ctx.userId,
      title:             input.title.trim(),
      description:       input.description ?? null,
      video_url:         input.video_url,
      thumbnail_url:     input.thumbnail_url ?? null,
      category:          input.category,
      scope_type:        input.scope_type,
      scope_id:          scopeId,
      duration_seconds:  input.duration_seconds ?? null,
      music_volume_pct:  input.category === "music" ? (input.music_volume_pct ?? 20) : null,
      music_loop:        input.category === "music" ? (input.music_loop ?? true)   : null,
      license_url:         input.license_url ?? null,
      license_attribution: input.license_attribution ?? null,
    })
    .select("id")
    .single()
  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/stock-library")
  return { success: true, assetId: data.id as string }
}

export async function deleteStockAsset(assetId: string): Promise<{
  success: boolean; error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const access = await resolvePolicyScopeAccess()
  const svc = createServiceClient()
  const { data: row } = await svc.from("video_assets")
    .select("scope_type, scope_id")
    .eq("id", assetId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  const r = row as { scope_type: string; scope_id: string } | null
  if (!r) return { success: false, error: "asset_not_found" }
  const canEditScope =
    (r.scope_type === "agent"     && access.canEditAgent     && r.scope_id === access.agentScopeId) ||
    (r.scope_type === "team"      && access.canEditTeam      && access.teamScopeIds.includes(r.scope_id)) ||
    (r.scope_type === "brokerage" && access.canEditBrokerage && r.scope_id === access.brokerageScopeId)
  if (!canEditScope) return { success: false, error: "scope_forbidden" }

  const { error } = await svc.from("video_assets").delete().eq("id", assetId)
  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/stock-library")
  return { success: true }
}
