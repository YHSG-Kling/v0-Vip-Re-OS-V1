"use client"

// Cross-tenant user management on the god console — per-user activate/suspend + invitation resend/revoke,
// with last-login, for any tenant. Superadmin-gated + audited server-side.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, Loader2 } from "lucide-react"
import {
  listTenantUsersAction, setTenantUserStatusAction, resendTenantInviteAction, revokeTenantInviteAction,
  createTenantUserAction,
  type TenantUserRow, type TenantInviteRow,
} from "@/app/actions/superadmin/tenant-users"

const CREATABLE_ROLES = ["admin", "broker", "agent", "team_lead", "tc", "isa", "compliance_officer", "lender", "vendor"]

export function TenantUsersPanel({ brokerageId }: { brokerageId: string }) {
  const [users, setUsers] = useState<TenantUserRow[]>([])
  const [invites, setInvites] = useState<TenantInviteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [showAdd, setShowAdd] = useState(false)
  const [addOk, setAddOk] = useState<string | null>(null)
  const [addForm, setAddForm] = useState({ email: "", firstName: "", lastName: "", userType: "agent" })

  function refresh() {
    listTenantUsersAction(brokerageId).then((r) => {
      if (r.ok) { setUsers(r.users); setInvites(r.invites) } else setErr(r.error)
      setLoading(false)
    })
  }
  useEffect(refresh, [brokerageId])

  function setStatus(userId: string, status: "active" | "suspended") {
    setErr(null)
    startTransition(async () => { const r = await setTenantUserStatusAction({ userId, status }); if (!r.ok) setErr(r.error ?? "Failed"); refresh() })
  }
  function invite(action: "resend" | "revoke", id: string) {
    setErr(null)
    startTransition(async () => { const r = action === "resend" ? await resendTenantInviteAction(id) : await revokeTenantInviteAction(id); if (!r.ok) setErr(r.error ?? "Failed"); refresh() })
  }
  function addUser() {
    setErr(null); setAddOk(null)
    if (!addForm.email.includes("@")) { setErr("Valid email required"); return }
    startTransition(async () => {
      const r = await createTenantUserAction({ brokerageId, email: addForm.email, firstName: addForm.firstName, lastName: addForm.lastName, userType: addForm.userType })
      if (!r.ok) { setErr(r.error ?? "Failed to create user") } else {
        setAddOk(`Invited ${addForm.email} as ${addForm.userType}`)
        setAddForm({ email: "", firstName: "", lastName: "", userType: "agent" })
        setShowAdd(false)
      }
      refresh()
    })
  }

  const pendingInvites = invites.filter((i) => i.status === "pending" || i.status === "expired")

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2"><Users className="h-4 w-4 text-primary" />Team ({users.length})</CardTitle>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { setShowAdd((s) => !s); setAddOk(null); setErr(null) }}>
          {showAdd ? "Cancel" : "Add user"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-xs text-red-600">{err}</p>}
        {addOk && <p className="text-xs text-emerald-600">{addOk}</p>}
        {showAdd && (
          <div className="rounded-md border bg-muted/10 p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Create a user in this tenant — they’ll get an invite email and their role records.</p>
            <div className="grid grid-cols-2 gap-2">
              <input className="rounded border px-2 py-1 text-sm col-span-2" type="email" placeholder="email@tenant.com" value={addForm.email} onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))} />
              <input className="rounded border px-2 py-1 text-sm" placeholder="First name" value={addForm.firstName} onChange={(e) => setAddForm((f) => ({ ...f, firstName: e.target.value }))} />
              <input className="rounded border px-2 py-1 text-sm" placeholder="Last name" value={addForm.lastName} onChange={(e) => setAddForm((f) => ({ ...f, lastName: e.target.value }))} />
              <select className="rounded border px-2 py-1 text-sm col-span-2" value={addForm.userType} onChange={(e) => setAddForm((f) => ({ ...f, userType: e.target.value }))}>
                {CREATABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <Button size="sm" disabled={pending} onClick={addUser}>{pending ? "Creating…" : "Send invite"}</Button>
          </div>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Name</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Manage</th>
              </tr></thead>
              <tbody>
                {users.map((u) => {
                  const suspended = u.status === "suspended"
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{u.name}</td>
                      <td className="px-3 py-2 text-xs">{u.email}</td>
                      <td className="px-3 py-2"><Badge variant="outline" className="text-xs">{u.role}</Badge></td>
                      <td className="px-3 py-2"><span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (suspended ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800")}>{suspended ? "suspended" : "active"}</span></td>
                      <td className="px-3 py-2 text-right">
                        {u.role === "superadmin" ? <span className="text-xs text-muted-foreground">—</span> : (
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => setStatus(u.id, suspended ? "active" : "suspended")}>
                            {suspended ? "Reactivate" : "Suspend"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {pendingInvites.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Pending invitations ({pendingInvites.length})</p>
            <div className="space-y-1">
              {pendingInvites.map((i) => (
                <div key={i.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">{i.email} · <span className="text-xs text-muted-foreground">{i.role}{i.status === "expired" ? " · expired" : ""}</span></span>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => invite("resend", i.id)}>Resend</Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => invite("revoke", i.id)}>Revoke</Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
