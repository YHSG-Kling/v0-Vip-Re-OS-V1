"use server"

/**
 * app/actions/admin/tenant-policy.ts — the tenant-admin surface of the VERSIONED TENANT OPERATING
 * CONSTITUTION (wave 101, lane 101A; m696; gap map rows 21/22).
 *
 * Three doors, all tenant-admin only (TENANT_ADMIN_USER_TYPES via isTenantAdminGrantRole), tenant
 * from the SESSION (requireCallerTenant — no argument names a brokerage), gate first, then the
 * service client (CLAUDE.md §4):
 *   getTenantOperatingConstitution()   every policy key's live value + version / changer / date
 *   policyHistory(policyKey)           that key's immutable versions, newest first
 *   revertPolicy(policyKey, version)   re-apply version N's value THROUGH THE KEY'S SURVIVOR WRITER,
 *                                      which appends a NEW version (history is never rewritten)
 * The derivations live in lib/kernel/tenant-policy.ts; nothing here writes a policy value itself.
 */

import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import {
  buildTenantOperatingConstitution,
  loadPolicyHistory,
  parsePolicyKey,
  samePolicyValue,
  type ConstitutionResult,
  type PolicyHistoryResult,
  type PolicyActor,
} from "@/lib/kernel/tenant-policy"
import type { AIISASettings } from "@/lib/ai-isa/settings-types"

type AdminGate = { ok: true; brokerageId: string; userId: string } | { ok: false; error: string }

async function requirePolicyAdmin(): Promise<AdminGate> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isTenantAdminGrantRole(caller.userType)) {
    return { ok: false, error: "Only a broker, owner, admin, team lead or compliance officer can see or revert operating policy." }
  }
  return { ok: true, brokerageId: caller.brokerageId, userId: caller.userId }
}

export async function getTenantOperatingConstitution(): Promise<ConstitutionResult> {
  const gate = await requirePolicyAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  return buildTenantOperatingConstitution(createServiceClient(), gate.brokerageId)
}

export async function policyHistory(policyKey: string): Promise<PolicyHistoryResult> {
  const gate = await requirePolicyAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  return loadPolicyHistory(createServiceClient(), gate.brokerageId, String(policyKey ?? ""))
}

export async function revertPolicy(
  policyKey: string,
  version: number,
): Promise<{ ok: true; newVersion: number | null; unchanged?: true } | { ok: false; error: string }> {
  const gate = await requirePolicyAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const parsed = parsePolicyKey(String(policyKey ?? ""))
  if (!parsed) return { ok: false, error: "Unknown policy key." }
  if (!Number.isInteger(version) || version < 1) return { ok: false, error: "Pick a version to revert to." }

  const svc = createServiceClient()
  // The target is read IN THIS TENANT ONLY — another tenant's version id/number is simply absent.
  const { data: target, error: readErr } = await svc
    .from("tenant_policy_versions")
    .select("value, version")
    .eq("brokerage_id", gate.brokerageId)
    .eq("policy_key", policyKey)
    .eq("version", version)
    .maybeSingle()
  if (readErr) return { ok: false, error: `Policy history could not be read: ${readErr.message}` }
  if (!target) return { ok: false, error: `Version ${version} of ${policyKey} does not exist for this brokerage.` }

  const value = (target as { value: unknown }).value
  // Already the latest version's value → nothing to re-apply (every policy writer is versioned,
  // so the latest version IS the live value; the survivor writer would append nothing anyway).
  const before = await loadPolicyHistory(svc, gate.brokerageId, policyKey)
  if (!before.ok) return { ok: false, error: before.error }
  if (before.rows[0] && samePolicyValue(before.rows[0].value, value)) {
    return { ok: true, newVersion: before.rows[0].version, unchanged: true }
  }
  const reason = `revert ${policyKey} to v${version}`
  const actor: PolicyActor = { type: "user", userId: gate.userId, reason }

  let wrote: { ok: boolean; error?: string }
  switch (parsed.kind) {
    case "settings": {
      const { mergeBrokerageSettings } = await import("@/lib/settings/brokerage-settings-merge")
      const w = await mergeBrokerageSettings(svc, gate.brokerageId, { [parsed.key]: value === null ? undefined : value }, { policy: actor })
      wrote = w.ok ? { ok: true } : { ok: false, error: w.error }
      break
    }
    case "column": {
      if (parsed.key === "default_assignment_method") {
        const { setDefaultAssignmentMethod } = await import("@/app/actions/admin/lead-routing-settings")
        const w = await setDefaultAssignmentMethod(String(value ?? "load_balance"), reason)
        wrote = { ok: w.success, error: w.error }
      } else if (parsed.key === "farm_mail") {
        // 102D — through the survivor writer (its own validation + scope gate + version append).
        const { saveFarmMailConfig } = await import("@/app/actions/direct-mail-settings")
        const fm = (value ?? {}) as { farm_mail_enabled?: boolean; farm_mail_max_per_week?: number | null; lob_fallback_template_id?: string | null }
        const w = await saveFarmMailConfig({ farm_mail_enabled: fm.farm_mail_enabled === true, farm_mail_max_per_week: fm.farm_mail_max_per_week ?? null, lob_fallback_template_id: fm.lob_fallback_template_id ?? null })
        wrote = { ok: w.success, error: w.error }
      } else {
        const cols = await import("@/lib/settings/brokerage-settings-columns")
        const w = parsed.key === "review_request_delay_days"
          ? await cols.saveReviewRequestDelayDays(svc, gate.brokerageId, (value as number | null) ?? null, actor)
          : await cols.saveLiveFaceProviderOrder(svc, gate.brokerageId, value ?? ["did", "simli"], actor)
        wrote = w.ok ? { ok: true } : { ok: false, error: w.error }
      }
      break
    }
    case "manager": {
      const evals = await import("@/app/actions/admin/manager-evals")
      const w = parsed.field === "authority_level"
        ? await evals.setManagerAuthorityLevel(parsed.agentKind, (value ?? null) as Parameters<typeof evals.setManagerAuthorityLevel>[1], reason)
        : await evals.setManagerAutonomy(parsed.agentKind, (value ?? null) as Parameters<typeof evals.setManagerAutonomy>[1], reason)
      wrote = w.ok ? { ok: true } : { ok: false, error: w.error }
      break
    }
    case "isa": {
      const { writeIsaSettings } = await import("@/lib/ai-isa/resolve-isa-settings")
      const { DEFAULT_AISA_SETTINGS } = await import("@/lib/ai-isa/settings-types")
      const ownerId = parsed.ownerType === "brokerage" ? gate.brokerageId : parsed.ownerId
      const w = await writeIsaSettings({
        owner: { ownerType: parsed.ownerType, ownerId },
        brokerageId: gate.brokerageId,
        updates: (value ?? DEFAULT_AISA_SETTINGS) as Partial<AIISASettings>,
        actor,
      })
      wrote = { ok: w.success, error: w.error }
      break
    }
    // 102D — row policies revert through their own server actions (session tenant, admin gate, version append).
    case "rule": {
      const rules = await import("@/app/actions/admin/assignment-rules")
      if (value === null) {
        const w = await rules.deleteAssignmentRuleAction(parsed.ruleId)
        wrote = w.ok ? { ok: true } : { ok: false, error: w.error }
      } else {
        const r = value as { name?: string; rule_type?: string; conditions?: Record<string, unknown>; agent_ids?: string[]; team_id?: string | null; priority?: number; is_active?: boolean }
        const w = await rules.saveAssignmentRuleAction({
          id: parsed.ruleId, name: String(r.name ?? ""), ruleType: String(r.rule_type ?? ""), conditions: r.conditions ?? {},
          agentIds: Array.isArray(r.agent_ids) ? r.agent_ids : [], teamId: r.team_id ?? null, priority: Number(r.priority ?? 10), isActive: r.is_active !== false,
        })
        // A rule deleted since cannot be restored under its old id (the key names that id): refused, said.
        wrote = w.ok ? { ok: true } : { ok: false, error: /not found/i.test(w.error) ? `Rule ${parsed.ruleId} no longer exists — a deleted rule cannot be restored under its old id; create it again.` : w.error }
      }
      break
    }
    case "cadence": {
      const c = (value ?? {}) as { cadence?: string; fire_day?: number | null; preferred_categories?: string[] | null; preferred_persona?: string | null; preferred_post_types?: string[] | null }
      const cadence = (c.cadence ?? "off") as "weekly" | "biweekly" | "monthly" | "off"
      if (parsed.table === "blog_cadence_policy") {
        const { upsertBlogCadencePolicy } = await import("@/app/actions/blog-cadence-policy")
        const w = await upsertBlogCadencePolicy({ cadence, fireDay: c.fire_day ?? null, preferredCategories: c.preferred_categories ?? null, preferredPersona: c.preferred_persona ?? null, scopeType: parsed.scopeType, scopeId: parsed.scopeId })
        wrote = { ok: w.success, error: w.error }
      } else {
        const { upsertMarketingCadencePolicy } = await import("@/app/actions/marketing-cadence-policy")
        const w = await upsertMarketingCadencePolicy({
          channel: parsed.table === "social_cadence_policy" ? "social" : "newsletter", cadence, fireDay: c.fire_day ?? null,
          preferredCategories: c.preferred_categories ?? null, preferredPersona: c.preferred_persona ?? null, preferredPostTypes: c.preferred_post_types ?? null,
          scopeType: parsed.scopeType, scopeId: parsed.scopeId,
        })
        wrote = { ok: w.success, error: w.error }
      }
      break
    }
  }
  if (!wrote.ok) return { ok: false, error: wrote.error ?? "The revert was not saved." }

  const after = await loadPolicyHistory(svc, gate.brokerageId, policyKey)
  revalidatePath("/dashboard/admin/manager-trust")
  if (!after.ok) return { ok: true, newVersion: null }
  const top = after.rows[0]
  // The survivor writer appends nothing when the live value already equals the target.
  if (!top || top.reason !== reason) return { ok: true, newVersion: top?.version ?? null, unchanged: true }
  return { ok: true, newVersion: top.version }
}
