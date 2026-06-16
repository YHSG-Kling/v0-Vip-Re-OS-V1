// lib/campaign-sequences/channel-order-runner.ts
//
// Live side of CHANNEL-ORDER learning — aggregate real per-channel reply rates from the sequence
// step executions and publish an ADVISORY ("lead with SMS — it earns 2× the replies here") to the
// coordination feed. Advisory only; never reorders a live sequence on its own. Never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { rankChannelsByReplyRate, type ChannelStat } from "./channel-order"

type Svc = ReturnType<typeof createServiceClient>

export interface ChannelOrderResult {
  channelsRanked: number
  recommended: string | null
}

export async function runChannelOrderLearning(brokerageId: string, client?: Svc, opts?: { windowDays?: number }): Promise<ChannelOrderResult> {
  const svc = client ?? createServiceClient()
  const since = new Date(Date.now() - (opts?.windowDays ?? 30) * 86_400_000).toISOString()

  const { data: rows } = await svc
    .from("sequence_step_executions")
    .select("channel, status, replied_at")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", since)
    .limit(20_000)

  const byChannel = new Map<string, { sent: number; replies: number }>()
  for (const r of (rows ?? []) as any[]) {
    if (!r.channel || (r.status ?? "") !== "sent") continue
    const e = byChannel.get(r.channel) ?? { sent: 0, replies: 0 }
    e.sent++
    if (r.replied_at) e.replies++
    byChannel.set(r.channel, e)
  }
  const stats: ChannelStat[] = [...byChannel.entries()].map(([channel, v]) => ({ channel, sent: v.sent, replies: v.replies }))
  const ranking = rankChannelsByReplyRate(stats)

  if (ranking.recommended) {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId, fromManager: "campaign_orchestrator", toManager: "campaign_orchestrator",
        signalType: "channel_order_recommendation",
        message: `Channel learning: ${ranking.reason}.`,
        entityType: "brokerage", entityId: brokerageId,
        payload: { recommended: ranking.recommended, ranked: ranking.ranked },
      }, svc)
    } catch { /* best-effort */ }
  }
  return { channelsRanked: ranking.ranked.length, recommended: ranking.recommended }
}
