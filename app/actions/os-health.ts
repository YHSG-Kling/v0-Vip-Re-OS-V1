"use server"

/**
 * app/actions/os-health.ts — the command center's OS HEALTH LINE and the ONE release path for a
 * financial-writer halt (wave 108, lane 108C). The supervisor itself (lib/kernel/os-health.ts) runs on
 * the cron; these two doors are the human side of it.
 *
 * Tenant from the SESSION only (requireCallerTenant — no tenant argument at all). Gate first, then the
 * service client (CLAUDE.md §4). Every export here is a public endpoint and async.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { resolveTenantAdmin, resolveBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { loadOsHealthLine, releaseFinancialWriterHalt, FINANCIAL_WRITERS, type FinancialWriterKey, type OsHealthLine } from "@/lib/kernel/os-health"

/** The one-line OS health for the caller's brokerage (tenant-admin roster). */
export async function getOsHealthLine(): Promise<{ success: true; health: OsHealthLine } | { success: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { success: false, error: caller.error }
  const admin = await resolveTenantAdmin(caller.supabase, caller.userId, { user_type: caller.userType, brokerage_id: caller.brokerageId })
  if (!admin.ok) return { success: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin) return { success: false, error: "Only a broker or a brokerage admin can read the OS health line." }
  return { success: true, health: await loadOsHealthLine(createServiceClient(), caller.brokerageId) }
}

/**
 * WAVE 139 (139F) — the tenant's OWN healing incidents (the healing console, tenant-scoped) + the effective
 * self-healing policy (the tenant's `self_healing` key under the platform ceiling). Tenant-admin roster; the
 * tenant is the SESSION's (tenantScope — a missing id refuses, never widens to every tenant).
 */
export async function getMyHealingIncidentsAction(): Promise<
  | { success: true; incidents: import("@/lib/kernel/self-heal-ledger").HealingIncident[]; windowDays: number; policy: import("@/lib/kernel/healing-policy").HealingPolicy }
  | { success: false; error: string }
> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { success: false, error: caller.error }
  const admin = await resolveTenantAdmin(caller.supabase, caller.userId, { user_type: caller.userType, brokerage_id: caller.brokerageId })
  if (!admin.ok) return { success: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin) return { success: false, error: "Only a broker or a brokerage admin can read the healing incidents." }
  const svc = createServiceClient()
  const { loadHealingIncidents } = await import("@/lib/kernel/self-heal-ledger")
  const { tenantScope } = await import("@/lib/kernel/tenant-scope")
  const { loadHealingPolicy } = await import("@/lib/kernel/healing-policy")
  const [inc, policy] = await Promise.all([
    loadHealingIncidents(svc, tenantScope(caller.brokerageId, "getMyHealingIncidentsAction")),
    loadHealingPolicy(svc, caller.brokerageId),
  ])
  if (!inc.ok) return { success: false, error: inc.error }
  return { success: true, incidents: inc.incidents, windowDays: inc.windowDays, policy }
}

/**
 * Release a financial writer the OS health supervisor HALTED. Finance-admin only (the brokerage's
 * books — BROKERAGE_FINANCE_ADMIN_USER_TYPES via resolveBrokerageFinanceAdmin), a reason is REQUIRED,
 * and the release is a versioned tenant-policy change attributed to the session user (LAW 5).
 */
export async function releaseFinancialWriterHaltAction(input: { writer: string; reason: string }): Promise<{ success: true } | { success: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { success: false, error: caller.error }
  const fin = await resolveBrokerageFinanceAdmin(caller.supabase, caller.userId, { user_type: caller.userType, brokerage_id: caller.brokerageId })
  if (!fin.ok) return { success: false, error: `Could not resolve your permissions: ${fin.error}` }
  if (!fin.isFinanceAdmin) return { success: false, error: "Only a brokerage finance admin can release a halted financial writer." }
  const writer = String(input?.writer ?? "") as FinancialWriterKey
  if (!(writer in FINANCIAL_WRITERS)) return { success: false, error: "Unknown financial writer." }
  const reason = String(input?.reason ?? "").trim()
  if (reason.length < 5) return { success: false, error: "Say why the discrepancy is resolved — a release needs a reason." }
  const r = await releaseFinancialWriterHalt(createServiceClient(), { brokerageId: caller.brokerageId, writer, userId: caller.userId, reason })
  return r.ok ? { success: true } : { success: false, error: r.error }
}
