"use server"
/**
 * app/actions/admin/brokerage-intelligence-doors.ts — the SERVER doors two admin pages
 * were missing (lane 88F, census round 33: hidden wires).
 *
 * app/dashboard/admin/farm-intelligence/page.tsx and
 * app/dashboard/admin/provider-intelligence/page.tsx are "use client" pages that
 * value-imported lib/territory/metrics-aggregator.ts and lib/analytics/vendor-roi.ts —
 * modules that build the SERVICE-ROLE client — and called them with a brokerageId the
 * browser read for itself. Two defects in one shape: service-role code in a browser
 * bundle (where the key does not exist, so the calls could only throw), and a tenant
 * taken from the client (CLAUDE.md §4 — the IDOR shape). scripts/client-server-only-guard.ts
 * could not see it because neither module carries `import "server-only"`; it now treats a
 * service-client builder the same way.
 *
 * Every export here is a public endpoint (§4): gate first — the SESSION user, resolved to
 * the brokerage they administer by lib/auth/require-brokerage-admin.ts — then the kernel
 * function with THAT brokerage id. No parameter names a tenant.
 */
import { createClient } from "@/lib/supabase/server"
import { requireBrokerageAdmin } from "@/lib/auth/require-brokerage-admin"
import type { DateRange, VendorRoiResult } from "@/lib/analytics/vendor-roi"

type Gate = { ok: true; brokerageId: string } | { ok: false; error: string }

async function sessionBrokerageAdmin(): Promise<Gate> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  try {
    const ctx = await requireBrokerageAdmin(supabase, user.id)
    return { ok: true, brokerageId: ctx.brokerageId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Forbidden" }
  }
}

/** Farm territories: seed from the brokerage's service area (upsert by name — no duplicates). */
export async function seedFarmTerritoriesFromServiceAreaAction(): Promise<
  { ok: true; seeded: number; skipped: number } | { ok: false; error: string }
> {
  const gate = await sessionBrokerageAdmin()
  if (!gate.ok) return gate
  const { seedTerritoriesFromServiceArea } = await import("@/lib/territory/metrics-aggregator")
  try {
    const r = await seedTerritoriesFromServiceArea(gate.brokerageId)
    return { ok: true, ...r }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Farm territories: record whether they follow the settings service area or are custom. */
export async function setFarmTerritoryModeAction(
  mode: "use_settings" | "custom",
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (mode !== "use_settings" && mode !== "custom") return { ok: false, error: "Unknown farm territory mode" }
  const gate = await sessionBrokerageAdmin()
  if (!gate.ok) return gate
  const { setFarmTerritoryMode } = await import("@/lib/territory/metrics-aggregator")
  try {
    await setFarmTerritoryMode(gate.brokerageId, mode)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Provider ROI for the caller's brokerage over a 30/60/90-day window. */
export async function getProviderRoiMetricsAction(
  dateRangeDays: DateRange,
): Promise<{ ok: true; result: VendorRoiResult } | { ok: false; error: string }> {
  if (!["30", "60", "90"].includes(dateRangeDays)) return { ok: false, error: "Unknown date range" }
  const gate = await sessionBrokerageAdmin()
  if (!gate.ok) return gate
  const { getProviderRoiMetrics } = await import("@/lib/analytics/vendor-roi")
  try {
    return { ok: true, result: await getProviderRoiMetrics({ brokerageId: gate.brokerageId, dateRangeDays }) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
