/**
 * lib/video/broll-picker.ts
 *
 * THE B-ROLL PICKER — the stop-the-scroll missing link. The Video Director
 * already FLAGS which formats want lifestyle B-roll under the narration
 * (format.needsBroll → ComingSoonReel / NeighborhoodSpotlightReel / the
 * vertical Just-Listed cut), but until now NOTHING sourced the actual clips.
 * This module sources them — from the EXISTING video_assets stock library,
 * honoring the EXISTING agent → team → brokerage scope cascade
 * (lib/remotion/stock-scope resolveStockScopeOrder, the same walk the render
 * coordinator's pickStockAsset uses for bookends + music). No new asset
 * system, no fabricated clips.
 *
 * Two seams:
 *
 *   · selectBrollPlan (PURE, no DB) — MOVED to lib/video/broll-plan.ts and
 *     re-exported from here; see the tombstone below. Given an ordered library
 *     of clips and a B-roll timeline length it SEQUENCEs / LOOPs / TRUNCATEs
 *     the clips to FILL the timeline, and never gives a clip a slot longer than
 *     the clip is.
 *
 *   · pickBrollClips (DB) — walk the scope cascade, fetch b_roll / neighborhood
 *     video_assets rows for the most-specific available scope, probe each clip's
 *     duration (Mediabunny when importable — it ships transitively with the
 *     Remotion encoder packages — else the stored video_assets.duration_seconds,
 *     else a sensible per-clip default), run selectBrollPlan, and return BOTH
 *     the ordered plan AND the BrollClip[] shape the compositions consume
 *     ({ url, durationSeconds, caption? }).
 *
 * WHERE THE PLAN GOES, PRECISELY (recorded 2026-09-05, because the previous
 * wording read as if the layer already honored it):
 *   · `PickBrollResult.plan` is the plan FOR THE TIMELINE THE CALLER SUPPLIED.
 *     `lib/video/video-director.ts` supplies NO `neededSeconds`, so its plan is
 *     the natural-sum sequence (each clip once) and NOT the composition's B-roll
 *     window — the Director cannot know that window, because it is a constant
 *     inside each composition (ComingSoonReel TOTAL=360, NeighborhoodSpotlight
 *     TOTAL=480, AgentTalkingHeadReel BODY=300, and BODY ≠ TOTAL there). Teaching
 *     the Director a second table of per-composition B-roll windows would be the
 *     §6 defect.
 *   · So the SEQUENCING happens where the window is known — in the layer, using
 *     this same `selectBrollPlan` (§6: one implementation, two callers). What
 *     the layer needed from here was the MEASUREMENTS, and those now ride
 *     `PickedBrollClip.durationSeconds`.
 *   · `plan` keeps its readers: `scripts/broll-picker-simulator.ts` asserts the
 *     fill/loop/truncate/honest-empty semantics on it, and any caller that DOES
 *     know its timeline (passing `neededSeconds`) gets the finished plan.
 *
 * HONEST: an empty scope (no b_roll uploaded anywhere in the cascade) returns
 * an EMPTY plan + EMPTY clips. The composition then renders WITHOUT B-roll
 * exactly as it does today (BrollLayer returns null, the brand background
 * carries through). Never a fabricated clip, never a broken render.
 */

// ── The composition-facing clip shape. MIRRORS remotion/_BrollLayer BrollClip
//    ({ url, caption? }) so the picker's output drops straight into the
//    brollClips prop. Re-declared (not imported) so this module stays free of
//    the remotion runtime — the simulator + the Director import it server-side. ──
export interface PickedBrollClip {
  /** Image OR video URL. _BrollLayer detects by extension. */
  url:       string
  /** Optional segment caption ("Brickell promenade"). */
  caption?:  string
  /**
   * THE CLIP'S MEASURED LENGTH IN SECONDS — Mediabunny probe, else the stored
   * `video_assets.duration_seconds`, else DEFAULT_CLIP_SECONDS. Carried onto
   * the composition-facing shape (2026-09-05) because it is the ONE fact the
   * B-roll layer could not know and could not guess.
   *
   * THE DEFECT IT CLOSES. This module measured every clip and handed the
   * measurements to `selectBrollPlan`; the Director kept only `picked.clips`
   * and the measurements died here. `remotion/_BrollLayer.tsx` therefore
   * divided its frame window EVENLY across N clips, and a clip shorter than
   * its even slot was asked to play past its own end — where a `<Video>` holds
   * its LAST FRAME. The reel showed a frozen still and the render reported
   * success. With this field populated the layer re-runs the SAME
   * `selectBrollPlan` against the window it actually owns
   * (`lib/video/broll-plan.ts`), so no clip is ever given a slot longer than
   * it is. `scripts/broll-slot-guard.ts` asserts that rule.
   *
   * OPTIONAL because the shape is also produced by callers that never measured
   * (`lib/agents/seller-update-reel-producer.ts` maps bare URLs). Absent →
   * the layer falls back to the even division, exactly as before.
   */
  durationSeconds?: number
}

// ── TOMBSTONE (§1): the PURE timeline math — `selectBrollPlan`,
//    `BrollPlanEntry`, `BrollSourceClip`, `DEFAULT_CLIP_SECONDS` — moved to
//    lib/video/broll-plan.ts:1 so `remotion/_BrollLayer.tsx` can import it
//    without dragging this module's `await import("@/lib/supabase/service")`
//    into the Remotion webpack bundle (that module is `server-only`).
//    THIS FILE REMAINS THE SURVIVOR for SOURCING clips (pickBrollClips, the
//    video_assets scope cascade, the Mediabunny probe) and re-exports the math
//    unchanged, so `scripts/broll-picker-simulator.ts` and every other importer
//    keep working against `@/lib/video/broll-picker`. ──
//    Relative, not `@/…`: `scripts/broll-picker-simulator.ts` loads this file
//    through tsx by relative path, and `remotion/components/CaptionLayer.tsx`
//    already proves relative is what the Remotion bundler resolves.
export {
  selectBrollPlan,
  DEFAULT_CLIP_SECONDS,
  type BrollPlanEntry,
  type BrollSourceClip,
} from "./broll-plan"

import {
  selectBrollPlan,
  DEFAULT_CLIP_SECONDS,
  type BrollPlanEntry,
  type BrollSourceClip,
} from "./broll-plan"

// ── Minimal structural type for the Supabase client this module accepts.
//    Mirrors how lib/video/video-director threads its AnyClient so the picker
//    can be called with the Director's already-resolved service client. ──
interface SupabaseLike {
  from: (table: string) => any
}

export interface PickBrollInput {
  brokerageId: string
  /** The caller's scope — the same scope the render uses. Agent renders pass
   *  scope_type 'agent' + scope_id = the agent id, and inherit team + brokerage
   *  b_roll via the cascade. */
  scopeType:   "agent" | "team" | "brokerage" | "multi_location" | "platform"
  scopeId:     string
  /** Total B-roll timeline to fill, in seconds (the composition's full length
   *  for the B-roll-under-everything formats). Either this OR `count`. */
  neededSeconds?: number
  /** How many distinct clips to pull. When set WITHOUT neededSeconds the plan
   *  simply sequences each clip for its own duration. */
  count?:       number
  /** Optional fixed per-clip beat (seconds) — passed through to selectBrollPlan.
   *  When omitted the picker lets each clip play its natural length, then loops. */
  perClipSeconds?: number
}

export interface PickBrollResult {
  /** The ordered B-roll timeline plan ((url, start, duration) per entry).
   *  EMPTY when the scope has no b_roll anywhere in the cascade. */
  plan:  BrollPlanEntry[]
  /** The composition-facing clip list ({ url, durationSeconds, caption? }) —
   *  the brollClips prop ComingSoonReel / NeighborhoodSpotlightReel consume.
   *  EMPTY when the scope is empty (the composition renders WITHOUT B-roll,
   *  like today). Carries each clip's MEASURED length so the layer can size its
   *  own slots — see PickedBrollClip.durationSeconds. */
  clips: PickedBrollClip[]
  /** Diagnostics — how many rows the cascade returned + which scope they came
   *  from (for the Director's video_metadata + the simulator's assertions). */
  sourcedCount:   number
  sourcedScope:   string | null
}

const EMPTY_RESULT: PickBrollResult = { plan: [], clips: [], sourcedCount: 0, sourcedScope: null }

/**
 * pickBrollClips — fetch real b_roll / neighborhood clips from video_assets for
 * the caller's scope (walking the EXISTING agent → team → brokerage cascade),
 * probe each clip's duration, and return the ordered plan + the BrollClip[]
 * shape the compositions consume.
 *
 * HONEST: empty scope → EMPTY result (the composition renders without B-roll,
 * exactly like today). Never fabricates a clip.
 */
export async function pickBrollClips(
  input:   PickBrollInput,
  client?: SupabaseLike,
): Promise<PickBrollResult> {
  if (!input.brokerageId || !input.scopeType || !input.scopeId) return EMPTY_RESULT

  let svc: SupabaseLike
  if (client) {
    svc = client
  } else {
    const { createServiceClient } = await import("@/lib/supabase/service")
    svc = createServiceClient() as unknown as SupabaseLike
  }

  // Resolve the agent's team so agent renders also inherit team-uploaded b_roll
  // — the SAME team resolution pickStockAsset does for bookends/music.
  let teamId: string | null = null
  if (input.scopeType === "agent") {
    try {
      const { data: agentRow } = await svc.from("agents").select("team_id").eq("id", input.scopeId).maybeSingle()
      teamId = (agentRow as { team_id?: string | null } | null)?.team_id ?? null
    } catch { /* team resolution is best-effort — the cascade just skips the team tier */ }
  }

  // Walk the EXISTING cascade — most-specific scope with b_roll wins. We pull
  // from the FIRST scope in the cascade that has any b_roll/neighborhood rows,
  // mirroring pickStockAsset's "most-specific available" semantics.
  const { resolveStockScopeOrder } = await import("@/lib/remotion/stock-scope")
  const scopes = resolveStockScopeOrder(
    { scopeType: input.scopeType, scopeId: input.scopeId, brokerageId: input.brokerageId },
    teamId,
  )

  let rows: Array<{ video_url: string; duration_seconds: number | null; title: string | null; category: string | null }> = []
  let sourcedScope: string | null = null
  for (const ref of scopes) {
    try {
      const { data } = await svc.from("video_assets")
        .select("video_url, duration_seconds, title, category")
        .eq("brokerage_id", input.brokerageId)
        .eq("scope_type",   ref.scopeType)
        .eq("scope_id",     ref.scopeId)
        .in("category",     ["b_roll", "neighborhood"])
        .not("video_url", "is", null)
        .order("created_at", { ascending: false })
      const got = (data ?? []) as typeof rows
      if (got.length > 0) {
        rows = got
        sourcedScope = `${ref.scopeType}:${ref.scopeId}`
        break
      }
    } catch { /* try the next scope in the cascade */ }
  }

  if (rows.length === 0) return EMPTY_RESULT

  // Cap to the requested count when supplied (keeps the most recent N).
  const capped = (input.count && input.count > 0) ? rows.slice(0, input.count) : rows

  // Probe each clip's duration: Mediabunny (if importable) → stored
  // duration_seconds → DEFAULT_CLIP_SECONDS.
  const source: BrollSourceClip[] = []
  for (const r of capped) {
    const stored = typeof r.duration_seconds === "number" && r.duration_seconds > 0 ? r.duration_seconds : null
    const probed = stored ?? (await probeDurationSeconds(r.video_url)) ?? DEFAULT_CLIP_SECONDS
    source.push({
      url:             r.video_url,
      durationSeconds: probed,
      ...(r.title ? { caption: r.title } : {}),
    })
  }

  // Default the timeline to the natural sum of clip durations when no explicit
  // neededSeconds is given — so a count-only call sequences every clip once.
  const timeline = (input.neededSeconds && input.neededSeconds > 0)
    ? input.neededSeconds
    : source.reduce((s, c) => s + c.durationSeconds, 0)

  const plan = selectBrollPlan(source, timeline, input.perClipSeconds)

  // The composition consumes a flat ordered { url, durationSeconds, caption? }
  // list. Derive it from the source clips in cascade order (deduped to distinct
  // URLs so a looped plan doesn't repeat the same clip in the prop — the layer
  // re-runs selectBrollPlan against its OWN window and loops the library there,
  // where the window length is actually known).
  const seen = new Set<string>()
  const clips: PickedBrollClip[] = []
  for (const c of source) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    clips.push({
      url: c.url,
      // THE MEASUREMENT TRAVELS WITH THE CLIP (2026-09-05). Without this the
      // layer had nothing to divide by but the clip COUNT, and a clip shorter
      // than its even slot froze on its last frame. See PickedBrollClip.
      durationSeconds: c.durationSeconds,
      ...(c.caption ? { caption: c.caption } : {}),
    })
  }

  return { plan, clips, sourcedCount: rows.length, sourcedScope }
}

/**
 * Probe a clip's duration via Mediabunny when it is importable. Mediabunny
 * ships transitively with the Remotion encoder packages (@mediabunny/*), so it
 * resolves in this repo without a direct dependency. If the import or the probe
 * fails (offline, unreachable URL, unsupported container) we return null and
 * the caller degrades to the stored duration / default — never throwing into
 * the staging path.
 */
async function probeDurationSeconds(url: string): Promise<number | null> {
  try {
    // Optional runtime dependency: resolved via a variable specifier so the
    // type-checker treats it as a dynamic optional import (it ships transitively
    // with the Remotion encoder packages and is guarded by .catch below).
    const mediabunnySpecifier = "mediabunny"
    const mb: any = await import(mediabunnySpecifier).catch(() => null)
    if (!mb || !mb.Input || !mb.ALL_FORMATS || !mb.UrlSource) return null
    const input = new mb.Input({
      formats: mb.ALL_FORMATS,
      source:  new mb.UrlSource(url, { getRetryDelay: () => null }),
    })
    const seconds = await input.computeDuration()
    return typeof seconds === "number" && seconds > 0 ? seconds : null
  } catch {
    return null
  }
}
