/**
 * lib/kernel/experiment-pipeline.ts — AUTONOMOUS EXPERIMENTATION (wave 108, lane 108F; m731).
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner: "proposal → historical replay → policy/risk → budget → cohort → measure → statistical evaluation →
 * promote/reject; humans control which experiment classes may deploy autonomously."
 *
 * NO NEW ENGINE — this file is the LIFECYCLE over the survivors (LAW 1/2):
 *   · the object .......... improvement_proposals (104C) — subject_kind `experiment`, proposer `experimentation`
 *                           (m731 additive widening). PROPOSED → EVALUATED → APPROVED (= RUNNING) →
 *                           PROMOTED (winner ADOPTED) / REJECTED. Every transition through the survivor's own
 *                           writers (proposeImprovement / evaluateProposal / decideProposal / promoteProposal).
 *   · cohort assignment ... lib/kernel/experiments.ts assignExperimentArm (stable hash, tenant kill switch →
 *                           control) + experimentLedgerDetail (ledger detail.experiment = { key, arm }, which
 *                           roi-ledger rolls up as byExperimentArm).
 *   · the class grant ..... the `experiments` policy key (settings.experiments.autonomous_classes; DEFAULT NONE).
 *   · the budget .......... lib/kernel/autonomy-budgets.ts consumeAutonomyEnvelope("experiment_budget").
 *   · measurement ......... lib/intelligence/roi-ledger.ts loadLedgerAttribution (the ONE outcome reader; since
 *                           wave 137 its `appointment` kind includes seller listing appointments).
 *   · statistics .......... lib/intelligence/strategy-learning.ts strategySignificance (pooled two-proportion
 *                           z-test, 95 %, sample floor) — deterministic; a model never scores.
 *   · evaluator replay .... historical replay of the COHORT over the control's own enrollment history (the
 *                           decision-replay harness replays NBA verdicts; an enrollment choice has no planner).
 * Classes NEVER experimented on: authority policy, financial rules, compliance boundaries (PROTECTED_SUBJECTS).
 * WIRED: lib/campaign-sequences/enrollment-engine.ts enrollContact routes a CONTACT through a running / adopted
 * experiment (routeEnrollmentThroughExperiments); app/api/cron/source-conversion-learning runs the owner's example
 * proposer (proposeVideoFirstSellerExperiments — Campaign Manager: video-first seller campaign → appointment rate)
 * and concludeExperiments per tenant, weekly.
 */

import { assignExperimentArm, experimentLedgerDetail, loadExperimentPolicy, type ExperimentDefinition, type ExperimentPolicy } from "@/lib/kernel/experiments"
import { LEDGER_OUTCOME_KINDS, type LedgerOutcomeKind } from "@/lib/intelligence/roi-ledger"
import type { ImprovementProposalRow, ProposalEvaluation } from "@/lib/kernel/improvement-proposals"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any }

export const EXPERIMENT_CLASSES = ["copy_variant", "send_timing", "sequence_choice", "creative_format", "follow_up_cadence", "channel_mix"] as const
export type ExperimentClass = (typeof EXPERIMENT_CLASSES)[number]

/** What an experiment may NEVER touch (owner: never authority policies, financial rules or compliance boundaries). */
export const PROTECTED_SUBJECTS = ["authority_policy", "financial_rule", "compliance_boundary", "commission", "pricing", "fair_housing"] as const

/** The only assignment surface wired today (the enrollment chokepoint). */
export const EXPERIMENT_SURFACES = ["sequence_enrollment"] as const

/** Mirrors strategy-learning's sample floor (STRATEGY_MIN_SAMPLE = 30) — the same statistician decides. */
export const DEFAULT_MIN_SAMPLE_PER_ARM = 30

export interface ExperimentSpec {
  /** Stable slug — the experiment's identity (subject key `experiment:<key>`, arm key `exp_<key>`). */
  key: string
  hypothesis: string
  /** The outcome the hypothesis is about — LEDGER_OUTCOME_KINDS (reply / appointment / contract / closed). */
  metric: LedgerOutcomeKind
  experimentClass: ExperimentClass
  /** The proposing manager (MANAGERS key). */
  manager: ManagerKey
  cohort: { surface: (typeof EXPERIMENT_SURFACES)[number]; control_sequence_id: string; treatment_sequence_id: string; contact_types?: string[] | null; treatment_share?: number | null; description?: string | null }
  durationDays: number
  budgetUsd: number
  minSamplePerArm?: number | null
  /** Anything the change touches beyond the class (a PROTECTED subject refuses the experiment). */
  touches?: string[] | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** PURE — every refusal named.
 * @proofSeam scripts/autonomous-budgeting-guard.ts asserts the spec gate directly. */
export function validateExperimentSpec(s: Partial<ExperimentSpec> | null | undefined): { ok: boolean; errors: string[] } {
  const e: string[] = []
  if (!s) return { ok: false, errors: ["no spec"] }
  if (!s.key || !/^[a-z0-9_]{3,64}$/.test(s.key)) e.push("key must be a 3–64 char [a-z0-9_] slug")
  if (!s.hypothesis || s.hypothesis.trim().length < 10) e.push("a hypothesis is required")
  if (!s.metric || !(LEDGER_OUTCOME_KINDS as readonly string[]).includes(s.metric)) e.push(`metric must be one of ${LEDGER_OUTCOME_KINDS.join(", ")}`)
  if (!s.experimentClass || !(EXPERIMENT_CLASSES as readonly string[]).includes(s.experimentClass)) e.push(`class must be one of ${EXPERIMENT_CLASSES.join(", ")}`)
  if (!s.manager) e.push("the proposing manager is required")
  const c = s.cohort
  if (!c || !(EXPERIMENT_SURFACES as readonly string[]).includes(c.surface)) e.push(`cohort surface must be one of ${EXPERIMENT_SURFACES.join(", ")}`)
  else {
    if (!UUID_RE.test(String(c.control_sequence_id)) || !UUID_RE.test(String(c.treatment_sequence_id))) e.push("cohort needs a control and a treatment sequence id")
    else if (c.control_sequence_id === c.treatment_sequence_id) e.push("control and treatment must differ")
    if (c.treatment_share != null && !(c.treatment_share > 0 && c.treatment_share < 1)) e.push("treatment_share must be in (0, 1)")
  }
  if (!(Number.isFinite(s.durationDays) && (s.durationDays as number) >= 7 && (s.durationDays as number) <= 180)) e.push("duration must be 7–180 days")
  if (!(Number.isFinite(s.budgetUsd) && (s.budgetUsd as number) >= 0)) e.push("budget must be ≥ 0")
  const prot = (s.touches ?? []).filter((t) => (PROTECTED_SUBJECTS as readonly string[]).includes(t))
  if (prot.length) e.push(`an experiment never touches ${prot.join(", ")} (authority / financial / compliance boundaries)`)
  return { ok: e.length === 0, errors: e }
}

function experimentSubjectKey(spec: Pick<ExperimentSpec, "key">): string { return `experiment:${spec.key}` }

/** PURE — the weighted-arm definition the ONE assigner hashes over. */
function definitionForExperiment(spec: ExperimentSpec): ExperimentDefinition {
  const share = spec.cohort.treatment_share ?? 0.5
  return {
    key: `exp_${spec.key}`, description: spec.hypothesis, control: "control",
    arms: [{ key: "control", weight: Math.round((1 - share) * 1000) }, { key: "treatment", weight: Math.round(share * 1000) }],
    instanceSwitch: "improvement_proposals.status = APPROVED (subject_kind experiment)",
  }
}

const specOf = (row: Pick<ImprovementProposalRow, "proposed_change">): ExperimentSpec | null => {
  const s = (row.proposed_change ?? {}).spec as ExperimentSpec | undefined
  return s && validateExperimentSpec(s).ok ? s : null
}

const endsAt = (row: Pick<ImprovementProposalRow, "decided_at">, spec: ExperimentSpec): number => Date.parse(String(row.decided_at ?? "")) + spec.durationDays * 86_400_000

// ── PURE: measurement + verdict ───────────────────────────────────────────────────────────────

export interface ArmMeasure { exposures: number; conversions: number }

/** PURE — intention-to-treat: each assigned subject counts once in its arm; it converts when a metric outcome names
 * it after its assignment and before the window closes.
 * @proofSeam scripts/autonomous-budgeting-guard.ts asserts the measurement rule directly. */
export function measureExperimentArms(input: { assignments: Array<{ subjectId: string; arm: string; at: string }>; outcomes: Array<{ kind: string; subjectIds: string[]; at: string }>; metric: LedgerOutcomeKind; windowEndIso: string }): { control: ArmMeasure; treatment: ArmMeasure } {
  const first = new Map<string, { arm: string; at: number }>()
  for (const a of [...input.assignments].sort((x, y) => x.at.localeCompare(y.at))) if (!first.has(a.subjectId)) first.set(a.subjectId, { arm: a.arm, at: Date.parse(a.at) })
  const end = Date.parse(input.windowEndIso)
  const out = { control: { exposures: 0, conversions: 0 }, treatment: { exposures: 0, conversions: 0 } }
  for (const [subject, a] of first) {
    const arm = a.arm === "treatment" ? out.treatment : a.arm === "control" ? out.control : null
    if (!arm) continue
    arm.exposures++
    if (input.outcomes.some((o) => o.kind === input.metric && o.subjectIds.includes(subject) && Date.parse(o.at) >= a.at && Date.parse(o.at) <= end)) arm.conversions++
  }
  return out
}

export type ExperimentConclusion = "adopt_treatment" | "reject_control_held" | "reject_no_lift" | "reject_insufficient" | "running"

/** PURE — the deterministic verdict at (or before) the end of the window. Interim reads never conclude (no peeking).
 * @proofSeam scripts/autonomous-budgeting-guard.ts asserts every conclusion directly. */
export function experimentConclusion(sig: { verdict: string }, ended: boolean): ExperimentConclusion {
  if (!ended) return "running"
  if (sig.verdict === "a_better") return "adopt_treatment"
  if (sig.verdict === "b_better") return "reject_control_held"
  if (sig.verdict === "no_difference") return "reject_no_lift"
  return "reject_insufficient"
}

// ── EVALUATION: historical replay + policy/risk + budget (the pre-run gate) ───────────────────

/** Called by improvement-proposals.ts evaluateImprovement for subject_kind `experiment`. Deterministic. */
export async function evaluateExperimentProposal(svc: Svc, row: Pick<ImprovementProposalRow, "brokerage_id" | "subject_kind" | "subject_key" | "proposed_change">, opts: { now?: Date; policy?: ExperimentPolicy } = {}): Promise<ProposalEvaluation> {
  const now = opts.now ?? new Date()
  const raw = (row.proposed_change ?? {}).spec as ExperimentSpec | undefined
  const v = validateExperimentSpec(raw)
  if (!v.ok || !raw) return { evaluator: "experiment_replay", verdict: "fail", score: null, why: `spec refused: ${v.errors.join("; ")}`, detail: { errors: v.errors } }
  const spec = raw
  const steps: Array<{ step: string; ok: boolean; why: string }> = []
  // POLICY / RISK
  const policy = opts.policy ?? (await loadExperimentPolicy(svc, row.brokerage_id))
  if (!policy.readable) return { evaluator: "experiment_replay", verdict: "inconclusive", score: null, why: "experiments policy unreadable — not deployable until it reads (fail closed)", detail: { steps } }
  if (policy.killSwitch) return { evaluator: "experiment_replay", verdict: "fail", score: null, why: "the tenant's experiment kill switch is ON", detail: { steps } }
  if (policy.disabled.includes(`exp_${spec.key}`)) return { evaluator: "experiment_replay", verdict: "fail", score: null, why: `exp_${spec.key} is disabled in the experiments policy`, detail: { steps } }
  steps.push({ step: "policy_risk", ok: true, why: `class ${spec.experimentClass}; touches no protected subject; kill switch off` })
  // SURFACES — both sequences are this tenant's, active and compliance-gated
  const { data: seqs, error: seqErr } = await svc.from("campaign_sequences").select("id, is_active, compliance_gated, contact_type").eq("brokerage_id", row.brokerage_id).in("id", [spec.cohort.control_sequence_id, spec.cohort.treatment_sequence_id])
  if (seqErr) return { evaluator: "experiment_replay", verdict: "inconclusive", score: null, why: `campaign_sequences read refused: ${seqErr.message}`, detail: { steps } }
  const live = ((seqs ?? []) as Array<{ id: string; is_active: boolean; compliance_gated: boolean }>).filter((s) => s.is_active && s.compliance_gated)
  if (live.length !== 2) return { evaluator: "experiment_replay", verdict: "fail", score: null, why: "control and treatment must both be ACTIVE, compliance-gated sequences of this brokerage", detail: { steps, found: (seqs ?? []).length } }
  steps.push({ step: "surfaces", ok: true, why: "both sequences active + compliance-gated in this tenant" })
  // HISTORICAL REPLAY — run the cohort rule over the control's enrollment history
  const lookbackDays = Math.min(180, Math.max(30, spec.durationDays * 3))
  const since = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString()
  const { data: enr, error: enrErr } = await svc.from("sequence_enrollments").select("contact_id, enrolled_at").eq("brokerage_id", row.brokerage_id).eq("sequence_id", spec.cohort.control_sequence_id).gte("enrolled_at", since).limit(5000)
  if (enrErr) return { evaluator: "experiment_replay", verdict: "inconclusive", score: null, why: `sequence_enrollments read refused: ${enrErr.message}`, detail: { steps } }
  let hist = ((enr ?? []) as Array<{ contact_id: string | null; enrolled_at: string }>).filter((r) => !!r.contact_id) as Array<{ contact_id: string; enrolled_at: string }>
  if (spec.cohort.contact_types?.length && hist.length) {
    const ids = [...new Set(hist.map((h) => h.contact_id))]
    const types = new Map<string, string>()
    for (let i = 0; i < ids.length; i += 200) {
      const { data: cs, error: cErr } = await svc.from("contacts").select("id, contact_type").eq("brokerage_id", row.brokerage_id).in("id", ids.slice(i, i + 200))
      if (cErr) return { evaluator: "experiment_replay", verdict: "inconclusive", score: null, why: `contacts read refused: ${cErr.message}`, detail: { steps } }
      for (const c of (cs ?? []) as Array<{ id: string; contact_type: string | null }>) types.set(c.id, String(c.contact_type ?? ""))
    }
    hist = hist.filter((h) => spec.cohort.contact_types!.includes(types.get(h.contact_id) ?? ""))
  }
  const share = spec.cohort.treatment_share ?? 0.5
  const expected = (hist.length / lookbackDays) * spec.durationDays
  const minArm = Math.floor(expected * Math.min(share, 1 - share))
  const minSample = spec.minSamplePerArm ?? DEFAULT_MIN_SAMPLE_PER_ARM
  const outcomes = await metricOutcomes(svc, row.brokerage_id, spec.metric, since)
  const baselineHits = outcomes.ok ? hist.filter((h) => outcomes.rows.some((o) => o.subjectIds.includes(h.contact_id) && Date.parse(o.at) >= Date.parse(h.enrolled_at) && Date.parse(o.at) <= Date.parse(h.enrolled_at) + spec.durationDays * 86_400_000)).length : 0
  const baseline = hist.length > 0 && outcomes.ok ? Math.round((baselineHits / hist.length) * 10000) / 10000 : null
  const replay = { lookbackDays, historicalCohort: hist.length, expectedOverDuration: Math.round(expected), smallerArmExpected: minArm, minSamplePerArm: minSample, baselineRate: baseline, outcomeReader: outcomes.ok ? "loadLedgerAttribution" : `refused: ${outcomes.error}` }
  if (minArm < minSample) return { evaluator: "experiment_replay", verdict: "fail", score: baseline, why: `underpowered — history shows ${hist.length} cohort enrollments in ${lookbackDays}d, so ≈${minArm} in the smaller arm over ${spec.durationDays}d (< ${minSample}); it could never decide`, detail: { steps, replay } }
  steps.push({ step: "historical_replay", ok: true, why: `≈${minArm}+ per arm expected; baseline ${spec.metric} rate ${baseline ?? "unknown"}` })
  // BUDGET — the envelope is CONSUMED at an autonomous deploy; here only whether one could
  const { loadAutonomyBudgets, envelopeLimits } = await import("@/lib/kernel/autonomy-budgets")
  const lim = spec.budgetUsd > 0 ? envelopeLimits(await loadAutonomyBudgets(svc, row.brokerage_id), "experiment_budget") : null
  const budgetAutonomous = spec.budgetUsd === 0 || (!!lim?.open && (lim.periodCap ?? 0) >= spec.budgetUsd)
  steps.push({ step: "budget", ok: true, why: spec.budgetUsd === 0 ? "no budget asked" : budgetAutonomous ? `$${spec.budgetUsd} fits the experiment envelope (${lim?.why})` : `$${spec.budgetUsd} exceeds the experiment envelope (${lim?.why ?? "closed"}) — a human deploys` })
  const autonomousClass = (policy.autonomousClasses ?? []).includes(spec.experimentClass)
  return {
    evaluator: "experiment_replay", verdict: "pass", score: baseline,
    why: `deployable: ${steps.map((s) => s.why).join(" · ")}${autonomousClass && budgetAutonomous ? " — class is autonomous for this tenant" : " — a human deploys (Manager Trust page)"}`,
    detail: { pipeline: { steps, replay, autonomousClass, budgetAutonomous } },
  }
}

/** The metric's outcomes for a tenant since a date, through the ONE outcome reader. */
async function metricOutcomes(svc: Svc, brokerageId: string, metric: LedgerOutcomeKind, sinceIso: string): Promise<{ ok: true; rows: Array<{ kind: string; subjectIds: string[]; at: string }> } | { ok: false; error: string }> {
  const { loadLedgerAttribution } = await import("@/lib/intelligence/roi-ledger")
  const attr = await loadLedgerAttribution(svc, brokerageId, { sinceIso })
  if (!attr.ok) return { ok: false, error: attr.error }
  const rows: Array<{ kind: string; subjectIds: string[]; at: string }> = attr.result.outcomes.filter((o) => o.kind === metric).map((o) => ({ kind: o.kind, subjectIds: o.subjectIds, at: o.at }))
  // TOMBSTONE (wave 137, CLAUDE.md §1.1): a side read of listings.appointment_at stood here because the
  // roi-ledger `appointment` kind was showings only. MERGED onto the survivor —
  // lib/intelligence/roi-ledger.ts loadLedgerAttribution (listing_presentations + listings appointments,
  // LISTING_APPOINTMENT_REF / LISTING_ROW_APPOINTMENT_REF) — so the appointment metric has ONE reader.
  return { ok: true, rows }
}

// ── PROPOSE → EVALUATE → DEPLOY ───────────────────────────────────────────────────────────────

export interface ExperimentRunResult { proposalId: string | null; status: string | null; deployed: boolean; held: string | null; existing: boolean }

/** A manager proposes; the pipeline evaluates; a class the tenant made autonomous deploys at once (within the envelope). */
export async function proposeExperiment(svc: Svc, input: { brokerageId: string; spec: ExperimentSpec; now?: Date }): Promise<ExperimentRunResult> {
  const v = validateExperimentSpec(input.spec)
  if (!v.ok) return { proposalId: null, status: null, deployed: false, held: `spec refused: ${v.errors.join("; ")}`, existing: false }
  const ip = await import("@/lib/kernel/improvement-proposals")
  const p = await ip.proposeImprovement(svc, {
    brokerageId: input.brokerageId, subjectKind: "experiment", subjectKey: experimentSubjectKey(input.spec), proposer: "experimentation",
    proposedChange: { spec: input.spec, summary: `${input.spec.manager}: ${input.spec.hypothesis} (${input.spec.metric}, ${input.spec.durationDays}d, $${input.spec.budgetUsd})` },
    evidenceRefs: [{ kind: "experiment_spec", key: input.spec.key }],
  })
  if (!p.ok) return { proposalId: null, status: null, deployed: false, held: p.error, existing: false }
  let row = await ip.loadProposal(svc, input.brokerageId, p.id)
  if (!row.ok) return { proposalId: p.id, status: null, deployed: false, held: row.error, existing: p.existing }
  if (row.row.status === "PROPOSED") {
    const ev = await ip.evaluateProposal(svc, { brokerageId: input.brokerageId, id: p.id }, { now: input.now })
    if (!ev.ok) return { proposalId: p.id, status: "PROPOSED", deployed: false, held: ev.error, existing: p.existing }
    if (ev.status !== "EVALUATED") return { proposalId: p.id, status: ev.status, deployed: false, held: ev.evaluation.why, existing: p.existing }
  }
  const d = await deployExperiment(svc, { brokerageId: input.brokerageId, id: p.id, now: input.now })
  row = await ip.loadProposal(svc, input.brokerageId, p.id)
  return { proposalId: p.id, status: row.ok ? row.row.status : null, deployed: d.deployed, held: d.held, existing: p.existing }
}

/**
 * The AUTONOMOUS deploy: only a PASSED experiment whose CLASS the tenant listed in experiments.autonomous_classes,
 * and only when the experiment envelope covers its budget (consumed atomically). Anything else stays EVALUATED for a
 * human (who approves on the Manager Trust page — decideProposal; a human's deploy is human-authorised spend).
 */
export async function deployExperiment(svc: Svc, input: { brokerageId: string; id: string; now?: Date }, deps: { policy?: ExperimentPolicy } = {}): Promise<{ deployed: boolean; held: string | null }> {
  const ip = await import("@/lib/kernel/improvement-proposals")
  const got = await ip.loadProposal(svc, input.brokerageId, input.id)
  if (!got.ok) return { deployed: false, held: got.error }
  const row = got.row
  const spec = specOf(row)
  if (row.subject_kind !== "experiment" || !spec) return { deployed: false, held: "not an experiment proposal" }
  if (row.status !== "EVALUATED" || row.evaluation?.verdict !== "pass") return { deployed: false, held: `experiment is ${row.status} (${row.evaluation?.verdict ?? "unevaluated"}) — only a PASSED evaluation deploys` }
  const policy = deps.policy ?? (await loadExperimentPolicy(svc, input.brokerageId))
  if (!policy.readable) return { deployed: false, held: "experiments policy unreadable — a human deploys (fail closed)" }
  const policyRef = `experiments@${policy.version ?? "unknown"}`
  if (!(policy.autonomousClasses ?? []).includes(spec.experimentClass)) return { deployed: false, held: `class ${spec.experimentClass} is not in experiments.autonomous_classes (${policyRef}) — awaiting a human on the Manager Trust page` }
  let consumptionId: string | null = null
  if (spec.budgetUsd > 0) {
    const { consumeAutonomyEnvelope } = await import("@/lib/kernel/autonomy-budgets")
    const env = await consumeAutonomyEnvelope(svc, {
      brokerageId: input.brokerageId, envelope: "experiment_budget", amount: spec.budgetUsd, reasonCode: "LEARNED_IMPROVEMENT",
      reasonDetail: `deploy experiment ${spec.key} (${spec.experimentClass}) autonomously`, subject: { type: "improvement_proposal", id: row.id },
      idempotencyKey: `experiment.deploy:${row.id}`, now: input.now,
    })
    if (!env.allowed) return { deployed: false, held: `experiment budget envelope refused: ${env.reason} — a human deploys` }
    consumptionId = env.consumptionId
  }
  const reason = `autonomous deploy — class ${spec.experimentClass} is listed in experiments.autonomous_classes (${policyRef})`
  const dec = await ip.decideProposal(svc, {
    brokerageId: input.brokerageId, id: row.id, decision: "approve",
    actor: { type: "manager", managerKey: spec.manager, reason },
    gate: { actorAuthority: ip.PROPOSAL_AUTHORITY.experiment, autonomy: { allow: true, held: false, posture: null, reason } },
    reason,
  })
  if (!dec.ok) {
    if (consumptionId) {
      const { releaseAutonomyEnvelope } = await import("@/lib/kernel/autonomy-budgets")
      const rel = await releaseAutonomyEnvelope(svc, { brokerageId: input.brokerageId, consumptionId, reason: `deploy refused: ${dec.error}` })
      if (!rel.ok) console.error(`[experiment-pipeline] envelope not released after a refused deploy: ${rel.error}`)
    }
    return { deployed: false, held: dec.error }
  }
  return { deployed: true, held: null }
}

// ── COHORT ASSIGNMENT at the enrollment chokepoint ────────────────────────────────────────────

export interface EnrollmentRouting { sequenceId: string; assignment: { key: string; arm: string; reason: string } | null; experimentId: string | null; adopted: boolean; why: string }

/**
 * Which sequence THIS contact enrolls into: an ADOPTED winner (the promoted treatment serves the cohort), else a
 * RUNNING experiment's deterministic arm (ledgered experiment.cohort.assign with detail.experiment), else unchanged.
 * Fail SAFE: anything unreadable keeps the asked-for (control) sequence.
 */
export async function routeEnrollmentThroughExperiments(svc: Svc, input: { brokerageId: string; sequenceId: string; contactId: string; now?: Date }): Promise<EnrollmentRouting> {
  const keep = (why: string): EnrollmentRouting => ({ sequenceId: input.sequenceId, assignment: null, experimentId: null, adopted: false, why })
  if (!input.brokerageId || !input.contactId || !input.sequenceId) return keep("no subject")
  const now = input.now ?? new Date()
  const policy = await loadExperimentPolicy(svc, input.brokerageId)
  if (!policy.readable) return keep("experiments policy unreadable — control")
  let contactType: string | null | undefined
  const typeOf = async (): Promise<string | null> => {
    if (contactType !== undefined) return contactType
    const { data, error } = await svc.from("contacts").select("contact_type").eq("brokerage_id", input.brokerageId).eq("id", input.contactId).maybeSingle()
    contactType = error ? null : ((data as { contact_type?: string | null } | null)?.contact_type ?? null)
    return contactType
  }
  for (const a of Object.values(policy.adopted ?? {}) as Array<{ arm: string; control_sequence_id?: string | null; treatment_sequence_id?: string | null; contact_types?: string[] | null }>) {
    if (a.arm !== "treatment" || a.control_sequence_id !== input.sequenceId || !a.treatment_sequence_id) continue
    if (a.contact_types?.length && !a.contact_types.includes((await typeOf()) ?? "")) continue
    return { sequenceId: a.treatment_sequence_id, assignment: null, experimentId: null, adopted: true, why: "adopted experiment winner serves this cohort" }
  }
  const { listImprovementProposals } = await import("@/lib/kernel/improvement-proposals")
  const list = await listImprovementProposals(svc, input.brokerageId, { limit: 200 })
  if (!list.ok || !list.available) return keep("proposals unreadable — control")
  for (const row of list.rows) {
    if (row.subject_kind !== "experiment" || row.status !== "APPROVED") continue
    const spec = specOf(row)
    if (!spec || spec.cohort.surface !== "sequence_enrollment" || spec.cohort.control_sequence_id !== input.sequenceId) continue
    if (now.getTime() > endsAt(row, spec)) continue
    if (spec.cohort.contact_types?.length && !spec.cohort.contact_types.includes((await typeOf()) ?? "")) continue
    const a = assignExperimentArm({ definition: definitionForExperiment(spec), brokerageId: input.brokerageId, subjectId: input.contactId, instanceOn: true, policy })
    if (!a) continue
    const target = a.arm === "treatment" ? spec.cohort.treatment_sequence_id : spec.cohort.control_sequence_id
    try {
      const { withActionLedger } = await import("@/lib/kernel/action-ledger")
      await withActionLedger(
        {
          brokerageId: input.brokerageId, action: "experiment.cohort.assign", actor: { type: "manager", managerKey: spec.manager },
          subject: { type: "contact", id: input.contactId }, reasonCode: "CAMPAIGN_STEP",
          reasonDetail: `cohort assignment: ${spec.key} → ${a.arm} (${a.reason})`, idempotencyKey: `experiment.cohort.assign:${row.id}:${input.contactId}`,
          riskClass: "LOW_RISK_WRITE", systemSource: "experimentation", policyKey: "experiments", policyVersion: policy.version ?? null,
          detail: { ...experimentLedgerDetail(a), experiment_proposal_id: row.id, sequence_id: target, assignment_reason: a.reason },
        },
        async () => ({ ok: true }),
        { settle: () => ({ status: "executed", outcome: `assigned_${a.arm}` }), replay: () => ({ ok: true }) },
        { client: svc as any },
      )
    } catch (e) { console.error(`[experiment-pipeline] assignment not ledgered (${spec.key}): ${(e as Error).message}`) }
    return { sequenceId: target, assignment: { key: a.key, arm: a.arm, reason: a.reason }, experimentId: row.id, adopted: false, why: `running experiment ${spec.key}: ${a.arm}` }
  }
  return keep("no running experiment on this sequence")
}

// ── MEASURE → STATISTICAL EVALUATION → PROMOTE / REJECT ───────────────────────────────────────

export interface ConcludeSummary { running: number; measured: number; adopted: number; awaitingHuman: number; rejected: number; errors: string[] }

/** Weekly per tenant: measure every RUNNING experiment; at the end of its window adopt or reject it, deterministically. */
export async function concludeExperiments(svc: Svc, brokerageId: string, opts: { now?: Date; policy?: ExperimentPolicy } = {}): Promise<ConcludeSummary> {
  const now = opts.now ?? new Date()
  const out: ConcludeSummary = { running: 0, measured: 0, adopted: 0, awaitingHuman: 0, rejected: 0, errors: [] }
  const ip = await import("@/lib/kernel/improvement-proposals")
  const list = await ip.listImprovementProposals(svc, brokerageId, { limit: 200 })
  if (!list.ok) { out.errors.push(list.error); return out }
  const running = list.rows.filter((r) => r.subject_kind === "experiment" && r.status === "APPROVED")
  out.running = running.length
  if (running.length === 0) return out
  const policy = opts.policy ?? (await loadExperimentPolicy(svc, brokerageId))
  const { strategySignificance } = await import("@/lib/intelligence/strategy-learning")
  for (const row of running) {
    const spec = specOf(row)
    if (!spec || !row.decided_at) { out.errors.push(`${row.id}: no spec / start`); continue }
    const start = String(row.decided_at)
    const end = Math.min(now.getTime(), endsAt(row, spec))
    const def = definitionForExperiment(spec)
    const { data: led, error: ledErr } = await svc.from("agent_action_ledger").select("subject_id, created_at, detail").eq("brokerage_id", brokerageId).eq("action", "experiment.cohort.assign").eq("status", "executed").gte("created_at", start).limit(20000)
    if (ledErr) { out.errors.push(`${spec.key}: assignments unreadable: ${ledErr.message}`); continue }
    const assignments = ((led ?? []) as Array<{ subject_id: string | null; created_at: string; detail: Record<string, any> | null }>)
      .filter((r) => r.subject_id && r.detail?.experiment?.key === def.key)
      .map((r) => ({ subjectId: String(r.subject_id), arm: String(r.detail!.experiment.arm), at: r.created_at }))
    const outcomes = await metricOutcomes(svc, brokerageId, spec.metric, start)
    if (!outcomes.ok) { out.errors.push(`${spec.key}: outcomes unreadable: ${outcomes.error}`); continue }
    const m = measureExperimentArms({ assignments, outcomes: outcomes.rows, metric: spec.metric, windowEndIso: new Date(end).toISOString() })
    const sig = strategySignificance(m.treatment, m.control, spec.minSamplePerArm ?? DEFAULT_MIN_SAMPLE_PER_ARM)
    const ended = now.getTime() >= endsAt(row, spec)
    const conclusion = experimentConclusion(sig, ended)
    const pipeline = (row.evaluation?.detail?.pipeline ?? null) as unknown
    const evaluation: ProposalEvaluation = {
      evaluator: "experiment_arms", verdict: conclusion === "adopt_treatment" ? "pass" : conclusion === "running" ? "inconclusive" : "fail",
      score: sig.z, why: `${conclusion}: ${sig.why} (treatment ${m.treatment.conversions}/${m.treatment.exposures}, control ${m.control.conversions}/${m.control.exposures} ${spec.metric})`,
      detail: { pipeline, result: { conclusion, winner: conclusion === "adopt_treatment" ? "treatment" : conclusion === "reject_control_held" ? "control" : null, measure: m, significance: sig, measuredAt: now.toISOString(), ended } },
    }
    const w = await ip.recordExperimentResult(svc, { brokerageId, id: row.id, evaluation })
    if (!w.ok) { out.errors.push(`${spec.key}: result not recorded: ${w.error}`); continue }
    out.measured++
    if (conclusion === "running") continue
    if (conclusion !== "adopt_treatment") {
      const r = await ip.decideProposal(svc, { brokerageId, id: row.id, decision: "reject", actor: { type: "manager", managerKey: spec.manager }, reason: `${conclusion}: ${sig.why}` })
      if (r.ok) out.rejected++; else out.errors.push(`${spec.key}: reject refused: ${r.error}`)
      continue
    }
    if (!policy.readable || !(policy.autonomousClasses ?? []).includes(spec.experimentClass)) { out.awaitingHuman++; continue }
    const reason = `autonomous adoption — measured treatment win (${sig.why}); class ${spec.experimentClass} is autonomous (experiments@${policy.version ?? "unknown"})`
    const prom = await ip.promoteProposal(svc, { brokerageId, id: row.id, actor: { type: "manager", managerKey: spec.manager, reason }, gate: { actorAuthority: ip.PROPOSAL_AUTHORITY.experiment, autonomy: { allow: true, held: false, posture: null, reason } } })
    if (prom.ok) out.adopted++; else out.errors.push(`${spec.key}: adoption refused: ${prom.error}`)
  }
  return out
}

// ── THE OWNER'S EXAMPLE — Campaign Manager: video-first seller campaign → appointment rate ────

/** Step-1 channels that make a sequence VIDEO-FIRST (campaign_sequence_steps.channel vocabulary). */
export const VIDEO_FIRST_CHANNELS = ["video", "commission_video"] as const

/** PURE — the (control, treatment) pair: the busiest non-video-first seller sequence vs the busiest video-first one.
 * @proofSeam scripts/autonomous-budgeting-guard.ts asserts the pairing rule directly. */
export function pickVideoFirstSellerPair(seqs: Array<{ id: string; contact_type: string | null; enrollments_total: number | null; firstChannel: string | null }>): { control: string; treatment: string } | null {
  const seller = seqs.filter((s) => s.contact_type === "seller" || s.contact_type === "both")
  const busiest = (xs: typeof seller) => [...xs].sort((a, b) => Number(b.enrollments_total ?? 0) - Number(a.enrollments_total ?? 0) || a.id.localeCompare(b.id))[0]
  const video = busiest(seller.filter((s) => (VIDEO_FIRST_CHANNELS as readonly string[]).includes(String(s.firstChannel))))
  const standard = busiest(seller.filter((s) => !(VIDEO_FIRST_CHANNELS as readonly string[]).includes(String(s.firstChannel))))
  return video && standard ? { control: standard.id, treatment: video.id } : null
}

/** The Campaign Manager proposes the owner's example when the tenant runs both kinds of seller campaign. Idempotent:
 *  an experiment with the same key proposed in the last 180 days (any status) is not proposed again. */
export async function proposeVideoFirstSellerExperiments(svc: Svc, brokerageId: string, opts: { now?: Date } = {}): Promise<ExperimentRunResult | { skipped: string }> {
  const { data: seqs, error } = await svc.from("campaign_sequences").select("id, contact_type, enrollments_total").eq("brokerage_id", brokerageId).eq("is_active", true).eq("compliance_gated", true).in("contact_type", ["seller", "both"]).limit(200)
  if (error) return { skipped: `campaign_sequences: ${error.message}` }
  const rows = (seqs ?? []) as Array<{ id: string; contact_type: string | null; enrollments_total: number | null }>
  if (rows.length < 2) return { skipped: "fewer than two active seller sequences" }
  const { data: steps, error: stErr } = await svc.from("campaign_sequence_steps").select("sequence_id, channel").in("sequence_id", rows.map((r) => r.id)).eq("step_number", 1).eq("is_active", true)
  if (stErr) return { skipped: `campaign_sequence_steps: ${stErr.message}` }
  const first = new Map(((steps ?? []) as Array<{ sequence_id: string; channel: string }>).map((s) => [s.sequence_id, s.channel]))
  const pair = pickVideoFirstSellerPair(rows.map((r) => ({ ...r, firstChannel: first.get(r.id) ?? null })))
  if (!pair) return { skipped: "no video-first + standard seller pair" }
  const key = `video_first_seller_${pair.control.slice(0, 8)}_${pair.treatment.slice(0, 8)}`
  const { listImprovementProposals } = await import("@/lib/kernel/improvement-proposals")
  const list = await listImprovementProposals(svc, brokerageId, { limit: 200 })
  const now = opts.now ?? new Date()
  if (list.ok && list.rows.some((r) => r.subject_kind === "experiment" && r.subject_key === `experiment:${key}` && Date.parse(r.created_at) > now.getTime() - 180 * 86_400_000)) return { skipped: "already proposed in the last 180 days" }
  return proposeExperiment(svc, { brokerageId, now, spec: {
    key, hypothesis: "A video-first seller campaign raises the seller appointment rate over the standard seller campaign",
    metric: "appointment", experimentClass: "sequence_choice", manager: "campaign_orchestrator",
    cohort: { surface: "sequence_enrollment", control_sequence_id: pair.control, treatment_sequence_id: pair.treatment, contact_types: ["seller", "both"], treatment_share: 0.5, description: "seller contacts enrolling into the standard seller sequence" },
    durationDays: 45, budgetUsd: 0,
  } })
}
