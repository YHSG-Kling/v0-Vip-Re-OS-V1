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
import { consumesVoiceover, missingContentProps } from "@/lib/remotion/content-contract"
import {
  MAX_AUTO_REQUEUE_ATTEMPTS, shouldAutoRequeueFailedRender, isStalledRender, stalledRenderError, PICKABLE_RENDER_STATUS, FAIR_PICK_RECENT_MS, chooseFairRender, type FairPickClaim,
} from "@/lib/remotion/render-decision"
import { didRenderUsdForSeconds, elevenLabsUsdForChars } from "@/lib/video/realism-profile"
import { wordsForSeconds, AVERAGE_CHARS_PER_WORD } from "@/lib/video/duration-model"

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
  /**
   * A MIRROR, not a source (m601, 2026-09-03). True iff the composition renders
   * `<Audio src={voiceoverUrl}>` — the set declared at
   * lib/remotion/content-contract.ts:VOICEOVER_CONSUMING_COMPOSITIONS, which is
   * what every decision in code reads (consumesVoiceover / stagesVoiceover).
   * test:content-contract §15 proves the column equals the set whenever it can
   * reach the live table. Read this field only when you already hold a live
   * row and want the mirror's answer (a badge, a cost estimate); never branch a
   * ledger write on it.
   */
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
  // THE D-ID LEG IS PRICED BY THE ONE RATE (wave 91 lane 91A). This used to say "D-ID Talks API
  // charges ~$0.30 per minute" and computed `max(0.10, minutes * 0.30)` — ~3.3x UNDER the
  // plan-derived rate the metering line books (lib/video/realism-profile.ts
  // DID_USD_PER_VIDEO_SECOND, Scale $297 / 1,200 credits x 15 s ≈ $0.99/min), and it ignored D-ID's
  // 15-second credit rounding. The forecast now calls didRenderUsdForSeconds, the same function
  // estimateAvatarRenderCostUsd prices through, so the budget gate and the ledger cannot disagree.
  // We compute from duration_frames + fps — through the ONE duration
  // computation (lib/remotion/composition-geometry.ts compositionSeconds), which
  // the render coordinator's narration pad and the render cache's
  // secondsAvoided also use. Three private copies of `duration_frames / fps`
  // were three chances to disagree (§6).
  const seconds = compositionSeconds(composition)
  const did = composition.requires_did_avatar ? didRenderUsdForSeconds(seconds) : 0

  // THE VOICE LEG IS PRICED BY THE ONE RATE (lane 92A, the twin of the D-ID fix above). This
  // used to say "ElevenLabs TTS at ~$0.18 per 1K characters; a typical narration runs ~120
  // characters per second" with a $0.05 floor for "a minimum charge". 120 chars/s is ~8x a
  // real narration (150 wpm x 6 chars/word = 15 chars/s — lib/video/duration-model.ts
  // wordsForSeconds + AVERAGE_CHARS_PER_WORD, the pace and character budget the narration
  // planner itself uses), $0.18 was ~1.8x the billed v3 rate, and ElevenLabs bills
  // characters, not calls — so the forecast over-stated voice ~10x. It now prices through
  // elevenLabsUsdForChars, the function the avatar metering line prices through.
  //
  // WHICH compositions carry that narration is read from the ONE set
  // (consumesVoiceover — lib/remotion/content-contract.ts), not from the row's
  // `requires_voiceover`, which is that set's live mirror (m601). The mirror is
  // consulted only when a caller hands a PARTIAL row with no composition_id,
  // because a silent 0 there would understate the economics snapshot without
  // saying so. NO LIVE CALLER IS IN THAT STATE as of 2026-09-03: the cache
  // board used to be (it built a row from four fields and dropped the id it had
  // already used as its map key) and now passes `composition_id`
  // (lib/remotion/render-cache.ts loadCacheBoard), and the composition library
  // passes the whole row (app/actions/composition-library.ts:99). The arm stays
  // as the fail-safe for the next partial caller — it is the only branch here
  // that can be reached without an id, and dropping it would answer "not
  // narrated" for a row that never said.
  // BLIND SPOT, named: narration muxed through the snake `voiceover_url` finish
  // key (the Director's EquityReportReel / MarketUpdateReel / ExplainerAnimReel
  // lane) is TTS spend this estimate does not see; the real ledger is
  // ai_tool_usage, and this number was always an approximation beside it.
  const narrated = composition.composition_id
    ? consumesVoiceover(composition.composition_id)
    : composition.requires_voiceover
  const voice = narrated
    ? elevenLabsUsdForChars(wordsForSeconds(seconds, "voiceover") * AVERAGE_CHARS_PER_WORD)
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

/**
 * Marks a render complete + stamps last_rendered_at on the composition row so
 * the Asset Manager sees freshness signal.
 *
 * THE TERMINAL WRITE READS ITS OWN ERROR (CLAUDE.md §3). This used to return
 * `Promise<void>` over an unchecked `.update()`, which made it the one function
 * in the Remotion rail that could not tell you it had failed — and it is the
 * function every render path calls to say "succeeded", "failed" or "cancelled".
 * supabase-js RESOLVES a refusal, so a dropped/renamed column (PGRST204), a
 * transient PostgREST 5xx or a wrong-id predicate all came back indistinguishable
 * from a write that landed. Concretely: the render endpoint's catch block calls
 * this with status 'failed' and then returns HTTP 500 naming the error, while the
 * row it was talking about is still 'rendering' — so the Asset Manager never sees
 * a failure to propose restart_failed_render on, and the video-pipeline reaper is
 * the only thing that ever notices, minutes-to-hours later and with no reason
 * attached. Callers that do not care still `await` it and ignore the result; the
 * ones that can act on a refusal now can.
 */
export async function recordRenderCompleted(args: {
  renderId:      string
  compositionId: string
  outputUrl?:    string | null
  thumbnailUrl?: string | null
  status:        "succeeded" | "failed" | "cancelled"
  errorMessage?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const svc = createServiceClient()
  const { error } = await svc
    .from("remotion_composition_renders")
    .update({
      render_status: args.status,
      output_url:    args.outputUrl ?? null,
      thumbnail_url: args.thumbnailUrl ?? null,
      error_message: args.errorMessage ?? null,
      completed_at:  new Date().toISOString(),
    })
    .eq("id", args.renderId)
  if (error) {
    console.error(
      `[remotion-registry] render ${args.renderId} (${args.compositionId}) could NOT be marked '${args.status}': `
      + `${error.message}. The row is still mid-flight and nothing downstream will learn the outcome.`,
    )
    return { ok: false, error: error.message }
  }

  if (args.status === "succeeded") {
    // Freshness telemetry, not the deliverable — a refusal here is logged and
    // does not turn a finished render into a failed one.
    const { error: freshnessError } = await svc
      .from("remotion_compositions")
      .update({ last_rendered_at: new Date().toISOString() })
      .eq("composition_id", args.compositionId)
    if (freshnessError) {
      console.warn(
        `[remotion-registry] last_rendered_at not stamped for ${args.compositionId}: ${freshnessError.message}`,
      )
    }
  }
  return { ok: true }
}

interface RenderSweepOutcome {
  /** Rows this sweep moved, with why. */
  moved:   Array<{ id: string; reason: string }>
  /** Rows it looked at and left, with why — a skip is never silent. */
  skipped: Array<{ id: string; reason: string }>
  /** A refused read: REPORTED, never read as an empty queue (CLAUDE.md §3). */
  error?:  string
}

/**
 * DEAD-CLAIM RECOVERY (wave 153, lane 153J) — called by the composition-render-queue
 * tick BEFORE the bounded requeue, so a recovered claim is retried in the same tick.
 *
 * A `rendering` row whose claim (m933 `claimed_at`, stamped by trigger) is older than
 * RENDER_STALL_AFTER_MS — or, with no stamp, whose `created_at` is older than
 * LEGACY_RENDER_STALL_AFTER_MS — is a render whose function was killed. It is failed
 * with stalledRenderError (census bucket `render_stalled`, transient). The flip is
 * guarded on the state AND the claim stamp it was judged on, so a row re-claimed in
 * between matches nothing; every update is `.select()`ed and counted.
 *
 * Before m933 is applied the `claimed_at` read is refused; the sweep then reports the
 * refusal and moves nothing — it degrades this step, never the queue drain beneath it.
 */
export async function recoverStalledRenders(svc: any, opts: { now?: Date; limit?: number } = {}): Promise<RenderSweepOutcome> {
  const now = opts.now ?? new Date()
  const out: RenderSweepOutcome = { moved: [], skipped: [] }
  const { data, error } = await svc.from("remotion_composition_renders")
    .select("id, composition_id, claimed_at, created_at")
    .eq("render_status", "rendering")
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 50)
  if (error) return { ...out, error: `stalled-render read refused: ${error.message}` }
  for (const r of (data ?? []) as Array<{ id: string; composition_id: string; claimed_at: string | null; created_at: string | null }>) {
    if (!isStalledRender(r, now)) { out.skipped.push({ id: r.id, reason: "claim is younger than the stall horizon — may still be rendering" }); continue }
    let q = svc.from("remotion_composition_renders")
      .update({ render_status: "failed", error_message: stalledRenderError(r, now), completed_at: now.toISOString() })
      .eq("id", r.id)
      .eq("render_status", "rendering")
    q = r.claimed_at ? q.eq("claimed_at", r.claimed_at) : q.is("claimed_at", null)
    const { data: flipped, error: flipErr } = await q.select("id")
    if (flipErr) out.skipped.push({ id: r.id, reason: `stall flip refused: ${flipErr.message}` })
    else if (!flipped || flipped.length === 0) out.skipped.push({ id: r.id, reason: "finished or re-claimed between the read and the flip" })
    else out.moved.push({ id: r.id, reason: `dead claim (${r.composition_id}) → failed render_stalled` })
  }
  return out
}

/**
 * BOUNDED AUTO-REQUEUE (wave 57, moved here from app/api/cron/composition-render-queue/route.ts
 * by wave 153 lane 153J so it can be driven by a proof; the cron is its one caller).
 *
 * THE POISON WINDOW IT CLOSES. The cron read the 5 OLDEST `failed` rows with no
 * filter, so five rows whose retries were spent sat at the head of that window
 * forever and no newer transient failure was ever retried again. Spent rows are now
 * excluded in the query (retry_count is NOT NULL DEFAULT 0, m622), and terminal ones
 * (census `retry: "terminal"`) are refused by shouldAutoRequeueFailedRender without
 * spending budget; the window is wide enough that the few terminal rows it can still
 * hold cannot crowd out a retryable one.
 */
export async function requeueFailedRenders(svc: any, opts: { window?: number } = {}): Promise<RenderSweepOutcome> {
  const out: RenderSweepOutcome = { moved: [], skipped: [] }
  const { data, error } = await svc.from("remotion_composition_renders")
    .select("id, composition_id, render_status, retry_count, input_props, error_message")
    .eq("render_status", "failed")
    .lt("retry_count", MAX_AUTO_REQUEUE_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(opts.window ?? 25)
  if (error) return { ...out, error: `failed-render read refused: ${error.message}` }
  for (const f of (data ?? []) as Array<{
    id: string; composition_id: string; render_status: string; retry_count: number | null
    input_props: Record<string, unknown> | null; error_message: string | null
  }>) {
    const decision = shouldAutoRequeueFailedRender(f, missingContentProps(f.composition_id, f.input_props ?? {}))
    if (!decision.requeue) { out.skipped.push({ id: f.id, reason: decision.reason }); continue }
    // Guarded on 'failed' AND the retry_count it was judged on, so a row the Asset
    // Manager (or another tick) already claimed or requeued matches zero rows.
    const { data: updated, error: rqErr } = await svc.from("remotion_composition_renders")
      .update({ render_status: "queued", retry_count: (f.retry_count ?? 0) + 1, error_message: null })
      .eq("id", f.id)
      .eq("render_status", "failed")
      .eq("retry_count", f.retry_count ?? 0)
      .select("id")
    if (rqErr) out.skipped.push({ id: f.id, reason: `update refused: ${rqErr.message}` })
    else if (!updated || updated.length === 0) out.skipped.push({ id: f.id, reason: "already claimed by another tick/action" })
    else out.moved.push({ id: f.id, reason: decision.reason })
  }
  return out
}

/**
 * FAIR PICK (wave 156, lane 156S) — the queue tick's choice of the ONE row it renders, replacing "the globally oldest
 * queued row" (lib/remotion/render-decision.ts chooseFairRender states why). Reads the oldest `window` queued rows and the
 * claims of the last FAIR_PICK_RECENT_MS; a refused claims read is REPORTED and the pick falls back to the oldest row
 * (ordering degrades, the queue never stops); a refused queue read is reported and picks nothing (CLAUDE.md §3).
 */
export async function pickNextQueuedRender(svc: any, opts: { now?: Date; window?: number } = {}): Promise<{
  row: { id: string; composition_id: string; brokerage_id: string; scope_type: string | null; scope_id: string | null } | null
  considered: number; tenants: number; error?: string; fairness?: "fair" | "oldest_first_fallback"
}> {
  const now = opts.now ?? new Date()
  const { data: queued, error } = await svc.from("remotion_composition_renders")
    .select("id, composition_id, brokerage_id, scope_type, scope_id, created_at")
    .eq("render_status", PICKABLE_RENDER_STATUS)
    .order("created_at", { ascending: true })
    .limit(opts.window ?? 200)
  if (error) return { row: null, considered: 0, tenants: 0, error: `queued-render read refused: ${error.message}` }
  const rows = (queued ?? []) as Array<{ id: string; composition_id: string; brokerage_id: string; scope_type: string | null; scope_id: string | null; created_at: string | null }>
  const tenants = new Set(rows.map((r) => r.brokerage_id)).size
  if (rows.length === 0) return { row: null, considered: 0, tenants: 0 }
  const since = new Date(now.getTime() - FAIR_PICK_RECENT_MS).toISOString()
  const { data: recent, error: recentErr } = await svc.from("remotion_composition_renders")
    .select("brokerage_id, scope_type, scope_id")
    .gte("claimed_at", since)
    .limit(2000)
  if (recentErr) {
    return { row: rows[0], considered: rows.length, tenants, fairness: "oldest_first_fallback", error: `recent-claims read refused (${recentErr.message}); picked the oldest row` }
  }
  return { row: chooseFairRender(rows, (recent ?? []) as FairPickClaim[]), considered: rows.length, tenants, fairness: "fair" }
}

/**
 * THE CLAIM (wave 156, lane 156S; moved out of app/api/internal/remotion/render-composition/route.ts so it is driven by a
 * proof): `queued → rendering`, matched on the id AND the queued state, so two ticks racing for one row cannot both win —
 * the loser matches nothing and reads `data: null`. claimed_at is stamped by the m933 trigger. The row comes back with its
 * OWN brokerage_id: the render runs as that tenant, never as the caller's.
 */
export async function claimQueuedRender(svc: any, renderId: string): Promise<{ data: any; error: { message: string } | null }> {
  return svc.from("remotion_composition_renders")
    .update({ render_status: "rendering" })
    .eq("id", renderId)
    .eq("render_status", PICKABLE_RENDER_STATUS)
    .select("id, brokerage_id, composition_id, agent_user_id, entity_type, entity_id, scope_type, scope_id, input_props")
    .maybeSingle()
}
