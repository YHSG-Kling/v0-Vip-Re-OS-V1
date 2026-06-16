// lib/campaign-sequences/copy-learning-conductor.ts
//
// THE LEARNING CONDUCTOR (copy) — closes the self-improving copy loop the A/B split unblocked. For
// each A/B step group (same step_number, different ab_variant) it reads the accumulated per-variant
// counts (sent_count / reply_count), asks pickWinningVariant who's clearly winning by reply rate
// (sample + margin gated), and PROMOTES the winner by deactivating the loser variant rows — the
// winner becomes the surviving control. The team's reactivation copy improves while you sleep.
//
// Idempotent: once a loser is deactivated the group has one active row, so it's no longer a
// multi-variant group and is skipped. Conservative: a near-tie / thin sample promotes nobody.
// Read-mostly + a single deactivate per resolved group; never throws into the caller.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { pickWinningVariant } from "@/lib/lead-pipeline/variant-winner"

type Svc = ReturnType<typeof createServiceClient>

export interface CopyLearningResult {
  sequencesScanned: number
  groupsEvaluated: number
  variantsPromoted: number
}

export async function runSequenceCopyLearning(brokerageId: string, client?: Svc): Promise<CopyLearningResult> {
  const svc = client ?? createServiceClient()
  const out: CopyLearningResult = { sequencesScanned: 0, groupsEvaluated: 0, variantsPromoted: 0 }

  const { data: seqs } = await svc
    .from("campaign_sequences")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .eq("is_ab_test", true)
    .limit(200)

  for (const seq of (seqs ?? []) as any[]) {
    out.sequencesScanned++
    const { data: steps } = await svc
      .from("campaign_sequence_steps")
      .select("id, step_number, ab_variant, sent_count, reply_count")
      .eq("sequence_id", seq.id)
      .eq("is_active", true)
    const rows = (steps ?? []) as any[]

    // Group by step_number; only groups with ≥2 distinct variants are A/B tests to resolve.
    const byStep = new Map<number, any[]>()
    for (const r of rows) {
      const arr = byStep.get(r.step_number) ?? []
      arr.push(r); byStep.set(r.step_number, arr)
    }

    for (const group of byStep.values()) {
      const variants = new Set(group.map((g) => g.ab_variant ?? "A"))
      if (group.length < 2 || variants.size < 2) continue
      out.groupsEvaluated++

      const stats = group.map((g) => ({ variant: (g.ab_variant ?? "A") as string, sent: g.sent_count ?? 0, replies: g.reply_count ?? 0 }))
      const winner = pickWinningVariant(stats)
      if (!winner.winner) continue // not clearly ahead yet — keep testing

      const loserIds = group.filter((g) => (g.ab_variant ?? "A") !== winner.winner).map((g) => g.id)
      if (loserIds.length === 0) continue
      const { error } = await svc.from("campaign_sequence_steps").update({ is_active: false }).in("id", loserIds)
      if (error) continue
      out.variantsPromoted++

      // Make the learning visible on the coordination feed.
      try {
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId, fromManager: "campaign_orchestrator", toManager: "campaign_orchestrator",
          signalType: "copy_variant_promoted",
          message: `Step ${group[0].step_number}: variant '${winner.winner}' won at ${((winner.winnerRate ?? 0) * 100).toFixed(1)}% reply — promoted; ${loserIds.length} losing variant(s) retired.`,
          entityType: "campaign_sequence", entityId: seq.id,
          payload: { winner: winner.winner, winnerRate: winner.winnerRate ?? null, stepNumber: group[0].step_number },
        }, svc)
      } catch { /* best-effort */ }
    }
  }

  return out
}
