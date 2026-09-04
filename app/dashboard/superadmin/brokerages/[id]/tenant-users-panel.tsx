"use client"

// Cross-tenant user management on the god console — per-user activate/suspend + invitation resend/revoke,
// with last-login, for any tenant. Superadmin-gated + audited server-side. Per-user
// "Enter as" (full) / "View as" (read-only) begin USER-GRANULAR impersonation
// sessions (GHL parity): the staff member lands in the tenant dashboard resolved
// as THAT user until they exit (banner) or the session auto-expires.
import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, Loader2, LogIn, Eye, Search } from "lucide-react"
import {
  listTenantUsersAction, setTenantUserStatusAction, resendTenantInviteAction, revokeTenantInviteAction,
  createTenantUserAction, searchUsersByEmailAction,
  type TenantUserRow, type TenantInviteRow, type TenantTeamRow, type CrossTenantUserHit,
} from "@/app/actions/superadmin/tenant-users"
import { enterTenantAction } from "@/app/actions/superadmin/impersonation"

// Mirrors TENANT_CREATABLE_ROLES in app/actions/superadmin/tenant-users.ts — a menu
// offering a role the action refuses is a dead end. 'lender' removed with it (owner
// ruling: lender is a vendor CATEGORY, not a user type — invite them as a vendor
// and pick the lender category).
const CREATABLE_ROLES = ["admin", "broker", "agent", "team_lead", "tc", "isa", "compliance_officer", "vendor"]

function fmtLastLogin(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

export function TenantUsersPanel({ brokerageId }: { brokerageId: string }) {
  const router = useRouter()
  const [users, setUsers] = useState<TenantUserRow[]>([])
  const [invites, setInvites] = useState<TenantInviteRow[]>([])
  const [teams, setTeams] = useState<TenantTeamRow[]>([])
  const [planTier, setPlanTier] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [showAdd, setShowAdd] = useState(false)
  const [addOk, setAddOk] = useState<string | null>(null)
  const [addForm, setAddForm] = useState({ email: "", firstName: "", lastName: "", userType: "agent" })
  const [searchQ, setSearchQ] = useState("")
  const [searchHits, setSearchHits] = useState<CrossTenantUserHit[] | null>(null)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  function refresh() {
    listTenantUsersAction(brokerageId).then((r) => {
      if (r.ok) { setUsers(r.users); setInvites(r.invites); setTeams(r.teams); setPlanTier(r.planTier) } else setErr(r.error)
      setLoading(false)
    })
  }
  useEffect(refresh, [brokerageId])

  async function runSearch() {
    setSearchErr(null)
    setSearching(true)
    try {
      const r = await searchUsersByEmailAction(searchQ)
      if (r.ok) setSearchHits(r.hits)
      else { setSearchHits(null); setSearchErr(r.error) }
    } finally {
      setSearching(false)
    }
  }

  function setStatus(userId: string, status: "active" | "suspended") {
    setErr(null)
    startTransition(async () => { const r = await setTenantUserStatusAction({ userId, status }); if (!r.ok) setErr(r.error ?? "Failed"); refresh() })
  }
  function invite(action: "resend" | "revoke", id: string) {
    setErr(null)
    startTransition(async () => { const r = action === "resend" ? await resendTenantInviteAction(id) : await revokeTenantInviteAction(id); if (!r.ok) setErr(r.error ?? "Failed"); refresh() })
  }
  // User-granular impersonation. The server action resolves the landing route:
  // staff targets land on /dashboard (entry router); a user_type='contact' target
  // is a PORTAL CLIENT and lands directly on THEIR portal (/portal/[contactId]).
  function enterAs(userId: string, mode: "full" | "read_only") {
    setErr(null)
    startTransition(async () => {
      const r = await enterTenantAction({
        brokerageId, targetUserId: userId, mode,
        reason: mode === "read_only" ? "god-console view-as-user" : "god-console enter-as-user",
      })
      if (!r.ok) { setErr(r.error ?? "Failed to start impersonation"); return }
      router.push(r.redirectTo ?? "/dashboard")
    })
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
                <th className="px-3 py-2">Name</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" title="auth.users.last_sign_in_at — Supabase Auth's own sign-in stamp">Last login</th><th className="px-3 py-2 text-right">Manage</th>
              </tr></thead>
              <tbody>
                {users.map((u) => {
                  const suspended = u.status === "suspended"
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{u.name}</td>
                      <td className="px-3 py-2 text-xs">{u.email}</td>
                      <td className="px-3 py-2">
                        {u.role === "contact" ? (
                          // Identity correction: portal clients ARE users — distinct badge.
                          <Badge className="text-xs bg-violet-100 text-violet-800" variant="secondary">Portal client</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">{u.role}</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2"><span className={"rounded px-1.5 py-0.5 text-[11px] font-medium " + (suspended ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800")}>{suspended ? "suspended" : "active"}</span></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground" title={u.lastLoginAt ?? "No sign-in recorded by Auth"}>{fmtLastLogin(u.lastLoginAt)}</td>
                      <td className="px-3 py-2 text-right">
                        {u.role === "superadmin" ? <span className="text-xs text-muted-foreground">—</span> : (
                          <div className="inline-flex items-center gap-1.5">
                            <Button size="sm" variant="ghost" disabled={pending} title={`Enter the tenant as ${u.name} (full access)`} onClick={() => enterAs(u.id, "full")} className="gap-1">
                              <LogIn className="h-3.5 w-3.5" /> Enter as
                            </Button>
                            <Button size="sm" variant="ghost" disabled={pending} title={`View the tenant as ${u.name} (read-only)`} onClick={() => enterAs(u.id, "read_only")} className="gap-1">
                              <Eye className="h-3.5 w-3.5" /> View as
                            </Button>
                            <Button size="sm" variant="outline" disabled={pending} onClick={() => setStatus(u.id, suspended ? "active" : "suspended")}>
                              {suspended ? "Reactivate" : "Suspend"}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Team structure — teams rows for team-tier+ tenants (name · lead · member count) */}
        {!loading && teams.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Teams ({teams.length}){planTier ? ` · ${planTier} tier` : ""}
            </p>
            <div className="space-y-1">
              {teams.map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded border px-3 py-1.5 text-sm">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-xs text-muted-foreground">
                    lead: {t.leadName ?? "—"}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {t.memberCount} member{t.memberCount === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cross-tenant user search — "which brokerage is this email in?" */}
        <div className="rounded-md border bg-muted/10 p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5" />Find a user across ALL tenants by email
          </p>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 rounded border px-2 py-1 text-sm"
              placeholder="part of an email, e.g. jane@ or @acme.com"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch() }}
            />
            <Button size="sm" variant="outline" disabled={searching || searchQ.trim().length < 3} onClick={() => void runSearch()}>
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Search"}
            </Button>
          </div>
          {searchErr && <p className="text-xs text-red-600">{searchErr}</p>}
          {searchHits !== null && (
            searchHits.length === 0 ? (
              <p className="text-xs text-muted-foreground">No users match that email anywhere.</p>
            ) : (
              <div className="space-y-1">
                {searchHits.map((h) => (
                  <div key={h.id} className="flex items-center gap-2 text-xs">
                    <span className="font-medium">{h.name}</span>
                    <span className="text-muted-foreground truncate">{h.email}</span>
                    <Badge variant="outline" className="text-[10px]">{h.role}</Badge>
                    {h.status === "suspended" && <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-800">suspended</span>}
                    <span className="ml-auto shrink-0">
                      {h.brokerageId ? (
                        <a href={`/dashboard/superadmin/brokerages/${h.brokerageId}`} className="font-medium text-indigo-600">
                          {h.brokerageName ?? "Open tenant"} →
                        </a>
                      ) : (
                        <span className="text-muted-foreground">no tenant</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

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
