/**
 * lib/remotion/render-decision.ts
 *
 * Wave 39 m172 — pure decision helpers shared by the generic render
 * endpoint (app/api/internal/remotion/render-composition), the
 * composition-render-queue cron, and the render simulator. Kept free of
 * @remotion/renderer, Chromium, and the DB so the whole dispatch contract
 * is unit-testable without egress.
 *
 * The split that matters: a composition is either a MOVING render
 * (renderMedia → mp4, runs through the coordinator's bookend + music
 * finalize) or a STILL (renderStill → png, no audio, no bookends). The
 * registry's duration_frames is the single source of truth — the
 * thumbnail / postcard / lead-magnet / newsletter-thumb compositions all
 * register at durationInFrames=1.
 */
import type { CompositionTier, RemotionCompositionRow } from "./registry"
import type { RenderIntent } from "./render-coordinator"
import { compositionKeepsBrandIntro } from "../video/duration-model"
import { classifyRenderFailure } from "./render-failure-census"

/** A composition with <=1 frame is a still card (renderStill → PNG):
 *  thumbnails, postcards, lead-magnet, newsletter-thumb. Everything
 *  longer is a moving render (renderMedia → MP4). */
export function isStillComposition(durationFrames: number): boolean {
  return durationFrames <= 1
}

/** Output content type for the artifact a composition produces. */
export function outputContentType(durationFrames: number): "image/png" | "video/mp4" {
  return isStillComposition(durationFrames) ? "image/png" : "video/mp4"
}

/** File extension for the artifact. */
export function outputExtension(durationFrames: number): "png" | "mp4" {
  return isStillComposition(durationFrames) ? "png" : "mp4"
}

/** THE ONE SPELLING of the pickable render_status (§6). The two SQL claims —
 *  app/api/internal/remotion/render-composition/route.ts (`queued → rendering`)
 *  and app/api/cron/composition-render-queue/route.ts (oldest queued first) —
 *  filter on this token; `isPickableStatus` is the same rule as a predicate for
 *  code that already holds a row. A status vocabulary change lands HERE and
 *  reaches both claims and the simulator together. */
export const PICKABLE_RENDER_STATUS = "queued" as const

/** Statuses the queue picker is allowed to claim. A render is pickable
 *  only while 'queued'; 'rendering' rows are in-flight, terminal rows
 *  (succeeded/failed/cancelled) are done. */
export function isPickableStatus(status: string): boolean {
  return status === PICKABLE_RENDER_STATUS
}

/** Bookends + music only ever apply to moving renders. A still has no
 *  audio track to mix under and no intro/outro to concat. The endpoint
 *  forces them off for stills regardless of the registry flag. */
export function shouldApplyBookends(composition: RemotionCompositionRow): boolean {
  if (isStillComposition(composition.duration_frames)) return false
  return composition.supports_bookends
}

/**
 * THE STOCK CATEGORY STITCHED IN FRONT OF THE FILM (wave 87, lane 87D2 — owner:
 * "hook first"). A hook-first composition (lib/video/duration-model.ts
 * COMPOSITION_DURATION_RULES `hookFirst`, read through compositionKeepsBrandIntro)
 * never gets a brand_intro clip before its first word:
 * the live registry row carries stock_intro_category 'brand_intro' for the
 * talking head, which put up to MAX_BRAND_BOOKEND_SECONDS + a dissolve of sting
 * in front of the hook. The brand moves to the END (the outro category is
 * untouched). ONE decision for the coordinator, the render-cache predictor and
 * the plan-asset readiness pass — a key that predicted an intro the
 * coordinator no longer stitches would never hit. PURE.
 *
 * WAVE 89 (lane 89F): the rule is now BY PURPOSE, not by one declared flag —
 * every SCROLL-format composition (lib/video/duration-model.ts SEATED_PURPOSES,
 * compositionKeepsBrandIntro) opens on its own hook and gets no brand sting in
 * front; the live registry rows all carry brand_intro (read 2026-09-29) and are
 * untouched — a seated format (the memory film, the partners' recap, a dripped
 * presentation section, the CMA reel) still stitches its registered intro.
 */
export function stitchedIntroCategory(composition: Pick<RemotionCompositionRow, "composition_id" | "stock_intro_category">): string | null {
  return compositionKeepsBrandIntro(composition.composition_id) ? (composition.stock_intro_category ?? null) : null
}

/** A queued render row carries everything needed to reconstruct the
 *  RenderIntent the coordinator's finalizeCoordinatedRender expects.
 *  Pure — the endpoint resolves callerTier from the brokerage and hands
 *  it in. */
export interface QueuedRenderRow {
  brokerage_id:   string
  composition_id: string
  agent_user_id:  string | null
  entity_type:    string | null
  entity_id:      string | null
  scope_type:     "agent" | "team" | "brokerage"
  scope_id:       string | null
  input_props:    Record<string, unknown> | null
}

export function buildRenderIntent(
  row:        QueuedRenderRow,
  callerTier: CompositionTier,
): RenderIntent {
  return {
    brokerageId:  row.brokerage_id,
    callerTier,
    compositionId: row.composition_id,
    scopeType:    row.scope_type ?? "brokerage",
    scopeId:      row.scope_id ?? row.brokerage_id,
    agentUserId:  row.agent_user_id,
    entityType:   row.entity_type,
    entityId:     row.entity_id,
    // The Video Director stamps its per-situation music mood into input_props so
    // the coordinator picks a mood-matched licensed track (null = no preference).
    musicMood:    ((row.input_props as { music_mood?: unknown } | null)?.music_mood as string | undefined) ?? null,
  }
}

/** The props handed to selectComposition. Empty/absent → undefined so
 *  Remotion uses the registry defaultProps for that composition. */
export function resolveInputProps(
  inputProps: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!inputProps || Object.keys(inputProps).length === 0) return undefined
  return inputProps
}

/** A moving render gets a companion share/OG/AI-search thumbnail when the
 *  registry declares one (thumbnail_composition_id, e.g. VideoCoverThumb).
 *  Stills ARE the image — they never get a separate thumbnail pass. */
export function needsThumbnailPass(composition: RemotionCompositionRow): boolean {
  if (isStillComposition(composition.duration_frames)) return false
  return !!composition.thumbnail_composition_id
}

/** Thumbnail props are carried under input_props.thumbnail_props — the ONE key
 *  every producer stages the companion card on. The video's own props are NOT
 *  reused: the cover card has a different shape (kind / title / subtitle /
 *  eyebrow / seoHint).
 *
 *  ABSENT NO LONGER MEANS "USE THE DEFAULTS" (2026-09-03). This comment used to
 *  read "absent → undefined → the thumbnail composition's registry
 *  defaultProps", and that was the defect, not the design: Remotion merges `{}`
 *  over defaultProps, so a producer that staged nothing did not get a blank
 *  card, it got VideoCoverThumb's Studio fixture — "Just Listed — 123 Main
 *  Street", "$625K · 3 bd · 2 ba · Brickell, FL", "Your Agent" — published as
 *  the og:image and player poster of a real client's video. `undefined` is now
 *  the signal that the card is REFUSED: the companion pass in
 *  app/api/internal/remotion/render-composition asks missingContentProps about
 *  the thumbnail composition and skips the still rather than rendering the
 *  sample, and the producers stage a real card (gated by
 *  lib/geo/video-landing.ts companionCard) so there is one to render. */
export function resolveThumbnailProps(
  inputProps: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const tp = inputProps?.thumbnail_props
  if (tp && typeof tp === "object" && Object.keys(tp as object).length > 0) {
    return tp as Record<string, unknown>
  }
  return undefined
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTONOMOUS FAILED-RENDER RE-QUEUE (wave 57)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE GAP. `restart_failed_render` (m171, app/api/internal/remotion/render-
// composition/route.ts) already does the RIGHT thing — it refuses a "doomed"
// retry via missingContentProps rather than burning a render slot on a row
// that will fail the same way again — but the ONLY caller is
// executeAssetManagerAction, itself only reachable through
// approveAssetManagerAction (app/actions/asset-manager-resolutions.ts), a
// "use server" action a HUMAN calls from the dashboard
// (app/dashboard/admin/asset-manager-actions/client.tsx). A composition-
// render-queue drain never retries a failure on its own (its own header said
// so, verbatim, before this wave). Owner ruling: "this OS runs autonomous
// loops; every capability should run autonomously (manager signal / cron /
// kernel event) rather than waiting for a button." A render that failed on a
// transient cause (Chromium hiccup, a momentary stock-asset fetch failure)
// should not sit waiting for a broker to click "restart" in a dashboard they
// may not open for days.
//
// THE FIX. `shouldAutoRequeueFailedRender` is the SAME judgment
// `restart_failed_render` already makes (doomed retry → refuse; retries
// remaining + content-contract satisfied → requeue), reusable by a cron with
// no human in the loop. `MAX_AUTO_REQUEUE_ATTEMPTS` bounds it — the same
// "bounded, not infinite" shape app/api/cron/poll-did-videos/route.ts already
// uses for its own persist-retry loop (MAX_PERSIST_ATTEMPTS) — so a
// permanently-broken composition fails loudly after a handful of ticks rather
// than spinning forever; the row then still carries its `failed` status for a
// human (or the weekly Asset Manager digest) to see, exactly as before this
// wave for anything that exhausts its auto-retries.

/** How many times the autonomous loop will re-queue the SAME failed render
 *  row before leaving it `failed` for a human to look at. Small and bounded
 *  by design — see the header above. */
export const MAX_AUTO_REQUEUE_ATTEMPTS = 2

/** The minimal shape `shouldAutoRequeueFailedRender` needs from a
 *  `remotion_composition_renders` row. */
export interface FailedRenderRow {
  render_status: string
  /** NULL on a row from before this column existed — treated as 0 attempts. */
  retry_count:   number | null | undefined
  /** What the failure said — classified by lib/remotion/render-failure-census.ts. Absent/empty reads as `unknown` (transient, bounded). */
  error_message?: string | null
}

export interface AutoRequeueDecision {
  requeue: boolean
  /** Human-readable reason, logged either way — a skip is not silent. */
  reason:  string
}

/**
 * Should the autonomous loop flip this failed render back to 'queued'?
 *
 * PURE — no DB, no fetch. The caller supplies `missingProps`
 * (missingContentProps(row.composition_id, row.input_props) — content-
 * contract.ts is DB-free but does its own registry lookup, which this
 * function stays free of so it is testable with a bare array).
 *
 * Refuses (never requeues) when:
 *   · the row is not actually `failed` (already requeued by someone else, or
 *     never failed at all — no-op, not an error);
 *   · MAX_AUTO_REQUEUE_ATTEMPTS is already spent;
 *   · the render is DOOMED — the same content the row failed with is still
 *     missing required props, so a retry fails the identical way;
 *   · the failure is TERMINAL by the census (wave 153, lane 153J): its
 *     error_message lands in a signature whose `retry` is "terminal" — a media
 *     file that is gone, a bundle the deploy cannot build, props that throw in
 *     interpolate(). Another attempt of the same row fails identically, so the
 *     budget is not spent and the reason names the signature's fix.
 */
export function shouldAutoRequeueFailedRender(
  row: FailedRenderRow,
  missingProps: string[],
): AutoRequeueDecision {
  if (row.render_status !== "failed") {
    return { requeue: false, reason: `render is '${row.render_status}', not 'failed' — nothing to requeue` }
  }
  const attempts = row.retry_count ?? 0
  if (attempts >= MAX_AUTO_REQUEUE_ATTEMPTS) {
    return {
      requeue: false,
      reason: `already auto-retried ${attempts}/${MAX_AUTO_REQUEUE_ATTEMPTS} times — needs a human look, not another blind retry`,
    }
  }
  const failure = classifyRenderFailure(row.error_message)
  if (failure.signature?.retry === "terminal") {
    return {
      requeue: false,
      reason: `terminal failure (${failure.bucket}) — another attempt of this row would fail identically; ${failure.signature.fix}`,
    }
  }
  if (missingProps.length > 0) {
    return {
      requeue: false,
      reason: `doomed retry — still missing required content props (${missingProps.join(", ")}); requeueing would fail identically`,
    }
  }
  return { requeue: true, reason: `transient failure, content-contract satisfied, ${MAX_AUTO_REQUEUE_ATTEMPTS - attempts} auto-retr${MAX_AUTO_REQUEUE_ATTEMPTS - attempts === 1 ? "y" : "ies"} remaining` }
}

// ── A CLAIMED RENDER THAT NEVER FINISHED (wave 153, lane 153J) ───────────────
//
// render-composition claims a row `queued → rendering` and then has ONE function
// lifetime (its segment `maxDuration`, 300 s) to write `succeeded` / `failed` /
// `cancelled`. A process the platform kills at the cap, on a memory limit or on an
// instance recycle writes nothing — and nothing read a `rendering` row again: the
// auto-requeue above, the failure census and the OS-health detector all read
// `failed`, and the pipeline reaper reads ai_video_projects. The row spun forever,
// and its readers (lead magnets, the product-content autopilot) waited on it forever.
//
// m933 stamps `claimed_at` on the transition (a trigger — the claim's own update
// names no new column, so a lagging migration can never turn every claim into a
// PGRST204 refusal). A claim older than THREE route lifetimes cannot still be
// running; it is failed with RENDER_STALLED_TOKEN, which the census classifies
// `render_stalled` (transient), so the bounded requeue above retries it next tick.

/** The render routes' segment `maxDuration` — a literal Next reads statically
 *  (app/api/internal/remotion/render-composition/route.ts), so it is restated here;
 *  test:render-queue-recovery holds the stall threshold to ≥ 2× the route's real value. */
const RENDER_ROUTE_MAX_DURATION_SECONDS = 300

/** A claim older than this has outlived three route lifetimes and is dead. */
const RENDER_STALL_AFTER_MS = 3 * RENDER_ROUTE_MAX_DURATION_SECONDS * 1000

/** A `rendering` row with NO claim stamp was claimed before m933 (or the trigger is
 *  absent); its only clock is `created_at`, which can sit hours in the queue first, so
 *  it is judged on a far longer horizon rather than reaped early. */
const LEGACY_RENDER_STALL_AFTER_MS = 24 * 3_600_000

/** PURE. Is this `rendering` row a dead claim at `now`? */
export function isStalledRender(row: { claimed_at?: string | null; created_at?: string | null }, now: Date): boolean {
  const at = row.claimed_at ? Date.parse(row.claimed_at) : NaN
  if (Number.isFinite(at)) return now.getTime() - at >= RENDER_STALL_AFTER_MS
  const created = row.created_at ? Date.parse(row.created_at) : NaN
  return Number.isFinite(created) && now.getTime() - created >= LEGACY_RENDER_STALL_AFTER_MS
}

/** The error_message a recovered dead claim carries (the census keys on `render_stalled`). */
export function stalledRenderError(row: { claimed_at?: string | null; created_at?: string | null }, now: Date): string {
  const since = row.claimed_at ?? row.created_at ?? "an unknown time"
  const clock = row.claimed_at ? "claimed" : "created (no claim stamp — claimed before m933)"
  return `render_stalled: ${clock} at ${since} and no terminal status was written by ${now.toISOString()} — the render function was killed (route cap, memory limit or instance recycle); a transient failure for the bounded auto-requeue`
}

// ─── FAIR CLAIMING ACROSS TENANTS AND THEIR DESKS (wave 156, lane 156S) ─────────────────────────────────────────────────
//
// The queue tick used to take the ONE globally oldest `queued` row. One tick renders one row (Chromium + ffmpeg share one
// function's memory), so a tenant that queued a 200-row batch — a multi-office brokerage's listing week, a living-video
// refresh — held the head of the queue for 200 ticks while every other tenant's single render waited behind it. Oldest-
// first is fair between ROWS and unfair between TENANTS.
//
// The pick is now LEAST-RECENTLY-SERVED: among the queued rows in the window, the tenant with the FEWEST claims in the
// recent window goes first (ties → the tenant whose oldest queued row is oldest); inside that tenant, the same rule over
// its desks (scope_type:scope_id — the agent / team / brokerage scope the render was requested for; a multi-location
// brokerage's offices run as team scopes, and the render row carries no office column), and then that desk's oldest row.
// A tenant alone in the queue is served exactly as before (its oldest row). The rule only ORDERS: it never skips a tenant,
// never reads another tenant's content, and a row is still claimed by its own id with its own brokerage_id.

/** How far back a claim counts as "recently served" when ranking tenants. */
export const FAIR_PICK_RECENT_MS = 60 * 60_000

export interface FairPickQueued { id: string; brokerage_id: string; scope_type?: string | null; scope_id?: string | null; created_at?: string | null }
export interface FairPickClaim { brokerage_id: string | null; scope_type?: string | null; scope_id?: string | null }

/** The desk a render was requested for — the second fairness level. */
export function renderDeskKey(r: { brokerage_id?: string | null; scope_type?: string | null; scope_id?: string | null }): string {
  return `${r.scope_type ?? "brokerage"}:${r.scope_id ?? r.brokerage_id ?? ""}`
}

/**
 * PURE. Choose the next queued render: least-recently-served tenant, then its least-recently-served desk, then that desk's
 * oldest row. `queued` must be ordered oldest first (the reader asks for it that way); `recentClaims` are the claims inside
 * FAIR_PICK_RECENT_MS (rendering / succeeded / failed rows with a recent claimed_at). Null when nothing is queued.
 */
export function chooseFairRender<Q extends FairPickQueued>(queued: readonly Q[], recentClaims: readonly FairPickClaim[]): Q | null {
  if (queued.length === 0) return null
  const tenantLoad = new Map<string, number>()
  const deskLoad = new Map<string, number>()
  for (const c of recentClaims) {
    if (!c.brokerage_id) continue
    tenantLoad.set(c.brokerage_id, (tenantLoad.get(c.brokerage_id) ?? 0) + 1)
    const d = `${c.brokerage_id}|${renderDeskKey(c)}`
    deskLoad.set(d, (deskLoad.get(d) ?? 0) + 1)
  }
  const rank = (load: number, idx: number) => load * 1e9 + idx
  const firstIdxOfTenant = new Map<string, number>()
  queued.forEach((q, i) => { if (!firstIdxOfTenant.has(q.brokerage_id)) firstIdxOfTenant.set(q.brokerage_id, i) })
  let tenant: string | null = null
  let best = Infinity
  for (const [t, idx] of firstIdxOfTenant) {
    const r = rank(tenantLoad.get(t) ?? 0, idx)
    if (r < best) { best = r; tenant = t }
  }
  const mine = queued.map((q, i) => ({ q, i })).filter((x) => x.q.brokerage_id === tenant)
  const firstIdxOfDesk = new Map<string, number>()
  for (const { q, i } of mine) { const d = renderDeskKey(q); if (!firstIdxOfDesk.has(d)) firstIdxOfDesk.set(d, i) }
  let desk: string | null = null
  best = Infinity
  for (const [d, idx] of firstIdxOfDesk) {
    const r = rank(deskLoad.get(`${tenant}|${d}`) ?? 0, idx)
    if (r < best) { best = r; desk = d }
  }
  return mine.find((x) => renderDeskKey(x.q) === desk)?.q ?? null
}
