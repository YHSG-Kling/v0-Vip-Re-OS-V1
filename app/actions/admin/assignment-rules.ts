"use server"

/**
 * app/actions/admin/assignment-rules.ts
 *
 * SECURITY FIX: the assignment-rules admin page wrote `assignment_rules` rows
 * DIRECTLY from the browser (supabase.from("assignment_rules").insert/update/
 * delete) with only RLS between a caller and the lead-routing table. Every other
 * admin surface routes privileged writes through a role-gated server action; this
 * one didn't. Lead-routing rules decide WHO RECEIVES WHICH LEADS (i.e. money), so
 * an under-gated write is a real integrity + revenue risk.
 *
 * These actions are the ONE write path for assignment rules: admin-gated
 * (broker / broker_admin / admin / superadmin / team_lead), brokerage-scoped with
 * identity resolved server-side, and every rule pinned to the caller's own
 * brokerage so a rule can never target another tenant's agents. Mirrors the
 * locations.ts pattern exactly (requireAdmin + service client + revalidatePath).
 */

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])
const RULE_TYPES = new Set(["round_robin", "load_balance", "geo_based", "specialization"])

async function requireAdmin(): Promise<
  | { ok: true; brokerageId: string; userId: string; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, userType: ctx.userType }
}

export interface AssignmentRuleInput {
  /** Present → update that rule; absent → create. */
  id?: string | null
  name: string
  ruleType: string
  conditions: Record<string, unknown>
  agentIds: string[]
  teamId?: string | null
  priority: number
  isActive?: boolean
}

/** Verify a rule id belongs to the caller's brokerage before mutating it. */
async function ruleBelongsToBrokerage(svc: ReturnType<typeof createServiceClient>, ruleId: string, brokerageId: string): Promise<boolean> {
  const { data } = await svc.from("assignment_rules").select("brokerage_id").eq("id", ruleId).maybeSingle()
  return !!data && (data as { brokerage_id: string }).brokerage_id === brokerageId
}

export async function saveAssignmentRuleAction(
  input: AssignmentRuleInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const name = (input.name ?? "").trim()
  if (!name) return { ok: false, error: "Rule name is required" }
  if (!RULE_TYPES.has(input.ruleType)) return { ok: false, error: `Invalid rule type: ${input.ruleType}` }
  const priority = Number.isFinite(input.priority) ? Math.round(input.priority) : 10
  const agentIds = Array.isArray(input.agentIds) ? input.agentIds.filter((x) => typeof x === "string") : []
  const teamId = input.teamId?.trim() || null

  const svc = createServiceClient()

  // brokerage_id is ALWAYS pinned to the caller's own tenant — never trusted from
  // the client — so a rule can't be created/moved onto another brokerage.
  const payload = {
    brokerage_id: auth.brokerageId,
    name,
    rule_type: input.ruleType,
    conditions: input.conditions ?? {},
    agent_ids: agentIds,
    team_id: teamId,
    priority,
    is_active: input.isActive ?? true,
  }

  if (input.id) {
    if (!(await ruleBelongsToBrokerage(svc, input.id, auth.brokerageId))) {
      return { ok: false, error: "Rule not found for this brokerage" }
    }
    const { error } = await svc.from("assignment_rules").update(payload).eq("id", input.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/dashboard/admin/assignment-rules")
    return { ok: true, id: input.id }
  }

  const { data, error } = await svc
    .from("assignment_rules")
    .insert({ ...payload, times_triggered: 0, created_by: auth.userId })
    .select("id")
    .single()
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/assignment-rules")
  return { ok: true, id: (data as { id: string }).id }
}

export async function toggleAssignmentRuleAction(
  ruleId: string,
  isActive: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  if (!(await ruleBelongsToBrokerage(svc, ruleId, auth.brokerageId))) {
    return { ok: false, error: "Rule not found for this brokerage" }
  }
  const { error } = await svc.from("assignment_rules").update({ is_active: isActive }).eq("id", ruleId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/assignment-rules")
  return { ok: true }
}

export async function deleteAssignmentRuleAction(
  ruleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  if (!(await ruleBelongsToBrokerage(svc, ruleId, auth.brokerageId))) {
    return { ok: false, error: "Rule not found for this brokerage" }
  }
  const { error } = await svc.from("assignment_rules").delete().eq("id", ruleId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/assignment-rules")
  return { ok: true }
}
