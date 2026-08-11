import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sweepStorageOrphans } from "@/lib/storage/orphan-sweeper"

/**
 * STORAGE ORPHAN SWEEP cron (suggest hourly — "0 * * * *").
 *
 * Every document lane in this codebase uploads bytes and then mints a URL for
 * them. `lib/storage/put-and-sign.ts` now undoes the upload when the second step
 * fails; only when that UNDO is itself refused does a row land on
 * `storage_orphaned_objects` (m387). This route retries those removes. Nothing
 * in the tree has ever swept a bucket before it.
 *
 * SERVICE CLIENT, DELIBERATELY. The worklist is service-role only (RLS on, no
 * permissive policy) because it names raw object paths across every tenant. A
 * cron has no cookies, so the work must not route through a session-gated
 * `"use server"` action — the earnest-money watchdog did exactly that and
 * returned Unauthorized on every iteration for its whole life.
 *
 * HONEST REPORTING. Pre-rollout the buckets and the worklist are EMPTY, so "the
 * sweep found nothing" is not evidence of anything. The sweeper's `outcome`
 * separates a refused read from an empty worklist, and this route surfaces that
 * distinction instead of collapsing both into a zero count: a refused read is a
 * 500, not a clean bill of health.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "storage-orphan-sweep",
    cron_path: "/app/api/cron/storage-orphan-sweep/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  try {
    const result = await sweepStorageOrphans(createServiceClient(), { limit: 200 })

    if (result.outcome === "read_refused") {
      await recordCronFailureAction({
        context_id: contextId,
        error: new Error(`the orphan worklist could not be read: ${result.error}`),
        stage: "worklist-read",
      }).catch(() => {})
      return NextResponse.json(
        {
          ok: false,
          outcome: result.outcome,
          error: result.error,
          note: "the worklist was NOT read — this is not the same as an empty worklist",
        },
        { status: 500 },
      )
    }

    const bookkeepingErrors = result.outcome === "swept" ? result.bookkeepingErrors : []

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.cleaned,
      metadata: {
        outcome:            result.outcome,
        examined:           result.examined,
        cleaned:            result.cleaned,
        still_failing:      result.stillFailing,
        bookkeeping_errors: bookkeepingErrors.slice(0, 10),
        still_failing_objects: result.swept
          .filter((s) => s.error !== null)
          .slice(0, 10)
          .map((s) => `${s.bucket}/${s.objectPath}: ${s.error}`),
      },
    }).catch(() => {})

    if (result.stillFailing > 0 || bookkeepingErrors.length > 0) {
      console.error(
        `[storage-orphan-sweep] ${result.stillFailing} object(s) still could not be removed` +
        (bookkeepingErrors.length > 0 ? `; ${bookkeepingErrors.length} bookkeeping write(s) refused` : ""),
      )
    }

    return NextResponse.json({
      ok: true,
      outcome:       result.outcome,
      examined:      result.examined,
      cleaned:       result.cleaned,
      still_failing: result.stillFailing,
      bookkeeping_errors: bookkeepingErrors,
    })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
