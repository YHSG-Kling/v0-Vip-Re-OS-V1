/**
 * lib/marketing/capture-render-asset.ts
 *
 * Wave 39 — every animated asset the OS renders (CMA chart reels, listing-
 * presentation section videos, avatar clips, b-roll, listing promos) is
 * captured into the reusable marketing_assets library the moment it finishes,
 * so the agent can repurpose it across social, email, listing promo, and ads —
 * not just the one flow that produced it. One render → many marketing uses.
 *
 * Idempotent on (source_table, source_id): a re-render or a second call won't
 * duplicate the asset. Not server-only: uses the service client; never import
 * from a client component.
 */
import { createServiceClient } from "@/lib/supabase/service"

export type CaptureResult =
  | { ok: true; assetId: string }
  | { ok: false; skipped: string }

const SOURCE_TABLE = "remotion_composition_renders"

/** Friendly asset name from the composition + the entity it was made for. */
function assetNameFor(compositionId: string, sectionKey: string | null, entityType: string | null): string {
  const comp = compositionId.replace(/([a-z])([A-Z])/g, "$1 $2")
  if (sectionKey) return `${comp} — ${sectionKey.replace(/_/g, " ")}`
  if (entityType) return `${comp} — ${entityType.replace(/_/g, " ")}`
  return comp
}

export async function captureRenderAsMarketingAsset(
  renderId: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<CaptureResult> {
  const supabase = client ?? createServiceClient()

  const { data: render } = await supabase
    .from("remotion_composition_renders")
    .select("id, brokerage_id, composition_id, agent_user_id, output_url, thumbnail_url, render_status, entity_type, entity_id, scope_type, used_did_avatar, input_props")
    .eq("id", renderId)
    .maybeSingle()
  if (!render) return { ok: false, skipped: "render not found" }
  if (render.render_status !== "succeeded" || !render.output_url) return { ok: false, skipped: "render not finished" }
  if (!render.brokerage_id) return { ok: false, skipped: "render has no brokerage" }

  // Idempotency — already captured?
  const { data: existing } = await supabase
    .from("marketing_assets")
    .select("id")
    .eq("source_table", SOURCE_TABLE)
    .eq("source_id", renderId)
    .maybeSingle()
  if (existing) return { ok: true, assetId: (existing as { id: string }).id }

  const props = (render.input_props ?? {}) as Record<string, unknown>
  const sectionKey = (props.sectionKey as string | undefined) ?? null
  const tags = [
    "reusable",
    render.composition_id,
    render.entity_type ?? undefined,
    sectionKey ?? undefined,
    render.used_did_avatar ? "avatar" : undefined,
  ].filter(Boolean) as string[]

  // Stills (flyers, hangers, carousel slides, thumbnails) upload as PNG/JPG —
  // capture them as images so the ads resolver + library filter correctly.
  const isImage = /\.(png|jpe?g|webp)(\?|$)/i.test(render.output_url)

  const { data: inserted, error } = await supabase
    .from("marketing_assets")
    .insert({
      brokerage_id:    render.brokerage_id,
      agent_user_id:   render.agent_user_id ?? null,
      visibility_scope: render.scope_type ?? "agent",   // already on the m176 ladder
      asset_type:      isImage ? "image" : "video",
      asset_name:      assetNameFor(render.composition_id, sectionKey, render.entity_type ?? null),
      asset_url:       render.output_url,
      thumbnail_url:   render.thumbnail_url ?? null,
      source_table:    SOURCE_TABLE,
      source_id:       renderId,
      tags,
      approval_status: "approved",
      metadata: {
        composition_id:  render.composition_id,
        used_did_avatar: !!render.used_did_avatar,
        section_key:     sectionKey,
        entity_type:     render.entity_type ?? null,
        entity_id:       render.entity_id ?? null,
        captured_from:   "render_completion",
      },
    })
    .select("id")
    .single()
  if (error || !inserted) return { ok: false, skipped: `insert failed: ${error?.message ?? "unknown"}` }
  const assetId = (inserted as { id: string }).id

  // Wave 106 (106C) — CREATIVE LINEAGE: a captured render names the library assets it was built from.
  // The sources are what the Director's bucket-first readiness ladder REUSED for this video
  // (ai_video_projects.video_metadata.asset_readiness.ledger[].assetIds — marketing_assets ids, the
  // same tenant) plus any `media_source_assets` the composition's props carried. Recorded through the
  // ONE lineage writer (tenant-pinned, counted); a missing stamp is simply no lineage, never a guess.
  try {
    const sources = new Set<string>()
    for (const s of (Array.isArray(props.media_source_assets) ? (props.media_source_assets as unknown[]) : [])) if (typeof s === "string") sources.add(s)
    if (render.entity_type === "ai_video_project" && render.entity_id) {
      const { data: vp } = await supabase.from("ai_video_projects").select("video_metadata")
        .eq("id", render.entity_id).eq("brokerage_id", render.brokerage_id).maybeSingle()
      const ledger = (((vp as { video_metadata?: Record<string, unknown> } | null)?.video_metadata?.asset_readiness as { ledger?: Array<{ status?: string; source?: string; assetIds?: string[] }> } | undefined)?.ledger ?? [])
      for (const e of ledger) if (e.status === "reused" && e.source === "marketing_assets") for (const id of e.assetIds ?? []) sources.add(id)
    }
    if (sources.size > 0) {
      const { recordAssetLineage } = await import("@/lib/kernel/media-intelligence")
      const lin = await recordAssetLineage(supabase, { brokerageId: render.brokerage_id, assetId, sourceAssetIds: [...sources] })
      if (!lin.ok) console.error("[capture-render-asset] lineage not recorded:", lin.error)
    }
  } catch (e) { console.error("[capture-render-asset] lineage failed:", (e as Error).message) }
  return { ok: true, assetId }
}
