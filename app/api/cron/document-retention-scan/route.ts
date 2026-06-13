import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runRetentionScan } from "@/lib/kernel/document-custody"

/**
 * DOCUMENT RETENTION SCAN cron (suggest weekly — "0 6 * * 1", Monday 6am). For each
 * brokerage, scans client_documents and FLAGS every document PAST its retention window
 * (retentionPolicyFor(doc_category) defaults — 3–7yr typical, HONEST about being a
 * default, not law) for human REVIEW.
 *
 * SAFE BY DESIGN: this is a REPORT — it NEVER deletes. Custody of record means an
 * overdue document is surfaced to a human who decides (archive / purge) per the
 * brokerage's own verified state + policy. Documents with no parsable created_at are
 * simply not flagged (cannot judge what we cannot date).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "document-retention-scan",
    cron_path: "/app/api/cron/document-retention-scan/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0
  let overdue = 0
  const overdueByBrokerage: Record<string, number> = {}

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runRetentionScan(b.id, supabase)
        scanned += r.scanned
        overdue += r.overdue.length
        if (r.overdue.length) overdueByBrokerage[b.id] = r.overdue.length
        if (r.errors.length) errors.push(...r.errors.map((e) => `${b.id}: ${e}`))
      } catch (e: any) {
        errors.push(`${b.id}: ${e?.message ?? String(e)}`)
      }
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: overdue,
      metadata: { scanned, overdue, overdueByBrokerage, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, overdue, overdueByBrokerage })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
