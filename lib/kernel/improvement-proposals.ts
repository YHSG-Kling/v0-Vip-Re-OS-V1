// lib/kernel/improvement-proposals.ts
//
// CONTROLLED LEARNING — THE ONE PROPOSAL OBJECT (wave 104, lane 104C; m709; gap map row 20).
//
// The OS may PROPOSE improvements to itself, EVALUATE them deterministically (decision replay for
// policy / threshold, experiment-arm results for copy variants), and PROMOTE them ONLY under explicit
// authority — a tenant admin, or a governed manager whose autonomy gate allows it and whose
// authority rung covers the change. An owner-level change (authority 6) is APPROVAL_REQUIRED: a
// human promotes it or nobody does. An LLM / AI agent never promotes (LAW 4).
//
// SURVIVORS (nothing here replaces them):
//   · proposal store ........ improvement_proposals (m709; connector_healing_proposals is platform-only,
//                             strategy_recommendations is per-deal — evaluated in the migration header)
//   · evaluator (policy) .... lib/kernel/decision-replay.ts replayDecisions with a planner that runs the
//                             PROPOSED settings over the recorded decision_input snapshots
//   · evaluator (variant) ... lib/lead-pipeline/variant-winner.ts pickWinningVariant over the attributed
//                             arm results (agent_outcome_evaluations, ledger_attribution)
//   · evaluator (threshold) . lib/intelligence/predictor-learning.ts predictorTuning over the record
//   · authority ............. lib/managers/autonomy-gate.ts autonomyDecision + the authority ladder
//   · promotion (policy) .... the key's survivor writer → appendTenantPolicyVersion (mergeBrokerageSettings
//                             for settings keys, writeIsaSettings for ai_isa_settings); never a direct write
//   · promotion (variant) ... lib/campaign-sequences/copy-learning-conductor.ts retireLosingVariants
//   · rollback .............. the same writers with the previous value (= revertPolicy's rule: a NEW
//                             version, history never rewritten)
//   · evidence .............. withActionLedger (learning.proposal.promote / .rollback, policy_ref) +
//                             auditOnly kernel events
// Every read and write is tenant-scoped by the brokerageId the CALLER resolved from its session /
// verified row; a row of another tenant is simply absent.

import { pickWinningVariant, type VariantStat } from "@/lib/lead-pipeline/variant-winner"
import { predictorTuning } from "@/lib/intelligence/predictor-learning"
import { parsePolicyKey, formatPolicyRef, type PolicyActor } from "@/lib/kernel/tenant-policy"
import type { AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import type { AutonomyDecision } from "@/lib/managers/autonomy-gate"

export const PROPOSAL_SUBJECT_KINDS = ["policy", "prompt", "variant", "threshold"] as const
export type ProposalSubjectKind = (typeof PROPOSAL_SUBJECT_KINDS)[number]

export const PROPOSAL_STATUSES = ["PROPOSED", "EVALUATED", "APPROVED", "REJECTED", "PROMOTED", "ROLLED_BACK"] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const PROPOSERS = ["copy_learning", "predictor_learning", "prompt_calibrator", "outcome_autopsy", "human"] as const
export type Proposer = (typeof PROPOSERS)[number]

/** The state machine (m709 CHECK is the vocabulary; this is the order). */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = Object.freeze({
  PROPOSED: ["EVALUATED", "REJECTED"],
  EVALUATED: ["APPROVED", "REJECTED"],
  APPROVED: ["PROMOTED", "REJECTED"],
  REJECTED: [],
  PROMOTED: ["ROLLED_BACK"],
  ROLLED_BACK: [],
})

/** A proposal in one of these states is OPEN — a learner re-proposing the same subject finds it. */
export const OPEN_STATUSES: readonly ProposalStatus[] = ["PROPOSED", "EVALUATED", "APPROVED"]

/** Consequential actions need human approval (AUTHORITY_LEVEL_LABELS[6]). */
export const OWNER_AUTHORITY_LEVEL: AuthorityLevel = 6

/** The rung a NON-human promoter needs per subject kind. Policy and prompt are owner-level. */
export const PROPOSAL_AUTHORITY: Readonly<Record<ProposalSubjectKind, AuthorityLevel>> = Object.freeze({
  variant: 4,
  threshold: 4,
  policy: OWNER_AUTHORITY_LEVEL,
  prompt: OWNER_AUTHORITY_LEVEL,
})

export type EvaluationVerdict = "pass" | "fail" | "inconclusive"
export type Evaluator = "decision_replay" | "experiment_arms" | "predictor_record" | "none"

export interface ProposalEvaluation {
  evaluator: Evaluator
  verdict: EvaluationVerdict
  /** agreement rate / winner rate / predictor accuracy — null when nothing was measurable. */
  score: number | null
  why: string
  detail: Record<string, unknown>
  /** Written by promotion: what the writer replaced (rollback re-applies it) and who wrote it. */
  promotion?: { writer: string; previous: unknown; loserIds?: string[] }
}

export interface ImprovementProposalRow {
  id: string
  brokerage_id: string
  subject_kind: ProposalSubjectKind
  subject_key: string
  proposer: Proposer
  proposed_change: Record<string, unknown>
  evidence_refs: unknown[]
  status: ProposalStatus
  evaluation: ProposalEvaluation | null
  evaluated_at: string | null
  authority_required: AuthorityLevel
  decided_by: string | null
  decided_at: string | null
  decision_reason: string | null
  policy_version_ref: string | null
  promoted_at: string | null
  rolled_back_at: string | null
  rollback_policy_version_ref: string | null
  created_at: string
  updated_at: string
}

// (the column list is written out literally at each .select so the readerless-writes sweep can see every column — wave 102 lesson 5)
const MISSING_TABLE = new Set(["42P01", "PGRST205"])
type Svc = { from: (t: string) => any }

/** Who proposes / decides / promotes — the ledger actor vocabulary (m687). `agent` = an AI agent, never promotes. */
export interface ProposalActor {
  type: "user" | "manager" | "system" | "agent"
  userId?: string | null
  managerKey?: string | null
  /** For a `user`: the SESSION role is on the tenant admin roster (TENANT_ADMIN_USER_TYPES via isTenantAdminGrantRole). */
  isTenantAdmin?: boolean
  reason?: string | null
}

/** What a NON-human promoter brings to the gate: its ladder rung and the autonomy gate's verdict. */
export interface PromotionGate {
  actorAuthority: AuthorityLevel | null
  autonomy: AutonomyDecision | null
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from]?.includes(to) ?? false
}

// ── PURE: the promotion decision ────────────────────────────────────────────────────────────

/**
 * PURE — may THIS actor promote THIS proposal? The same rule gates a manager's auto-approval.
 *   · only an APPROVED proposal promotes (the caller passes the status it is deciding AS);
 *   · an AI agent never promotes (LAW 4 — the LLM proposes, authority decides);
 *   · a failed evaluation never promotes, whoever asks;
 *   · a human promotes only from the tenant admin roster;
 *   · a manager / the system promotes only a PASSED evaluation, below owner level, with a rung that
 *     covers the change, and only when the autonomy gate allows — anything else is APPROVAL_REQUIRED.
 */
export function promotionDecision(input: {
  status: ProposalStatus
  verdict: EvaluationVerdict | null
  authorityRequired: AuthorityLevel
  actor: ProposalActor
  gate?: PromotionGate | null
}): { allow: boolean; reason: string } {
  if (input.status !== "APPROVED") return { allow: false, reason: `proposal is ${input.status} — only an APPROVED proposal promotes` }
  if (input.actor.type === "agent") return { allow: false, reason: "an AI agent never promotes a change to the OS (LAW 4) — a human or a governed manager decides" }
  if (input.verdict === "fail") return { allow: false, reason: "the evaluation FAILED — a failed proposal is never promoted" }
  if (input.actor.type === "user") {
    return input.actor.isTenantAdmin
      ? { allow: true, reason: "tenant admin (human authority)" }
      : { allow: false, reason: "only a broker, owner, admin, team lead or compliance officer promotes a proposal" }
  }
  if (input.verdict !== "pass") return { allow: false, reason: "the evaluation is inconclusive — APPROVAL_REQUIRED: a human decides" }
  if (input.authorityRequired >= OWNER_AUTHORITY_LEVEL) return { allow: false, reason: "owner-level change — APPROVAL_REQUIRED: a human promotes it" }
  const rung = input.gate?.actorAuthority ?? null
  if (rung === null || rung < input.authorityRequired) {
    return { allow: false, reason: `${input.actor.managerKey ?? input.actor.type} is at authority level ${rung ?? "unknown"} — this change needs level ${input.authorityRequired}; APPROVAL_REQUIRED` }
  }
  const auto = input.gate?.autonomy ?? null
  if (auto && !auto.allow) return { allow: false, reason: auto.reason ?? "autonomy gate held the promotion — APPROVAL_REQUIRED" }
  return { allow: true, reason: `${input.actor.managerKey ?? input.actor.type} at level ${rung} under the autonomy gate` }
}

// ── PURE-ish: the deterministic evaluators (LLM never scores) ───────────────────────────────

const REPLAYABLE_ISA_FIELDS = ["blocked_lifecycle_states", "max_touches_lead", "touch_interval_days", "lead_allowed_channels"] as const

/**
 * Score a proposal from its evidence — deterministic, no model call.
 * @proofSeam exported so scripts/controlled-learning-guard.ts scores fixtures directly.
 */
export async function evaluateImprovement(
  svc: Svc,
  row: Pick<ImprovementProposalRow, "brokerage_id" | "subject_kind" | "subject_key" | "proposed_change">,
  opts: { now?: Date; replaySinceDays?: number; /** @proofSeam the proof injects a replay report carrying attributed outcomes */ replay?: typeof import("@/lib/kernel/decision-replay").replayDecisions } = {},
): Promise<ProposalEvaluation> {
  const change = row.proposed_change ?? {}
  switch (row.subject_kind) {
    case "variant": {
      const stats = Array.isArray(change.stats) ? (change.stats as VariantStat[]) : []
      const winner = pickWinningVariant(stats)
      const proposed = typeof change.winner === "string" ? change.winner : null
      if (!winner.winner) return { evaluator: "experiment_arms", verdict: "fail", score: null, why: `no clear winner in the arm results (${winner.reason ?? "sample / margin gate"})`, detail: { stats, winner } }
      if (winner.winner !== proposed) return { evaluator: "experiment_arms", verdict: "fail", score: winner.winnerRate ?? null, why: `the arm results name '${winner.winner}', not the proposed '${proposed}'`, detail: { stats, winner } }
      return { evaluator: "experiment_arms", verdict: "pass", score: winner.winnerRate ?? null, why: `'${winner.winner}' wins at ${((winner.winnerRate ?? 0) * 100).toFixed(1)}% reply over ${stats.map((s) => s.sent).reduce((a, b) => a + b, 0)} sends`, detail: { stats, winner } }
    }
    case "threshold": {
      const rec = (change.record ?? {}) as { wins?: number; losses?: number }
      const tuning = predictorTuning(Number(rec.wins ?? 0), Number(rec.losses ?? 0))
      if (tuning.confidence === "unproven") return { evaluator: "predictor_record", verdict: "inconclusive", score: tuning.accuracy, why: tuning.why, detail: { tuning } }
      const same = tuning.requireStrongest === change.requireStrongest && tuning.thresholdMultiplier === change.thresholdMultiplier
      return same
        ? { evaluator: "predictor_record", verdict: "pass", score: tuning.accuracy, why: `the record supports it — ${tuning.why}`, detail: { tuning } }
        : { evaluator: "predictor_record", verdict: "fail", score: tuning.accuracy, why: `the record says ${tuning.confidence} (×${tuning.thresholdMultiplier}, strongest=${tuning.requireStrongest}), not the proposed ×${change.thresholdMultiplier}/strongest=${change.requireStrongest}`, detail: { tuning } }
    }
    case "policy": {
      const policyKey = parsePolicyKey(row.subject_key)
      if (!policyKey) return { evaluator: "none", verdict: "fail", score: null, why: `"${row.subject_key}" is not a registered tenant policy key`, detail: {} }
      if (policyKey.kind !== "isa") return { evaluator: "none", verdict: "inconclusive", score: null, why: `no deterministic replay exists for ${policyKey.kind} policy ${row.subject_key} — a human decides`, detail: { kind: policyKey.kind } }
      const patch: Record<string, unknown> = {}
      for (const f of REPLAYABLE_ISA_FIELDS) if (f in change) patch[f] = change[f]
      if (Object.keys(patch).length === 0) return { evaluator: "none", verdict: "inconclusive", score: null, why: "none of the proposed ISA fields drive the recorded decisions (replayable: blocked_lifecycle_states, max_touches_lead, touch_interval_days, lead_allowed_channels) — a human decides", detail: {} }
      const now = opts.now ?? new Date()
      const since = new Date(now.getTime() - (opts.replaySinceDays ?? 90) * 86_400_000).toISOString()
      const replayDecisions = opts.replay ?? (await import("@/lib/kernel/decision-replay")).replayDecisions
      const { planFromDecisionInput } = await import("@/lib/ai-isa/lead-action-plan")
      const res = await replayDecisions({ brokerageId: row.brokerage_id, since, until: now.toISOString() }, {
        client: svc,
        planner: (snap) => {
          const patched = snap.core ? { ...snap, core: { ...snap.core, settings: { ...snap.core.settings, ...patch } } } : snap
          const p = planFromDecisionInput(patched as typeof snap)
          return p ? { reasonCode: p.reasonCode, action: p.action } : null
        },
      })
      if (!res.ok) return { evaluator: "decision_replay", verdict: "inconclusive", score: null, why: `replay refused: ${res.error}`, detail: {} }
      const r = res.report
      if (r.replayed === 0) return { evaluator: "decision_replay", verdict: "inconclusive", score: null, why: `nothing replayable in the window (examined ${r.examined}, no snapshot ${r.unreplayable.noSnapshot})`, detail: { examined: r.examined, unreplayable: r.unreplayable } }
      const earnedCents = r.disagreements.reduce((s, d) => s + d.outcomes.reduce((t, o) => t + (o.cents > 0 ? o.cents : 0), 0), 0)
      const earnedChanged = r.disagreements.filter((d) => d.outcomes.some((o) => o.cents > 0)).length
      const detail = { replayed: r.replayed, agreements: r.agreements, disagreements: r.disagreements.length, earnedChanged, earnedCents, byReasonCode: r.byReasonCode, attributionError: res.attributionError }
      if (earnedChanged > 0) return { evaluator: "decision_replay", verdict: "fail", score: r.agreementRate, why: `would change ${earnedChanged} decision(s) that earned $${(earnedCents / 100).toFixed(2)} (attributed) — refused`, detail }
      return { evaluator: "decision_replay", verdict: "pass", score: r.agreementRate, why: `replayed ${r.replayed}: ${r.agreements} unchanged, ${r.disagreements.length} would change, none of them earned`, detail }
    }
    case "prompt":
    default:
      return { evaluator: "none", verdict: "inconclusive", score: null, why: "a prompt change has no deterministic replay — a human decides; it is never model-promoted", detail: {} }
  }
}

// ── Writers (service client the caller already gated; tenant = the caller's) ───────────────

export type ProposeResult =
  | { ok: true; id: string; existing: boolean }
  | { ok: false; error: string; degraded?: boolean }

export async function proposeImprovement(
  svc: Svc,
  input: { brokerageId: string; subjectKind: ProposalSubjectKind; subjectKey: string; proposer: Proposer; proposedChange: Record<string, unknown>; evidenceRefs?: unknown[] },
): Promise<ProposeResult> {
  if (!input.brokerageId) return { ok: false, error: "No brokerage — proposal not recorded." }
  if (!PROPOSAL_SUBJECT_KINDS.includes(input.subjectKind)) return { ok: false, error: `unknown subject kind ${String(input.subjectKind)}` }
  if (!PROPOSERS.includes(input.proposer)) return { ok: false, error: `unknown proposer ${String(input.proposer)}` }
  if (input.subjectKind === "policy" && !parsePolicyKey(input.subjectKey)) return { ok: false, error: `"${input.subjectKey}" is not a registered tenant policy key` }
  const { data: open, error: readErr } = await svc
    .from("improvement_proposals").select("id, status")
    .eq("brokerage_id", input.brokerageId).eq("subject_kind", input.subjectKind).eq("subject_key", input.subjectKey)
    .in("status", [...OPEN_STATUSES]).limit(1)
  if (readErr) return { ok: false, degraded: MISSING_TABLE.has(String(readErr.code ?? "")), error: `proposals could not be read (${readErr.message}) — not recorded` }
  const existing = (open ?? [])[0] as { id: string } | undefined
  if (existing) return { ok: true, id: existing.id, existing: true }
  const { data: ins, error: insErr } = await svc.from("improvement_proposals").insert({
    brokerage_id: input.brokerageId,
    subject_kind: input.subjectKind,
    subject_key: input.subjectKey,
    proposer: input.proposer,
    proposed_change: input.proposedChange ?? {},
    evidence_refs: input.evidenceRefs ?? [],
    status: "PROPOSED",
    authority_required: PROPOSAL_AUTHORITY[input.subjectKind],
  }).select("id")
  if (insErr) return { ok: false, degraded: MISSING_TABLE.has(String(insErr.code ?? "")), error: `proposal not recorded (${insErr.message})` }
  const id = (Array.isArray(ins) ? ins[0] : ins)?.id as string | undefined
  if (!id) return { ok: false, error: "proposal insert returned no row — not recorded" }
  await audit(svc, input.brokerageId, "improvement_proposal.proposed", id, null, { subject_kind: input.subjectKind, subject_key: input.subjectKey, proposer: input.proposer })
  return { ok: true, id, existing: false }
}

export type LoadProposalResult = { ok: true; row: ImprovementProposalRow } | { ok: false; error: string }

/** Tenant-scoped read of one proposal — another tenant's id is simply absent. */
export async function loadProposal(svc: Svc, brokerageId: string, id: string): Promise<LoadProposalResult> {
  if (!brokerageId || !id) return { ok: false, error: "No brokerage / proposal id." }
  const { data, error } = await svc.from("improvement_proposals").select("id, brokerage_id, subject_kind, subject_key, proposer, proposed_change, evidence_refs, status, evaluation, evaluated_at, authority_required, decided_by, decided_at, decision_reason, policy_version_ref, promoted_at, rolled_back_at, rollback_policy_version_ref, created_at, updated_at").eq("brokerage_id", brokerageId).eq("id", id).limit(1)
  if (error) return { ok: false, error: `proposal could not be read: ${error.message}` }
  const row = (data ?? [])[0] as ImprovementProposalRow | undefined
  if (!row) return { ok: false, error: "Proposal not found for this brokerage." }
  return { ok: true, row }
}

export async function listImprovementProposals(svc: Svc, brokerageId: string, opts: { limit?: number } = {}): Promise<{ ok: true; available: boolean; rows: ImprovementProposalRow[] } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "No brokerage on this session." }
  const { data, error } = await svc.from("improvement_proposals").select("id, brokerage_id, subject_kind, subject_key, proposer, proposed_change, evidence_refs, status, evaluation, evaluated_at, authority_required, decided_by, decided_at, decision_reason, policy_version_ref, promoted_at, rolled_back_at, rollback_policy_version_ref, created_at, updated_at").eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(opts.limit ?? 100)
  if (error) {
    if (MISSING_TABLE.has(String(error.code ?? ""))) return { ok: true, available: false, rows: [] }
    return { ok: false, error: `proposals could not be read: ${error.message}` }
  }
  return { ok: true, available: true, rows: (data ?? []) as ImprovementProposalRow[] }
}

/** A COUNTED tenant-scoped update (CLAUDE.md §3: a matched-nothing update also resolves). */
async function patchProposal(svc: Svc, brokerageId: string, id: string, patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await svc.from("improvement_proposals").update({ ...patch, updated_at: new Date().toISOString() }).eq("brokerage_id", brokerageId).eq("id", id).select("id")
  if (error) return { ok: false, error: `proposal not updated: ${error.message}` }
  if ((data ?? []).length !== 1) return { ok: false, error: "proposal not updated: no row matched this brokerage + id" }
  return { ok: true }
}

async function audit(svc: Svc, brokerageId: string, event: string, id: string, actorUserId: string | null, metadata: Record<string, unknown>): Promise<void> {
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({ event, brokerageId, entityType: "improvement_proposal", entityId: id, actorUserId, source: actorUserId ? "ui" : "system", metadata, auditOnly: true, client: svc as any })
  } catch { /* evidence is best-effort here; the ledger row is the consequential record */ }
}

export type EvaluateResult = { ok: true; status: ProposalStatus; evaluation: ProposalEvaluation } | { ok: false; error: string }

/** PROPOSED → EVALUATED (verdict pass / inconclusive) or → REJECTED (verdict fail; the evaluator decided). */
export async function evaluateProposal(svc: Svc, input: { brokerageId: string; id: string }, opts: Parameters<typeof evaluateImprovement>[2] = {}): Promise<EvaluateResult> {
  const got = await loadProposal(svc, input.brokerageId, input.id)
  if (!got.ok) return got
  const row = got.row
  if (row.status !== "PROPOSED" && row.status !== "EVALUATED") return { ok: false, error: `proposal is ${row.status} — only a PROPOSED proposal is evaluated` }
  const evaluation = await evaluateImprovement(svc, row, opts)
  const now = (opts.now ?? new Date()).toISOString()
  const rejected = evaluation.verdict === "fail"
  const next: ProposalStatus = rejected ? "REJECTED" : "EVALUATED"
  if (!canTransition(row.status, next) && !(row.status === "EVALUATED" && next === "EVALUATED")) return { ok: false, error: `cannot move ${row.status} → ${next}` }
  const w = await patchProposal(svc, row.brokerage_id, row.id, {
    status: next, evaluation, evaluated_at: now,
    ...(rejected ? { decided_by: null, decided_at: now, decision_reason: `evaluator ${evaluation.evaluator}: ${evaluation.why}` } : {}),
  })
  if (!w.ok) return w
  await audit(svc, row.brokerage_id, rejected ? "improvement_proposal.rejected" : "improvement_proposal.evaluated", row.id, null, { evaluator: evaluation.evaluator, verdict: evaluation.verdict, score: evaluation.score })
  return { ok: true, status: next, evaluation }
}

export type DecideResult = { ok: true; status: ProposalStatus } | { ok: false; error: string }

/**
 * EVALUATED → APPROVED / REJECTED. A human on the admin roster decides freely; a manager / the
 * system approves only what promotionDecision would let it promote (same rule, decided AS approved).
 */
export async function decideProposal(
  svc: Svc,
  input: { brokerageId: string; id: string; decision: "approve" | "reject"; actor: ProposalActor; gate?: PromotionGate | null; reason?: string | null },
): Promise<DecideResult> {
  const got = await loadProposal(svc, input.brokerageId, input.id)
  if (!got.ok) return got
  const row = got.row
  const next: ProposalStatus = input.decision === "approve" ? "APPROVED" : "REJECTED"
  if (!canTransition(row.status, next)) return { ok: false, error: `cannot move ${row.status} → ${next}` }
  if (input.actor.type === "agent") return { ok: false, error: "an AI agent never decides a proposal (LAW 4)" }
  if (input.actor.type === "user" && !input.actor.isTenantAdmin) return { ok: false, error: "only a broker, owner, admin, team lead or compliance officer decides a proposal" }
  if (input.decision === "approve" && input.actor.type !== "user") {
    const d = promotionDecision({ status: "APPROVED", verdict: row.evaluation?.verdict ?? null, authorityRequired: row.authority_required, actor: input.actor, gate: input.gate })
    if (!d.allow) return { ok: false, error: d.reason }
  }
  const now = new Date().toISOString()
  const w = await patchProposal(svc, row.brokerage_id, row.id, {
    status: next, decided_by: input.actor.userId ?? null, decided_at: now,
    decision_reason: (input.reason ?? `${input.decision} by ${input.actor.managerKey ?? input.actor.type}`).slice(0, 500),
  })
  if (!w.ok) return w
  await audit(svc, row.brokerage_id, `improvement_proposal.${input.decision === "approve" ? "approved" : "rejected"}`, row.id, input.actor.userId ?? null, { actor_type: input.actor.type, manager_key: input.actor.managerKey ?? null, reason: input.reason ?? null })
  return { ok: true, status: next }
}

export type PromoteResult =
  | { ok: true; policyVersionRef: string | null; writer: string }
  | { ok: false; error: string; held?: boolean }

/** How a promotion lands — each kind through its SURVIVOR writer; returns what to roll back to. */
async function applyChange(svc: Svc, row: ImprovementProposalRow, actor: PolicyActor, direction: "promote" | "rollback"): Promise<{ writer: string; previous: unknown; policyVersionRef: string | null; loserIds?: string[] }> {
  const change = row.proposed_change ?? {}
  const prior = row.evaluation?.promotion
  switch (row.subject_kind) {
    case "policy": {
      // Named for what the message blames (error-message honesty): the thing tested IS the policy key.
      const policyKey = parsePolicyKey(row.subject_key)
      if (!policyKey) throw new Error(`Policy key "${row.subject_key}" is not registered for this tenant`)
      if (policyKey.kind === "settings") {
        const { mergeBrokerageSettings } = await import("@/lib/settings/brokerage-settings-merge")
        let previous: unknown = undefined
        const value = direction === "promote" ? change.value : prior?.previous
        const w = await mergeBrokerageSettings(svc, row.brokerage_id, (cur) => { previous = cur[policyKey.key]; return { [policyKey.key]: value === null ? undefined : value } }, { policy: actor })
        if (!w.ok) throw new Error(w.error)
        const v = w.policyVersions.find((p) => p.key === policyKey.key)
        return { writer: "mergeBrokerageSettings", previous, policyVersionRef: v?.version ? formatPolicyRef(policyKey.key, v.version) : null }
      }
      if (policyKey.kind === "isa") {
        const { writeIsaSettings } = await import("@/lib/ai-isa/resolve-isa-settings")
        const { currentPolicyVersion } = await import("@/lib/kernel/tenant-policy")
        const ownerId = policyKey.ownerType === "brokerage" ? row.brokerage_id : policyKey.ownerId
        const updates = (direction === "promote" ? change : (prior?.previous ?? {})) as Record<string, unknown>
        const w = await writeIsaSettings({ owner: { ownerType: policyKey.ownerType, ownerId } as any, brokerageId: row.brokerage_id, updates: updates as any, actor })
        if (!w.success) throw new Error(w.error ?? "ISA settings not written")
        const v = await currentPolicyVersion(svc, row.brokerage_id, row.subject_key)
        return { writer: "writeIsaSettings", previous: prior?.previous ?? change.previous ?? null, policyVersionRef: v.ok && v.version ? formatPolicyRef(row.subject_key, v.version) : null }
      }
      throw new Error(`${policyKey.kind} policy ${row.subject_key} promotes only on its own settings screen (no kernel writer here)`)
    }
    case "threshold": {
      const predictor = String(change.predictor ?? row.subject_key.replace(/^predictor:/, ""))
      const { mergeBrokerageSettings } = await import("@/lib/settings/brokerage-settings-merge")
      let previous: unknown = undefined
      const w = await mergeBrokerageSettings(svc, row.brokerage_id, (cur) => {
        const all = (cur.predictor_tuning && typeof cur.predictor_tuning === "object" ? { ...(cur.predictor_tuning as Record<string, unknown>) } : {}) as Record<string, unknown>
        previous = all[predictor]
        if (direction === "promote") all[predictor] = { thresholdMultiplier: change.thresholdMultiplier, requireStrongest: change.requireStrongest === true }
        else if (prior?.previous === undefined || prior?.previous === null) delete all[predictor]
        else all[predictor] = prior.previous
        return { predictor_tuning: all }
      }, { policy: actor })
      if (!w.ok) throw new Error(w.error)
      const v = w.policyVersions.find((p) => p.key === "predictor_tuning")
      return { writer: "mergeBrokerageSettings:predictor_tuning", previous, policyVersionRef: v?.version ? formatPolicyRef("predictor_tuning", v.version) : null }
    }
    case "variant": {
      const { retireLosingVariants, restoreRetiredVariants } = await import("@/lib/campaign-sequences/copy-learning-conductor")
      const loserIds = (direction === "promote" ? (Array.isArray(change.loserIds) ? change.loserIds : []) : (prior?.loserIds ?? [])).map(String)
      const r = direction === "promote" ? await retireLosingVariants(svc, row.brokerage_id, loserIds) : await restoreRetiredVariants(svc, row.brokerage_id, loserIds)
      if (!r.ok) throw new Error(r.error)
      return { writer: "campaign_sequence_steps.is_active", previous: { active: true }, policyVersionRef: null, loserIds }
    }
    case "prompt":
    default:
      throw new Error("no survivor writer applies a prompt change — model_retraining_log is advisory; the approval is the review")
  }
}

/**
 * APPROVED → PROMOTED, through the subject's survivor writer, under promotionDecision, ledgered
 * (learning.proposal.promote; a human's WHY is HUMAN_REQUESTED, the loop's own is LEARNED_IMPROVEMENT).
 */
export async function promoteProposal(
  svc: Svc,
  input: { brokerageId: string; id: string; actor: ProposalActor; gate?: PromotionGate | null },
): Promise<PromoteResult> {
  const got = await loadProposal(svc, input.brokerageId, input.id)
  if (!got.ok) return got
  const row = got.row
  const d = promotionDecision({ status: row.status, verdict: row.evaluation?.verdict ?? null, authorityRequired: row.authority_required, actor: input.actor, gate: input.gate })
  if (!d.allow) return { ok: false, held: true, error: d.reason }
  return ledgered(svc, row, input.actor, "promote")
}

/** PROMOTED → ROLLED_BACK: the previous value back through the same writer (a NEW version; history stays). */
export async function rollbackProposal(
  svc: Svc,
  input: { brokerageId: string; id: string; actor: ProposalActor },
): Promise<PromoteResult> {
  const got = await loadProposal(svc, input.brokerageId, input.id)
  if (!got.ok) return got
  const row = got.row
  if (!canTransition(row.status, "ROLLED_BACK")) return { ok: false, error: `proposal is ${row.status} — only a PROMOTED proposal rolls back` }
  if (input.actor.type === "agent") return { ok: false, held: true, error: "an AI agent never rolls back a promotion (LAW 4)" }
  if (input.actor.type === "user" && !input.actor.isTenantAdmin) return { ok: false, held: true, error: "only a broker, owner, admin, team lead or compliance officer rolls back a promotion" }
  return ledgered(svc, row, input.actor, "rollback")
}

async function ledgered(svc: Svc, row: ImprovementProposalRow, actor: ProposalActor, direction: "promote" | "rollback"): Promise<PromoteResult> {
  const policyActor: PolicyActor = { type: actor.type === "agent" ? "system" : actor.type, userId: actor.userId ?? null, managerKey: actor.managerKey ?? null, reason: (actor.reason ?? `${direction} improvement proposal ${row.id} (${row.subject_kind} ${row.subject_key})`).slice(0, 500) }
  const policyKey = row.subject_kind === "policy" ? row.subject_key : row.subject_kind === "threshold" ? "predictor_tuning" : null
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const res = await withActionLedger<{ ok: true; applied: Awaited<ReturnType<typeof applyChange>> } | { ok: false; error: string }>(
      {
        brokerageId: row.brokerage_id,
        action: `learning.proposal.${direction}`,
        actor: { type: actor.type === "agent" ? "system" : actor.type, userId: actor.userId ?? null, managerKey: actor.managerKey ?? null },
        subject: { type: "improvement_proposal", id: row.id },
        reasonCode: actor.type === "user" ? "HUMAN_REQUESTED" : "LEARNED_IMPROVEMENT",
        reasonDetail: policyActor.reason,
        idempotencyKey: `learning.proposal.${direction}:${row.id}`,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "controlled_learning",
        policyKey,
        detail: { subject_kind: row.subject_kind, subject_key: row.subject_key, proposer: row.proposer, proposed_change: row.proposed_change, evaluation: row.evaluation ? { evaluator: row.evaluation.evaluator, verdict: row.evaluation.verdict, score: row.evaluation.score } : null },
      },
      async () => ({ ok: true as const, applied: await applyChange(svc, row, policyActor, direction) }),
      {
        settle: (r) => r.ok ? { status: "executed", outcome: direction, provider: r.applied.writer } : { status: "failed", outcome: "writer_refused", error: r.error },
        replay: (claim) => ({ ok: false as const, error: claim.kind === "replay" ? `already ${direction}d (ledger ${claim.entry.id})` : `ledger refused the ${direction}: ${claim.kind}` }),
      },
      { client: svc as any },
    )
    if (!res.ok) return { ok: false, error: res.error }
    const now = new Date().toISOString()
    const patch = direction === "promote"
      ? { status: "PROMOTED", promoted_at: now, policy_version_ref: res.applied.policyVersionRef, evaluation: { ...(row.evaluation ?? { evaluator: "none", verdict: "inconclusive", score: null, why: "", detail: {} }), promotion: { writer: res.applied.writer, previous: res.applied.previous ?? null, loserIds: res.applied.loserIds } } }
      : { status: "ROLLED_BACK", rolled_back_at: now, rollback_policy_version_ref: res.applied.policyVersionRef }
    const w = await patchProposal(svc, row.brokerage_id, row.id, patch)
    if (!w.ok) return { ok: false, error: `${direction} LANDED but the proposal row was not marked: ${w.error}` }
    await audit(svc, row.brokerage_id, `improvement_proposal.${direction === "promote" ? "promoted" : "rolled_back"}`, row.id, actor.userId ?? null, { actor_type: actor.type, manager_key: actor.managerKey ?? null, writer: res.applied.writer, policy_version_ref: res.applied.policyVersionRef })
    return { ok: true, policyVersionRef: res.applied.policyVersionRef, writer: res.applied.writer }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}

/**
 * The learners' one call: propose, evaluate, and — when a governed manager brings a gate that
 * allows it — approve and promote in the same pass. Anything held stays EVALUATED for the
 * Manager Trust page. Never throws.
 */
export async function proposeEvaluatePromote(
  svc: Svc,
  input: Parameters<typeof proposeImprovement>[1] & { actor?: ProposalActor | null; gate?: PromotionGate | null },
): Promise<{ proposal: ProposeResult; status: ProposalStatus | null; promoted: boolean; held: string | null; policyVersionRef: string | null }> {
  const out = { proposal: await proposeImprovement(svc, input), status: null as ProposalStatus | null, promoted: false, held: null as string | null, policyVersionRef: null as string | null }
  if (!out.proposal.ok) { out.held = out.proposal.error; return out }
  const id = out.proposal.id
  const got = await loadProposal(svc, input.brokerageId, id)
  if (!got.ok) { out.held = got.error; return out }
  out.status = got.row.status
  if (got.row.status === "PROPOSED") {
    const ev = await evaluateProposal(svc, { brokerageId: input.brokerageId, id })
    if (!ev.ok) { out.held = ev.error; return out }
    out.status = ev.status
  }
  if (!input.actor || out.status !== "EVALUATED") { if (out.status !== "PROMOTED") out.held = `proposal ${out.status} — awaiting a human on the Manager Trust page`; return out }
  const approved = await decideProposal(svc, { brokerageId: input.brokerageId, id, decision: "approve", actor: input.actor, gate: input.gate })
  if (!approved.ok) { out.held = approved.error; return out }
  out.status = approved.status
  const prom = await promoteProposal(svc, { brokerageId: input.brokerageId, id, actor: input.actor, gate: input.gate })
  if (!prom.ok) { out.held = prom.error; return out }
  out.status = "PROMOTED"; out.promoted = true; out.policyVersionRef = prom.policyVersionRef
  return out
}
