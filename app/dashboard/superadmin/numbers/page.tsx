import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { ProvisionPanel, ReleaseCell } from "./numbers-client"

export const dynamic = "force-dynamic"

// FLEET NUMBERS CONSOLE — the staff-side provisioning surface deferred in
// round 24 (provisioning was tenant-context only). Providers-gated. Per-tenant
// phone inventory read straight from vapi_phone_numbers (the same ledger the
// voice lane routes by), provisioning + release through the ONE shared core
// (lib/voice/number-provisioning.ts — the tenant action runs the same
// pipeline), and the phone_number_events feed as the audit trail. Release is
// destructive, so it requires typing the number verbatim — and the server
// action re-checks the match; the UI is a convenience, not the enforcement.

const EVENT_CLS: Record<string, string> = {
  purchased: "bg-emerald-100 text-emerald-800",
  released: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  manually_added: "bg-slate-100 text-slate-700",
  ported_in: "bg-slate-100 text-slate-700",
  vapi_registered: "bg-indigo-100 text-indigo-800",
}

export default async function FleetNumbersPage(
  { searchParams }: { searchParams: Promise<{ brokerageId?: string }> },
) {
  const gate = await requirePlatformCapability("providers")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: requires platform providers capability</div>

  const params = await searchParams
  const svc = createServiceClient()

  const [{ data: brokerageRows, error: brkError }, { data: numberRows, error: numError }, { data: eventRows }] = await Promise.all([
    svc.from("brokerages").select("id, name").is("deleted_at", null).order("name"),
    svc.from("vapi_phone_numbers")
      .select("id, brokerage_id, phone_number, scope_type, agent_user_id, number_source, byoc_credential_id, is_active, created_at")
      .order("created_at", { ascending: false }).limit(500),
    svc.from("phone_number_events")
      .select("id, brokerage_id, phone_number, event_type, source, twilio_sid, cost_usd, notes, created_at")
      .order("created_at", { ascending: false }).limit(30),
  ])
  if (brkError) return <div className="p-6 text-red-600">Failed to load tenants: {brkError.message}</div>
  if (numError) return <div className="p-6 text-red-600">Failed to load number inventory: {numError.message}</div>

  const brokerages = (brokerageRows ?? []) as { id: string; name: string | null }[]
  const tenantName = new Map(brokerages.map((b) => [b.id, b.name ?? "(unnamed)"]))
  const selected = brokerages.find((b) => b.id === params.brokerageId) ?? null

  const allNumbers = (numberRows ?? []) as any[]
  const numbers = selected ? allNumbers.filter((n) => n.brokerage_id === selected.id) : allNumbers
  const events = (eventRows ?? []) as any[]
  const activeCount = numbers.filter((n) => n.is_active).length
  const readOnly = gate.access === "read"

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Fleet numbers</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Per-tenant phone inventory (vapi_phone_numbers — the ledger the voice lane routes by),
            staff-side provisioning and release through the same pipeline the tenant action runs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/home" className="rounded-md border px-3 py-1 text-sm">Home</Link>
          <Link href="/dashboard/superadmin/connectors" className="rounded-md border px-3 py-1 text-sm">Connectors</Link>
          <Link href="/dashboard/superadmin/a2p" className="rounded-md border px-3 py-1 text-sm">A2P</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {readOnly ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <span className="font-semibold">Read-only.</span> Your role&apos;s providers capability is downgraded to read —
          the provision and release actions will refuse (they require write).
        </div>
      ) : (
        <ProvisionPanel tenants={brokerages.map((b) => ({ id: b.id, name: b.name ?? "(unnamed)" }))} />
      )}

      {/* Tenant filter — plain GET form, no client JS. */}
      <form method="GET" className="flex items-center gap-2 text-sm">
        <label htmlFor="brokerageId" className="text-muted-foreground">Inventory for</label>
        <select id="brokerageId" name="brokerageId" defaultValue={selected?.id ?? ""} className="rounded-md border px-2 py-1 bg-background">
          <option value="">All tenants</option>
          {brokerages.map((b) => (
            <option key={b.id} value={b.id}>{b.name ?? "(unnamed)"}</option>
          ))}
        </select>
        <button type="submit" className="rounded-md border px-3 py-1">Apply</button>
        {selected && (
          <Link href="/dashboard/superadmin/numbers" className="text-xs text-muted-foreground underline">Clear filter</Link>
        )}
      </form>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">
          {selected ? `Numbers — ${selected.name ?? "(unnamed)"}` : "Numbers — all tenants"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">({numbers.length} rows · {activeCount} active)</span>
        </h2>
        {numbers.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            {selected ? "This tenant has no numbers on file." : "No numbers on file across any tenant yet."}
          </div>
        ) : (
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Number</th>
                  <th className="px-3 py-2 font-medium">Tenant</th>
                  <th className="px-3 py-2 font-medium">Scope</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Twilio SID</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Added</th>
                  {!readOnly && <th className="px-3 py-2 font-medium">Release</th>}
                </tr>
              </thead>
              <tbody className="divide-y">
                {numbers.map((n) => (
                  <tr key={n.id}>
                    <td className="px-3 py-2 font-medium tabular-nums">{n.phone_number}</td>
                    <td className="px-3 py-2">{tenantName.get(n.brokerage_id) ?? "(unknown tenant)"}</td>
                    <td className="px-3 py-2 text-xs">{n.scope_type}{n.agent_user_id ? " (agent line)" : ""}</td>
                    <td className="px-3 py-2 text-xs">{n.number_source ?? "—"}</td>
                    <td className="px-3 py-2 text-xs tabular-nums">{n.byoc_credential_id ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (n.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600")}>
                        {n.is_active ? "active" : "inactive"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{n.created_at ? new Date(n.created_at).toLocaleDateString() : "—"}</td>
                    {!readOnly && (
                      <td className="px-3 py-2">
                        {n.is_active ? (
                          <ReleaseCell brokerageId={n.brokerage_id} numberRowId={n.id} phoneNumber={n.phone_number} />
                        ) : (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">
          Recent provisioning events
          <span className="ml-2 text-sm font-normal text-muted-foreground">(phone_number_events, latest 30 — all tenants)</span>
        </h2>
        {events.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">No provisioning events recorded yet.</div>
        ) : (
          <div className="rounded-lg border divide-y">
            {events.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                <span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (EVENT_CLS[e.event_type] ?? "bg-slate-100 text-slate-600")}>
                  {e.event_type}
                </span>
                <span className="font-medium tabular-nums">{e.phone_number}</span>
                <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-indigo-100 text-indigo-800">
                  {tenantName.get(e.brokerage_id) ?? "(unknown tenant)"}
                </span>
                {e.source && <span className="text-xs text-muted-foreground">source: {e.source}</span>}
                {e.cost_usd != null && <span className="text-xs text-muted-foreground tabular-nums">${Number(e.cost_usd).toFixed(2)}</span>}
                {e.notes && <span className="text-xs text-muted-foreground truncate max-w-[420px]" title={e.notes}>{e.notes}</span>}
                <span className="ml-auto text-xs text-muted-foreground">{e.created_at ? new Date(e.created_at).toLocaleString() : "—"}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
