import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sweepEsignDocSync } from "@/lib/transactions/esign-doc-sync-sweep"

/**
 * ESIGN DOCUMENT SYNC cron (every 4 hours, offset :17 — see CRON_REGISTRY in
 * lib/kernel/cron-dispatch.ts for the exact schedule; not quoted here because
 * its own asterisk-slash syntax would close this block comment).
 *
 * BUILT this lane (orphan doctrine §1.2, m614) — the autonomous half
 * app/actions/forms-kernel.ts:syncEsignDocsAction was missing. The portal
 * documents page (app/portal/[contactId]/documents/page.tsx) already syncs a
 * transaction's provider documents, but only when that contact happens to open
 * their portal; nothing pulled a listing's pre-contract packet at all, and
 * nothing pulled EITHER on a schedule. This route sweeps both lanes through
 * the same two persisting cores the portal page and the UI action call
 * (lib/transactions/sync-from-provider.ts) — one path, three callers, never a
 * fourth (§6).
 *
 * SERVICE CLIENT, DELIBERATELY — same reasoning as storage-orphan-sweep: a
 * cron has no cookies, so the work cannot route through a session-gated
 * `"use server"` action.
 *
 * HONEST REPORTING. Pre-rollout `external_provider_source` is NULL on every
 * live transaction and listing row (m106 / m614 just added the columns), so
 * "swept 0" is the ordinary case here, not evidence of anything — the sweep's
 * `outcome` distinguishes that from a refused candidate read, and this route
 * surfaces the distinction as a 500 rather than folding it into a calm 200.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "esign-doc-sync",
    cron_path: "/app/api/cron/esign-doc-sync/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  try {
    const result = await sweepEsignDocSync(createServiceClient(), { limit: 200 })

    if (result.outcome === "read_refused") {
      await recordCronFailureAction({
        context_id: contextId,
        error: new Error(`the sync candidate list could not be read: ${result.error}`),
        stage: "candidate-read",
      }).catch(() => {})
      return NextResponse.json(
        {
          ok: false,
          outcome: result.outcome,
          error: result.error,
          note: "candidates were NOT read — this is not the same as zero due for sync",
        },
        { status: 500 },
      )
    }

    const failures = result.entries.filter((e) => !e.result.ok)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.synced,
      metadata: {
        transactions_examined: result.transactionsExamined,
        listings_examined:     result.listingsExamined,
        synced:                result.synced,
        failed:                result.failed,
        failed_entries: failures.slice(0, 10).map((e) => `${e.kind}:${e.id} — ${e.result.error}`),
      },
    }).catch(() => {})

    if (result.failed > 0) {
      console.error(`[esign-doc-sync] ${result.failed} sync call(s) failed out of ${result.entries.length}`)
    }

    return NextResponse.json({
      ok: true,
      transactions_examined: result.transactionsExamined,
      listings_examined:     result.listingsExamined,
      synced:                result.synced,
      failed:                result.failed,
    })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
