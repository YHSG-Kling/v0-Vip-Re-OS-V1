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
 *   · selectBrollPlan (PURE, no DB) — given an ordered library of clips and a
 *     B-roll timeline length, SEQUENCE / LOOP / TRUNCATE the clips to FILL the
 *     timeline. Deterministic: the same library + timeline always yields the
 *     same ordered plan. This is the math the BrollLayer divides time across —
 *     we compute the explicit (url, start, duration) plan so the picker can
 *     reason about fit, loop the library when it is shorter than the timeline,
 *     and truncate the final clip so the plan never overruns.
 *
 *   · pickBrollClips (DB) — walk the scope cascade, fetch b_roll / neighborhood
 *     video_assets rows for the most-specific available scope, probe each clip's
 *     duration (Mediabunny when importable — it ships transitively with the
 *     Remotion encoder packages — else the stored video_assets.duration_seconds,
 *     else a sensible per-clip default), run selectBrollPlan, and return BOTH
 *     the ordered plan AND the BrollClip[] shape the compositions consume
 *     ({ url, caption? } — the _BrollLayer primitive divides the composition's
 *     B-roll window evenly across the clips and loops itself).
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
}

/** One clip in the ordered B-roll timeline plan. */
export interface BrollPlanEntry {
  /** The source clip URL. */
  url:             string
  /** When this clip starts in the composition's B-roll window, in seconds. */
  startSeconds:    number
  /** How long this clip plays, in seconds (the final entry may be truncated
   *  so the plan ends exactly at the timeline length). */
  durationSeconds: number
  /** Optional caption carried through from the source clip. */
  caption?:        string
}

/** A library clip handed to selectBrollPlan — a URL + its (probed/stored)
 *  length. duration must be > 0; selectBrollPlan defends against bad input. */
export interface BrollSourceClip {
  url:             string
  durationSeconds: number
  caption?:        string
}

/** When a clip's true duration is unknown (no Mediabunny probe + no stored
 *  duration_seconds), assume this many seconds. Long enough that a single
 *  unknown clip can carry a short window, short enough that the loop logic
 *  still cycles a library of unknowns. */
export const DEFAULT_CLIP_SECONDS = 4

/**
 * selectBrollPlan — PURE. Sequence the supplied clips in order to fill exactly
 * `neededSeconds` of B-roll timeline.
 *
 *   · If `perClipSeconds` is supplied (> 0), every clip is shown for that long
 *     (capped to its own duration so we never ask a 3s clip to play 5s),
 *     looping the library until the timeline is full.
 *   · Otherwise each clip plays for its own duration.
 *   · LOOP: when the library is shorter than the timeline, the clips repeat
 *     from the top until the timeline is filled.
 *   · TRUNCATE: the final clip is clipped so the plan ends exactly at
 *     `neededSeconds` (never overruns).
 *
 * Deterministic — same inputs, same ordered plan. Empty library or a
 * non-positive timeline returns [].
 */
export function selectBrollPlan(
  clips:         BrollSourceClip[],
  neededSeconds: number,
  perClipSeconds?: number,
): BrollPlanEntry[] {
  if (!Array.isArray(clips) || clips.length === 0) return []
  if (!(neededSeconds > 0)) return []

  // Normalize each source clip to a positive duration.
  const lib = clips
    .filter((c) => c && typeof c.url === "string" && c.url.length > 0)
    .map((c) => ({
      url:      c.url,
      caption:  c.caption,
      duration: c.durationSeconds > 0 ? c.durationSeconds : DEFAULT_CLIP_SECONDS,
    }))
  if (lib.length === 0) return []

  const plan: BrollPlanEntry[] = []
  let cursor = 0
  let i = 0
  // Hard cap on iterations so a degenerate input (e.g. all-zero perClip) can
  // never spin forever; the timeline is finite so this is only a guardrail.
  const maxEntries = 10_000

  while (cursor < neededSeconds - 1e-6 && plan.length < maxEntries) {
    const src = lib[i % lib.length]
    // How long this clip WANTS to play: a fixed per-clip beat (capped to the
    // clip's own length) or its full natural duration.
    const want = perClipSeconds && perClipSeconds > 0
      ? Math.min(perClipSeconds, src.duration)
      : src.duration
    // Truncate the final clip so the plan ends exactly at the timeline length.
    const remaining = neededSeconds - cursor
    const dur = Math.min(want, remaining)
    if (dur <= 1e-6) break

    plan.push({
      url:             src.url,
      startSeconds:    round3(cursor),
      durationSeconds: round3(dur),
      ...(src.caption ? { caption: src.caption } : {}),
    })
    cursor += dur
    i += 1
  }

  return plan
}

/** Round to ms precision so the plan numbers are clean + comparable. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

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
  /** The composition-facing clip list ({ url, caption? }) — the brollClips
   *  prop ComingSoonReel / NeighborhoodSpotlightReel consume. EMPTY when the
   *  scope is empty (the composition renders WITHOUT B-roll, like today). */
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

  // The composition consumes a flat ordered { url, caption? } list. Derive it
  // from the source clips in cascade order (deduped to distinct URLs so a
  // looped plan doesn't repeat the same clip in the prop — _BrollLayer loops
  // for us). Falls back to the plan order when count caps below the library.
  const seen = new Set<string>()
  const clips: PickedBrollClip[] = []
  for (const c of source) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    clips.push({ url: c.url, ...(c.caption ? { caption: c.caption } : {}) })
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
