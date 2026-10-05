#!/usr/bin/env tsx
/**
 * scripts/controlled-learning-guard.ts  (npm run test:controlled-learning) — wave 104, lane 104C, gap map row 20.
 *
 * Proves CONTROLLED LEARNING (lib/kernel/improvement-proposals.ts over the survivors):
 *   F   a proposal flows PROPOSED → EVALUATED → APPROVED → PROMOTED producing a policy version
 *       (tenant_policy_versions) and a ledger row carrying policy_ref; the promoted override is read;
 *   U   an unauthorised promotion is refused — an AI agent, a non-admin user, a manager under the rung,
 *       a manager held by the autonomy gate, a manager on an owner-level change — each with the allowing
 *       control beside it;
 *   R   a bad replay result (a decision that EARNED would change) REJECTS; the same change with no earning
 *       disagreement passes; a real replay over recorded decisions runs through the proposed settings;
 *   B   rollback restores the previous value as a NEW version and the ledger records it;
 *   C   the copy conductor promotes a winner under an allowing gate and HOLDS it under a holding one
 *       (the human then promotes it from the page's action, and rolls it back);
 *   T   cross-tenant reads / decisions / promotions are refused, owning-tenant positive control;
 *   W   wiring, read from STRIPPED source, each with a positive control; vocabularies derived, not pinned.
 * In-memory client only, no DB, no model calls.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  PROPOSAL_STATUSES, PROPOSAL_TRANSITIONS, PROPOSAL_AUTHORITY, OWNER_AUTHORITY_LEVEL, canTransition, promotionDecision,
  proposeImprovement, evaluateProposal, evaluateImprovement, decideProposal, promoteProposal, rollbackProposal, loadProposal, listImprovementProposals,
  type ImprovementProposalRow,
} from "../lib/kernel/improvement-proposals"
import { planNextLeadTouch, decisionInputSnapshot, type PlanNextLeadTouchInput } from "../lib/ai-isa/lead-action-plan"
import { DEFAULT_AISA_SETTINGS } from "../lib/ai-isa/settings-types"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { runSequenceCopyLearning } from "../lib/campaign-sequences/copy-learning-conductor"
import { getPredictorTuning } from "../lib/intelligence/predictor-learning-runner"
import { __clearAutonomyCache } from "../lib/managers/autonomy-gate"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const src = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

const B = "11111111-1111-4111-8111-111111111111"
const OTHER = "99999999-9999-4999-8999-999999999999"
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001"
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const admin = { type: "user" as const, userId: ADMIN, isTenantAdmin: true }
const settingsRow = (b: string) => ({ id: uuid(900), brokerage_id: b, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" })

async function main() {
  console.log("\ncontrolled-learning-guard — wave 104C\n")

  // ── F: the full flow on a threshold proposal (policy version + ledger) ──────────────────
  console.log("F — PROPOSED → EVALUATED → APPROVED → PROMOTED")
  const mem = memSupabase({ improvement_proposals: [], brokerage_settings: [settingsRow(B)], tenant_policy_versions: [], agent_action_ledger: [] }, { stampCreatedAt: true })
  const p = await proposeImprovement(mem, { brokerageId: B, subjectKind: "threshold", subjectKey: "predictor:buyer_stall", proposer: "predictor_learning",
    proposedChange: { predictor: "buyer_stall", thresholdMultiplier: 1.5, requireStrongest: true, record: { wins: 2, losses: 8 } }, evidenceRefs: [{ kind: "ai_feedback_log", wins: 2, losses: 8 }] })
  check("F1 proposal recorded PROPOSED", p.ok && !p.existing && mem.tables.improvement_proposals[0]?.status === "PROPOSED", JSON.stringify(p))
  const id = p.ok ? p.id : ""
  const dup = await proposeImprovement(mem, { brokerageId: B, subjectKind: "threshold", subjectKey: "predictor:buyer_stall", proposer: "predictor_learning", proposedChange: {} })
  check("F2 re-proposing an OPEN subject finds the open row (no duplicate)", dup.ok && dup.existing && dup.id === id && mem.tables.improvement_proposals.length === 1)
  const ev = await evaluateProposal(mem, { brokerageId: B, id })
  check("F3 evaluated deterministically from the record → EVALUATED pass", ev.ok && ev.status === "EVALUATED" && ev.evaluation.evaluator === "predictor_record" && ev.evaluation.verdict === "pass", JSON.stringify(ev))
  const early = await promoteProposal(mem, { brokerageId: B, id, actor: admin })
  check("F4 an EVALUATED (not yet approved) proposal does not promote", !early.ok && /APPROVED/.test(early.error))
  const ap = await decideProposal(mem, { brokerageId: B, id, decision: "approve", actor: admin, reason: "looks right" })
  check("F5 tenant admin approves → APPROVED with decided_by", ap.ok && mem.tables.improvement_proposals[0].status === "APPROVED" && mem.tables.improvement_proposals[0].decided_by === ADMIN)
  const pr = await promoteProposal(mem, { brokerageId: B, id, actor: admin })
  const row = mem.tables.improvement_proposals[0] as ImprovementProposalRow
  check("F6 promoted through mergeBrokerageSettings → PROMOTED with policy_version_ref predictor_tuning@1", pr.ok && pr.policyVersionRef === "predictor_tuning@1" && row.status === "PROMOTED" && row.policy_version_ref === "predictor_tuning@1", JSON.stringify(pr))
  const ver = mem.tables.tenant_policy_versions
  check("F7 tenant_policy_versions got v1 of predictor_tuning carrying previous + the human actor", ver.length === 1 && ver[0].policy_key === "predictor_tuning" && ver[0].version === 1 && ver[0].actor_type === "user" && ver[0].changed_by === ADMIN, JSON.stringify(ver))
  check("F8 the live settings carry the promoted override", mem.tables.brokerage_settings[0].settings?.predictor_tuning?.buyer_stall?.thresholdMultiplier === 1.5)
  const led = mem.tables.agent_action_ledger.filter((r) => r.action === "learning.proposal.promote")
  check("F9 ledgered: learning.proposal.promote, HUMAN_REQUESTED, executed, policy_ref names predictor_tuning", led.length === 1 && led[0].reason_code === "HUMAN_REQUESTED" && led[0].status === "executed" && String(led[0].policy_ref ?? "").startsWith("predictor_tuning@"), JSON.stringify(led))
  const tuning = await getPredictorTuning(mem as any, B, "buyer_stall")
  check("F10 getPredictorTuning reads the PROMOTED override ahead of the (unproven) record", tuning.thresholdMultiplier === 1.5 && tuning.requireStrongest === true && /promoted override/.test(tuning.why), tuning.why)
  const again = await promoteProposal(mem, { brokerageId: B, id, actor: admin })
  check("F11 a PROMOTED proposal does not promote twice", !again.ok)
  const listed = await listImprovementProposals(mem, B)
  check("F12 the page's list reads it with evaluation + version ref", listed.ok && listed.available && listed.rows.length === 1 && listed.rows[0].evaluation?.verdict === "pass")

  // ── B: rollback ────────────────────────────────────────────────────────────────────────
  console.log("B — rollback")
  const rb = await rollbackProposal(mem, { brokerageId: B, id, actor: admin })
  check("B1 rollback → ROLLED_BACK, previous value back as a NEW version predictor_tuning@2", rb.ok && rb.policyVersionRef === "predictor_tuning@2" && mem.tables.improvement_proposals[0].status === "ROLLED_BACK" && mem.tables.improvement_proposals[0].rollback_policy_version_ref === "predictor_tuning@2", JSON.stringify(rb))
  check("B2 the override is gone from live settings; history keeps both versions", mem.tables.brokerage_settings[0].settings?.predictor_tuning?.buyer_stall === undefined && mem.tables.tenant_policy_versions.length === 2)
  check("B3 rollback ledgered (learning.proposal.rollback)", mem.tables.agent_action_ledger.some((r) => r.action === "learning.proposal.rollback" && r.status === "executed"))
  const rb2 = await rollbackProposal(mem, { brokerageId: B, id, actor: admin })
  check("B4 a ROLLED_BACK proposal does not roll back again", !rb2.ok)

  // ── U: unauthorised promotions refused (pure gate + kernel) ─────────────────────────────
  console.log("U — authority")
  const base = { status: "APPROVED" as const, verdict: "pass" as const, authorityRequired: PROPOSAL_AUTHORITY.variant }
  const allow = { allow: true, held: false, posture: null, reason: null }
  const held = { allow: false, held: true, posture: "approval_required" as const, reason: "campaign_orchestrator is approval_required" }
  check("U1 an AI agent never promotes", !promotionDecision({ ...base, actor: { type: "agent" } }).allow)
  check("U2 a user off the admin roster is refused; an admin allowed (control)", !promotionDecision({ ...base, actor: { type: "user", isTenantAdmin: false } }).allow && promotionDecision({ ...base, actor: { type: "user", isTenantAdmin: true } }).allow)
  check("U3 a manager under the rung is refused; at the rung allowed (control)", !promotionDecision({ ...base, actor: { type: "manager", managerKey: "campaign_orchestrator" }, gate: { actorAuthority: 3, autonomy: allow } }).allow && promotionDecision({ ...base, actor: { type: "manager", managerKey: "campaign_orchestrator" }, gate: { actorAuthority: 4, autonomy: allow } }).allow)
  check("U4 a manager held by the autonomy gate is refused with the gate's reason", (() => { const d = promotionDecision({ ...base, actor: { type: "manager", managerKey: "campaign_orchestrator" }, gate: { actorAuthority: 6, autonomy: held } }); return !d.allow && d.reason === held.reason })())
  check("U5 an owner-level change (policy / prompt = 6) is APPROVAL_REQUIRED for a manager even at rung 6; a human promotes it", !promotionDecision({ ...base, authorityRequired: PROPOSAL_AUTHORITY.policy, actor: { type: "manager", managerKey: "ai_isa" }, gate: { actorAuthority: 6, autonomy: allow } }).allow && PROPOSAL_AUTHORITY.policy === OWNER_AUTHORITY_LEVEL && PROPOSAL_AUTHORITY.prompt === OWNER_AUTHORITY_LEVEL && promotionDecision({ ...base, authorityRequired: 6, actor: admin }).allow)
  check("U6 an inconclusive evaluation needs a human; a failed one promotes for nobody", !promotionDecision({ ...base, verdict: "inconclusive", actor: { type: "manager", managerKey: "campaign_orchestrator" }, gate: { actorAuthority: 6, autonomy: allow } }).allow && promotionDecision({ ...base, verdict: "inconclusive", actor: admin }).allow && !promotionDecision({ ...base, verdict: "fail", actor: admin }).allow)
  const memU = memSupabase({ improvement_proposals: [], brokerage_settings: [settingsRow(B)], tenant_policy_versions: [], agent_action_ledger: [] }, { stampCreatedAt: true })
  const pu = await proposeImprovement(memU, { brokerageId: B, subjectKind: "threshold", subjectKey: "predictor:listing_stall", proposer: "predictor_learning", proposedChange: { predictor: "listing_stall", thresholdMultiplier: 1.5, requireStrongest: true, record: { wins: 1, losses: 9 } } })
  const idU = pu.ok ? pu.id : ""
  await evaluateProposal(memU, { brokerageId: B, id: idU })
  const agentDecide = await decideProposal(memU, { brokerageId: B, id: idU, decision: "approve", actor: { type: "agent" } })
  const nonAdmin = await decideProposal(memU, { brokerageId: B, id: idU, decision: "approve", actor: { type: "user", userId: uuid(5), isTenantAdmin: false } })
  const mgrLow = await decideProposal(memU, { brokerageId: B, id: idU, decision: "approve", actor: { type: "manager", managerKey: "ai_isa" }, gate: { actorAuthority: 2, autonomy: allow } })
  check("U7 kernel: agent / non-admin / under-rung manager cannot approve; the row stays EVALUATED", !agentDecide.ok && !nonAdmin.ok && !mgrLow.ok && memU.tables.improvement_proposals[0].status === "EVALUATED")
  const mgrOk = await decideProposal(memU, { brokerageId: B, id: idU, decision: "approve", actor: { type: "manager", managerKey: "ai_isa" }, gate: { actorAuthority: 4, autonomy: allow } })
  const agentPromote = await promoteProposal(memU, { brokerageId: B, id: idU, actor: { type: "agent" } })
  const mgrHeld = await promoteProposal(memU, { brokerageId: B, id: idU, actor: { type: "manager", managerKey: "ai_isa" }, gate: { actorAuthority: 4, autonomy: held } })
  check("U8 kernel: a manager at the rung approves; an agent promotion and a gate-held promotion are refused, nothing written", mgrOk.ok && !agentPromote.ok && !mgrHeld.ok && mgrHeld.held === true && memU.tables.improvement_proposals[0].status === "APPROVED" && memU.tables.tenant_policy_versions.length === 0 && memU.tables.agent_action_ledger.length === 0)
  const mgrPromote = await promoteProposal(memU, { brokerageId: B, id: idU, actor: { type: "manager", managerKey: "ai_isa" }, gate: { actorAuthority: 4, autonomy: allow } })
  check("U9 kernel: the same manager under an allowing gate promotes, ledgered LEARNED_IMPROVEMENT with actor manager", mgrPromote.ok && memU.tables.agent_action_ledger.some((r) => r.action === "learning.proposal.promote" && r.reason_code === "LEARNED_IMPROVEMENT" && r.actor_type === "manager"), JSON.stringify(memU.tables.agent_action_ledger))

  // ── R: replay evaluation ────────────────────────────────────────────────────────────────
  console.log("R — replay")
  const plan: PlanNextLeadTouchInput = { now: new Date("2026-09-20T15:00:00Z"), settings: { ...DEFAULT_AISA_SETTINGS }, touchesSoFar: 1, lastTouchAt: new Date("2026-09-01T12:00:00Z"), lastChannel: "email", channelsAlreadyStaged: ["email"], emailUsable: true, mailingVerified: true, reelReady: true, lifecycleState: "unconsented" }
  const recorded = planNextLeadTouch(plan)
  const snap = decisionInputSnapshot({ subject: "lead", plan })
  const ledgerRows = [1, 2, 3].map((n) => ({ id: uuid(n), brokerage_id: B, action: `lead.decision.${recorded.action}`, status: "executed", reason_code: "NURTURE_TOUCH", subject_type: "lead", subject_id: uuid(100 + n), created_at: `2026-09-2${n}T15:00:00.000Z`, detail: { decision_input: snap, plan_code: recorded.reasonCode } }))
  const memR = memSupabase({ improvement_proposals: [], agent_action_ledger: ledgerRows, brokerage_settings: [settingsRow(B)] }, { stampCreatedAt: true })
  const now = new Date("2026-10-05T00:00:00Z")
  const same = await evaluateImprovement(memR, { brokerage_id: B, subject_kind: "policy", subject_key: "ai_isa_settings", proposed_change: { touch_interval_days: DEFAULT_AISA_SETTINGS.touch_interval_days } }, { now })
  check("R1 a real replay of the proposed ISA settings over the recorded decisions: unchanged settings agree 100%", same.evaluator === "decision_replay" && same.verdict === "pass" && same.score === 1 && same.detail.replayed === 3, JSON.stringify(same))
  const cap = await evaluateImprovement(memR, { brokerage_id: B, subject_kind: "policy", subject_key: "ai_isa_settings", proposed_change: { max_touches_lead: 1 } }, { now })
  check("R2 a cap of 1 touch changes every recorded send (3 disagreements), none earning → pass with the count published", cap.evaluator === "decision_replay" && cap.verdict === "pass" && cap.detail.disagreements === 3 && cap.detail.earnedChanged === 0 && recorded.action === "send_touch", JSON.stringify({ recorded, cap }))
  const earningReplay: NonNullable<Parameters<typeof evaluateImprovement>[2]>["replay"] = async () => ({ ok: true, ledgerAvailable: true, attributionError: null, truncated: false, report: { brokerageId: B, examined: 3, replayed: 3, agreements: 2, agreementRate: 2 / 3, unreplayable: { noSnapshot: 0, unknownVersion: 0, plannerNull: 0 }, crossTenantRefused: 0, byReasonCode: [],
    disagreements: [{ actionId: uuid(1), subjectType: "lead", subjectId: uuid(101), recordedAt: "2026-09-21T15:00:00.000Z", recordedCode: recorded.reasonCode, recordedAction: "send_touch", replayedCode: "MAX_TOUCHES_REACHED", replayedAction: "do_nothing", causationId: null, correlationId: null, outcomes: [{ ref: "tx-1", kind: "closed", model: "last_touch", cents: 450_000 }] }] } })
  const pBad = await proposeImprovement(memR, { brokerageId: B, subjectKind: "policy", subjectKey: "ai_isa_settings", proposer: "human", proposedChange: { max_touches_lead: 1 } })
  const evBad = await evaluateProposal(memR, { brokerageId: B, id: pBad.ok ? pBad.id : "" }, { now, replay: earningReplay })
  check("R3 a bad replay (a decision that EARNED $4,500 would change) REJECTS the proposal — the evaluator decided, nobody human", evBad.ok && evBad.status === "REJECTED" && evBad.evaluation.verdict === "fail" && /earned \$4500\.00/.test(evBad.evaluation.why) && memR.tables.improvement_proposals[0].status === "REJECTED" && memR.tables.improvement_proposals[0].decided_by === null, JSON.stringify(evBad))
  const rejPromote = await promoteProposal(memR, { brokerageId: B, id: pBad.ok ? pBad.id : "", actor: admin })
  check("R4 a REJECTED proposal cannot be approved or promoted, even by an admin", !rejPromote.ok && !(await decideProposal(memR, { brokerageId: B, id: pBad.ok ? pBad.id : "", decision: "approve", actor: admin })).ok)
  const empty = await evaluateImprovement(memSupabase({ agent_action_ledger: [] }), { brokerage_id: B, subject_kind: "policy", subject_key: "ai_isa_settings", proposed_change: { max_touches_lead: 1 } }, { now })
  check("R5 nothing replayable → inconclusive (never a fake pass); a prompt proposal is inconclusive by rule", empty.verdict === "inconclusive" && (await evaluateImprovement(memR, { brokerage_id: B, subject_kind: "prompt", subject_key: "listing_descriptions", proposed_change: { system_prompt_additions: "x" } })).verdict === "inconclusive")
  const bogus = await evaluateImprovement(memR, { brokerage_id: B, subject_kind: "policy", subject_key: "not_a_policy", proposed_change: {} })
  check("R6 POSITIVE CONTROL: an unregistered policy key fails evaluation", bogus.verdict === "fail")
  const varFail = await evaluateImprovement(memR, { brokerage_id: B, subject_kind: "variant", subject_key: "sequence_ab:x", proposed_change: { winner: "B", stats: [{ variant: "A", sent: 100, replies: 12 }, { variant: "B", sent: 100, replies: 3 }] } })
  const varPass = await evaluateImprovement(memR, { brokerage_id: B, subject_kind: "variant", subject_key: "sequence_ab:x", proposed_change: { winner: "A", stats: [{ variant: "A", sent: 100, replies: 12 }, { variant: "B", sent: 100, replies: 3 }] } })
  check("R7 variant: the arm results must name the proposed winner (B fails, A passes)", varFail.verdict === "fail" && varPass.verdict === "pass" && varPass.evaluator === "experiment_arms")

  // ── C: the copy conductor under the gate ────────────────────────────────────────────────
  console.log("C — conductor")
  const seqOf = (b: string, s: string) => ({ campaign_sequences: [{ id: s, brokerage_id: b, is_active: true, is_ab_test: true }], campaign_sequence_steps: [
    { id: `${s}-A`, sequence_id: s, step_number: 1, ab_variant: "A", is_active: true, sent_count: 100, reply_count: 12 },
    { id: `${s}-B`, sequence_id: s, step_number: 1, ab_variant: "B", is_active: true, sent_count: 100, reply_count: 3 },
  ], agent_outcome_evaluations: [], improvement_proposals: [], brokerage_settings: [settingsRow(b)], tenant_policy_versions: [], agent_action_ledger: [] })
  __clearAutonomyCache()
  const memC1 = memSupabase({ ...seqOf(B, "seq-1"), managed_agents: [{ brokerage_id: B, agent_kind: "campaign_orchestrator", archived_at: null, updated_at: "2026-10-01T00:00:00Z", config: { authority_level: 4 } }] }, { stampCreatedAt: true })
  const c1 = await runSequenceCopyLearning(B, memC1 as any)
  const c1Row = memC1.tables.improvement_proposals[0]
  check("C1 allowing gate (rung 4, no posture): the winner is proposed, evaluated, approved and PROMOTED in one pass; loser retired", c1.variantsPromoted === 1 && c1.proposalsHeld === 0 && c1Row?.status === "PROMOTED" && c1Row?.subject_kind === "variant" && memC1.tables.campaign_sequence_steps.find((s) => s.id === "seq-1-B")?.is_active === false && memC1.tables.campaign_sequence_steps.find((s) => s.id === "seq-1-A")?.is_active === true, JSON.stringify({ c1, c1Row }))
  check("C2 the manager's promotion is ledgered LEARNED_IMPROVEMENT by campaign_orchestrator", memC1.tables.agent_action_ledger.some((r) => r.action === "learning.proposal.promote" && r.reason_code === "LEARNED_IMPROVEMENT" && r.actor_type === "manager" && r.actor_manager_key === "campaign_orchestrator"), JSON.stringify(memC1.tables.agent_action_ledger))
  __clearAutonomyCache()
  const memC2 = memSupabase({ ...seqOf(OTHER, "seq-2"), managed_agents: [{ brokerage_id: OTHER, agent_kind: "campaign_orchestrator", archived_at: null, updated_at: "2026-10-01T00:00:00Z", config: { authority_level: 4, autonomy_tier: "approval_required" } }] }, { stampCreatedAt: true })
  const c2 = await runSequenceCopyLearning(OTHER, memC2 as any)
  const c2Row = memC2.tables.improvement_proposals[0]
  check("C3 holding gate (approval_required): the winner is proposed + EVALUATED but NOT promoted — loser still active, nothing ledgered", c2.variantsPromoted === 0 && c2.proposalsHeld === 1 && c2Row?.status === "EVALUATED" && memC2.tables.campaign_sequence_steps.every((s) => s.is_active === true) && memC2.tables.agent_action_ledger.length === 0, JSON.stringify({ c2, c2Row }))
  const c2Again = await runSequenceCopyLearning(OTHER, memC2 as any)
  check("C4 a re-run finds the open proposal (no duplicate) and still holds", c2Again.proposalsHeld === 1 && memC2.tables.improvement_proposals.length === 1)
  const hApprove = await decideProposal(memC2, { brokerageId: OTHER, id: c2Row.id, decision: "approve", actor: admin })
  const hPromote = await promoteProposal(memC2, { brokerageId: OTHER, id: c2Row.id, actor: admin })
  check("C5 the human promotes the held winner from the page's action → loser retired, HUMAN_REQUESTED", hApprove.ok && hPromote.ok && memC2.tables.campaign_sequence_steps.find((s) => s.id === "seq-2-B")?.is_active === false && memC2.tables.agent_action_ledger.some((r) => r.reason_code === "HUMAN_REQUESTED"), JSON.stringify(hPromote))
  const hRollback = await rollbackProposal(memC2, { brokerageId: OTHER, id: c2Row.id, actor: admin })
  check("C6 rollback restores the retired variant row", hRollback.ok && memC2.tables.campaign_sequence_steps.find((s) => s.id === "seq-2-B")?.is_active === true && memC2.tables.improvement_proposals[0].status === "ROLLED_BACK")
  __clearAutonomyCache()
  const memC3 = memSupabase({ ...seqOf(B, "seq-3"), managed_agents: [{ brokerage_id: B, agent_kind: "campaign_orchestrator", archived_at: null, updated_at: "2026-10-01T00:00:00Z", config: { authority_level: 2 } }] }, { stampCreatedAt: true })
  const c3 = await runSequenceCopyLearning(B, memC3 as any)
  check("C7 a manager under the rung (authority 2 < 4) holds too", c3.variantsPromoted === 0 && c3.proposalsHeld === 1 && memC3.tables.campaign_sequence_steps.every((s) => s.is_active === true))

  // ── T: tenancy ─────────────────────────────────────────────────────────────────────────
  console.log("T — tenancy")
  const memT = memSupabase({ improvement_proposals: [], brokerage_settings: [settingsRow(B), { ...settingsRow(OTHER), id: uuid(901) }], tenant_policy_versions: [], agent_action_ledger: [] }, { stampCreatedAt: true })
  const pt = await proposeImprovement(memT, { brokerageId: B, subjectKind: "threshold", subjectKey: "predictor:stuck_stage", proposer: "predictor_learning", proposedChange: { predictor: "stuck_stage", thresholdMultiplier: 1.2, requireStrongest: false, record: { wins: 5, losses: 5 } } })
  const idT = pt.ok ? pt.id : ""
  await evaluateProposal(memT, { brokerageId: B, id: idT })
  const xRead = await loadProposal(memT, OTHER, idT)
  const xDecide = await decideProposal(memT, { brokerageId: OTHER, id: idT, decision: "approve", actor: admin })
  const xPromote = await promoteProposal(memT, { brokerageId: OTHER, id: idT, actor: admin })
  const xList = await listImprovementProposals(memT, OTHER)
  check("T1 another tenant cannot read, decide, promote or list this proposal", !xRead.ok && !xDecide.ok && !xPromote.ok && xList.ok && xList.rows.length === 0 && memT.tables.improvement_proposals[0].status === "EVALUATED")
  const own = await decideProposal(memT, { brokerageId: B, id: idT, decision: "approve", actor: admin })
  const ownP = await promoteProposal(memT, { brokerageId: B, id: idT, actor: admin })
  check("T2 POSITIVE CONTROL: the owning tenant decides and promotes it; only ITS settings row changed", own.ok && ownP.ok && memT.tables.brokerage_settings.find((s) => s.brokerage_id === B)?.settings?.predictor_tuning?.stuck_stage !== undefined && memT.tables.brokerage_settings.find((s) => s.brokerage_id === OTHER)?.settings?.predictor_tuning === undefined)
  const memAbsent = memSupabase({ brokerage_settings: [settingsRow(B)] }, { missingTables: ["improvement_proposals"] })
  const pAbsent = await proposeImprovement(memAbsent, { brokerageId: B, subjectKind: "prompt", subjectKey: "x", proposer: "prompt_calibrator", proposedChange: {} })
  const lAbsent = await listImprovementProposals(memAbsent, B)
  check("T3 before the migration the store is absent: the proposal is REPORTED lost (degraded), the page says unavailable", !pAbsent.ok && pAbsent.degraded === true && lAbsent.ok && lAbsent.available === false)

  // ── S: the state machine and vocabularies (rules, not waypoints) ────────────────────────
  console.log("S — state machine")
  check("S1 every status has a transition row; terminal states have none; PROMOTED only rolls back", PROPOSAL_STATUSES.every((s) => s in PROPOSAL_TRANSITIONS) && PROPOSAL_TRANSITIONS.REJECTED.length === 0 && PROPOSAL_TRANSITIONS.ROLLED_BACK.length === 0 && PROPOSAL_TRANSITIONS.PROMOTED.join() === "ROLLED_BACK" && !canTransition("PROMOTED", "APPROVED"))
  const migSql = readFileSync(join(ROOT, "supabase/migrations/m709-improvement-proposals-controlled-learning.sql"), "utf8")
  const sqlStatuses = [...(/improvement_proposals_status_check\s+CHECK \(status IN \(([^)]*)\)/.exec(migSql)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1])
  check("S2 the migration's status CHECK equals PROPOSAL_STATUSES (derived, both ways)", sqlStatuses.length === PROPOSAL_STATUSES.length && PROPOSAL_STATUSES.every((s) => sqlStatuses.includes(s)), sqlStatuses.join())
  const sqlReasons = [...(/agent_action_ledger_reason_code_check\s+CHECK \(reason_code IN \(([^)]*)\)/.exec(migSql)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1])
  const codeReasons = [...src("lib/kernel/action-ledger.ts").matchAll(/^\s*"([A-Z_]+)",\s*$/gm)].map((m) => m[1])
  check("S3 LEARNED_IMPROVEMENT is in ACTION_REASON_CODES and the migration's CHECK restates the WHOLE code list", codeReasons.includes("LEARNED_IMPROVEMENT") && sqlReasons.includes("LEARNED_IMPROVEMENT") && codeReasons.every((c) => sqlReasons.includes(c)), `code ${codeReasons.length} / sql ${sqlReasons.length}`)
  check("S4 predictor_tuning is a registered settings policy key (the promotion's version stream)", "predictor_tuning" in TENANT_POLICY_SETTINGS_KEYS)
  check("S5 MAINTENANCE_DOMAINS owns improvement_proposals with this proof", MAINTENANCE_DOMAINS.improvement_proposals?.proof === "test:controlled-learning" && (MAINTENANCE_DOMAINS.improvement_proposals?.coOwners?.length ?? 0) >= 1)

  // ── W: wiring from stripped source, with positive controls ─────────────────────────────
  console.log("W — wiring")
  const conductor = src("lib/campaign-sequences/copy-learning-conductor.ts")
  const directDeactivate = /\.update\(\{ is_active: false \}\)/.test(conductor)
  check("W1 the conductor promotes ONLY through proposeEvaluatePromote; no direct is_active:false write remains (control: the old line would match)", /proposeEvaluatePromote\(svc, \{/.test(conductor) && !directDeactivate && /\.update\(\{ is_active: false \}\)/.test(`svc.from("campaign_sequence_steps").update({ is_active: false })`))
  check("W2 the conductor brings campaign_orchestrator's gate (posture + authority) to the kernel", /resolveManagerAutonomy\(brokerageId, "campaign_orchestrator", svc\)/.test(conductor) && /resolveAgentAuthorityLevel\(brokerageId, "campaign_orchestrator", svc\)/.test(conductor) && /actor: \{ type: "manager", managerKey: "campaign_orchestrator"/.test(conductor))
  const cron = src("app/api/cron/source-conversion-learning/route.ts")
  check("W3 the weekly cron proposes predictor thresholds AFTER resolving outcomes", cron.indexOf("resolvePredictorOutcomes(b.id, {}, svc)") > 0 && cron.indexOf("proposePredictorTuning(svc, b.id, predictor)") > cron.indexOf("resolvePredictorOutcomes(b.id, {}, svc)"))
  const calib = src("lib/intelligence/prompt-calibrator.ts")
  check("W4 the prompt calibrator proposes its change beside the log row (subject prompt, proposer prompt_calibrator)", /subjectKind: "prompt", subjectKey: sourceSystem, proposer: "prompt_calibrator"/.test(calib) && calib.indexOf("model_retraining_log") < calib.indexOf("proposeEvaluatePromote"))
  const runner = src("lib/intelligence/predictor-learning-runner.ts")
  check("W5 getPredictorTuning reads the promoted override (settings.predictor_tuning) ahead of the record", /promotedPredictorOverride\(svc, brokerageId, predictor\)/.test(runner) && /\.predictor_tuning as Record/.test(runner))
  const actions = src("app/actions/admin/improvement-proposals.ts")
  check("W6 the server actions gate on the SESSION tenant + the admin roster predicate before the service client", /^"use server"/.test(actions) && /requireCallerTenant\(\)/.test(actions) && /isTenantAdminGrantRole\(caller\.userType\)/.test(actions) && !/brokerageId: string/.test(actions.replace(/type AdminGate[^\n]*/, "")) && /export async function (listProposals|decideProposalAction|promoteProposalAction|rollbackProposalAction)/.test(actions))
  const page = src("app/dashboard/admin/manager-trust/page.tsx")
  const panel = src("app/dashboard/admin/manager-trust/improvement-proposals-panel.tsx")
  check("W7 the Manager Trust page mounts the proposals panel; the panel lists evidence + evaluation and offers approve / reject / promote / roll back", /<ImprovementProposalsPanel \/>/.test(page) && /listProposals\(\)/.test(panel) && /decideProposalAction\(p\.id, "approve"\)/.test(panel) && /decideProposalAction\(p\.id, "reject"\)/.test(panel) && /promoteProposalAction\(p\.id\)/.test(panel) && /rollbackProposalAction\(p\.id\)/.test(panel) && /evidence_refs/.test(panel))
  const kernel = src("lib/kernel/improvement-proposals.ts")
  check("W8 the kernel never writes a policy value directly — promotion goes through mergeBrokerageSettings / writeIsaSettings, inside withActionLedger", !/from\("brokerage_settings"\)/.test(kernel) && !/from\("tenant_policy_versions"\)/.test(kernel) && /mergeBrokerageSettings\(svc, row\.brokerage_id/.test(kernel) && /writeIsaSettings\(\{/.test(kernel) && /withActionLedger</.test(kernel) && /learning\.proposal\.\$\{direction\}/.test(kernel))
  check("W9 the kernel contains no model call (LLM never evaluates or promotes)", !/generateObjectRouted|generateTextRouted|@\/lib\/ai\/models/.test(kernel) && /generateObjectRouted/.test(src("lib/intelligence/prompt-calibrator.ts")))
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
  check("W10 registered as test:controlled-learning and in the guard chain", pkg.scripts["test:controlled-learning"]?.includes("controlled-learning-guard") === true && /npm run test:controlled-learning(\s|&|$)/.test(pkg.scripts.guard))
  check("W11 the migration carries the lane stamp (or the APPLIED LIVE stamp) on line 1 and applies in two parts", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(migSql) && /PART A/.test(migSql) && /PART B/.test(migSql))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { for (const f of fails) console.log(`   - ${f}`); console.log(" ❌ CONTROLLED_LEARNING_FAIL"); process.exit(1) }
  console.log(" ✅ CONTROLLED_LEARNING_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
