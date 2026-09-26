"use client"

// Portal clients on the tenant detail page — the god-console view of the tenant's
// CLIENT-side identity state. Portal clients ARE users (user_type='contact'):
// this panel shows who has accepted portal access (and whether their users row —
// the thing that makes them roster-visible and impersonable — exists), their last
// portal activity (portal_event_stream / site_activity, reused), pending invites,
// and the one-click backfill that creates any missing users rows with honest
// counters. Empty states say exactly what is (not) there.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DoorOpen, Loader2 } from "lucide-react"
import {
  listPortalClientsAction, backfillPortalClientUsersAction,
  type PortalClientRow, type PendingPortalInviteRow,
} from "@/app/actions/superadmin/portal-clients"

function fmtWhen(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : "—"
}

/**
 * WHO INVITED THEM. `portal_contact_invites.invited_by` (a users.id — see the
 * identity-class note in lib/portal/portal-clients-read.ts) is stamped on every
 * invite and, until now, read by nothing. Three states, never collapsed:
 * a resolved name; an id that does not resolve inside this brokerage; and no id
 * at all — which for a CLIENT row means link-only access, not "invited by nobody".
 */
function fmtInviter(userId: string | null, name: string | null, noneLabel: string): string {
  if (name) return name
  if (userId) return "outside this brokerage"
  return noneLabel
}

export function PortalClientsPanel({ brokerageId }: { brokerageId: string }) {
  const [clients, setClients] = useState<PortalClientRow[]>([])
  const [pendingInvites, setPendingInvites] = useState<PendingPortalInviteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function refresh() {
    listPortalClientsAction(brokerageId).then((r) => {
      if (r.ok) { setClients(r.clients); setPendingInvites(r.pending) } else setErr(r.error)
      setLoading(false)
    })
  }
  useEffect(refresh, [brokerageId])

  const missingUserRows = clients.filter((c) => !c.userLinked).length

  function runBackfill() {
    setErr(null); setBackfillMsg(null)
    startTransition(async () => {
      const r = await backfillPortalClientUsersAction(brokerageId)
      if (!r.ok) { setErr(r.error ?? "Backfill failed"); return }
      setBackfillMsg(
        `Backfill: ${r.created} created · ${r.alreadyExisted} already existed · ${r.noAuthUser} without an auth user` +
        (r.failed > 0 ? ` · ${r.failed} failed (see write-sentinel ledger)` : ""),
      )
      refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <DoorOpen className="h-4 w-4 text-primary" />
          Portal clients ({clients.length})
        </CardTitle>
        <Button
          size="sm" variant="outline" disabled={pending || loading}
          title="Create missing users rows for clients who already authenticated via magic link"
          onClick={runBackfill}
        >
          {pending ? "Backfilling…" : missingUserRows > 0 ? `Backfill user rows (${missingUserRows})` : "Backfill user rows"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {backfillMsg && <p className="text-xs text-emerald-700">{backfillMsg}</p>}

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No clients have portal access yet — accepted invites and linked logins will appear here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Client</th><th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Accepted</th><th className="px-3 py-2">Invited by</th>
                <th className="px-3 py-2">Last portal activity</th>
                <th className="px-3 py-2">User row</th>
              </tr></thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.contactId} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{c.name}</td>
                    <td className="px-3 py-2 text-xs">{c.email ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{c.acceptedAt ? fmtWhen(c.acceptedAt) : "link access"}</td>
                    <td className="px-3 py-2 text-xs">
                      {fmtInviter(c.invitedByUserId, c.invitedByName, "no invite on file (link access)")}
                    </td>
                    <td className="px-3 py-2 text-xs">{c.lastActivityAt ? fmtWhen(c.lastActivityAt) : "no activity recorded"}</td>
                    <td className="px-3 py-2">
                      {c.userLinked
                        ? <Badge className="text-xs bg-violet-100 text-violet-800" variant="secondary">Portal client</Badge>
                        : <Badge variant="outline" className="text-xs text-amber-700">missing</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Pending portal invites ({pendingInvites.length})</p>
          {pendingInvites.length === 0 ? (
            <p className="text-xs text-muted-foreground">No pending portal invites.</p>
          ) : (
            <div className="space-y-1">
              {pendingInvites.map((i) => (
                <div key={i.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">
                    {i.name}{i.email ? ` · ${i.email}` : ""} ·{" "}
                    <span className="text-xs text-muted-foreground">
                      {i.status}
                      {i.invitedAt ? ` · invited ${fmtWhen(i.invitedAt)}` : ""}
                      {` · by ${fmtInviter(i.invitedByUserId, i.invitedByName, "inviter not recorded")}`}
                      {i.expiresAt ? ` · expires ${fmtWhen(i.expiresAt)}` : ""}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
