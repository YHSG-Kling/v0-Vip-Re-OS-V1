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

type Door<T> = { ok: true; data: T } | { ok: false; error: string }

async function gate(): Promise<{ ok: true; brokerageId: string; userId: string; admin: boolean } | { ok: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  const profile = { user_type: caller.userType }
  if (!isAgentOrTenantAdmin(profile)) return { ok: false, error: "Only brokerage staff can work missions." }
  return { ok: true, brokerageId: caller.brokerageId, userId: caller.userId, admin: isAdminOrBroker(profile) }
}

export async function listMissionsAction(input?: { mine?: boolean }): Promise<Door<{ active: MissionRow[]; attention: MissionRow[]; readRefused: string | null }>> {
  const g = await gate()
  if (!g.ok) return g
  const r = await activeMissionsFor(g.brokerageId, { createdBy: input?.mine ? g.userId : null }, createServiceClient() as any)
  return { ok: true, data: { active: r.active, attention: r.attention, readRefused: r.readRefused } }
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

export async function blockMissionAction(input: { missionId: string; key: string; reason: string; clear?: boolean }): Promise<Door<MissionRow>> {
  const g = await gate()
  if (!g.ok) return g
  const p = { brokerageId: g.brokerageId, missionId: input.missionId, key: String(input.key ?? "").trim(), reason: String(input.reason ?? "").trim(), actor: { type: "user" as const, id: g.userId } }
  if (!p.key) return { ok: false, error: "A blocker needs a key" }
  const r = input.clear ? await unblockMission(p, createServiceClient() as any) : await blockMission(p, createServiceClient() as any)
  return r.ok ? { ok: true, data: r.mission } : { ok: false, error: r.reason }
}
