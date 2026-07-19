"use client"

// TENANT portal-clients roster — the subscriber's mirror of the round-31 staff
// view: which of MY contacts have client-portal access, when they accepted, when
// they were last seen in the portal, and which invites are still pending. Same
// read composition as the god-console panel (lib/portal/portal-clients-read.ts);
// read-only here — invites are sent from the contact's Portal tab in the CRM.
import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DoorOpen, Loader2 } from "lucide-react"
import {
  listMyPortalClientsAction,
  type PortalClientRow,
  type PendingPortalInviteRow,
} from "@/app/actions/portal-invites"

function fmtWhen(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : "—"
}

export function PortalClientsRoster() {
  const [clients, setClients] = useState<PortalClientRow[]>([])
  const [pendingInvites, setPendingInvites] = useState<PendingPortalInviteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    listMyPortalClientsAction().then((r) => {
      if (r.ok) { setClients(r.clients); setPendingInvites(r.pending) } else setErr(r.error)
      setLoading(false)
    })
  }, [])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <DoorOpen className="h-4 w-4 text-primary" />
          Portal clients ({clients.length})
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Contacts with access to your client portal. Invite a contact from their Portal tab in the CRM.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-xs text-red-600">{err}</p>}

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">No clients have portal access yet — accepted invites and linked logins will appear here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Client</th><th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Accepted</th><th className="px-3 py-2">Last portal activity</th>
                <th className="px-3 py-2">Status</th>
              </tr></thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.contactId} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">
                      <Link href={`/crm?contact=${c.contactId}`} className="hover:underline">{c.name}</Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{c.email ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{c.acceptedAt ? fmtWhen(c.acceptedAt) : "link access"}</td>
                    <td className="px-3 py-2 text-xs">{c.lastActivityAt ? fmtWhen(c.lastActivityAt) : "no activity recorded"}</td>
                    <td className="px-3 py-2">
                      {c.userLinked
                        ? <Badge className="text-xs bg-violet-100 text-violet-800" variant="secondary">active login</Badge>
                        : <Badge variant="outline" className="text-xs text-amber-700">not signed in yet</Badge>}
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
                    <Link href={`/crm?contact=${i.contactId}`} className="hover:underline">{i.name}</Link>
                    {i.email ? ` · ${i.email}` : ""} ·{" "}
                    <span className="text-xs text-muted-foreground">
                      {i.status}{i.invitedAt ? ` · invited ${fmtWhen(i.invitedAt)}` : ""}{i.expiresAt ? ` · expires ${fmtWhen(i.expiresAt)}` : ""}
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
