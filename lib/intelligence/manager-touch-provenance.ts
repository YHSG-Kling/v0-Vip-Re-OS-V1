// lib/intelligence/manager-touch-provenance.ts
//
// PROVENANCE-POWERED standup enrichment — "what did each manager actually SEND this week, and WHY?".
// Now that every sequence touch stamps marketing_campaign_touchpoints.metadata.manager + ai_intent
// (touchpoint-bridge), the Manager Standup can show receipts, not just counts: per manager, how
// many touches went out, on which channels, and the distinct intents behind them. This is the "AI
// team reporting in, with receipts" surface no competitor has.
//
// aggregateTouchProvenance is PURE (no I/O) so the grouping is unit-tested directly; the loader
// just pulls the rows.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface TouchRow {
  channel: string | null
  metadata: { manager?: string | null; ai_intent?: string | null } | null
}

export interface ManagerTouchSummary {
  manager: string
  touchCount: number
  channels: string[]
  /** distinct ai_intents behind the touches (capped, for a readable receipt). */
  sampleIntents: string[]
}

const MAX_INTENTS = 3

/** Group touchpoint rows by the manager that produced them. Pure. */
export function aggregateTouchProvenance(rows: TouchRow[]): ManagerTouchSummary[] {
  const byManager = new Map<string, { count: number; channels: Set<string>; intents: Set<string> }>()
  for (const r of rows ?? []) {
    const manager = (r.metadata?.manager ?? "").trim() || "unattributed"
    const entry = byManager.get(manager) ?? { count: 0, channels: new Set<string>(), intents: new Set<string>() }
    entry.count++
    if (r.channel) entry.channels.add(r.channel)
    const intent = (r.metadata?.ai_intent ?? "").trim()
    if (intent) entry.intents.add(intent)
    byManager.set(manager, entry)
  }
  return [...byManager.entries()]
    .map(([manager, e]) => ({
      manager,
      touchCount: e.count,
      channels: [...e.channels].sort(),
      sampleIntents: [...e.intents].slice(0, MAX_INTENTS),
    }))
    .sort((a, b) => b.touchCount - a.touchCount)
}

/** Load + aggregate the last `sinceDays` of touches with provenance for a brokerage. Best-effort. */
export async function summarizeManagerTouches(svc: Svc, brokerageId: string, sinceDays = 7): Promise<ManagerTouchSummary[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const { data } = await svc
    .from("marketing_campaign_touchpoints")
    .select("channel, metadata")
    .eq("brokerage_id", brokerageId)
    .eq("status", "sent")
    .gte("sent_at", since)
    .limit(2000)
  return aggregateTouchProvenance((data ?? []) as TouchRow[])
}
