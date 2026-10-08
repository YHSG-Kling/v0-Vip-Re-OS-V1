"use server"

/**
 * app/actions/blog-cadence-policy.ts
 *
 * Wave 30 — server actions for the blog cadence Settings UI. Mirrors the
 * Wave 28 lifecycle-promo-policy actions but with a different schema:
 * cadence is a SINGLE row per (scope_type, scope_id), not per event_type.
 * Each row carries cadence + fire_day + preferred_categories + preferred_persona.
 *
 * Permission model (same as Wave 28):
 *   · Any authenticated user can set their AGENT-scope override
 *   · Future commit: team leads → TEAM scope, brokerage admins → BROKERAGE
 *
 * For Wave 30 the UI exposes AGENT scope only.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

export type CadenceValue = "weekly" | "biweekly" | "monthly" | "off"

const VALID_CADENCES: CadenceValue[] = ["weekly", "biweekly", "monthly", "off"]

export interface BlogCadencePolicyRow {
  cadence:              CadenceValue
  fire_day:             number | null   // 0-6 for weekly/biweekly (Mon=0); 1-28 for monthly
  preferred_categories: string[] | null
  preferred_persona:    string | null
}

export interface GetMyBlogCadenceResult {
  success: boolean
  error?: string
  scope?: "agent"
  scopeId?: string
  policy?: BlogCadencePolicyRow | null  // null = no row yet → cadence is implicitly 'off'
}

export async function getMyBlogCadencePolicy(): Promise<GetMyBlogCadenceResult> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }
  const svc = createServiceClient()
  const { data: agentRow } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  const agentRecordId = (agentRow?.id as string | undefined) ?? null
  if (!agentRecordId) return { success: false, error: "Agent record not found" }

  const { data: policy } = await svc
    .from("blog_cadence_policy")
    .select("cadence, fire_day, preferred_categories, preferred_persona")
    .eq("scope_type", "agent")
    .eq("scope_id", agentRecordId)
    .maybeSingle()

  return {
    success: true,
    scope:   "agent",
    scopeId: agentRecordId,
    policy:  (policy as BlogCadencePolicyRow | null) ?? null,
  }
}

/**
 * Wave 32 — scoped upsert. Without scopeType the action defaults to AGENT
 * (backward compat). Other tiers gated by resolvePolicyScopeAccess.
 */
export async function upsertBlogCadencePolicy(input: {
  cadence:              CadenceValue
  fireDay:              number | null
  preferredCategories:  string[] | null
  preferredPersona:     string | null
  scopeType?:           "agent" | "team" | "brokerage"
  scopeId?:             string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: "Unauthorized" }
  }
  if (!VALID_CADENCES.includes(input.cadence)) {
    return { success: false, error: "Invalid cadence" }
  }
  // fire_day validation: weekly/biweekly need 0-6; monthly needs 1-28
  if (input.cadence === "weekly" || input.cadence === "biweekly") {
    if (input.fireDay === null || input.fireDay < 0 || input.fireDay > 6) {
      return { success: false, error: "fire_day must be 0-6 for weekly/biweekly cadence" }
    }
  } else if (input.cadence === "monthly") {
    if (input.fireDay === null || input.fireDay < 1 || input.fireDay > 28) {
      return { success: false, error: "fire_day must be 1-28 for monthly cadence" }
    }
  }

  const scopeType = input.scopeType ?? "agent"
  const { resolvePolicyScopeAccess } = await import("@/lib/identity/policy-scope")
  const access = await resolvePolicyScopeAccess()
  let scopeId = input.scopeId ?? null
  if (scopeType === "agent") {
    if (!access.canEditAgent) return { success: false, error: "Forbidden" }
    scopeId = access.agentScopeId
  } else if (scopeType === "team") {
    if (!access.canEditTeam) return { success: false, error: "Forbidden" }
    if (!scopeId || !access.teamScopeIds.includes(scopeId)) {
      return { success: false, error: "Forbidden — team not in your scope" }
    }
  } else if (scopeType === "brokerage") {
    if (!access.canEditBrokerage) return { success: false, error: "Forbidden" }
    scopeId = access.brokerageScopeId
  }
  if (!scopeId) return { success: false, error: "Could not resolve scope id" }

  const svc = createServiceClient()
  // 102D — a cadence row is tenant operating policy: the row it replaces is the version's `previous`.
  const { data: before, error: beforeErr } = await svc.from("blog_cadence_policy")
    .select("cadence, fire_day, preferred_categories, preferred_persona").eq("scope_type", scopeType).eq("scope_id", scopeId).maybeSingle()
  if (beforeErr) return { success: false, error: `Current cadence could not be read: ${beforeErr.message}` }
  const row = {
    scope_type:           scopeType,
    scope_id:             scopeId,
    cadence:              input.cadence,
    fire_day:             input.fireDay,
    preferred_categories: input.preferredCategories,
    preferred_persona:    input.preferredPersona,
    updated_at:           new Date().toISOString(),
    updated_by:           ctx.userId,
  }
  const { error } = await svc.from("blog_cadence_policy").upsert(row, { onConflict: "scope_type,scope_id" })
  if (error) return { success: false, error: error.message }
  const { appendTenantPolicyVersion, cadencePolicyKey, cadencePolicyValue } = await import("@/lib/kernel/tenant-policy")
  const v = await appendTenantPolicyVersion(svc, {
    brokerageId: ctx.brokerageId, policyKey: cadencePolicyKey("blog_cadence_policy", scopeType, scopeId),
    value: cadencePolicyValue(row), previous: cadencePolicyValue(before as Record<string, unknown> | null),
    actor: { type: "user", userId: ctx.userId, reason: "blog cadence saved" },
  })
  if (!v.ok) console.error(`[blog-cadence-policy] policy version not recorded: ${v.error}`)
  revalidatePath("/settings/blog-cadence")
  return { success: true }
}
