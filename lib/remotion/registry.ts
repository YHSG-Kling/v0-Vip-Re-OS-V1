/**
 * lib/remotion/registry.ts
 *
 * Wave 39 — typed accessors over the remotion_compositions table
 * (m168). Source of truth for which compositions exist, what tier
 * can use each, which need D-ID / voiceover, and what to ship as
 * the AI-search og:title.
 *
 * Read by:
 *   · the W40 ad creator + content engine — picks a composition
 *     given (intent, format, tier) and verifies tier access before
 *     queuing a render
 *   · lib/agents/asset-manager.ts — adds composition health to the
 *     weekly snapshot (which are popular, which are stale, which
 *     are gated higher than they should be)
 *   · the render endpoints — read tier_access + the thumbnail
 *     companion composition id; write to remotion_composition_renders
 *     when each render starts + completes
 *
 * Tier hierarchy (high → low):
 *   platform > multi_location > brokerage > team > solo_agent
 * A composition listed for `team` is reachable by team + brokerage +
 * multi_location + platform. The helper expands this implicitly so
 * callers can pass the tenant's actual tier and get a clean boolean.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { compositionSeconds } from "@/lib/remotion/composition-geometry"

export type CompositionTier =
  | "solo_agent"
  | "team"
  | "brokerage"
  | "multi_location"
  | "platform"

export type CompositionCategory =
  | "listing"
  | "explainer"
  | "presentation"
  | "market_update"
  | "testimonial"
  | "open_house"
  | "coming_soon"
  | "neighborhood"
  | "affordability"
  | "agent_avatar"
  | "lead_magnet"
  | "postcard"
  | "newsletter"
  | "thumbnail"

export type CompositionOrientation =
  | "square"
  | "vertical"
  | "horizontal"
  | "static_card"
  | "postcard"

export interface RemotionCompositionRow {
  composition_id:           string
  display_name:             string
  category:                 CompositionCategory
  orientation:              CompositionOrientation
  width:                    number
  height:                   number
  duration_frames:          number
  fps:                      number
  requires_did_avatar:      boolean
  requires_voiceover:       boolean
  tier_access:              CompositionTier[]
  is_active:                boolean
  seo_title:                string | null
  seo_description:          string | null
  thumbnail_composition_id: string | null
  asset_manager_notes:      string | null
  last_rendered_at:         string | null
  /** Wave 39 — when true the render coordinator wraps the output
   *  with intro + outro pulled from the brokerage's video_assets
   *  stock library via the existing concatIntroOutro helper in
   *  lib/video/composite-attribution. Videos true; static cards +
   *  postcards false. */
  supports_bookends:        boolean
  /** Wave 39 — video_assets.category to pull for the intro.
   *  NULL = no intro even when supports_bookends=true. */
  stock_intro_category:     string | null
  stock_outro_category:     string | null
}

/** Tier ordering — every tier reachable by the SAME tier OR any
 *  HIGHER tier. Lookup direction: callers pass the tenant's tier and
 *  ask "can they use this composition?". We expand the registry
 *  row's tier_access to include all lower tiers when a higher tier
 *  is listed (a brokerage-tier subscriber inherits team + solo_agent
 *  access — they can produce ANYTHING they can pay for at the brokerage
 *  level OR below). */
const TIER_RANK: Record<CompositionTier, number> = {
  solo_agent:     1,
  team:           2,
  brokerage:      3,
  multi_location: 4,
  platform:       5,
}

/** Returns true when the caller's tier can use this composition.
 *  Pass the tenant's actual subscription tier; the helper expands
 *  the registry row's tier_access into the implied set (any tier
 *  >= the lowest tier in the row's access list passes). */
export function canAccessComposition(
  callerTier:  CompositionTier,
  composition: Pick<RemotionCompositionRow, "tier_access" | "is_active">,
): boolean {
  if (!composition.is_active) return false
  if (composition.tier_access.length === 0) return false
  const lowestRequired = Math.min(...composition.tier_access.map((t) => TIER_RANK[t]))
  return TIER_RANK[callerTier] >= lowestRequired
}

/** Fetch every active composition. Used by the Asset Manager's
 *  snapshot + the admin library page. */
export async function listAllCompositions(): Promise<RemotionCompositionRow[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("remotion_compositions")
    .select("*")
    .eq("is_active", true)
    .order("category", { ascending: true })
    .order("display_name", { ascending: true })
  if (error) {
    console.error("[remotion-registry] listAllCompositions failed:", error.message)
    return []
  }
  return (data ?? []) as RemotionCompositionRow[]
}

/** Fetch every composition the caller's tier can use. The W40 ad
 *  creator + content engine use this to seed the per-tenant picker. */
export async function listCompositionsForTier(
  callerTier: CompositionTier,
): Promise<RemotionCompositionRow[]> {
  const rows = await listAllCompositions()
  return rows.filter((r) => canAccessComposition(callerTier, r))
}

/** Single-composition lookup. Returns null when the id isn't in
 *  the registry — callers should treat this as "composition was
 *  removed; cancel the render". */
export async function getComposition(
  compositionId: string,
): Promise<RemotionCompositionRow | null> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("remotion_compositions")
    .select("*")
    .eq("composition_id", compositionId)
    .maybeSingle()
  return (data as RemotionCompositionRow | null) ?? null
}

/** Cost-shape estimator. The W40 ad creator calls this BEFORE
 *  queuing a render to forecast spend and gate against the
 *  brokerage's vendor budget. Values are USD per-render approximations
 *  — the vendor-governance budget gate at synthesis time is still the
 *  authoritative spend control. */
export interface CompositionCostEstimate {
  didAvatarUsd:  number
  voiceoverUsd:  number
  remotionUsd:   number
  totalUsd:      number
}
export function estimateCompositionCost(
  composition: RemotionCompositionRow,
): CompositionCostEstimate {
  // D-ID Talks API charges ~$0.30 per minute of avatar video.
  // We compute from duration_frames + fps — through the ONE duration
  // computation (lib/remotion/composition-geometry.ts compositionSeconds), which
  // the render coordinator's narration pad and the render cache's
  // secondsAvoided also use. Three private copies of `duration_frames / fps`
  // were three chances to disagree (§6).
  const seconds = compositionSeconds(composition)
  const minutes = seconds / 60
  const did = composition.requires_did_avatar ? Math.max(0.10, minutes * 0.30) : 0

  // ElevenLabs TTS at ~$0.18 per 1K characters; a typical narration
  // runs ~120 characters per second. Conservative cap at $0.10 even
  // for short clips because the API has a minimum charge.
  const voice = composition.requires_voiceover
    ? Math.max(0.05, (seconds * 120 / 1000) * 0.18)
    : 0

  // Remotion render on Vercel Lambda: ~$0.005 per second of output.
  const remotion = Math.max(0.01, seconds * 0.005)

  const total = did + voice + remotion
  return {
    didAvatarUsd: Number(did.toFixed(3)),
    voiceoverUsd: Number(voice.toFixed(3)),
    remotionUsd:  Number(remotion.toFixed(3)),
    totalUsd:     Number(total.toFixed(3)),
  }
}

/** Audit a render kickoff. Called from the render endpoint when a
 *  render is queued so the Asset Manager + cost rollups can see it
 *  even before completion. */
export async function recordRenderQueued(args: {
  brokerageId:    string
  compositionId:  string
  agentUserId?:   string | null
  entityType?:    string | null
  entityId?:      string | null
  usedDidAvatar?: boolean
  usedVoiceover?: boolean
  /** Wave 39 m172 — the composition props payload + scope the generic
   *  render endpoint (app/api/internal/remotion/render-composition)
   *  consumes. inputProps={} → the renderer falls back to the
   *  registry defaultProps for the composition. scope drives the
   *  coordinator's stock-asset (intro/outro/music) cascade. */
  inputProps?:    Record<string, unknown> | null
  scopeType?:     "agent" | "team" | "brokerage"
  scopeId?:       string | null
  requestedVia?:  "asset_manager" | "ad_creator" | "cron" | "manual" | "api"
  /** m312 — LIVING VIDEO. Set when this render is a claim about facts that
   *  move, so the refresh sweep can re-derive them later and tell whether the
   *  video has started saying something untrue. See lib/video/living-video.ts. */
  livingKind?:    string | null
  factsKey?:      string | null
  facts?:         Record<string, unknown> | null
  /** The stale render this one replaces, when it was queued by the sweep. */
  refreshedFromRenderId?: string | null
}): Promise<{ ok: boolean; renderId?: string; error?: string }> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("remotion_composition_renders")
    .insert({
      brokerage_id:     args.brokerageId,
      composition_id:   args.compositionId,
      agent_user_id:    args.agentUserId ?? null,
      entity_type:      args.entityType ?? null,
      entity_id:        args.entityId ?? null,
      used_did_avatar:  args.usedDidAvatar ?? false,
      used_voiceover:   args.usedVoiceover ?? false,
      input_props:      args.inputProps ?? {},
      scope_type:       args.scopeType ?? "brokerage",
      scope_id:         args.scopeId ?? args.brokerageId,
      requested_via:    args.requestedVia ?? "asset_manager",
      living_kind:      args.livingKind ?? null,
      facts_key:        args.factsKey ?? null,
      facts:            args.facts ?? null,
      refreshed_from_render_id: args.refreshedFromRenderId ?? null,
      render_status:    "queued",
    })
    .select("id")
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, renderId: (data as { id: string }).id }
}

/** Marks a render complete + stamps last_rendered_at on the
 *  composition row so the Asset Manager sees freshness signal. */
export async function recordRenderCompleted(args: {
  renderId:      string
  compositionId: string
  outputUrl?:    string | null
  thumbnailUrl?: string | null
  status:        "succeeded" | "failed" | "cancelled"
  errorMessage?: string | null
}): Promise<void> {
  const svc = createServiceClient()
  await svc
    .from("remotion_composition_renders")
    .update({
      render_status: args.status,
      output_url:    args.outputUrl ?? null,
      thumbnail_url: args.thumbnailUrl ?? null,
      error_message: args.errorMessage ?? null,
      completed_at:  new Date().toISOString(),
    })
    .eq("id", args.renderId)

  if (args.status === "succeeded") {
    await svc
      .from("remotion_compositions")
      .update({ last_rendered_at: new Date().toISOString() })
      .eq("composition_id", args.compositionId)
  }
}
