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
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { isRuleType } from "@/lib/lead-assignment/rule-matcher"
import { appendTenantPolicyVersion, assignmentRulePolicyKey, assignmentRulePolicyValue } from "@/lib/kernel/tenant-policy"

// 102D — an assignment rule is TENANT OPERATING POLICY (who receives which leads). Every write
// here appends a version through the ONE appender (lib/kernel/tenant-policy.ts, m696): key
// `assignment_rule:<id>`, value the rule's policy columns, null once deleted. The tenant is the
// session's (requireAdmin above), the actor the session user. A lost version is reported, never silent.
const RULE_POLICY_COLS = "id, brokerage_id, name, rule_type, conditions, agent_ids, team_id, priority, is_active"
async function versionRule(
  svc: ReturnType<typeof createServiceClient>,
  args: { brokerageId: string; ruleId: string; previous: Record<string, unknown> | null; value: Record<string, unknown> | null; userId: string; reason: string },
): Promise<void> {
  const v = await appendTenantPolicyVersion(svc, {
    brokerageId: args.brokerageId, policyKey: assignmentRulePolicyKey(args.ruleId),
    value: assignmentRulePolicyValue(args.value), previous: assignmentRulePolicyValue(args.previous),
    actor: { type: "user", userId: args.userId, reason: args.reason },
  })
  if (!v.ok) console.error(`[assignment-rules] policy version not recorded for ${args.ruleId}: ${v.error}`)
}

// TOMBSTONE (lane 91D2, §1.1 / §6 one vocabulary). A file-local
// `RULE_TYPES = new Set(["round_robin","load_balance","geo_based","specialization"])`
// stood here — a second spelling of the rule-type vocabulary, one value SHORT:
// it refused `manual`, which the matcher routes ("Assigns nobody. The lead waits
// for a person"), the admin page labels, and the live assignment_rules.rule_type
// CHECK admits (scripts/check-vocabularies.ts). So the ONE write path could not
// save a rule the rest of the system already understood. Survivor:
// lib/lead-assignment/rule-matcher.ts:31 (`RULE_TYPES`) via `isRuleType`.

async function requireAdmin(): Promise<
  | { ok: true; brokerageId: string; userId: string; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!isAdminOrBroker({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
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

/** Verify a rule id belongs to the caller's brokerage before mutating it — and return the row it
 *  had (the `previous` of the version the write appends). */
async function ruleBelongsToBrokerage(svc: ReturnType<typeof createServiceClient>, ruleId: string, brokerageId: string): Promise<Record<string, unknown> | null> {
  const { data } = await svc.from("assignment_rules").select(RULE_POLICY_COLS).eq("id", ruleId).maybeSingle()
  return data && (data as { brokerage_id: string }).brokerage_id === brokerageId ? (data as Record<string, unknown>) : null
}

export async function saveAssignmentRuleAction(
  input: AssignmentRuleInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const name = (input.name ?? "").trim()
  if (!name) return { ok: false, error: "Rule name is required" }
  if (!isRuleType(input.ruleType)) return { ok: false, error: `Invalid rule type: ${input.ruleType}` }
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
    const previous = await ruleBelongsToBrokerage(svc, input.id, auth.brokerageId)
    if (!previous) {
      return { ok: false, error: "Rule not found for this brokerage" }
    }
    const { error } = await svc.from("assignment_rules").update(payload).eq("id", input.id)
    if (error) return { ok: false, error: error.message }
    await versionRule(svc, { brokerageId: auth.brokerageId, ruleId: input.id, previous, value: payload, userId: auth.userId, reason: "assignment rule saved" })
    revalidatePath("/dashboard/admin/assignment-rules")
    return { ok: true, id: input.id }
  }

  const { data, error } = await svc
    .from("assignment_rules")
    .insert({ ...payload, times_triggered: 0, created_by: auth.userId })
    .select("id")
    .single()
  if (error) return { ok: false, error: error.message }
  const newId = (data as { id: string }).id
  await versionRule(svc, { brokerageId: auth.brokerageId, ruleId: newId, previous: null, value: payload, userId: auth.userId, reason: "assignment rule created" })
  revalidatePath("/dashboard/admin/assignment-rules")
  return { ok: true, id: newId }
}

export async function toggleAssignmentRuleAction(
  ruleId: string,
  isActive: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const previous = await ruleBelongsToBrokerage(svc, ruleId, auth.brokerageId)
  if (!previous) {
    return { ok: false, error: "Rule not found for this brokerage" }
  }
  const { error } = await svc.from("assignment_rules").update({ is_active: isActive }).eq("id", ruleId)
  if (error) return { ok: false, error: error.message }
  await versionRule(svc, { brokerageId: auth.brokerageId, ruleId, previous, value: { ...previous, is_active: isActive }, userId: auth.userId, reason: `assignment rule ${isActive ? "activated" : "deactivated"}` })
  revalidatePath("/dashboard/admin/assignment-rules")
  return { ok: true }
}

export async function deleteAssignmentRuleAction(
  ruleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const previous = await ruleBelongsToBrokerage(svc, ruleId, auth.brokerageId)
  if (!previous) {
    return { ok: false, error: "Rule not found for this brokerage" }
  }
  // .select() + count: a DELETE matching nothing also resolves (CLAUDE.md §3).
  const { data: deleted, error } = await svc.from("assignment_rules").delete().eq("id", ruleId).eq("brokerage_id", auth.brokerageId).select("id")
  if (error) return { ok: false, error: error.message }
  if (!Array.isArray(deleted) || deleted.length !== 1) return { ok: false, error: "Rule not found for this brokerage" }
  await versionRule(svc, { brokerageId: auth.brokerageId, ruleId, previous, value: null, userId: auth.userId, reason: "assignment rule deleted" })
  revalidatePath("/dashboard/admin/assignment-rules")
  return { ok: true }
}
