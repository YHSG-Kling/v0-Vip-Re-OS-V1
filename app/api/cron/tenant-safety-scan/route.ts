import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Tenant Safety Scan Cron
 *
 * Runs daily. Three checks:
 *   1. table_missing_brokerage_id  — tenant-looking tables (have agent_id /
 *      contact_id / listing_id / transaction_id / user_id) but lack a
 *      brokerage_id column. Surfaced via tenant_safety_schema_check() RPC.
 *   2. table_missing_rls_policy    — tables WITH brokerage_id but no RLS
 *      policy filtering by it. Migration 1032 covered the backlog; this
 *      catches new tables that bypassed the policy template.
 *   3. rows_missing_brokerage_id   — on a curated list of sensitive tables,
 *      count rows where brokerage_id IS NULL.
 *
 * Findings persist in tenant_safety_findings; broker/admin/compliance
 * see them via the admin dashboard widget.
 */

const SENSITIVE_TABLES = [
  "transactions", "listings", "offers", "showings", "contacts",
  "transaction_milestones", "transaction_commissions", "commissions",
  "agent_earnings", "brokerage_earnings", "team_earnings",
  "deal_health_scores", "listing_health_scores",
  "proactive_interventions", "listing_health_interventions",
  "lifecycle_events", "messages", "activities", "notifications",
  "documents", "cma_reports", "listing_presentations",
  "workflow_runs", "compliance_events",
]

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctxResult = await createCronRunContextAction({
    cron_name: "tenant-safety-scan",
    cron_path: "/app/api/cron/tenant-safety-scan/route.ts",
  })
  if (!ctxResult.success || !ctxResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctxResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  const scanRunId = crypto.randomUUID()

  const summary = {
    scanRunId,
    tables_missing_brokerage_id: 0,
    tables_missing_rls_policy:   0,
    rows_missing_brokerage_id:   0,
    findings_inserted:           0,
  }

  try {
    // ─── Schema-level checks via SECURITY DEFINER RPC ─────────────────────
    const { data: schemaRows, error: rpcError } = await supabase.rpc("tenant_safety_schema_check")

    if (rpcError) {
      console.error("[tenant-safety-scan] schema check RPC failed:", rpcError)
    } else if (Array.isArray(schemaRows)) {
      for (const row of schemaRows as Array<{ table_name: string; missing_col: string | null; missing_policy: string | null }>) {
        if (row.missing_col) {
          await supabase.from("tenant_safety_findings").insert({
            scan_run_id:  scanRunId,
            finding_type: "table_missing_brokerage_id",
            table_name:   row.table_name,
            severity:     "high",
            details:      { detected_at: new Date().toISOString() },
          })
          summary.tables_missing_brokerage_id++
          summary.findings_inserted++
        }
        if (row.missing_policy) {
          await supabase.from("tenant_safety_findings").insert({
            scan_run_id:  scanRunId,
            finding_type: "table_missing_rls_policy",
            table_name:   row.table_name,
            severity:     "critical",
            details:      { detected_at: new Date().toISOString() },
          })
          summary.tables_missing_rls_policy++
          summary.findings_inserted++
        }
      }
    }

    // ─── Row-level check on the curated sensitive list ────────────────────
    for (const tableName of SENSITIVE_TABLES) {
      const { count, error } = await supabase
        .from(tableName)
        .select("id", { count: "exact", head: true })
        .is("brokerage_id", null)

      if (error) {
        // Table may not have brokerage_id or may not exist — skip silently.
        continue
      }
      if ((count ?? 0) > 0) {
        await supabase.from("tenant_safety_findings").insert({
          scan_run_id:    scanRunId,
          finding_type:   "rows_missing_brokerage_id",
          table_name:     tableName,
          severity:       "critical",
          details:        { detected_at: new Date().toISOString() },
          affected_rows:  count,
        })
        summary.rows_missing_brokerage_id += count ?? 0
        summary.findings_inserted++
      }
    }

    // ─── Day-one assistant backfill ────────────────────────────────────────
    // Every tenant must have a NAMED assistant (it answers the phone, hosts
    // the weekly show, presents report videos). Signup seeds new tenants; this
    // idempotent sweep covers tenants that predate the seeder or missed it.
    let assistantsSeeded = 0
    try {
      const { seedStarterAssistant } = await import("@/lib/kernel/assistant-starter")
      const { data: allBrokerages } = await supabase.from("brokerages").select("id").limit(2000)
      for (const b of ((allBrokerages ?? []) as Array<{ id: string }>)) {
        const r = await seedStarterAssistant(supabase, b.id)
        if (r.seeded) assistantsSeeded += 1
      }
    } catch { /* best-effort — next scan retries */ }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.findings_inserted,
      metadata:          { ...summary, scanned_tables: SENSITIVE_TABLES.length, assistants_seeded: assistantsSeeded },
    })

    return NextResponse.json({ message: "Tenant safety scan complete", summary, assistantsSeeded })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Scan failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
