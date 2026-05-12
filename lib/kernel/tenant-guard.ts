/**
 * lib/kernel/tenant-guard.ts — runtime tenant-isolation enforcement.
 *
 * LAYER 0 — defense-in-depth for the 373 server-action call sites that
 * use createServiceClient(). The service-role bypasses RLS by design,
 * so the only thing standing between brokerage A and brokerage B's data
 * is whether the action's developer remembered to .eq("brokerage_id", x).
 *
 * This module makes that remembering automatic.
 *
 * Three exports:
 *   - assertSameBrokerage(a, b)   — throws TenantViolationError if a !== b
 *   - withBrokerageGuard(brokerageId, fn) — wraps a service-client function
 *     so every read against tenant tables is auto-filtered, and every write
 *     asserts brokerage_id matches the guard
 *   - logTenantViolation(...)     — best-effort audit write to
 *     tenant_safety_findings when something looks wrong
 *
 * The guard is opt-in by design — adding it to one action at a time lets
 * us migrate without breaking anything. By the end of Sprint 1 every
 * service-role action that touches tenant tables should be wrapped.
 *
 * Combine with the RLS policies installed by migration 1032: even if the
 * guard misses, RLS now catches any direct-auth-user reads, and the
 * tenant-safety-scan cron flags any rows with NULL brokerage_id.
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

// ─── Primitive assertion ─────────────────────────────────────────────────────

/**
 * Throws TenantViolationError unless both arguments resolve to the same
 * non-null brokerage id. Use at every join point where a server action
 * reads a row from table A and writes/reads a row from table B that should
 * belong to the same brokerage.
 *
 * Example:
 *   const offer = await svc.from("offers").select("brokerage_id, ...").single()
 *   assertSameBrokerage(offer.brokerage_id, actorContext.brokerageId, "negotiationCoPilot")
 */
export function assertSameBrokerage(
  a: string | null | undefined,
  b: string | null | undefined,
  context: string,
): asserts a is string {
  if (!a) {
    throw new TenantViolationError({ expected: b ?? "any", actual: a, context, message: `${context}: brokerage_id is null` })
  }
  if (!b) {
    throw new TenantViolationError({ expected: a, actual: b, context, message: `${context}: caller brokerage_id is null` })
  }
  if (a !== b) {
    throw new TenantViolationError({ expected: b, actual: a, context })
  }
}

// ─── Guarded service client ──────────────────────────────────────────────────
//
// withBrokerageGuard returns a thin wrapper around the service client that:
//   • injects .eq("brokerage_id", brokerageId) into every SELECT/UPDATE/DELETE
//   • auto-stamps brokerage_id on every INSERT (overwriting any contradictory
//     value and throwing if the caller passed a different brokerage)
//
// Designed to be the safe default in any new action. Existing actions can
// migrate one at a time. Tables without a brokerage_id column should NOT
// use the guard — pass them through the raw client.
//
// Usage:
//   const svc = withBrokerageGuard(actorContext.brokerageId, "syncDealHealth")
//   await svc.from("deal_health_scores").select("*").eq("transaction_id", tid)
//   await svc.from("deal_health_scores").insert({ transaction_id: tid, ... })
//   // ↑ brokerage_id is automatically appended to the insert payload

export interface GuardedClient {
  /** the raw service client; use only for tables WITHOUT brokerage_id */
  raw: ReturnType<typeof createServiceClient>
  /** the brokerage id this client is scoped to */
  brokerageId: string
  /** call-site label, surfaces in violation errors and audit rows */
  context: string
  /** tenant-scoped from() */
  from: (table: string) => GuardedFromBuilder
}

interface GuardedFromBuilder {
  select: (cols?: string, opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) => GuardedQuery
  insert: (values: Record<string, unknown> | Record<string, unknown>[]) => GuardedQuery
  update: (values: Record<string, unknown>) => GuardedQuery
  delete: () => GuardedQuery
  upsert: (
    values: Record<string, unknown> | Record<string, unknown>[],
    options?: Record<string, unknown>,
  ) => GuardedQuery
}

// We use a recursive proxy on PostgrestFilterBuilder; the unknown return
// preserves chainability across .eq/.in/.maybeSingle/.single/.order/.limit.
type GuardedQuery = unknown

export function withBrokerageGuard(
  brokerageId: string | null | undefined,
  context: string,
): GuardedClient {
  if (!brokerageId) {
    throw new TenantViolationError({
      expected: "non-null brokerage_id",
      actual: brokerageId,
      context,
      message: `${context}: cannot construct guarded client without brokerage_id`,
    })
  }
  const raw = createServiceClient()

  return {
    raw,
    brokerageId,
    context,
    from: (table: string) => buildGuardedFrom(raw, table, brokerageId, context),
  }
}

function buildGuardedFrom(
  raw: ReturnType<typeof createServiceClient>,
  table: string,
  brokerageId: string,
  context: string,
): GuardedFromBuilder {
  const base = raw.from(table)
  return {
    select(cols, opts) {
      return (base.select(cols as string, opts) as unknown as { eq: (c: string, v: string) => unknown })
        .eq("brokerage_id", brokerageId)
    },
    insert(values) {
      const stamped = Array.isArray(values)
        ? values.map((v) => stampOrThrow(v, brokerageId, context, table))
        : stampOrThrow(values, brokerageId, context, table)
      return (base.insert(stamped as Record<string, unknown> | Record<string, unknown>[]))
    },
    update(values) {
      const stamped = stampOrThrow(values, brokerageId, context, table)
      return (base.update(stamped as Record<string, unknown>) as unknown as { eq: (c: string, v: string) => unknown })
        .eq("brokerage_id", brokerageId)
    },
    delete() {
      return (base.delete() as unknown as { eq: (c: string, v: string) => unknown })
        .eq("brokerage_id", brokerageId)
    },
    upsert(values, options) {
      const stamped = Array.isArray(values)
        ? values.map((v) => stampOrThrow(v, brokerageId, context, table))
        : stampOrThrow(values, brokerageId, context, table)
      return (base.upsert(stamped as Record<string, unknown> | Record<string, unknown>[], options as never))
    },
  }
}

function stampOrThrow(
  values: Record<string, unknown>,
  brokerageId: string,
  context: string,
  table: string,
): Record<string, unknown> {
  const existing = values.brokerage_id
  if (existing != null && existing !== brokerageId) {
    throw new TenantViolationError({
      expected: brokerageId,
      actual: typeof existing === "string" ? existing : null,
      context,
      message: `${context}: write to ${table} carried brokerage_id=${String(existing)} but guard is scoped to ${brokerageId}`,
    })
  }
  return { ...values, brokerage_id: brokerageId }
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
