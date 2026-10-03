import { redirect } from "next/navigation"
import Link from "next/link"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { listTenantTransitionLogAction } from "@/app/actions/superadmin/tenant-transition-log"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

// Superadmin: READER (orphan doctrine §1.2) for tenant_transition_log — the
// immutable cross-tenant audit log (migration 038) app/api/recruiting/
// provision-agent writes on every recruit-provisioning outcome (allowed AND
// the two denied shapes: cross-brokerage, email-belongs-to-another-brokerage)
// and nothing ever read back. Platform-only, matching the table's own shape
// (from_brokerage_id/to_brokerage_id — a cross-tenant event has no single
// tenant to scope a page to). Gate: 'staff' capability, same door as the
// sibling platform-action ledger at /dashboard/superadmin/audit.
export default async function TenantTransitionsPage() {
  const gate = await requirePlatformCapability("staff")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const res = await listTenantTransitionLogAction(200)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tenant transitions</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Cross-tenant moves — recruit provisioning, and every refused attempt to move a
            person across brokerages. Most recent 200 entries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/audit" className="rounded-md border px-3 py-1 text-sm">Platform action ledger</Link>
        </div>
      </div>

      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load log: {res.error}</div>}

      {res.ok && res.rows.length === 0 && (
        <div className="rounded border p-6 text-sm text-muted-foreground">
          No tenant transitions recorded yet.
        </div>
      )}

      {res.ok && res.rows.length > 0 && (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="p-2">When</th>
                <th className="p-2">Action</th>
                <th className="p-2">Entity</th>
                <th className="p-2">From → To</th>
                <th className="p-2">Actor</th>
                <th className="p-2">Rows moved</th>
                <th className="p-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r) => {
                const denied = r.action.includes("denied")
                return (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(r.at).toLocaleString()}
                    </td>
                    <td className="p-2">
                      <Badge variant={denied ? "destructive" : "outline"} className="text-xs font-mono">
                        {r.action}
                      </Badge>
                    </td>
                    <td className="p-2 text-xs">
                      <span className="text-muted-foreground">{r.entityType}</span>{" "}
                      <span className="font-mono">{r.entityId.slice(0, 8)}…</span>
                    </td>
                    <td className="p-2 text-xs font-mono">
                      {r.fromBrokerageId ? `${r.fromBrokerageId.slice(0, 8)}…` : "—"}
                      {" → "}
                      {r.toBrokerageId ? `${r.toBrokerageId.slice(0, 8)}…` : "—"}
                    </td>
                    <td className="p-2 text-xs font-mono">
                      {r.actorUserId ? `${r.actorUserId.slice(0, 8)}…` : "—"}
                    </td>
                    <td className="p-2 text-xs text-center">
                      {r.rowCountMoved != null ? (
                        <Badge variant={r.rowCountMoved > 0 ? "default" : "secondary"}>{r.rowCountMoved}</Badge>
                      ) : "—"}
                    </td>
                    <td className="p-2 text-xs font-mono max-w-md">
                      <span className="break-all">{JSON.stringify(r.metadata)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
