import { redirect } from "next/navigation"
import Link from "next/link"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { listSuperadminAuditLogAction } from "@/app/actions/superadmin/brokerage-management"
import { Badge } from "@/components/ui/badge"

export const dynamic = "force-dynamic"

// Superadmin: the platform-action ledger. Every lifecycle action (tier change,
// suspend, refund, impersonation, suppression edit) writes here — this page is
// the ledger's consumer, which is what keeps superadmin_audit_log's AUDIT_EXEMPT
// entry in the orphan-write sweep honest. Gate: 'staff' capability (superadmin
// only) — the ledger records what platform staff did, so only whoever manages
// staff may read it, matching requireSuperadmin inside the list action.
export default async function SuperadminAuditPage() {
  const gate = await requirePlatformCapability("staff")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const res = await listSuperadminAuditLogAction(200)

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Platform action ledger</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Chain of custody for every platform-staff action — tier changes, suspensions, refunds,
            impersonation, suppression edits. Most recent 200 entries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/audit-trail" className="rounded-md border px-3 py-1 text-sm">Event audit trail</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {!res.ok && <div className="rounded border p-4 text-sm text-red-600">Failed to load ledger: {res.error}</div>}

      {res.ok && res.rows.length === 0 && (
        <div className="rounded border p-6 text-sm text-muted-foreground">
          No platform actions recorded yet. Lifecycle actions (tier changes, suspensions, refunds) will appear here.
        </div>
      )}

      {res.ok && res.rows.length > 0 && (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="p-2">When</th>
                <th className="p-2">Actor</th>
                <th className="p-2">Action</th>
                <th className="p-2">Target</th>
                <th className="p-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 align-top">
                  <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  {/* Chain of custody: the seat id, source IP and client are part
                      of the record — hover the actor for the full trace. */}
                  <td
                    className="p-2 text-xs"
                    title={[
                      r.actor_user_id ? `user ${r.actor_user_id}` : null,
                      r.ip_address ? `from ${r.ip_address}` : null,
                      r.user_agent ?? null,
                    ].filter(Boolean).join(" · ") || undefined}
                  >
                    <span>{r.actor_email ?? (r.actor_user_id ? `${r.actor_user_id.slice(0, 8)}…` : "—")}</span>
                    {r.ip_address && (
                      <span className="block text-[10px] text-muted-foreground font-mono">{r.ip_address}</span>
                    )}
                  </td>
                  <td className="p-2">
                    <Badge variant="outline" className="text-xs font-mono">{r.action}</Badge>
                  </td>
                  <td className="p-2 text-xs">
                    <span className="text-muted-foreground">{r.target_type}</span>
                    {r.target_id && (
                      r.target_type === "brokerage" ? (
                        <Link href={`/dashboard/superadmin/brokerages/${r.target_id}`} className="ml-1 text-indigo-600 hover:underline">
                          {r.target_id.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="ml-1 font-mono">{r.target_id.slice(0, 8)}…</span>
                      )
                    )}
                  </td>
                  <td className="p-2 text-xs font-mono max-w-md">
                    <span className="break-all">{JSON.stringify(r.details)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
