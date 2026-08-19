/**
 * lib/kernel/tenant-guard.ts — the tenant-safety FINDINGS writer.
 *
 * ── TOMBSTONE (orphan burn-down, lane E) ────────────────────────────────────
 *
 * `assertSameBrokerage` and `withBrokerageGuard` were DELETED from this file.
 * Both had zero callers, and this module's own header described them as
 * "opt-in by design ... by the end of Sprint 1 every service-role action that
 * touches tenant tables should be wrapped". That sprint never happened, and in
 * the meantime the codebase enforced the SAME rule three other ways that
 * together cover every call site. Naming each, with file:line, because a
 * tenant-isolation primitive is not something to delete on a hunch:
 *
 *   1. CI, over the whole repo — scripts/tenant-scope-guard.ts:1
 *      (`npm run test:tenant-scope`, in the guard chain). Every
 *      `.from("<tenant table>")` chain must show scoping evidence — a
 *      brokerage_id filter, a PK/unique-id lookup, or a validated parent id —
 *      or the build FAILS with the file and line. Its baseline
 *      (scripts/tenant-scope-baseline.json) holds exactly FIVE grandfathered
 *      entries, all in app/api/migrate/verify/route.ts, and may only shrink.
 *      That is strictly wider coverage than an opt-in wrapper ever reached:
 *      the wrapper protected the actions someone remembered to wrap; the lint
 *      protects the ones nobody did.
 *
 *   2. In the DATABASE — the RLS policies from m466 / m471 / m472 and the
 *      helper functions public.is_brokerage_admin() /
 *      public.is_brokerage_finance_admin(), verified by
 *      `npm run test:cross-tenant-read` and `npm run test:child-tenant-scope`.
 *
 *   3. At the ~28 real cross-tenant JOIN POINTS, each with a refusal shape its
 *      caller can act on — which a throwing assertion could not have given
 *      them. Live examples: lib/transactions/offer-bridge.ts:130,
 *      lib/campaigns/enroll-in-sequence.ts:56, lib/marketing/qr-asset-linker.ts:90,
 *      lib/audiences/audience-sync.ts:153, lib/providers/dispatch.ts:773.
 *      Those return `{ success:false, error:"tenant_mismatch" }` or `notFound()`;
 *      `assertSameBrokerage` threw, so adopting it would have meant a THIRD
 *      vocabulary over one rule — the thing the owner ruling in
 *      lib/auth/resolve-user-role.ts:107 explicitly forbids.
 *
 * Nothing was merged onto those survivors: the deleted pair carried no check
 * they lack. `withBrokerageGuard`'s auto-stamping of brokerage_id on INSERT is
 * the one behaviour with no exact twin, and it is unreachable in practice —
 * its `GuardedQuery = unknown` return erased the PostgrestFilterBuilder type,
 * so every adopting call site would have had to cast, which is why none did.
 *
 * WHAT REMAINS HERE is the half that IS wired: TenantViolationError (the named
 * error type for a cross-tenant refusal) and logTenantFinding, the best-effort
 * writer for tenant_safety_findings, called by the tenant-safety-scan cron
 * (app/api/cron/tenant-safety-scan/route.ts) and surfaced at
 * /dashboard/admin/tenant-safety.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

// ─── Error class ─────────────────────────────────────────────────────────────

export class TenantViolationError extends Error {
  readonly code = "TENANT_VIOLATION" as const
  readonly expected: string
  readonly actual: string | null | undefined
  readonly context: string

  constructor(args: {
    expected: string
    actual: string | null | undefined
    context: string
    message?: string
  }) {
    super(
      args.message ??
        `Tenant violation in ${args.context}: expected brokerage_id=${args.expected}, got ${args.actual ?? "null"}`,
    )
    this.name = "TenantViolationError"
    this.expected = args.expected
    this.actual = args.actual
    this.context = args.context
  }
}

// ─── Best-effort audit-log write ─────────────────────────────────────────────

/**
 * Records a finding in tenant_safety_findings. Called by the scan cron and
 * by catch handlers anywhere TenantViolationError surfaces in production.
 * Idempotency-friendly: callers pass a stable scanRunId so re-runs don't
 * duplicate rows for the same problem on the same scan.
 */
export async function logTenantFinding(input: {
  scanRunId: string
  findingType:
    | "rows_missing_brokerage_id"
    | "table_missing_brokerage_id"
    | "table_missing_rls_policy"
    | "cross_tenant_join_risk"
    | "listing_missing_agreement"
  tableName: string
  severity?: "low" | "medium" | "high" | "critical"
  details?: Record<string, unknown>
  affectedRows?: number
}): Promise<void> {
  try {
    const svc = createServiceClient()
    await svc.from("tenant_safety_findings").insert({
      scan_run_id:    input.scanRunId,
      finding_type:   input.findingType,
      table_name:     input.tableName,
      severity:       input.severity ?? "high",
      details:        input.details ?? {},
      affected_rows:  input.affectedRows ?? null,
    })
  } catch (err) {
    console.error("[tenant-guard] logTenantFinding failed (non-fatal):", err)
  }
}
