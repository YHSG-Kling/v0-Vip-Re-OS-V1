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
