import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { canonicalProvider } from "@/lib/integrations/connection-manager"
import {
  deriveConnectivityStatus,
  needsAttention,
  transportFor,
  type ConnectivityStatus,
} from "@/lib/agentic-os/connectivity-agent"

export const dynamic = "force-dynamic"

// ALL-TENANT CONNECTION HEALTH — every tenant × the integrations THEY actually
// connected, in one board. PLATFORM-GLOBAL READ by design (sentinel-gated,
// service client — see app/dashboard/superadmin/a2p/page.tsx header for the
// convention): the three credential stores the app grew are read WITHOUT a
// brokerage filter and grouped per tenant here, with the SAME precedence and
// the SAME pure status derivation the tenant-side panels use
// (lib/agentic-os/connectivity-agent + canonicalProvider) — so this board and
// a tenant's own connection-health card can never disagree about a connector.
// Platform-owned vendors (platform holds the key) are deliberately absent:
// they're the connectors page's job. Statuses come only from live credential
// rows (active flag + OAuth expiry) — nothing probed, nothing assumed.

interface CredEntry {
  isActive: boolean
  tokenExpiresAt: string | null
  source: "agent" | "platform" | "integration"
}

const STATUS_META: Record<ConnectivityStatus, { label: string; cls: string }> = {
  connected: { label: "connected", cls: "bg-emerald-100 text-emerald-800" },
  expiring_soon: { label: "expiring soon", cls: "bg-amber-100 text-amber-800" },
  expired: { label: "expired", cls: "bg-red-100 text-red-800" },
  disconnected: { label: "inactive", cls: "bg-slate-100 text-slate-600" },
  platform_managed: { label: "platform", cls: "bg-slate-100 text-slate-600" },
}

export default async function AllTenantConnectionHealthPage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform sentinel capability</div>

  const svc = createServiceClient()
  const now = new Date()

  const [brk, agentCreds, platCreds, intCreds] = await Promise.all([
    svc.from("brokerages").select("id, name, plan_tier").is("deleted_at", null).order("name"),
    svc.from("agent_api_credentials").select("brokerage_id, service_name, token_expires_at, is_active"),
    svc.from("platform_credentials").select("brokerage_id, platform, token_expires_at, is_active"),
    svc.from("integration_credentials").select("brokerage_id, provider_name, is_active"),
  ])
  const failed = [brk, agentCreds, platCreds, intCreds].find((r) => r.error)
  if (failed?.error) return <div className="p-6 text-red-600">Failed to load connection health: {failed.error.message}</div>

  // Group per tenant with the SAME precedence resolve-connectivity uses:
  // agent → platform → integration (most specific wins, first seen kept).
  const byTenant = new Map<string, Map<string, CredEntry>>()
  const setOnce = (brokerageId: string | null, provider: string, entry: CredEntry) => {
    if (!brokerageId || !provider) return
    let m = byTenant.get(brokerageId)
    if (!m) { m = new Map(); byTenant.set(brokerageId, m) }
    const canon = canonicalProvider(provider)
    if (!m.has(canon)) m.set(canon, entry)
  }
  for (const r of (agentCreds.data ?? []) as any[]) {
    setOnce(r.brokerage_id, r.service_name, { isActive: !!r.is_active, tokenExpiresAt: r.token_expires_at ?? null, source: "agent" })
  }
  for (const r of (platCreds.data ?? []) as any[]) {
    setOnce(r.brokerage_id, r.platform, { isActive: !!r.is_active, tokenExpiresAt: r.token_expires_at ?? null, source: "platform" })
  }
  for (const r of (intCreds.data ?? []) as any[]) {
    setOnce(r.brokerage_id, r.provider_name, { isActive: !!r.is_active, tokenExpiresAt: null, source: "integration" })
  }

  const rows = ((brk.data ?? []) as any[]).map((b) => {
    const creds = byTenant.get(b.id) ?? new Map<string, CredEntry>()
    const connectors = [...creds.entries()]
      .map(([provider, entry]) => {
        // An expiry on the row ⇒ treat as oauth (same refinement resolve-connectivity applies).
        const transport = entry.tokenExpiresAt ? ("oauth" as const) : transportFor(provider)
        const status = deriveConnectivityStatus(
          { connected: entry.isActive, transport, isActive: entry.isActive, tokenExpiresAt: entry.tokenExpiresAt },
          now,
        )
        return { provider, transport, status, expiresAt: entry.tokenExpiresAt, source: entry.source, actionRequired: needsAttention(status) }
      })
      .sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired) || a.provider.localeCompare(b.provider))
    const attention = connectors.filter((c) => c.actionRequired).length
    const inactive = connectors.filter((c) => c.status === "disconnected").length
    const connected = connectors.filter((c) => c.status === "connected").length
    return {
      id: b.id as string,
      name: (b.name as string) ?? "(unnamed)",
      tier: (b.plan_tier as string) ?? "—",
      connectors,
      connected,
      attention,
      inactive,
    }
  })
  // Tenants needing attention first, then most-connected, then name.
  rows.sort((a, b) => b.attention - a.attention || b.connected - a.connected || a.name.localeCompare(b.name))

  const tenantsWithConnections = rows.filter((r) => r.connectors.length > 0).length
  const tenantsNeedingAttention = rows.filter((r) => r.attention > 0).length
  const totalConnected = rows.reduce((n, r) => n + r.connected, 0)
  const totalAttention = rows.reduce((n, r) => n + r.attention, 0)

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Connection health — every tenant</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Each tenant's own connected integrations (OAuth + API-key stores), with the same
            health derivation their dashboards use — token expiry aware. Platform-owned vendor
            keys live on the Connectors page, not here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/connectors" className="rounded-md border px-3 py-1 text-sm">Connectors</Link>
          <Link href="/dashboard/superadmin/sentinel" className="rounded-md border px-3 py-1 text-sm">Sentinel</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* Fleet posture */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{tenantsWithConnections}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">Tenants with connections</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{totalConnected}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-800">Healthy connections</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{totalAttention}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800">Expiring / expired</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{tenantsNeedingAttention}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">Tenants needing action</div>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">All tenants ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">No tenants yet.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Brokerage</th>
                  <th className="p-2 text-right">Healthy</th>
                  <th className="p-2 text-right">Needs action</th>
                  <th className="p-2 text-right">Inactive</th>
                  <th className="p-2">Their connected integrations</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="p-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[11px] text-muted-foreground">{r.tier}</div>
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.connectors.length ? r.connected : "—"}</td>
                    <td className="p-2 text-right tabular-nums">
                      {r.attention > 0
                        ? <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-800">{r.attention}</span>
                        : r.connectors.length ? "0" : "—"}
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.connectors.length ? r.inactive : "—"}</td>
                    <td className="p-2">
                      {r.connectors.length === 0 ? (
                        <span className="text-xs text-muted-foreground">No tenant-connected integrations — running on platform-managed rails only.</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {r.connectors.map((c) => {
                            const meta = STATUS_META[c.status]
                            return (
                              <span
                                key={c.provider}
                                className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + meta.cls}
                                title={`${c.provider} · ${c.transport} · ${c.source} store${c.expiresAt ? ` · token expires ${new Date(c.expiresAt).toLocaleString()}` : ""}`}
                              >
                                {c.provider} · {meta.label}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <Link href={`/dashboard/superadmin/brokerages/${r.id}`} className="text-xs font-medium text-indigo-600">Manage →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
