// lib/platform/self-audit-rollup.ts
//
// FIRST-WEEK TELEMETRY LOOP (approved rec) — the platform-level view of what
// the OS caught ITSELF doing wrong in production: self-audit findings
// (decision-latency breaches, stuck bookings) + signature-chase escalations,
// rolled up by kind and tenant over the trailing window, so week-one data
// picks the next build instead of intuition. No new tables — it reads the
// SAME notifications ledger the finding writers stamp with dedupe tags.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export interface SelfAuditRollup {
  windowDays: number
  totals: Array<{ kind: string; count: number }>
  byTenant: Array<{ brokerageId: string; brokerageName: string | null; kind: string; count: number }>
}

/** PURE: recover the finding kind from a tagged notification. */
export function parseFindingKind(type: string, body: string | null): string {
  const m = /\[OS_AUDIT:([a-z_]+)\]/.exec(body ?? "")
  if (m) return m[1]
  const c = /\[SIG_CHASE:([a-z_]+)\]/.exec(body ?? "")
  if (c) return `signature_${c[1]}`
  return type
}

export async function computeSelfAuditRollup(svc: Svc, windowDays = 7, now: Date = new Date()): Promise<SelfAuditRollup> {
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString()
  const { data: rows } = await svc.from("notifications")
    .select("type, body, brokerage_id, created_at")
    .in("type", ["os_self_audit", "signature_chase"])
    .gte("created_at", since)
    .limit(2000)

  const byKey = new Map<string, number>()
  const kinds = new Map<string, number>()
  const brokerageIds = new Set<string>()
  for (const n of ((rows ?? []) as any[])) {
    const kind = parseFindingKind(n.type, n.body)
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    if (n.brokerage_id) {
      brokerageIds.add(n.brokerage_id)
      const k = `${n.brokerage_id}|${kind}`
      byKey.set(k, (byKey.get(k) ?? 0) + 1)
    }
  }

  const names = new Map<string, string | null>()
  if (brokerageIds.size > 0) {
    const { data: brs } = await svc.from("brokerages").select("id, name").in("id", [...brokerageIds])
    for (const b of ((brs ?? []) as any[])) names.set(b.id, b.name ?? null)
  }

  return {
    windowDays,
    totals: [...kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    byTenant: [...byKey.entries()].map(([k, count]) => {
      const [brokerageId, kind] = k.split("|")
      return { brokerageId, brokerageName: names.get(brokerageId) ?? null, kind, count }
    }).sort((a, b) => b.count - a.count).slice(0, 50),
  }
}
