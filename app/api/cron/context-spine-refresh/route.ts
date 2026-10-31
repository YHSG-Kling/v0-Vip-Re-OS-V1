import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { refreshRecentContactSpines, realSummaryRewriter } from "@/lib/kernel/conversation-memory"

/**
 * CONTEXT SPINE REFRESH cron. The write side of the conversation-memory spine: for each
 * brokerage, refresh the per-contact running summary (contacts.metadata.context_spine) for
 * contacts that had a recent conversation, so the whole team always reads a fresh running
 * note. Bounded (recency window + hard cap), idempotent, composes only from real interaction
 * rows (never fabricates).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "context-spine-refresh",
    cron_path: "/app/api/cron/context-spine-refresh/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let contactsConsidered = 0, spinesRefreshed = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        // The warm-paragraph rewriter is an opt-in seam (the simulator injects its own);
        // PRODUCTION opts in here. realSummaryRewriter may only re-phrase the deterministic
        // facts and returns null on any failure, so the deterministic draft always stands.
        const r = await refreshRecentContactSpines(b.id, { rewriter: realSummaryRewriter }, supabase)
        contactsConsidered += r.contactsConsidered
        spinesRefreshed += r.spinesRefreshed
        if (r.errors.length) errors.push(...r.errors.slice(0, 3))
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: spinesRefreshed,
      metadata: { contactsConsidered, spinesRefreshed, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, contactsConsidered, spinesRefreshed })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
