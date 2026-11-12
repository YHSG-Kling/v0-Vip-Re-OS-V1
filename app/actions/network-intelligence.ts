"use server"

// app/actions/network-intelligence.ts — the tenant's door to PRIVACY-SAFE NETWORK BENCHMARKS (wave 107, lane 107F).
// Every export is a public endpoint (CLAUDE.md §4): the tenant comes from the SESSION (requireCallerTenant), never
// an argument; the tenant-admin roster gates both (resolveTenantAdmin → TENANT_ADMIN_USER_TYPES); the service
// client is used only after the gate. Reads return this tenant's own numbers beside the k-anonymous network cells.

import { createServiceClient } from "@/lib/supabase/service"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import { NETWORK_BENCHMARK_POLICY, benchmarksBeside, readNetworkOptIn, type BenchmarkBesideRow } from "@/lib/intelligence/network-benchmarks"

async function gateTenantAdmin(): Promise<{ ok: true; brokerageId: string; userId: string } | { ok: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  const admin = await resolveTenantAdmin(caller.supabase, caller.userId, { user_type: caller.userType, brokerage_id: caller.brokerageId })
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions: ${admin.error}` }
  if (!admin.isTenantAdmin) return { ok: false, error: "Only a broker or a brokerage admin can view or change network benchmarks." }
  return { ok: true, brokerageId: caller.brokerageId, userId: caller.userId }
}

export async function getNetworkBenchmarksBeside(): Promise<
  | { ok: true; rows: BenchmarkBesideRow[]; periodEnd: string | null; marketBand: string; optedIn: boolean; minTenants: number; minEvents: number; ownErrors: string[] }
  | { ok: false; error: string }
> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) return gate
  const svc = createServiceClient()
  const [view, optedIn] = await Promise.all([benchmarksBeside(svc, gate.brokerageId), readNetworkOptIn(svc, gate.brokerageId)])
  if (!view.ok) return view
  return { ...view, optedIn, minTenants: NETWORK_BENCHMARK_POLICY.minTenants, minEvents: NETWORK_BENCHMARK_POLICY.minEvents }
}

/** The contractual opt-in (versioned tenant policy key network_benchmarks_opt_in). Default is OFF. */
export async function setNetworkBenchmarksOptIn(input: { optIn: boolean }): Promise<{ ok: true; version: number | null } | { ok: false; error: string }> {
  const gate = await gateTenantAdmin()
  if (!gate.ok) return gate
  const optIn = input?.optIn === true
  const write = await mergeBrokerageSettings(createServiceClient(), gate.brokerageId, () => ({
    network_benchmarks_opt_in: { opted_in: optIn, set_by: gate.userId, set_at: new Date().toISOString() },
  }), { policy: { type: "user", userId: gate.userId, reason: `network benchmarks ${optIn ? "opted in" : "opted out"}` } })
  if (!write.ok) return { ok: false, error: write.error }
  const v = write.policyVersions.find((p) => p.key === "network_benchmarks_opt_in")
  return { ok: true, version: v?.version ?? null }
}
