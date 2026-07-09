/**
 * lib/remotion/render-coordinator.ts
 *
 * Wave 39 — the connective tissue between the composition registry,
 * the existing concatIntroOutro helper (lib/video/composite-attribution),
 * the new music mixer, and the per-render audit table. Until this lands
 * the registry's supports_bookends + stock_intro_category fields had
 * no consumer; the W40 ad creator + Asset Manager start/restart
 * actions now route every Remotion render through this coordinator.
 *
 * Flow:
 *   1. Tier-gate via canAccessComposition(callerTier, registryRow).
 *   2. Cost-forecast via estimateCompositionCost; caller checks the
 *      brokerage vendor budget before invoking.
 *   3. recordRenderQueued (registry helper) — atomic claim of a
 *      remotion_composition_renders row in 'queued' state. Returns
 *      the renderId the caller stores on the entity it's rendering
 *      for (listing / contact / campaign).
 *   4. Caller hands us back a rendered Remotion buffer (this module
 *      doesn't own the actual @remotion/renderer call — that lives
 *      in the per-composition endpoints under
 *      app/api/internal/remotion/render-*).
 *   5. If supports_bookends + stock_intro_category set + the caller's
 *      scope has a matching video_assets row, we call concatIntroOutro
 *      (the EXISTING ffmpeg helper used by the D-ID pipeline — no
 *      duplicate stitcher).
 *   6. If a background-music asset is available for the scope, we
 *      mix it under the audio via mixBackgroundMusic.
 *   7. Upload final mp4 to Vercel Blob, record the result + which
 *      stock asset rows were stitched.
 *
 * The caller can disable bookends / music per-render via the
 * `intent` arg — useful for thumbnail-only renders or A/B tests
 * where the framework should NOT add intro / outro / music.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  canAccessComposition,
  getComposition,
  recordRenderQueued,
  recordRenderCompleted,
  estimateCompositionCost,
  type CompositionTier,
  type RemotionCompositionRow,
} from "./registry"
import { concatIntroOutro } from "@/lib/video/composite-attribution"
import { mixBackgroundMusic } from "./music-mixer"

export interface RenderIntent {
  brokerageId:     string
  /** Subscription tier for tier-access enforcement. */
  callerTier:      CompositionTier
  /** Composition id the caller wants to render — must be registered
   *  in remotion_compositions. */
  compositionId:   string
  /** Scope context for stock-asset lookup. Pass the agent scope
   *  if the render is personal-brand (solo agent voicedrop preset);
   *  brokerage scope for the brokerage's shared content engine. */
  scopeType:       "agent" | "team" | "brokerage"
  scopeId:         string
  agentUserId?:    string | null
  entityType?:     string | null
  entityId?:       string | null
  /** Whether to attempt bookends. Defaults to following the
   *  registry row's supports_bookends + categories; set to false
   *  to force-disable (e.g. for thumbnail renders). */
  applyBookends?:  boolean
  /** Whether to attempt background music mix. Same defaulting:
   *  follows availability of a 'music' asset in the scope. Set
   *  false to force-disable. */
  applyMusic?:     boolean
  /** The Video Director's per-situation music MOOD (e.g. "sophisticated",
   *  "upbeat", "calm"). When set, the music pick PREFERS a licensed track
   *  tagged with this mood (video_assets.music_mood), falling back to any
   *  music asset in scope. "none" suppresses music entirely. */
  musicMood?:      string | null
}

export interface CoordinatedRenderResult {
  ok:                boolean
  renderId?:         string
  composition?:      RemotionCompositionRow
  /** When ok=false, the structured reason. */
  blockedReason?:
    | "composition_not_registered"
    | "composition_not_reachable_at_tier"
  /** Helpers populated when bookends / music actually stitched. */
  introAssetId?:     string | null
  outroAssetId?:     string | null
  musicAssetId?:     string | null
}

/**
 * Step 1 — claim a render row, tier-gate, return the registry row +
 * the renderId the caller stamps on the entity. The caller then
 * runs the actual @remotion/renderer call (via the per-composition
 * endpoint) and hands the buffer back to finalizeCoordinatedRender.
 *
 * Split into two phases so the Remotion render itself (which is
 * heavy and lives in a separate function with its own timeout) is
 * decoupled from the registry / stock-asset / blob-upload work that
 * must run on either side of it.
 */
export async function beginCoordinatedRender(
  intent: RenderIntent,
): Promise<CoordinatedRenderResult> {
  const composition = await getComposition(intent.compositionId)
  if (!composition) {
    return { ok: false, blockedReason: "composition_not_registered" }
  }
  if (!canAccessComposition(intent.callerTier, composition)) {
    return { ok: false, blockedReason: "composition_not_reachable_at_tier" }
  }

  const queued = await recordRenderQueued({
    brokerageId:    intent.brokerageId,
    compositionId:  intent.compositionId,
    agentUserId:    intent.agentUserId ?? null,
    entityType:     intent.entityType ?? null,
    entityId:       intent.entityId ?? null,
    usedDidAvatar:  composition.requires_did_avatar,
    usedVoiceover:  composition.requires_voiceover,
  })
  if (!queued.ok || !queued.renderId) {
    return { ok: false, blockedReason: "composition_not_registered" }
  }
  return { ok: true, renderId: queued.renderId, composition }
}

/**
 * Step 3 — caller hands back the rendered buffer; coordinator stitches
 * bookends + music + uploads + completes the audit row.
 *
 * The caller path looks like:
 *   const begin = await beginCoordinatedRender(intent)
 *   const buffer = await runActualRemotionRender(intent, begin.composition!)
 *   const result = await finalizeCoordinatedRender(intent, begin.renderId!, buffer)
 *
 * On any failure we mark the render row failed so the Asset Manager
 * surfaces the failure signal next cycle.
 */
export async function finalizeCoordinatedRender(
  intent:     RenderIntent,
  renderId:   string,
  buffer:     Buffer,
): Promise<{
  ok: boolean; outputUrl?: string | null; thumbnailUrl?: string | null;
  introAssetId?: string | null; outroAssetId?: string | null; musicAssetId?: string | null;
  error?: string;
}> {
  const svc = createServiceClient()
  const composition = await getComposition(intent.compositionId)
  if (!composition) {
    await recordRenderCompleted({
      renderId,
      compositionId: intent.compositionId,
      status:        "failed",
      errorMessage:  "composition disappeared between begin + finalize",
    })
    return { ok: false, error: "composition_not_registered" }
  }

  let working = buffer
  let introAssetId: string | null = null
  let outroAssetId: string | null = null
  let musicAssetId: string | null = null

  // ─── Bookends ───
  const wantsBookends = intent.applyBookends ?? composition.supports_bookends
  if (wantsBookends && (composition.stock_intro_category || composition.stock_outro_category)) {
    const [introRow, outroRow] = await Promise.all([
      composition.stock_intro_category
        ? pickStockAsset(svc, intent, composition.stock_intro_category)
        : Promise.resolve(null),
      composition.stock_outro_category
        ? pickStockAsset(svc, intent, composition.stock_outro_category)
        : Promise.resolve(null),
    ])
    if (introRow || outroRow) {
      try {
        const concat = await concatIntroOutro({
          mainVideoBuffer: working,
          introVideoUrl:   introRow?.video_url ?? null,
          outroVideoUrl:   outroRow?.video_url ?? null,
        })
        if (concat.overlayApplied && concat.outputBuffer.length > 0) {
          working = concat.outputBuffer
          introAssetId = introRow?.id ?? null
          outroAssetId = outroRow?.id ?? null
        }
      } catch (e) {
        console.warn("[render-coordinator] bookend stitch failed; continuing:", (e as Error).message)
      }
    }
  }

  // ─── Narration voiceover (owner rule: voice on every video unless stated) ───
  // Producers synthesize the script at queue time (assistant's voice for
  // internal reports, the agent's clone for contact-facing) and carry the mp3
  // URL in input_props.voiceover_url; we mux it here BEFORE music so the music
  // ducks under the narration. Best-effort — a mux failure ships the video silent.
  let usedVoiceover = composition.requires_voiceover
  try {
    const { data: renderRow } = await svc.from("remotion_composition_renders")
      .select("input_props").eq("id", renderId).maybeSingle()
    const voUrl = (renderRow as any)?.input_props?.voiceover_url
    if (typeof voUrl === "string" && voUrl.startsWith("http")) {
      const { mixNarrationVoiceover } = await import("./voiceover-mixer")
      const narrated = await mixNarrationVoiceover({ videoBuffer: working, voiceoverUrl: voUrl })
      if (narrated.ok && narrated.outputBuffer.length > 0) {
        working = narrated.outputBuffer
        usedVoiceover = true
      }
    }
  } catch (e) {
    console.warn("[render-coordinator] voiceover mux failed; continuing:", (e as Error).message)
  }

  // ─── Music ───
  // The Director's "none" mood suppresses music entirely (informational cuts);
  // any other mood PREFERS a mood-tagged licensed track, else falls back to any.
  const wantsMusic = (intent.applyMusic ?? true) && intent.musicMood !== "none"
  if (wantsMusic) {
    const musicRow = await pickStockAsset(svc, intent, "music", intent.musicMood ?? null)
    if (musicRow?.video_url) {
      try {
        const mixed = await mixBackgroundMusic({
          videoBuffer:        working,
          musicUrl:           musicRow.video_url,
          musicVolumePct:     musicRow.music_volume_pct ?? 20,
          loop:               musicRow.music_loop ?? true,
        })
        if (mixed.ok && mixed.outputBuffer.length > 0) {
          working = mixed.outputBuffer
          musicAssetId = musicRow.id
        }
      } catch (e) {
        console.warn("[render-coordinator] music mix failed; continuing:", (e as Error).message)
      }
    }
  }

  // ─── Upload — SUPABASE STORAGE hosts the finished product (owner rule:
  // we host the delivery URL). video-assets bucket (public, created live);
  // Vercel Blob stays as the fallback so a storage hiccup never loses a
  // finished render. ───
  try {
    const { hostRenderedMedia } = await import("./media-host")
    const path = `compositions/${intent.brokerageId}/${composition.composition_id}/${renderId}.mp4`
    const uploaded = { url: await hostRenderedMedia(svc, path, working, "video/mp4") }

    // Audit: record the per-asset attribution alongside the standard fields.
    await svc.from("remotion_composition_renders")
      .update({
        render_status:       "succeeded",
        output_url:          uploaded.url,
        used_intro_asset_id: introAssetId,
        used_outro_asset_id: outroAssetId,
        used_music_asset_id: musicAssetId,
        used_voiceover:      usedVoiceover,
        completed_at:        new Date().toISOString(),
      })
      .eq("id", renderId)

    await svc.from("remotion_compositions")
      .update({ last_rendered_at: new Date().toISOString() })
      .eq("composition_id", composition.composition_id)

    // Capture the finished render into the reusable marketing_assets library so
    // every chart reel / section video / avatar clip / b-roll can be repurposed
    // across social, email, listing promo, and ads. Best-effort + idempotent —
    // a capture failure must not fail the render.
    try {
      const { captureRenderAsMarketingAsset } = await import("@/lib/marketing/capture-render-asset")
      await captureRenderAsMarketingAsset(renderId, svc)
    } catch { /* asset capture is best-effort */ }

    return {
      ok: true,
      outputUrl:    uploaded.url,
      thumbnailUrl: null,
      introAssetId, outroAssetId, musicAssetId,
    }
  } catch (e) {
    await recordRenderCompleted({
      renderId,
      compositionId: composition.composition_id,
      status:        "failed",
      errorMessage:  (e as Error).message,
    })
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Look up a stock video_assets row for the caller's scope. Walks
 * the tier cascade: caller's scope → brokerage scope → no row.
 * Picks the most recently created so brokerages with multiple
 * intro options get rotation without us building a separate
 * selection policy.
 */
async function pickStockAsset(
  svc:      ReturnType<typeof createServiceClient>,
  intent:   RenderIntent,
  category: string,
  /** When category is "music" and a mood is supplied, PREFER a track tagged with
   *  it; if none in scope, fall back to any music track (mood-preferred, never
   *  mood-required, so single-track libraries still work). */
  moodPref?: string | null,
): Promise<{
  id:                string
  video_url:         string
  music_volume_pct:  number | null
  music_loop:        boolean | null
} | null> {
  const tryScope = async (scopeType: string, scopeId: string, mood?: string | null) => {
    let q = svc.from("video_assets")
      .select("id, video_url, music_volume_pct, music_loop")
      .eq("brokerage_id", intent.brokerageId)
      .eq("scope_type", scopeType)
      .eq("scope_id",   scopeId)
      .eq("category",   category)
      .not("video_url", "is", null)
    if (mood) q = q.contains("tags", [mood])
    const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle()
    return data as { id: string; video_url: string; music_volume_pct: number | null; music_loop: boolean | null } | null
  }

  // Resolve the agent's team so agent renders also inherit team-uploaded stock.
  let teamId: string | null = null
  if (intent.scopeType === "agent") {
    const { data: agentRow } = await svc.from("agents").select("team_id").eq("id", intent.scopeId).maybeSingle()
    teamId = (agentRow as { team_id?: string | null } | null)?.team_id ?? null
  }

  // Walk the agent → team → brokerage cascade; most specific available wins.
  const { resolveStockScopeOrder } = await import("./stock-scope")
  const scopes = resolveStockScopeOrder(intent, teamId)
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

export { estimateCompositionCost }
