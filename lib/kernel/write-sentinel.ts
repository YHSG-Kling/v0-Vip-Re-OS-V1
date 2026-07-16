/**
 * lib/kernel/write-sentinel.ts
 *
 * THE WRITE SENTINEL — pass 4's answer to the bug class that hid every defect
 * the last three passes hand-hunted: best-effort DB writes silenced with
 * `.then(() => {}, () => {})` or a bare `await` that never checks `{ error }`.
 *
 * supabase-js does NOT throw on a rejected row — it RESOLVES with { error }.
 * The old silencers therefore hid two distinct failures:
 *   (a) the resolved { error } (FK violation, CHECK violation, NOT NULL) —
 *       the silent killer: the code path "succeeds" while the row is lost;
 *   (b) a genuine rejection (network, timeout).
 *
 * sentinelWrite keeps the best-effort CONTRACT (the caller's flow never
 * breaks, nothing throws) but makes the loss OBSERVABLE: every failure lands
 * on the append-only self_heal_events ledger (domain data_flow, action
 * 'best_effort_write', outcome 'failed') — the same ledger the repair digest
 * ranks and the Exception Center reads. A drifted CHECK literal or a wrong
 * id-class FK now announces itself in the weekly digest instead of silently
 * eating months of rows.
 *
 * The ledger write itself is best-effort (recordSelfHeal never throws), so
 * the sentinel can never make a webhook 500 — same guarantee as before, plus
 * eyes.
 *
 * Usage (replaces `.then(undefined, () => {})` / unchecked awaits):
 *   await sentinelWrite(svc, svc.from("voice_calls").insert({...}), {
 *     table: "voice_calls", flow: "voice_call_ledger", brokerageId,
 *   })
 */

import { recordSelfHeal } from "./self-heal-ledger"

export interface SentinelWriteContext {
  /** The table being written — the digest groups losses by it. */
  table: string
  /** The business flow the write belongs to (e.g. 'isa_outreach_record'). */
  flow: string
  brokerageId?: string | null
}

/**
 * Await a supabase write, swallow failure for the caller (best-effort
 * contract preserved), but ledger every loss. Returns true when the write
 * actually landed.
 */
export async function sentinelWrite(
  svc: any,
  op: PromiseLike<{ error?: { message?: string; code?: string } | null }>,
  ctx: SentinelWriteContext,
): Promise<boolean> {
  try {
    const result = await op
    const err = (result as any)?.error
    if (!err) return true
    await recordSelfHeal(svc, {
      brokerageId: ctx.brokerageId ?? null,
      domain: "data_flow",
      subject: `${ctx.flow}:${ctx.table}`,
      action: "best_effort_write",
      outcome: "failed",
      detail: {
        flow: ctx.flow,
        table: ctx.table,
        message: String(err.message ?? "").slice(0, 300),
        code: err.code ?? null,
      },
    })
    return false
  } catch (err) {
    await recordSelfHeal(svc, {
      brokerageId: ctx.brokerageId ?? null,
      domain: "data_flow",
      subject: `${ctx.flow}:${ctx.table}`,
      action: "best_effort_write",
      outcome: "failed",
      detail: {
        flow: ctx.flow,
        table: ctx.table,
        message: err instanceof Error ? err.message.slice(0, 300) : "rejected",
        code: null,
      },
    }).catch(() => null)
    return false
  }
}

// ─── THE OBSERVATION SURFACE ─────────────────────────────────────────────────
//
// The sentinel WRITES losses; these read them back. A raw "N failed" count is
// useless — the point of the sentinel is to name WHICH write path is losing
// rows and WHY, so a human (or the digest) fixes the rail, not the symptom.
//
// PostgreSQL error codes the report translates to plain hints:
//   23502 NOT NULL · 23503 FK violation · 23505 unique violation · 23514 CHECK

const PG_CODE_HINT: Record<string, string> = {
  "23502": "a required column is missing (NOT NULL)",
  "23503": "a foreign key points at a row that isn't there (wrong id-class?)",
  "23505": "a unique/onConflict collision",
  "23514": "a value the column's CHECK rejects (drifted vocabulary?)",
  "22P02": "a malformed value (bad uuid / number / enum text)",
  "42703": "SCHEMA DRIFT AT RUNTIME — the column doesn't exist on the live table",
  "42P01": "SCHEMA DRIFT AT RUNTIME — the table doesn't exist in the live schema",
  PGRST204: "SCHEMA DRIFT AT RUNTIME — PostgREST can't find the column (phantom key)",
  PGRST205: "SCHEMA DRIFT AT RUNTIME — PostgREST can't find the table (phantom table)",
}

/** PURE: the RUNTIME TWIN of the CI schema-drift guard — drift the guard can't
 *  see because it arrived via a hotfix migration (not code) still shows up here
 *  as these error codes on the sentinel ledger. */
export function isRuntimeDriftLoss(code: string | null | undefined): boolean {
  return code === "42703" || code === "42P01" || code === "PGRST204" || code === "PGRST205"
}

export interface SentinelLossRow {
  flow: string
  table: string
  code: string | null
  count: number
  /** Distinct tenants affected (platform-scoped rows count as one). */
  tenants: number
  /** A representative error message from the group. */
  sampleMessage: string
  /** Plain-language cause hint derived from the pg code. */
  hint: string
}

export interface SentinelLossReport {
  totalLosses: number
  distinctPaths: number
  /** Loss groups, worst-first — the write-rail repair priority list. */
  groups: SentinelLossRow[]
  /** One-line human summary; "" when the week was clean. */
  headline: string
  /** RUNTIME DRIFT TWIN: losses whose pg code proves live-schema drift
   *  (42703/42P01/PGRST204/PGRST205) — the CI guard's zero baseline holds for
   *  CODE, this holds for the DATABASE (hotfix migrations, manual DDL). */
  runtimeDriftLosses: number
  runtimeDriftGroups: SentinelLossRow[]
}

/**
 * PURE: fold a window of best_effort_write failure rows into a ranked report.
 * Input rows are the self_heal_events shape (detail carries flow/table/code).
 */
export function composeSentinelLossReport(
  rows: Array<{ brokerage_id?: string | null; detail?: unknown }>,
): SentinelLossReport {
  const byKey = new Map<string, { flow: string; table: string; code: string | null; count: number; tenants: Set<string>; sampleMessage: string }>()
  for (const r of rows) {
    const d = (r.detail ?? {}) as { flow?: string; table?: string; code?: string | null; message?: string }
    const flow = d.flow ?? "unknown"
    const table = d.table ?? "unknown"
    const code = d.code ?? null
    const key = `${flow}::${table}::${code ?? "none"}`
    const g = byKey.get(key) ?? { flow, table, code, count: 0, tenants: new Set<string>(), sampleMessage: d.message ?? "" }
    g.count++
    g.tenants.add(r.brokerage_id ?? "platform")
    if (!g.sampleMessage && d.message) g.sampleMessage = d.message
    byKey.set(key, g)
  }

  const groups: SentinelLossRow[] = [...byKey.values()]
    .map((g) => ({
      flow: g.flow, table: g.table, code: g.code, count: g.count, tenants: g.tenants.size,
      sampleMessage: g.sampleMessage,
      hint: (g.code && PG_CODE_HINT[g.code]) ? PG_CODE_HINT[g.code] : "an unexpected write rejection",
    }))
    .sort((a, b) => b.count - a.count)

  const totalLosses = groups.reduce((s, g) => s + g.count, 0)
  const runtimeDriftGroups = groups.filter((g) => isRuntimeDriftLoss(g.code))
  const runtimeDriftLosses = runtimeDriftGroups.reduce((s, g) => s + g.count, 0)
  let headline = totalLosses === 0
    ? ""
    : `${totalLosses} silent write loss${totalLosses === 1 ? "" : "es"} across ${groups.length} rail${groups.length === 1 ? "" : "s"}` +
      (groups[0] ? ` — worst: ${groups[0].flow} → ${groups[0].table} (${groups[0].count}×, ${groups[0].hint}).` : ".")
  if (runtimeDriftLosses > 0) {
    headline += ` ⚠ ${runtimeDriftLosses} of these are RUNTIME SCHEMA DRIFT (live schema no longer matches the code) — regenerate the snapshot and reconcile.`
  }

  return { totalLosses, distinctPaths: groups.length, groups, headline, runtimeDriftLosses, runtimeDriftGroups }
}

/** Read the best_effort_write losses over a window and rank them. */
export async function loadSentinelLosses(svc: any, sinceIso: string, brokerageId?: string | null): Promise<SentinelLossReport> {
  let q = svc.from("self_heal_events")
    .select("brokerage_id, detail")
    .eq("domain", "data_flow")
    .eq("action", "best_effort_write")
    .eq("outcome", "failed")
    .gte("created_at", sinceIso)
    .limit(5000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data } = await q
  return composeSentinelLossReport((data ?? []) as any[])
}
