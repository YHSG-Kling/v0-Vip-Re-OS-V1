import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAutoFileSweep } from "@/lib/kernel/document-autofile"

/**
 * AI AUTO-FILING CLERK cron (suggest every 15 min — "*\/15 * * * *"). For each
 * brokerage, sweeps recently-uploaded UNFILED client_documents (no canonical
 * doc_category yet), classifies each (gateway classifier → deterministic keyword
 * floor) into the canonical doc_category enum, resolves the deal it belongs to
 * (already-stamped transaction, else the uploader's single open transaction), and
 * FILES it (set doc_category + document_type folder key + transaction_id +
 * ai_metadata audit) — recording each filing on lifecycle_events. HONEST: a
 * low-confidence doc is left UNFILED and flagged for human review (never misfiled).
 * Idempotent end-to-end (an already-filed doc is a no-op). In-app canonical filing;
 * a Google Drive sync is a documented follow-up (no Drive folder API is wired).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "document-autofile",
    cron_path: "/app/api/cron/document-autofile/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, filed = 0, flagged = 0, alreadyFiled = 0, skipped = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runAutoFileSweep(b.id, {}, supabase)
        scanned += r.scanned
        filed += r.filed
        flagged += r.flagged
        alreadyFiled += r.alreadyFiled
        skipped += r.skipped
        if (r.errors.length) errors.push(...r.errors.map((e) => `${b.id}: ${e}`))
      } catch (e: any) {
        errors.push(`${b.id}: ${e?.message ?? String(e)}`)
      }
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: filed,
      metadata: { scanned, filed, flagged, alreadyFiled, skipped, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, filed, flagged, alreadyFiled, skipped })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
