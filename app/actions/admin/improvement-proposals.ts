"use server"

/**
 * app/actions/admin/improvement-proposals.ts — the tenant-admin doors of CONTROLLED LEARNING
 * (wave 104, lane 104C; m709; gap map row 20).
 *
 * Every door is tenant-admin only (TENANT_ADMIN_USER_TYPES via isTenantAdminGrantRole), tenant from
 * the SESSION (requireCallerTenant — no argument names a brokerage), gate first, then the service
 * client (CLAUDE.md §4). The decisions themselves live in lib/kernel/improvement-proposals.ts:
 *   listProposals()                       every proposal of this brokerage with its evidence + evaluation
 *   decideProposalAction(id, decision)    EVALUATED → APPROVED / REJECTED (a human on the roster)
 *   promoteProposalAction(id)             APPROVED → PROMOTED through the subject's survivor writer, ledgered
 *   rollbackProposalAction(id)            PROMOTED → ROLLED_BACK (previous value back through the same writer)
 *   getWorkforceThresholdsEditor()        the DEDICATED workforce_thresholds editor's read (current vs default + bounds)
 *   submitWorkforceThresholdsAction(…)    the editor's submit: a `policy` proposal (proposer human); "apply now"
 *                                         approves + promotes it in the same action through promoteProposal
 */

import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import {
  decideProposal, listImprovementProposals, promoteProposal, rollbackProposal, proposeEvaluatePromote, OPEN_STATUSES,
  type ImprovementProposalRow, type ProposalActor,
} from "@/lib/kernel/improvement-proposals"
import {
  DEFAULT_WORKFORCE_THRESHOLDS, WORKFORCE_THRESHOLDS_KEY, WORKFORCE_THRESHOLD_FIELDS, WORKFORCE_OVERWHELMED_BANDS,
  resolveWorkforceThresholds, validateWorkforceThresholdsEdit, type WorkforceThresholds,
} from "@/lib/kernel/brokerage-twin"
import { buildTenantOperatingConstitution } from "@/lib/kernel/tenant-policy"

type AdminGate = { ok: true; brokerageId: string; actor: ProposalActor } | { ok: false; error: string }

async function requireLearningAdmin(reason?: string | null): Promise<AdminGate> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isTenantAdminGrantRole(caller.userType)) {
    return { ok: false, error: "Only a broker, owner, admin, team lead or compliance officer can decide on improvement proposals." }
  }
  return { ok: true, brokerageId: caller.brokerageId, actor: { type: "user", userId: caller.userId, isTenantAdmin: true, reason: reason ?? null } }
}

export async function listProposals(): Promise<{ ok: true; available: boolean; rows: ImprovementProposalRow[] } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  return listImprovementProposals(createServiceClient(), gate.brokerageId, { limit: 100 })
}

/**
 * Wave 106 (lane 106A) — THE MARKETING ALLOCATION DOOR: "how should I split $X this month?" The
 * recommender (lib/kernel/resource-allocation.ts recommendMarketingAllocation) runs the owner's chain
 * (budget → campaign performance → territory demand → agent capacity → pipeline need → marginal
 * expected return) and records ONE allocation proposal a human decides on the Manager Trust page —
 * nothing is spent or applied here. Form action of the Command Center's allocation card (server
 * component form); tenant from the SESSION, admin roster only.
 */
export async function recommendMarketingAllocationFormAction(formData: FormData): Promise<void> {
  const gate = await requireLearningAdmin("marketing allocation requested from the Command Center")
  if (!gate.ok) { console.warn(`[improvement-proposals] marketing allocation refused: ${gate.error}`); return }
  const budgetUsd = Number(String(formData.get("budgetUsd") ?? "").replace(/[^0-9.]/g, ""))
  if (!(budgetUsd > 0) || budgetUsd > 10_000_000) { console.warn("[improvement-proposals] marketing allocation refused: budget must be a positive amount"); return }
  const { recommendMarketingAllocation } = await import("@/lib/kernel/resource-allocation")
  const r = await recommendMarketingAllocation(createServiceClient(), { brokerageId: gate.brokerageId, budgetUsd })
  if (!r.ok) console.warn(`[improvement-proposals] marketing allocation not recommended: ${r.error}`)
  else if (r.record && !r.record.ok) console.warn(`[improvement-proposals] marketing allocation recommended but NOT recorded: ${r.record.error}`)
  revalidatePath("/dashboard/admin/command-center")
  revalidatePath("/dashboard/admin/manager-trust")
}

export async function decideProposalAction(id: string, decision: "approve" | "reject", reason?: string): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin(reason)
  if (!gate.ok) return { ok: false, error: gate.error }
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: "Decision must be approve or reject." }
  const r = await decideProposal(createServiceClient(), { brokerageId: gate.brokerageId, id: String(id ?? ""), decision, actor: gate.actor, reason: reason ?? null })
  if (r.ok) revalidatePath("/dashboard/admin/manager-trust")
  return r
}

export async function promoteProposalAction(id: string, reason?: string): Promise<{ ok: true; policyVersionRef: string | null; writer: string } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin(reason)
  if (!gate.ok) return { ok: false, error: gate.error }
  const r = await promoteProposal(createServiceClient(), { brokerageId: gate.brokerageId, id: String(id ?? ""), actor: gate.actor })
  if (r.ok) revalidatePath("/dashboard/admin/manager-trust")
  return r.ok ? r : { ok: false, error: r.error }
}

export async function rollbackProposalAction(id: string, reason?: string): Promise<{ ok: true; policyVersionRef: string | null; writer: string } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin(reason)
  if (!gate.ok) return { ok: false, error: gate.error }
  const r = await rollbackProposal(createServiceClient(), { brokerageId: gate.brokerageId, id: String(id ?? ""), actor: gate.actor })
  if (r.ok) revalidatePath("/dashboard/admin/manager-trust")
  return r.ok ? r : { ok: false, error: r.error }
}

// ── WAVE 107G — THE DEDICATED WORKFORCE-THRESHOLDS EDITOR (owner: "create dedicated editor") ─────────
// The thresholds are tenant policy key `workforce_thresholds` (lib/kernel/tenant-policy.ts), read by
// lib/kernel/brokerage-twin.ts resolveWorkforceThresholds. They change through the ONE policy path:
// an improvement_proposals `policy` proposal (proposer human) → approve → promoteProposal →
// mergeBrokerageSettings → appendTenantPolicyVersion, inside withActionLedger. This editor never
// writes brokerage_settings itself (the wave-106 setWorkforceThresholds endpoint was tombstoned for
// exactly that — app/actions/recruiting-roi.ts). Rendered on the Manager Trust page
// (app/dashboard/admin/manager-trust/workforce-thresholds-editor.tsx).

export interface WorkforceThresholdsEditorData {
  current: WorkforceThresholds
  defaults: WorkforceThresholds
  source: "policy" | "default"
  stored: unknown
  version: number
  changedAt: string | null
  fields: typeof WORKFORCE_THRESHOLD_FIELDS
  bands: typeof WORKFORCE_OVERWHELMED_BANDS
  openProposal: { id: string; status: string; value: unknown; createdAt: string } | null
  proposalsAvailable: boolean
}

export async function getWorkforceThresholdsEditor(): Promise<{ ok: true; data: WorkforceThresholdsEditorData } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()
  const con = await buildTenantOperatingConstitution(svc, gate.brokerageId)
  if (!con.ok) return { ok: false, error: con.error }
  const entry = con.entries.find((e) => e.policyKey === WORKFORCE_THRESHOLDS_KEY)
  if (!entry) return { ok: false, error: `${WORKFORCE_THRESHOLDS_KEY} is not in the operating constitution — not registered in lib/kernel/tenant-policy.ts` }
  const list = await listImprovementProposals(svc, gate.brokerageId, { limit: 100 })
  if (!list.ok) return { ok: false, error: list.error }
  const open = list.rows.find((r) => r.subject_kind === "policy" && r.subject_key === WORKFORCE_THRESHOLDS_KEY && OPEN_STATUSES.includes(r.status))
  return {
    ok: true,
    data: {
      current: resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: entry.value }),
      defaults: DEFAULT_WORKFORCE_THRESHOLDS,
      source: entry.isDefault ? "default" : "policy",
      stored: entry.value ?? null,
      version: entry.version,
      changedAt: entry.changedAt,
      fields: WORKFORCE_THRESHOLD_FIELDS,
      bands: WORKFORCE_OVERWHELMED_BANDS,
      openProposal: open ? { id: open.id, status: open.status, value: (open.proposed_change ?? {}).value ?? null, createdAt: open.created_at } : null,
      proposalsAvailable: list.available,
    },
  }
}

export type WorkforceThresholdsSubmitState = { ok: boolean; message: string; errors?: string[] } | null

/**
 * The editor's submit (useActionState form action). mode=propose records a `policy` proposal the
 * Improvement proposals panel decides; mode=apply is the brokerage admin's "apply now" door — the
 * SAME proposal, approved and promoted in this action through proposeEvaluatePromote → decideProposal
 * → promoteProposal (promotionDecision honours the human authority; nothing here bypasses it).
 */
export async function submitWorkforceThresholdsAction(_prev: WorkforceThresholdsSubmitState, formData: FormData): Promise<WorkforceThresholdsSubmitState> {
  const mode = formData.get("mode") === "apply" ? "apply" : "propose"
  const gate = await requireLearningAdmin(mode === "apply" ? "workforce thresholds applied from the dedicated editor" : "workforce thresholds proposed from the dedicated editor")
  if (!gate.ok) return { ok: false, message: gate.error }
  const input: Record<string, unknown> = { overwhelmed_band: formData.get("overwhelmed_band") }
  for (const f of WORKFORCE_THRESHOLD_FIELDS) input[f.key] = formData.get(f.key)
  const edit = validateWorkforceThresholdsEdit(input)
  if (!edit.ok) return { ok: false, message: "Nothing was proposed — fix the highlighted values.", errors: edit.errors }

  const svc = createServiceClient()
  // An OPEN proposal for this key is the one the kernel would hand back (proposeImprovement dedups on
  // subject) — a DIFFERENT value must not ride it silently: decide that one first.
  const list = await listImprovementProposals(svc, gate.brokerageId, { limit: 100 })
  if (!list.ok) return { ok: false, message: list.error }
  const open = list.rows.find((r) => r.subject_kind === "policy" && r.subject_key === WORKFORCE_THRESHOLDS_KEY && OPEN_STATUSES.includes(r.status))
  if (open && JSON.stringify((open.proposed_change ?? {}).value ?? null) !== JSON.stringify(edit.value)) {
    return { ok: false, message: `A different workforce-thresholds proposal is already ${open.status} — approve, promote or reject it in Improvement proposals first.` }
  }
  const r = await proposeEvaluatePromote(svc, {
    brokerageId: gate.brokerageId,
    subjectKind: "policy",
    subjectKey: WORKFORCE_THRESHOLDS_KEY,
    proposer: "human",
    proposedChange: { value: edit.value, changed_keys: edit.changedKeys },
    evidenceRefs: [{ kind: "human_edit", surface: "manager_trust.workforce_thresholds", user_id: gate.actor.userId ?? null, mode, changed_keys: edit.changedKeys }],
    actor: mode === "apply" ? gate.actor : null,
  })
  revalidatePath("/dashboard/admin/manager-trust")
  revalidatePath("/dashboard/recruiting-roi")
  if (!r.proposal.ok) return { ok: false, message: `Not proposed: ${r.proposal.error}` }
  if (mode === "apply") {
    return r.promoted
      ? { ok: true, message: `Applied — ${r.policyVersionRef ?? "new policy version"}. The next twin build classifies against the new thresholds.` }
      : { ok: false, message: `Proposed but NOT applied: ${r.held ?? `proposal ${r.status}`}` }
  }
  return { ok: true, message: `Proposed (${r.status ?? "PROPOSED"}) — approve and promote it in Improvement proposals below.` }
}


// ── WAVE 108G — SELF-OPTIMIZING MANAGER TEAMS: the tenant's AUTONOMOUS CLASS LIST ─────────────────────────────
// Policy key `self_optimization` { autonomous_classes } (lib/kernel/tenant-policy.ts) decides which optimization
// classes the weekly team cycle (lib/kernel/self-optimization.ts runTeamOptimizationCycle) may promote without a
// human. It is AUTHORITY POLICY — a forbidden surface for the optimizer — so it changes only here, by a tenant
// admin, through the ONE policy path (a `policy` proposal, proposer human → approve → promoteProposal →
// mergeBrokerageSettings → appendTenantPolicyVersion, inside withActionLedger). Rendered on the Manager Trust page
// (app/dashboard/admin/manager-trust/self-optimization-panel.tsx).

export interface SelfOptimizationAutonomyData {
  classes: Array<{ key: string; label: string; owner: string; coProposers: string[]; evaluator: string; reader: string; autonomous: boolean }>
  openTeamProposals: number
}

export async function getSelfOptimizationAutonomy(): Promise<{ ok: true; data: SelfOptimizationAutonomyData } | { ok: false; error: string }> {
  const gate = await requireLearningAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()
  const { OPTIMIZATION_CLASSES, OPTIMIZATION_CLASS_DEFS, readTenantSettings, resolveSelfOptimizationPolicy, TEAM_OPTIMIZATION_PROPOSER } = await import("@/lib/kernel/self-optimization")
  const st = await readTenantSettings(svc, gate.brokerageId)
  if (!st.ok) return { ok: false, error: st.error }
  const auto = resolveSelfOptimizationPolicy(st.settings).autonomousClasses
  const list = await listImprovementProposals(svc, gate.brokerageId, { limit: 200 })
  if (!list.ok) return { ok: false, error: list.error }
  return {
    ok: true,
    data: {
      classes: OPTIMIZATION_CLASSES.map((k) => {
        const d = OPTIMIZATION_CLASS_DEFS[k]
        return { key: k, label: d.label, owner: d.owner, coProposers: d.coProposers.map((c) => c.manager), evaluator: d.evaluator, reader: d.reader, autonomous: auto.includes(k) }
      }),
      openTeamProposals: list.rows.filter((r) => (r.proposer === TEAM_OPTIMIZATION_PROPOSER || !!(r.proposed_change ?? {}).optimization) && OPEN_STATUSES.includes(r.status)).length,
    },
  }
}

/** Form action: the checked classes become the tenant's autonomous list (applied now — a human's own policy edit). */
export async function setSelfOptimizationAutonomyFormAction(formData: FormData): Promise<void> {
  const gate = await requireLearningAdmin("self-optimization autonomous classes set on the Manager Trust page")
  if (!gate.ok) { console.warn(`[improvement-proposals] self-optimization autonomy refused: ${gate.error}`); return }
  const { isOptimizationClass, SELF_OPTIMIZATION_POLICY_KEY } = await import("@/lib/kernel/self-optimization")
  const classes = [...new Set(formData.getAll("autonomous_classes").map(String).filter(isOptimizationClass))]
  const svc = createServiceClient()
  const list = await listImprovementProposals(svc, gate.brokerageId, { limit: 100 })
  if (!list.ok) { console.warn(`[improvement-proposals] self-optimization autonomy not proposed: ${list.error}`); return }
  const open = list.rows.find((r) => r.subject_kind === "policy" && r.subject_key === SELF_OPTIMIZATION_POLICY_KEY && OPEN_STATUSES.includes(r.status))
  if (open) { console.warn(`[improvement-proposals] a self_optimization proposal is already ${open.status} — decide it in Improvement proposals first`); return }
  const r = await proposeEvaluatePromote(svc, {
    brokerageId: gate.brokerageId, subjectKind: "policy", subjectKey: SELF_OPTIMIZATION_POLICY_KEY, proposer: "human",
    proposedChange: { value: { autonomous_classes: classes } },
    evidenceRefs: [{ kind: "human_edit", surface: "manager_trust.self_optimization", user_id: gate.actor.userId ?? null, classes }],
    actor: gate.actor,
  })
  if (!r.promoted) console.warn(`[improvement-proposals] self-optimization autonomy NOT applied: ${r.held ?? `proposal ${r.status}`}`)
  revalidatePath("/dashboard/admin/manager-trust")
}
