import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { OsSentinelBoard } from "./os-sentinel-board"
import { SentinelActionQueue } from "./sentinel-action-queue"

export const dynamic = "force-dynamic"

// The platform-rail manager-bus signal types that are FEED-ONLY (no consumer
// picks them up — they exist so a human sees them). Without this panel they
// only live in each tenant's own feed and scroll away unseen by staff.
const PLATFORM_RAIL_SIGNAL_TYPES = [
  "webhook_endpoint_dead",
  "affiliate_commission_accrued",
  "custom_domain_verified",
  "custom_domain_error",
] as const

const SIGNAL_BADGE: Record<string, string> = {
  webhook_endpoint_dead: "bg-red-100 text-red-800",
  custom_domain_error: "bg-red-100 text-red-800",
  custom_domain_verified: "bg-emerald-100 text-emerald-800",
  affiliate_commission_accrued: "bg-blue-100 text-blue-800",
}

function fmtAge(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

/** Read-only cross-tenant view of the platform-rail bus signals (manager_signals). */
async function PlatformRailSignals() {
  const svc = createServiceClient()
  const { data: signals, error } = await svc
    .from("manager_signals")
    .select("id, brokerage_id, signal_type, message, status, created_at")
    .in("signal_type", PLATFORM_RAIL_SIGNAL_TYPES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(30)
  if (error) {
    return <p className="text-sm text-red-600">Failed to load platform-rail signals: {error.message}</p>
  }
  const rows = (signals ?? []) as Array<{ id: string; brokerage_id: string | null; signal_type: string; message: string | null; status: string | null; created_at: string | null }>

  const brokerageIds = [...new Set(rows.map((r) => r.brokerage_id).filter(Boolean))] as string[]
  const nameById = new Map<string, string>()
  if (brokerageIds.length > 0) {
    const { data: brks } = await svc.from("brokerages").select("id, name").in("id", brokerageIds)
    for (const b of (brks ?? []) as Array<{ id: string; name: string | null }>) nameById.set(b.id, b.name ?? "(unnamed)")
  }

  return rows.length === 0 ? (
    <p className="text-sm text-muted-foreground">No platform-rail signals yet — dead webhook endpoints, affiliate accruals, and custom-domain outcomes will land here.</p>
  ) : (
    <ul className="space-y-1.5">
      {rows.map((s) => (
        <li key={s.id} className="flex items-center gap-2 text-sm">
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${SIGNAL_BADGE[s.signal_type] ?? "bg-slate-100 text-slate-700"}`}>
            {s.signal_type}
          </span>
          <span className="shrink-0 text-xs font-medium">
            {s.brokerage_id ? (nameById.get(s.brokerage_id) ?? "(unknown tenant)") : "(platform)"}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={s.message ?? undefined}>{s.message ?? ""}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums" title={s.created_at ?? undefined}>{fmtAge(s.created_at)}</span>
        </li>
      ))}
    </ul>
  )
}

// Platform-staff "state of the whole agentic OS" board + the Platform Sentinel
// Manager's proposed-action queue (daily fleet watch → drafted outreach that
// staff approve or dismiss — app/api/cron/platform-sentinel fills it).
export default async function OsSentinelPage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) redirect("/dashboard")

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">OS Sentinel</h1>
        <p className="text-muted-foreground text-sm">One view of the whole agentic OS — every subsystem, the top open incidents, and the self-healing that keeps it running. Below it: the sentinel&apos;s daily proposed actions for the subscriber fleet, drafted and waiting on your approval.</p>
      </div>
      <SentinelActionQueue />
      {/* Platform-rail bus signals — feed-only manager_signals staff must see */}
      <section className="rounded-lg border p-4 space-y-3">
        <div>
          <h2 className="text-base font-semibold">Platform-rail signals</h2>
          <p className="text-xs text-muted-foreground">
            Cross-tenant, read-only view of the feed-only bus signals on the platform rail — dead webhook
            endpoints, affiliate commission accruals, and custom-domain verify/error outcomes — so they can&apos;t
            scroll away unseen in a tenant feed.
          </p>
        </div>
        <PlatformRailSignals />
      </section>
      <OsSentinelBoard />
    </div>
  )
}
