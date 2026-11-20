/**
 * app/api/cron/composition-render-queue/route.ts
 *
 * Wave 39 m172 — drains the generic Remotion render queue. The Asset
 * Manager's start_render / restart_failed_render actions (m171) and the
 * W40 ad creator claim remotion_composition_renders rows in 'queued'
 * state; this cron sweeps them and POSTs each to the generic render
 * endpoint (render-composition), which renders ANY registered
 * composition.
 *
 * Mirrors listing-promo-render: one row per tick, serialized — concurrent
 * renders would compete for the same Chromium / ffmpeg memory pool on a
 * single Vercel function instance.
 *
 * AUTONOMOUS FAILED-RENDER RE-QUEUE (wave 57 — owner ruling "this OS runs
 * autonomous loops... rather than waiting for a button"). Before this wave a
 * failed render sat at 'failed' until a human clicked restart_failed_render
 * in the Asset Manager dashboard — this cron never retried a failure on its
 * own. It now also re-queues a BOUNDED number of 'failed' rows itself, using
 * the SAME doomed-retry judgment restart_failed_render already makes
 * (lib/remotion/render-decision.ts shouldAutoRequeueFailedRender +
 * lib/remotion/content-contract.ts missingContentProps) so a transient
 * failure heals itself while a render that is missing required content still
 * waits for a human to supply it. See m622-composition-render-retry-count.sql
 * for the column this bounds on.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createCronRunContextAction, recordCronSuccessAction, recordCronFailureAction } from "@/app/actions/cron-kernel"
import { createServiceClient } from "@/lib/supabase/service"
import { PICKABLE_RENDER_STATUS } from "@/lib/remotion/render-decision"
import { recoverStalledRenders, requeueFailedRenders } from "@/lib/remotion/registry"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const denied = verifyCronAuth(req)
  if (denied) return denied
  const cronRun = await createCronRunContextAction({ cron_name: "composition-render-queue", cron_path: "/app/api/cron/composition-render-queue/route.ts" }) // run row + cron decision door (155R1)
  if (cronRun.data?.held) return NextResponse.json({ success: true, held: true, decision: cronRun.data.decision })
  // verifyCronAuth refused an unset CRON_SECRET above, so it is present here;
  // the self-calls below forward it as the same Bearer credential.
  const expected = process.env.CRON_SECRET as string

  const svc = createServiceClient()

  // Determinism sweep (m310) — this is the video-ops cron, so it is where the
  // Asset Manager learns that a composition can never reuse a render. Runs
  // whether or not there is a queued row, because a leak is a standing
  // condition and an empty queue is when the tick has time for it. Never
  // throws; a sweep failure must not stop the queue from draining.
  const { sweepDeterminismLeaks } = await import("@/lib/remotion/render-cache")
  const leakSweep = await sweepDeterminismLeaks({ limit: 200 })

  // LIVING-VIDEO REFRESH (m312) — a delivered video whose facts have moved is a
  // video that now says something untrue. Runs BEFORE the queue drain so a
  // refresh staged this tick is picked up on the next one. Cheap by design: a
  // few indexed reads per living video and an early exit on an unchanged key,
  // so the steady state finds nothing and costs nothing. Never throws.
  const { refreshLivingVideos } = await import("@/lib/video/living-video-sweep")
  const livingRefresh = await refreshLivingVideos({ limit: 200 })

  // DEAD-CLAIM RECOVERY, then the AUTONOMOUS FAILED-RENDER RE-QUEUE (wave 57) — see
  // this file's header. TOMBSTONE (wave 153, lane 153J): the requeue loop that lived
  // inline here moved to lib/remotion/registry.ts requeueFailedRenders (the survivor,
  // now proof-driven by test:render-queue-recovery); it read the 5 oldest failed rows
  // unfiltered, so five spent rows starved every newer retry, and it never read
  // error_message, so terminal failures burned both retries. recoverStalledRenders
  // runs FIRST: a claim the route never finished (killed at its 300 s cap / memory /
  // recycle) used to sit 'rendering' forever; it is failed `render_stalled` here and
  // retried by the requeue below in the same tick. Each step is wrapped whole and
  // reports its own refusal: a missing column (m622 retry_count, m933 claimed_at) on
  // an environment that has not applied the migration degrades THAT step to a
  // reported no-op, never the queue drain beneath it (§4 fail closed, on this step).
  const stallRecovery: { recovered: Array<{ id: string; reason: string }>; skipped: Array<{ id: string; reason: string }>; error?: string } =
    { recovered: [], skipped: [] }
  try {
    const r = await recoverStalledRenders(svc)
    stallRecovery.recovered = r.moved
    stallRecovery.skipped = r.skipped
    if (r.error) { stallRecovery.error = r.error; console.error(`[composition-render-queue] ${r.error} (dead-claim recovery degraded to a no-op this tick)`) }
    if (r.moved.length > 0) console.warn(`[composition-render-queue] recovered ${r.moved.length} dead render claim(s): ${r.moved.map((m) => m.id).join(", ")}`)
  } catch (e) {
    stallRecovery.error = (e as Error).message
    console.error("[composition-render-queue] dead-claim recovery failed (degrading to no-op):", (e as Error).message)
  }
  const autoRequeue: { requeued: Array<{ id: string; reason: string }>; skipped: Array<{ id: string; reason: string }>; error?: string } =
    { requeued: [], skipped: [] }
  try {
    const r = await requeueFailedRenders(svc)
    autoRequeue.requeued = r.moved
    autoRequeue.skipped = r.skipped
    if (r.error) { autoRequeue.error = r.error; console.error(`[composition-render-queue] ${r.error} (auto-requeue degraded to a no-op this tick)`) }
  } catch (e) {
    autoRequeue.error = (e as Error).message
    console.error("[composition-render-queue] auto-requeue sweep failed (degrading to no-op):", (e as Error).message)
  }

  // FAILURE CENSUS (wave 142, lane 142F; owner: "figure out what remotion issues we keep
  // running into"). The live table held 0 rows on 2026-10-19 — there is no production
  // failure history yet — so this is the READER that classifies the FIRST one the moment
  // it is written: every failed row of the last 7 days folded through the recorded
  // root-cause signatures (lib/remotion/render-failure-census.ts), printed in the tick's
  // response and on the log line. Best-effort; a refused read is reported, never zero.
  let failureCensus: { total: number; byBucket: Record<string, unknown>; lines: string[]; error?: string } = { total: 0, byBucket: {}, lines: [] }
  try {
    const { censusRenderFailures, describeRenderFailureCensus } = await import("@/lib/remotion/render-failure-census")
    const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString()
    const { data: failedWeek, error: censusErr } = await svc.from("remotion_composition_renders")
      .select("id, composition_id, error_message, retry_count")
      .eq("render_status", "failed")
      .gte("created_at", since)
      .limit(200)
    if (censusErr) {
      failureCensus = { total: 0, byBucket: {}, lines: [], error: `census read refused: ${censusErr.message}` }
    } else {
      const census = censusRenderFailures((failedWeek ?? []) as Array<{ id: string; composition_id: string | null; error_message: string | null; retry_count: number | null }>)
      const lines = describeRenderFailureCensus(census)
      failureCensus = { total: census.total, byBucket: census.byBucket as Record<string, unknown>, lines }
      if (census.total > 0) console.warn(`[composition-render-queue] render failure census (7d): ${census.total} failed — ${lines.join(" | ")}`)
    }
  } catch (e) {
    failureCensus = { total: 0, byBucket: {}, lines: [], error: (e as Error).message }
  }

  // Oldest queued row first (idx_remotion_renders_queued covers this).
  const { data: rows, error } = await svc.from("remotion_composition_renders")
    .select("id, composition_id, brokerage_id")
    .eq("render_status", PICKABLE_RENDER_STATUS)
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    if (cronRun.data) await recordCronSuccessAction({ context_id: cronRun.data.context_id }) // 155R1
    return NextResponse.json({
      ran_at: new Date().toISOString(), processed: 0,
      leak_sweep: leakSweep, living_refresh: livingRefresh, stall_recovery: stallRecovery, auto_requeue: autoRequeue,
      failure_census: failureCensus,
    })
  }

  const row = rows[0] as { id: string; composition_id: string; brokerage_id: string }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")

  try {
    const r = await fetch(`${baseUrl}/api/internal/remotion/render-composition`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${expected}`,
      },
      body: JSON.stringify({ render_id: row.id }),
    })
    const renderBody = await r.json().catch(() => ({}))
    if (cronRun.data) await recordCronSuccessAction({ context_id: cronRun.data.context_id }) // 155R1
    return NextResponse.json({
      ran_at:         new Date().toISOString(),
      processed:      1,
      render_id:      row.id,
      composition_id: row.composition_id,
      render_status:  r.status,
      render_body:    renderBody,
      leak_sweep:     leakSweep,
      living_refresh: livingRefresh,
      stall_recovery: stallRecovery,
      auto_requeue:   autoRequeue,
      failure_census: failureCensus,
    })
  } catch (e) {
    if (cronRun.data) await recordCronFailureAction({ context_id: cronRun.data.context_id, error: "HTTP 500 response", stage: "main-processing" }) // 155R1
    return NextResponse.json({
      ran_at:    new Date().toISOString(),
      processed: 0,
      render_id: row.id,
      error:     (e as Error).message,
    }, { status: 500 })
  }
}
