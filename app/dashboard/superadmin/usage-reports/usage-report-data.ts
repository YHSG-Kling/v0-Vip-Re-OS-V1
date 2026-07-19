// app/dashboard/superadmin/usage-reports/usage-report-data.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE loader for the per-subscriber usage report — shared by the page render
// AND the CSV export route so the download can never drift from what the table
// shows (keep-one). Same reads as before: brokerages roster, current-month
// usage_counters, and per-tenant head counts on the three core tables.

import type { SupabaseClient } from "@supabase/supabase-js"

export const USAGE_CORE_TABLES = ["contacts", "listings", "transactions"] as const

export interface UsageReportRow {
  tenant: { id: string; name: string | null; plan_tier: string | null; status: string | null; created_at: string | null }
  counts: Record<string, number>
  userCount: number
  usage: Record<string, number>
}

export async function loadUsageReportRows(svc: SupabaseClient): Promise<
  { ok: true; rows: UsageReportRow[] } | { ok: false; error: string }
> {
  const { data: tenants, error } = await svc
    .from("brokerages")
    .select("id, name, plan_tier, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(200)
  if (error) return { ok: false, error: error.message }

  // Current-month media/usage counters (one query, grouped client-side).
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
  const { data: counters } = await svc
    .from("usage_counters")
    .select("brokerage_id, metric, value")
    .eq("period_start", monthStart)
  const countersByTenant = new Map<string, Record<string, number>>()
  for (const c of (counters ?? []) as Array<{ brokerage_id: string; metric: string; value: number | null }>) {
    const m = countersByTenant.get(c.brokerage_id) ?? {}
    m[c.metric] = Number(c.value ?? 0)
    countersByTenant.set(c.brokerage_id, m)
  }

  // Core-object head counts per tenant.
  const rows = await Promise.all(
    ((tenants ?? []) as UsageReportRow["tenant"][]).map(async (t) => {
      const counts: Record<string, number> = {}
      await Promise.all(
        USAGE_CORE_TABLES.map(async (tbl) => {
          const { count } = await svc
            .from(tbl)
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", t.id)
          counts[tbl] = count ?? 0
        })
      )
      const { count: userCount } = await svc
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", t.id)
      return { tenant: t, counts, userCount: userCount ?? 0, usage: countersByTenant.get(t.id) ?? {} }
    })
  )
  return { ok: true, rows }
}

/** PURE: the report rows as CSV text — exactly the table's columns, no new data. */
export function usageReportCsv(rows: UsageReportRow[]): string {
  const esc = (v: unknown): string => {
    const s = v == null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = [
    "subscriber", "tier", "status", "users", "contacts", "listings", "transactions",
    "avatar_minutes_month", "avatar_sessions_month", "tts_characters_month", "created_at",
  ]
  const lines = rows.map(({ tenant, counts, userCount, usage }) => [
    esc(tenant.name ?? tenant.id), esc(tenant.plan_tier ?? ""), esc(tenant.status ?? ""),
    userCount, counts.contacts ?? 0, counts.listings ?? 0, counts.transactions ?? 0,
    usage.live_avatar_minutes ?? 0, usage.live_avatar_sessions ?? 0, usage.tts_characters ?? 0,
    esc(tenant.created_at ?? ""),
  ].join(","))
  return [header.join(","), ...lines].join("\n") + "\n"
}
