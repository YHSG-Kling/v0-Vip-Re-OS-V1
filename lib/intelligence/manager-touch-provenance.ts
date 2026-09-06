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
  /**
   * TYPED provenance columns — the SURVIVORS (§6, orphan tranche X4 2026-09-01).
   * Both writers stamp these as first-class columns (touchpoint-bridge writes
   * sequence_id + source='sequence'; touchpoint-recorder writes external_table /
   * external_id / source), and until now this reader aggregated provenance ONLY
   * out of the metadata blob — one fact, two homes. The typed columns are
   * preferred everywhere below; metadata is consulted only as a fallback for
   * legacy rows written before m1098 added the columns. Optional so existing
   * pure-test fixtures keep type-checking.
   */
  source?: string | null
  sequence_id?: string | null
  external_table?: string | null
  external_id?: string | null
  metadata: {
    manager?: string | null
    ai_intent?: string | null
    /** legacy sequence linkage — pre-m1098 rows carried it only here. */
    enrollment_id?: string | null
  } | null
}

export interface ManagerTouchSummary {
  manager: string
  touchCount: number
  channels: string[]
  /** distinct ai_intents behind the touches (capped, for a readable receipt). */
  sampleIntents: string[]
  /** distinct pipeline sources (typed `source` column: launch | trigger | manual | retarget | sequence). */
  sources: string[]
  /** touches driven by a canonical sequence (typed sequence_id; metadata.enrollment_id for legacy rows). */
  sequenceTouchCount: number
  /** distinct tables the touches link back to (typed external_table, present only with an external_id) —
   *  the "which artifact was actually sent" half of the receipt. */
  linkedArtifactTables: string[]
}

const MAX_INTENTS = 3

/** Group touchpoint rows by the manager that produced them. Pure. */
export function aggregateTouchProvenance(rows: TouchRow[]): ManagerTouchSummary[] {
  const byManager = new Map<string, {
    count: number; channels: Set<string>; intents: Set<string>
    sources: Set<string>; sequenceCount: number; artifactTables: Set<string>
  }>()
  for (const r of rows ?? []) {
    const manager = (r.metadata?.manager ?? "").trim() || "unattributed"
    const entry = byManager.get(manager) ?? {
      count: 0, channels: new Set<string>(), intents: new Set<string>(),
      sources: new Set<string>(), sequenceCount: 0, artifactTables: new Set<string>(),
    }
    entry.count++
    if (r.channel) entry.channels.add(r.channel)
    const intent = (r.metadata?.ai_intent ?? "").trim()
    if (intent) entry.intents.add(intent)
    // Typed columns first; metadata only for legacy rows that predate them.
    const isSequenceTouch = !!r.sequence_id || !!r.metadata?.enrollment_id
    if (isSequenceTouch) entry.sequenceCount++
    const source = (r.source ?? "").trim() || (isSequenceTouch ? "sequence" : "")
    if (source) entry.sources.add(source)
    if (r.external_id && r.external_table) entry.artifactTables.add(r.external_table)
    byManager.set(manager, entry)
  }
  return [...byManager.entries()]
    .map(([manager, e]) => ({
      manager,
      touchCount: e.count,
      channels: [...e.channels].sort(),
      sampleIntents: [...e.intents].slice(0, MAX_INTENTS),
      sources: [...e.sources].sort(),
      sequenceTouchCount: e.sequenceCount,
      linkedArtifactTables: [...e.artifactTables].sort(),
    }))
    .sort((a, b) => b.touchCount - a.touchCount)
}

/**
 * Load + aggregate the last `sinceDays` of touches with provenance for a brokerage.
 *
 * Returns NULL when the read was REFUSED, and `[]` only when the ledger genuinely
 * held nothing. supabase-js RESOLVES a refusal (§3), so a swallowed error would hand
 * back an absence byte-identical to "this brokerage sent nothing" — and the standup
 * would then print zero touches as a FACT. The two outcomes are different receipts,
 * so they get different return values; the caller decides what to render.
 */
export async function summarizeManagerTouches(svc: Svc, brokerageId: string, sinceDays = 7): Promise<ManagerTouchSummary[] | null> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const { data, error } = await svc
    .from("marketing_campaign_touchpoints")
    .select("channel, metadata, source, sequence_id, external_table, external_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "sent")
    .gte("sent_at", since)
    .limit(2000)
  if (error) {
    console.error("[manager-touch-provenance] touchpoint read refused:", error)
    return null
  }
  return aggregateTouchProvenance((data ?? []) as TouchRow[])
}
