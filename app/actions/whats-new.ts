"use server"

// app/actions/whats-new.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT-FACING PLATFORM STATUS — the read side of /dashboard/whats-new.
// Composes three EXISTING truths (no new tables):
//   · platform_settings.status_notice — the superadmin incident broadcast
//     (lib/platform/status-notice.ts; fails soft to "no notice");
//   · the platform halt (emergency mode / AI engine off) — if every tenant's
//     autonomous managers are frozen, tenants deserve to see that stated;
//   · the tenant's OWN service_status rows (written by the health-check cron)
//     — per-service detail for admin/broker principals, overall rollup only
//     for everyone else (service internals are an operator concern).

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { loadStatusNotice, type StatusNotice } from "@/lib/platform/status-notice"
import { getPlatformControls, resolvePlatformHalt } from "@/lib/platform/platform-controls"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export interface TenantServiceRow {
  serviceName: string
  category: string | null
  status: string
  isCritical: boolean
  lastCheckedAt: string | null
}

export interface TenantPlatformStatus {
  notice: StatusNotice
  /** Non-null ⇒ autonomous AI is frozen platform-wide (the honest banner). */
  haltReason: string | null
  overallStatus: "operational" | "degraded" | "critical" | "unknown"
  lastCheckedAt: string | null
  /** Per-service rows — populated for admin/broker principals only. */
  services: TenantServiceRow[]
  canSeeServices: boolean
}

export async function getTenantPlatformStatusAction(): Promise<
  | { ok: true; status: TenantPlatformStatus }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: u } = await supabase.from("users").select("user_type, brokerage_id").eq("id", user.id).maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  const canSeeServices = isAdminOrBroker({ user_type: (u as any).user_type ?? "" })

  const svc = createServiceClient()
  const [notice, controls, servicesRes] = await Promise.all([
    loadStatusNotice(svc),
    getPlatformControls(svc).catch(() => null),
    svc
      .from("service_status")
      .select("service_name, service_category, current_status, is_critical, last_checked_at")
      .eq("brokerage_id", u.brokerage_id)
      .order("is_critical", { ascending: false })
      .order("service_name"),
  ])

  const halt = controls ? resolvePlatformHalt(controls) : { halted: false, reason: null }

  const rows = ((servicesRes.data ?? []) as any[]).map((s): TenantServiceRow => ({
    serviceName: s.service_name ?? "(unnamed service)",
    category: s.service_category ?? null,
    status: s.current_status ?? "unknown",
    isCritical: s.is_critical === true,
    lastCheckedAt: s.last_checked_at ?? null,
  }))

  let overallStatus: TenantPlatformStatus["overallStatus"] = "unknown"
  if (rows.length > 0) {
    const criticalDown = rows.some((r) => r.isCritical && r.status === "down")
    const anyBad = rows.some((r) => r.status === "down" || r.status === "degraded")
    overallStatus = criticalDown ? "critical" : anyBad ? "degraded" : "operational"
  }
  const lastCheckedAt = rows.reduce<string | null>(
    (latest, r) => (r.lastCheckedAt && (!latest || r.lastCheckedAt > latest) ? r.lastCheckedAt : latest),
    null,
  )

  return {
    ok: true,
    status: {
      notice,
      haltReason: halt.halted ? halt.reason : null,
      overallStatus,
      lastCheckedAt,
      services: canSeeServices ? rows : [],
      canSeeServices,
    },
  }
}
