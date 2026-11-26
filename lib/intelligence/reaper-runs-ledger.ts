// ─── THE REAPER_RUNS LEDGER — its one writer and its one reader ─────────────
// Moved VERBATIM out of lib/intelligence/reaper-net.ts (wave 156, lane 156L), which re-exports both,
// so every existing caller and proof keeps its import. WHY A SEPARATE MODULE: the reaper NET is a
// registry whose entries lazily import ~25 reapers across every manager domain (video, workflow,
// transactions, finance, compliance, marketing, ads, recruiting, the OS health supervisor). The
// two callers that only touch the LEDGER — lib/kernel/os-health.ts (records its own sweep) and
// lib/intelligence/manager-standup.ts (reads the per-manager activity) — imported the whole registry
// for these two functions, which put every reaper into the import graph of every app page that can
// reach the health supervisor or the stand-up (app/crm/page.tsx among them). Same table, same
// columns, same sentinel classification, same aggregation: behavior is unchanged.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

/** Persist one reaper's sweep to the accountability ledger (best-effort). */
export async function recordReaperRun(
  row: { brokerageId: string; domain: string; manager: ManagerKey; scanned: number; escalated: number; reaped: number; detail?: string | null },
  client?: Svc,
): Promise<void> {
  const svc = client ?? createServiceClient()
  await sentinelWrite(svc, svc.from("reaper_runs").insert({
    brokerage_id: row.brokerageId,
    domain: row.domain,
    manager: row.manager,
    scanned: row.scanned,
    escalated: row.escalated,
    reaped: row.reaped,
    detail: row.detail ?? null,
  }), { table: "reaper_runs", flow: "reaper_runs_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
}

// ── STANDUP FEED — per-manager reaper activity over a window ──────────────────
export interface ManagerReaperActivity {
  scanned: number
  escalated: number
  reaped: number
  domains: string[]
}

/**
 * Aggregate the reaper_runs ledger over the last `sinceHours` into a per-manager
 * map, for the daily standup. Returns {} when the ledger is empty (honest).
 */
export async function loadRecentReaperActivity(
  brokerageId: string,
  sinceHours = 24,
  client?: Svc,
): Promise<Record<string, ManagerReaperActivity>> {
  const svc = client ?? createServiceClient()
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString()
  const { data } = await svc
    .from("reaper_runs")
    .select("manager, domain, scanned, escalated, reaped")
    .eq("brokerage_id", brokerageId)
    .gte("ran_at", since)
    .limit(2000)

  const out: Record<string, ManagerReaperActivity> = {}
  for (const row of (data ?? []) as Array<{ manager: string; domain: string; scanned: number; escalated: number; reaped: number }>) {
    const m = (out[row.manager] ??= { scanned: 0, escalated: 0, reaped: 0, domains: [] })
    m.scanned += row.scanned ?? 0
    m.escalated += row.escalated ?? 0
    m.reaped += row.reaped ?? 0
    if (!m.domains.includes(row.domain)) m.domains.push(row.domain)
  }
  return out
}
