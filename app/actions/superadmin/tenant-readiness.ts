"use server"

/**
 * app/actions/superadmin/tenant-readiness.ts — the PLATFORM-STAFF door of the tenant readiness contract
 * (wave 140, lanes 140B+K; lib/kernel/tenant-readiness.ts evaluateTenantReadiness).
 *
 * Reading a named tenant's readiness is the same intent as the sibling tenant-setup door (a staffer works a
 * tenant's posture on their behalf): requirePlatformCapability("support") — the platform ROSTER, never a
 * tenant user_type. REPAIRING writes rows on the tenant, so that door is superadmin-only (requireSuperadmin);
 * every repair still runs under the tenant's healing policy and leaves its self_heal_events / ledger evidence.
 */

import { requirePlatformCapability, requireSuperadmin } from "@/lib/auth/platform-guard"
import { createServiceClient } from "@/lib/supabase/service"
import { evaluateTenantReadiness, type TenantReadinessReport } from "@/lib/kernel/tenant-readiness"

export async function getTenantReadinessAction(brokerageId: string): Promise<{ ok: true; report: TenantReadinessReport } | { ok: false; error: string }> {
  const gate = await requirePlatformCapability("support")
  if (!gate.ok) return { ok: false, error: gate.error }
  return { ok: true, report: await evaluateTenantReadiness(createServiceClient(), String(brokerageId ?? "")) }
}

export async function repairTenantReadinessAction(brokerageId: string): Promise<{ ok: true; report: TenantReadinessReport } | { ok: false; error: string }> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  return { ok: true, report: await evaluateTenantReadiness(createServiceClient(), String(brokerageId ?? ""), { repair: true }) }
}
