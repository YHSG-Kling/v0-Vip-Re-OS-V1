"use server"

/**
 * app/actions/admin/tenant-readiness.ts — the TENANT-ADMIN door of the tenant readiness contract
 * (wave 140, lanes 140B+K; lib/kernel/tenant-readiness.ts evaluateTenantReadiness).
 *
 * Tenant from the SESSION only (requireCallerTenant — no argument names a brokerage), tenant-admin only
 * (TENANT_ADMIN_USER_TYPES via isTenantAdminGrantRole), gate first, then the service client (CLAUDE.md §4).
 *   getMyTenantReadiness()     the structured report (every check, its owner, evidence, blockers)
 *   repairMyTenantReadiness()  the same report after each REPAIRABLE check ran its DECLARED playbook through
 *                              the self-healing engine (policy-bounded, absent defaults only) and re-verified
 * Nothing here evaluates or repairs anything itself; the contract does.
 */

import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateTenantReadiness, type TenantReadinessReport } from "@/lib/kernel/tenant-readiness"

type Gate = { ok: true; brokerageId: string } | { ok: false; error: string }

async function requireReadinessAdmin(): Promise<Gate> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isTenantAdminGrantRole(caller.userType)) return { ok: false, error: "Only a broker, owner, admin, team lead or compliance officer can see the workspace readiness report." }
  return { ok: true, brokerageId: caller.brokerageId }
}

export async function getMyTenantReadiness(): Promise<{ ok: true; report: TenantReadinessReport } | { ok: false; error: string }> {
  const gate = await requireReadinessAdmin()
  if (!gate.ok) return gate
  return { ok: true, report: await evaluateTenantReadiness(createServiceClient(), gate.brokerageId) }
}

export async function repairMyTenantReadiness(): Promise<{ ok: true; report: TenantReadinessReport } | { ok: false; error: string }> {
  const gate = await requireReadinessAdmin()
  if (!gate.ok) return gate
  return { ok: true, report: await evaluateTenantReadiness(createServiceClient(), gate.brokerageId, { repair: true }) }
}
