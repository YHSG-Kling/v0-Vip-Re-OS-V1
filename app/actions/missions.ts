"use server"

/**
 * MISSIONS — the human door onto the durable mission runtime (wave 104, lane 104D).
 * Every export is a public HTTP endpoint (CLAUDE.md §4): tenant from the SESSION
 * (requireCallerTenant, no claimed id accepted), gate first, then the service client.
 * The kernel service (lib/kernel/missions.ts) is the only writer; this file only
 * resolves WHO is asking and relays the result.
 */
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isAgentOrTenantAdmin, isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import {
  activeMissionsFor, blockMission, createMission, transitionMission, unblockMission,
  type MissionPriority, type MissionRow, type MissionType, type SuccessCriterion,
} from "@/lib/kernel/missions"
import type { MissionVerdictLine } from "@/lib/kernel/mission-controller"
import {
  acceptDelegation, cancelDelegation, dissentDelegation, escalateDelegation, pendingDelegationsFor, rejectDelegation,
  type DelegationRow,
} from "@/lib/kernel/manager-delegation"

type Door<T> = { ok: true; data: T } | { ok: false; error: string }

async function gate(): Promise<{ ok: true; brokerageId: string; userId: string; admin: boolean } | { ok: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  const profile = { user_type: caller.userType }
  if (!isAgentOrTenantAdmin(profile)) return { ok: false, error: "Only brokerage staff can work missions." }
  return { ok: true, brokerageId: caller.brokerageId, userId: caller.userId, admin: isAdminOrBroker(profile) }
}

export async function listMissionsAction(input?: { mine?: boolean }): Promise<Door<{ active: MissionRow[]; attention: MissionRow[]; readRefused: string | null; verdicts: Record<string, MissionVerdictLine>; delegations: Record<string, DelegationRow[]>; delegationsRefused: string | null }>> {
  const g = await gate()
  if (!g.ok) return g
  const svc = createServiceClient() as any
  const r = await activeMissionsFor(g.brokerageId, { createdBy: input?.mine ? g.userId : null }, svc)
  // THE CONTROLLER'S VERDICT LINE (wave 105, lane 105B): owner, participants, progress %, blockers,
  // budget, next action — planned from the row + the delegation seam, never written from here (the
  // cron tick writes; this door only shows). A refused plan leaves the line out, never a fake one.
  let verdicts: Record<string, MissionVerdictLine> = {}
  try {
    const { missionVerdictLines } = await import("@/lib/kernel/mission-controller")
    const lines = await missionVerdictLines(g.brokerageId, r.active, svc)
    verdicts = Object.fromEntries(Object.entries(lines).map(([id, v]) => [id, { line: v.line, nextAction: v.nextAction, flags: v.flags, progressPct: v.progress.pct, humanNeeded: v.human.needed, ownerExpected: v.owner.expected, participantsMissing: v.participants.missing }]))
  } catch (e) { console.error(`[missions] controller verdict lines unavailable: ${e instanceof Error ? e.message : String(e)}`) }
    const d = await pendingDelegationsFor(g.brokerageId, {}, svc)
  return { ok: true, data: { active: r.active, attention: r.attention, readRefused: r.readRefused, verdicts, delegations: d.byMission, delegationsRefused: d.readRefused } }
}

/**
 * WAVE 105A — a HUMAN intervenes on a manager-to-manager delegation (the Missions card): accept /
 * resume it, reject it, dissent with objections, escalate it, or cancel it. Tenant-admin roster only
 * (a human overriding what two managers agreed is a brokerage decision, not an agent's). The kernel
 * service is the only writer; the state machine's refusal reads back verbatim.
 */
export async function decideDelegationAction(input: { delegationId: string; decision: "accept" | "reject" | "dissent" | "escalate" | "cancel"; reason: string }): Promise<Door<DelegationRow>> {
  const g = await gate()
  if (!g.ok) return g
  if (!g.admin) return { ok: false, error: "Only a brokerage admin can decide a manager delegation." }
  const svc = createServiceClient() as any
  const reason = String(input?.reason ?? "").trim()
  const p = { brokerageId: g.brokerageId, delegationId: String(input?.delegationId ?? ""), actor: { type: "user" as const, id: g.userId } }
  const r = input?.decision === "accept" ? await acceptDelegation({ ...p, reason: reason || "accepted by a human" }, svc)
    : input?.decision === "reject" ? await rejectDelegation({ ...p, reason: reason || "rejected by a human" }, svc)
    : input?.decision === "dissent" ? await dissentDelegation({ ...p, objections: reason ? [reason] : [] }, svc)
    : input?.decision === "escalate" ? await escalateDelegation({ ...p, reason: reason || "escalated by a human" }, svc)
    : input?.decision === "cancel" ? await cancelDelegation({ ...p, reason: reason || "cancelled by a human" }, svc)
    : null
  if (!r) return { ok: false, error: "Unknown decision" }
  return r.ok ? { ok: true, data: r.delegation } : { ok: false, error: r.reason }
}

export async function createMissionAction(input: {
  objective: string; ownerManager: ManagerKey; participatingManagers?: ManagerKey[]; missionType?: MissionType
  priority?: MissionPriority; successCriteria?: SuccessCriterion[]; budgetUsd?: number | null; deadline?: string | null
  subject?: { type: string; id: string } | null; start?: boolean
}): Promise<Door<MissionRow>> {
  const g = await gate()
  if (!g.ok) return g
  if (!(input?.ownerManager in MANAGERS)) return { ok: false, error: "Unknown owner manager" }
  const r = await createMission({
    brokerageId: g.brokerageId, objective: String(input.objective ?? ""), ownerManager: input.ownerManager,
    participatingManagers: input.participatingManagers, missionType: input.missionType, priority: input.priority,
    successCriteria: input.successCriteria, budget: typeof input.budgetUsd === "number" ? { usd: input.budgetUsd } : {},
    deadline: input.deadline ?? null, subject: input.subject ?? null, createdBy: g.userId,
    actor: { type: "user", id: g.userId }, initialState: input.start ? "ACTIVE" : "PROPOSED",
  }, createServiceClient() as any)
  return r.ok ? { ok: true, data: r.mission } : { ok: false, error: r.reason }
}

/** A human decides: approve / resume (→ ACTIVE), plan (→ PLANNING), cancel, or fail. Admins decide
 *  any mission of the tenant; an agent only the missions they created. */
export async function decideMissionAction(input: { missionId: string; decision: "approve" | "plan" | "cancel" | "fail"; reason: string }): Promise<Door<MissionRow>> {
  const g = await gate()
  if (!g.ok) return g
  const to = input?.decision === "approve" ? "ACTIVE" : input?.decision === "plan" ? "PLANNING" : input?.decision === "cancel" ? "CANCELLED" : input?.decision === "fail" ? "FAILED" : null
  if (!to) return { ok: false, error: "Unknown decision" }
  const svc = createServiceClient() as any
  if (!g.admin) {
    const { data: own, error } = await svc.from("missions").select("id").eq("brokerage_id", g.brokerageId).eq("id", input.missionId).eq("created_by", g.userId).maybeSingle()
    if (error) return { ok: false, error: `Mission could not be read: ${error.message}` }
    if (!own) return { ok: false, error: "Only the mission's creator or a brokerage admin can decide it." }
  }
  const r = await transitionMission({ brokerageId: g.brokerageId, missionId: input.missionId, to, reason: String(input.reason ?? "").trim() || `${input.decision} by a human`, actor: { type: "user", id: g.userId } }, svc)
  return r.ok ? { ok: true, data: r.mission } : { ok: false, error: r.reason }
}

/**
 * RE-CHECK NOW (wave 105, lane 105B): a tenant admin asks the EXECUTIVE MISSION CONTROLLER to
 * judge ONE mission outside the cron tick (lib/kernel/mission-controller.ts controlMission — plan,
 * act through the mission service, record the verdict). Admin roster only; the tenant is the
 * session's. The verdict line comes back verbatim for the card.
 */
export async function controlMissionAction(input: { missionId: string }): Promise<Door<{ line: string; nextAction: string; moved: boolean; state: string }>> {
  const g = await gate()
  if (!g.ok) return g
  if (!g.admin) return { ok: false, error: "Only a brokerage admin can run the mission controller." }
  const missionId = String(input?.missionId ?? "").trim()
  if (!missionId) return { ok: false, error: "A mission id is required." }
  const { controlMission } = await import("@/lib/kernel/mission-controller")
  const r = await controlMission(g.brokerageId, missionId, createServiceClient() as any)
  if (!r.ok) return { ok: false, error: r.reason }
  return { ok: true, data: { line: r.plan.line, nextAction: r.plan.nextAction, moved: r.moved, state: r.plan.transition && r.moved ? r.plan.transition.to : r.plan.state } }
}

export async function blockMissionAction(input: { missionId: string; key: string; reason: string; clear?: boolean }): Promise<Door<MissionRow>> {
  const g = await gate()
  if (!g.ok) return g
  const p = { brokerageId: g.brokerageId, missionId: input.missionId, key: String(input.key ?? "").trim(), reason: String(input.reason ?? "").trim(), actor: { type: "user" as const, id: g.userId } }
  if (!p.key) return { ok: false, error: "A blocker needs a key" }
  const r = input.clear ? await unblockMission(p, createServiceClient() as any) : await blockMission(p, createServiceClient() as any)
  return r.ok ? { ok: true, data: r.mission } : { ok: false, error: r.reason }
}
