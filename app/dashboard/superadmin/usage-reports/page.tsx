import { redirect } from "next/navigation"
import Link from "next/link"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

// PER-SUBSCRIBER USAGE REPORT — the spec's "usage reports for each subscriber
// of all tiers" in ONE table (audit drift #9: AI-Ops shows cross-tenant AI
// cost and the tenant detail shows margin, but no all-tier usage report
// existed). PLATFORM-GLOBAL READS by design: this is the staff oversight
// surface, service-client + platform capability gate (the tenant-scope
// guard's verified platform-global convention). Gate: 'tenants' — every
// staff role oversees subscribers.
//
// Scale note: per-tenant head counts fan out N queries; fine for the current
// subscriber count (cron sweeps cap at 500). When the fleet outgrows this,
// fold the counts into the nightly meter rollup instead.

const CORE_TABLES = ["contacts", "listings", "transactions"] as const

export default async function UsageReportsPage() {
  const gate = await requirePlatformCapability("tenants")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform tenants capability</div>

  const svc = createServiceClient()
  const { data: tenants, error } = await svc
    .from("brokerages")
    .select("id, name, plan_tier, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(200)
  if (error) return <div className="p-6 text-red-600">Failed to load subscribers: {error.message}</div>

  // Current-month media/usage counters (one query, grouped client-side).
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
  const { data: counters } = await svc
    .from("usage_counters")
    .select("brokerage_id, metric, value")
    .eq("period_start", monthStart)
  const countersByTenant = new Map<string, Record<string, number>>()
  for (const c of counters ?? []) {
    const m = countersByTenant.get(c.brokerage_id) ?? {}
    m[c.metric] = Number(c.value ?? 0)
    countersByTenant.set(c.brokerage_id, m)
  }

  // Core-object head counts per tenant.
  const rows = await Promise.all(
    (tenants ?? []).map(async (t) => {
      const counts: Record<string, number> = {}
      await Promise.all(
        CORE_TABLES.map(async (tbl) => {
          const { count } = await svc
            .from(tbl)
            .select("id", { count: "exact", head: true })
            .eq("brokerage_id", t.id)
          counts[tbl] = count ?? 0
        })
      )
      const { count: userCount } = await svc
        .from("users")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", t.id)
      return { tenant: t, counts, userCount: userCount ?? 0, usage: countersByTenant.get(t.id) ?? {} }
    })
  )

  const fmtMetric = (v: number | undefined) => (v == null || v === 0 ? "—" : v.toLocaleString())

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Usage reports — every subscriber, every tier</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Seats, book-of-business size, and this month's metered usage per tenant. AI spend and
            margin live in AI&nbsp;Ops and the tenant detail; this is the volume picture.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/home" className="rounded-md border px-3 py-1 text-sm">Home</Link>
          <Link href="/dashboard/superadmin/ai-ops" className="rounded-md border px-3 py-1 text-sm">AI Ops (spend)</Link>
          <Link href="/dashboard/superadmin/subscriptions" className="rounded-md border px-3 py-1 text-sm">Subscriptions</Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border p-6 text-sm text-muted-foreground">No subscribers yet.</div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="p-2">Subscriber</th>
                <th className="p-2">Tier</th>
                <th className="p-2">Status</th>
                <th className="p-2 text-right">Users</th>
                <th className="p-2 text-right">Contacts</th>
                <th className="p-2 text-right">Listings</th>
                <th className="p-2 text-right">Transactions</th>
                <th className="p-2 text-right">Avatar min (mo)</th>
                <th className="p-2 text-right">Avatar sessions (mo)</th>
                <th className="p-2 text-right">TTS chars (mo)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ tenant, counts, userCount, usage }) => (
                <tr key={tenant.id} className="border-b last:border-0">
                  <td className="p-2">
                    <Link href={`/dashboard/superadmin/brokerages/${tenant.id}`} className="font-medium text-indigo-600 hover:underline">
                      {tenant.name ?? tenant.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="p-2"><Badge variant="outline" className="text-xs">{tenant.plan_tier}</Badge></td>
                  <td className="p-2 text-xs">{tenant.status}</td>
                  <td className="p-2 text-right">{userCount}</td>
                  <td className="p-2 text-right">{counts.contacts.toLocaleString()}</td>
                  <td className="p-2 text-right">{counts.listings.toLocaleString()}</td>
                  <td className="p-2 text-right">{counts.transactions.toLocaleString()}</td>
                  <td className="p-2 text-right">{fmtMetric(usage.live_avatar_minutes)}</td>
                  <td className="p-2 text-right">{fmtMetric(usage.live_avatar_sessions)}</td>
                  <td className="p-2 text-right">{fmtMetric(usage.tts_characters)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
