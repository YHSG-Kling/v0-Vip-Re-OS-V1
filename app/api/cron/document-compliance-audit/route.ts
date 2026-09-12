import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runDocumentComplianceAudit, defaultTextChecker } from "@/lib/kernel/document-compliance-audit"

/**
 * DOCUMENT-TEXT COMPLIANCE AUDIT cron (hourly) — the live equivalent of the legacy
 * workflows/audit-document.json + workflows/broker-audit.json. Sweeps recently-uploaded
 * deal documents (client_documents tied to a transaction or contact) that have NOT yet been
 * audited, runs the hybrid compliance pass per document (ocr-pdf text layer + deterministic
 * checklist + the semantic gateway-TEXT pass, plus the default gateway VISION pass for
 * execution marks), records the result on the doc's ai_metadata, and on
 * findings escalates to the broker via the existing notifications rail + the manager-signals
 * bus. The sweep is the lower-risk trigger (no upload-path coupling); idempotent per
 * (document, extracted-text content) so re-runs are cheap and never double-escalate.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "document-compliance-audit",
    cron_path: "/app/api/cron/document-compliance-audit/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, audited = 0, findings = 0, escalations = 0, notAudited = 0

  try {
    // Recently-uploaded deal documents (last 48h) that have no audit yet. A deal document
    // is one tied to a transaction OR a contact; un-audited = ai_metadata has no audit key.
    const sinceIso = new Date(Date.now() - 48 * 3_600_000).toISOString()
    const { data: docs, error } = await supabase
      .from("client_documents")
      .select("id, ai_metadata, created_at")
      .gte("created_at", sinceIso)
      .or("transaction_id.not.is.null,contact_id.not.is.null")
      .order("created_at", { ascending: false })
      .limit(500)
    if (error) throw error

    for (const row of (docs ?? []) as Array<{ id: string; ai_metadata: any }>) {
      const prior = row.ai_metadata?.document_compliance_audit
      // Skip docs already audited with a COMPLETE result; retry 'not_audited' (creds may have
      // been configured since) AND 'partial_audit' (a degraded pass — e.g. vision was down — that
      // a later run can complete into the full hybrid). Re-runs over the same inputs are no-ops
      // (idempotent content hash), so retrying these is cheap and never double-escalates.
      if (prior && prior.status && prior.status !== "not_audited" && prior.status !== "partial_audit") continue
      scanned += 1
      try {
        // The semantic gateway-TEXT pass is opt-in by module contract (the simulator injects
        // seams so the live test spends no tokens); PRODUCTION opts in here so the content
        // checks (correct form, names/addresses consistency, disclosure clauses) actually run.
        // defaultTextChecker degrades honestly to null (deterministic-only) without a gateway key.
        const r = await runDocumentComplianceAudit({ documentId: row.id }, { textChecker: defaultTextChecker }, supabase)
        if (r.status === "not_audited") notAudited += 1
        else {
          audited += 1
          if (r.status === "findings") { findings += 1; escalations += r.escalated }
        }
      } catch (e: any) {
        errors.push(`${row.id}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: audited,
      metadata: { scanned, audited, findings, escalations, notAudited, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, audited, findings, escalations, notAudited })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
