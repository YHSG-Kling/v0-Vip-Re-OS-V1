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
//
// CONTROLLED LEARNING (wave 104, lane 104C): the promotion is no longer a silent write. Each winner
// becomes an improvement_proposals row (lib/kernel/improvement-proposals.ts) that the kernel
// evaluates from the same stats and promotes through retireLosingVariants ONLY under
// campaign_orchestrator's autonomy gate + authority rung — held winners wait for a human.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { pickWinningVariant } from "@/lib/lead-pipeline/variant-winner"

type Svc = ReturnType<typeof createServiceClient>

export interface CopyLearningResult {
  sequencesScanned: number
  groupsEvaluated: number
  variantsPromoted: number
  /** 102D: groups whose reply counts came from attributed arm results (agent_outcome_evaluations). */
  armResultsUsed: number
  /** 102D: groups that fell back to the step counters because the arm results could not be read. */
  armResultsUnavailable: number
  /** 104C: winners proposed but NOT promoted this pass — held by the autonomy gate / authority ladder
   *  (or the proposal store refused) and waiting, EVALUATED, for a human on the Manager Trust page. */
  proposalsHeld: number
}

/**
 * 102D — the ATTRIBUTED arm results for one experiment key (`sequence_ab:<sequence id>`): replies
 * per arm from agent_outcome_evaluations rows the attribution wrote (evaluator 'ledger_attribution',
 * lib/intelligence/roi-ledger.ts recordExperimentArmOutcomes). null = the read was refused or the
 * m700 columns are absent — the caller then falls back to the step counters and SAYS so.
 * @proofSeam exported so scripts/replay-harness-guard.ts drives it with an in-memory client.
 */
export async function loadExperimentArmResults(
  svc: { from: (t: string) => any },
  brokerageId: string,
  experimentKey: string,
): Promise<{ repliesByArm: Record<string, number>; outcomesByArm: Record<string, number> } | null> {
  const { data, error } = await svc
    .from("agent_outcome_evaluations")
    .select("experiment_arm, outcome_kind")
    .eq("brokerage_id", brokerageId)
    .eq("evaluator", "ledger_attribution")
    .eq("experiment_key", experimentKey)
    .limit(5000)
  if (error) return null
  const repliesByArm: Record<string, number> = {}
  const outcomesByArm: Record<string, number> = {}
  for (const r of (data ?? []) as Array<{ experiment_arm: string; outcome_kind: string }>) {
    outcomesByArm[r.experiment_arm] = (outcomesByArm[r.experiment_arm] ?? 0) + 1
    if (r.outcome_kind === "reply") repliesByArm[r.experiment_arm] = (repliesByArm[r.experiment_arm] ?? 0) + 1
  }
  return { repliesByArm, outcomesByArm }
}

/**
 * THE VARIANT WRITER (the existing promotion: a loser row is deactivated, the winner becomes the
 * surviving control). Tenant-pinned through the step's sequence (campaign_sequence_steps carries no
 * brokerage_id), COUNTED: a matched-nothing update is a refusal, not a success (CLAUDE.md §3).
 * Called ONLY by lib/kernel/improvement-proposals.ts promotion (104C) — the conductor below no longer
 * writes it directly.
 */
export async function retireLosingVariants(svc: { from: (t: string) => any }, brokerageId: string, loserIds: string[]): Promise<{ ok: true; retired: number } | { ok: false; error: string }> {
  return setVariantsActive(svc, brokerageId, loserIds, false)
}

/** The rollback of retireLosingVariants — the retired rows come back as active. */
export async function restoreRetiredVariants(svc: { from: (t: string) => any }, brokerageId: string, loserIds: string[]): Promise<{ ok: true; retired: number } | { ok: false; error: string }> {
  return setVariantsActive(svc, brokerageId, loserIds, true)
}

async function setVariantsActive(svc: { from: (t: string) => any }, brokerageId: string, ids: string[], active: boolean): Promise<{ ok: true; retired: number } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no brokerage — variant rows not touched" }
  if (ids.length === 0) return { ok: true, retired: 0 }
  const { data: owned, error: ownErr } = await svc.from("campaign_sequence_steps").select("id, sequence_id").in("id", ids)
  if (ownErr) return { ok: false, error: `variant rows could not be read: ${ownErr.message}` }
  const seqIds = [...new Set(((owned ?? []) as Array<{ sequence_id: string }>).map((r) => r.sequence_id))]
  const { data: seqs, error: seqErr } = await svc.from("campaign_sequences").select("id").eq("brokerage_id", brokerageId).in("id", seqIds)
  if (seqErr) return { ok: false, error: `sequence ownership could not be read: ${seqErr.message}` }
  const mine = new Set(((seqs ?? []) as Array<{ id: string }>).map((s) => s.id))
  const allowed = ((owned ?? []) as Array<{ id: string; sequence_id: string }>).filter((r) => mine.has(r.sequence_id)).map((r) => r.id)
  if (allowed.length !== ids.length) return { ok: false, error: `${ids.length - allowed.length} variant row(s) are not this brokerage's — refused` }
  const { data, error } = await svc.from("campaign_sequence_steps").update({ is_active: active }).in("id", allowed).select("id")
  if (error) return { ok: false, error: `variant rows not updated: ${error.message}` }
  const n = (data ?? []).length
  if (n !== allowed.length) return { ok: false, error: `variant update matched ${n} of ${allowed.length} rows` }
  return { ok: true, retired: n }
}

export async function runSequenceCopyLearning(brokerageId: string, client?: Svc): Promise<CopyLearningResult> {
  const svc = client ?? createServiceClient()
  const out: CopyLearningResult = { sequencesScanned: 0, groupsEvaluated: 0, variantsPromoted: 0, armResultsUsed: 0, armResultsUnavailable: 0, proposalsHeld: 0 }
  // CONTROLLED LEARNING (104C): the manager that owns this learning brings its gate ONCE per run —
  // posture (platform halt → tenant halt → broker-set posture) and authority rung — and the kernel
  // decides per proposal whether it may promote or must wait for a human.
  let gate: import("@/lib/kernel/improvement-proposals").PromotionGate | null = null
  try {
    const { resolveManagerAutonomy, resolveAgentAuthorityLevel, autonomyDecision } = await import("@/lib/managers/autonomy-gate")
    const [posture, authority] = await Promise.all([resolveManagerAutonomy(brokerageId, "campaign_orchestrator", svc), resolveAgentAuthorityLevel(brokerageId, "campaign_orchestrator", svc)])
    gate = { actorAuthority: authority, autonomy: autonomyDecision({ managerKey: "campaign_orchestrator", effective: posture, authorityLevel: authority }) }
  } catch {
    gate = { actorAuthority: null, autonomy: { allow: false, held: true, posture: "approval_required", reason: "autonomy gate could not be read — promotion held (fail closed)" } }
  }

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
    // 102D — the winner gate reads ATTRIBUTED arm results when they exist for this sequence's
    // experiment (lib/kernel/experiments.ts key `sequence_ab:<sequence id>`): a reply credited to
    // the arm by last touch, the same evidence the command center rolls up byExperimentArm. The
    // step counters remain the SENT denominator; they are the reply numerator only when no arm
    // result was ever recorded (pre-m700, or a sequence whose sends predate the ledger).
    const armResults = await loadExperimentArmResults(svc, brokerageId, `sequence_ab:${seq.id}`)
    const armReplies = armResults && Object.keys(armResults.repliesByArm).length > 0 ? armResults.repliesByArm : null

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

      if (armReplies) out.armResultsUsed++; else if (armResults === null) out.armResultsUnavailable++
      const stats = group.map((g) => {
        const variant = (g.ab_variant ?? "A") as string
        return { variant, sent: g.sent_count ?? 0, replies: armReplies ? (armReplies[variant] ?? 0) : (g.reply_count ?? 0) }
      })
      const winner = pickWinningVariant(stats)
      if (!winner.winner) continue // not clearly ahead yet — keep testing

      const loserIds = group.filter((g) => (g.ab_variant ?? "A") !== winner.winner).map((g) => g.id)
      if (loserIds.length === 0) continue
      // CONTROLLED LEARNING (104C): before this the loser rows were deactivated HERE, directly — no
      // actor, no authority, no ledger, no way back. Now the winner is a `variant` PROPOSAL
      // (lib/kernel/improvement-proposals.ts): evaluated deterministically from the same stats
      // (pickWinningVariant), approved + promoted in this pass ONLY when campaign_orchestrator's
      // autonomy gate and authority rung (≥ 4) allow — else it waits, EVALUATED, for a human on the
      // Manager Trust page. The write itself is still retireLosingVariants above, ledgered
      // (learning.proposal.promote, LEARNED_IMPROVEMENT) and reversible (ROLLED_BACK restores the rows).
      const { proposeEvaluatePromote } = await import("@/lib/kernel/improvement-proposals")
      const r = await proposeEvaluatePromote(svc, {
        brokerageId, subjectKind: "variant", subjectKey: `sequence_ab:${seq.id}`, proposer: "copy_learning",
        proposedChange: { winner: winner.winner, winnerRate: winner.winnerRate ?? null, stepNumber: group[0].step_number, loserIds, stats, source: armReplies ? "agent_outcome_evaluations" : "step_counters" },
        evidenceRefs: [{ kind: "agent_outcome_evaluations", experiment_key: `sequence_ab:${seq.id}`, used: !!armReplies }, ...group.map((g) => ({ kind: "campaign_sequence_steps", id: g.id, variant: g.ab_variant ?? "A", sent: g.sent_count ?? 0 }))],
        actor: { type: "manager", managerKey: "campaign_orchestrator", reason: `copy winner '${winner.winner}' step ${group[0].step_number}` },
        gate,
      })
      if (!r.promoted) { out.proposalsHeld++; continue }
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
