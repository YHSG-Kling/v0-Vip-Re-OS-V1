"use client"

import { useState, useTransition } from "react"
import { updateUser } from "@/app/actions/admin/update-user"
import { invitableRolesForTier } from "@/lib/kernel/tier-role-matrix"
import { InviteUserButton } from "@/app/dashboard/admin/users/invite-user-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Search, Pencil, Trash2, Loader2, User, ShieldCheck } from "lucide-react"
import { useRouter } from "next/navigation"

type UserRow = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  user_type: string | null
  created_at: string
  brokerage_id: string | null
}

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-red-100 text-red-800",
  superadmin: "bg-red-100 text-red-800",
  broker: "bg-purple-100 text-purple-800",
  broker_admin: "bg-purple-100 text-purple-800",
  agent: "bg-blue-100 text-blue-800",
  tc: "bg-green-100 text-green-800",
  isa: "bg-orange-100 text-orange-800",
  compliance_officer: "bg-yellow-100 text-yellow-800",
  lender: "bg-cyan-100 text-cyan-800",
  vendor: "bg-gray-100 text-gray-800",
  contact: "bg-slate-100 text-slate-800",
}

interface Props {
  users: UserRow[]
  currentUserId: string
  brokerageId: string | null | undefined
  /** Caller's user_type — forwarded to the tier-aware invite dialog. */
  callerRole: string
  /** brokerages.plan_tier — drives the invitable/assignable role menu. */
  tier: string | null
}

export function UsersManagementClient({ users: initialUsers, currentUserId, brokerageId, callerRole, tier }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [users, setUsers] = useState<UserRow[]>(initialUsers)
  const [search, setSearch] = useState("")
  const [editingUser, setEditingUser] = useState<UserRow | null>(null)
  const [deletingUser, setDeletingUser] = useState<UserRow | null>(null)
  const [editRole, setEditRole] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Tier-aware assignable roles — the SAME matrix as the invite path, so the
  // role menu never offers a seat the tenant's plan does not include.
  const assignableRoles = invitableRolesForTier(tier)

  const filtered = users.filter(u => {
    const q = search.toLowerCase()
    return (
      u.email?.toLowerCase().includes(q) ||
      u.first_name?.toLowerCase().includes(q) ||
      u.last_name?.toLowerCase().includes(q) ||
      u.user_type?.toLowerCase().includes(q)
    )
  })

  // Role changes ride the guarded server action (tier matrix + brokerage scope +
  // RBAC sync + audit ledger) — never a raw client-side users update, which
  // bypassed tierAllowsRole/seatCheck and left no audit trail.
  async function handleUpdateRole() {
    if (!editingUser || !editRole) return
    setSaving(true)
    setError(null)

    const result = await updateUser({ userId: editingUser.id, updates: { user_type: editRole } })
    if (!result.success) {
      setError(result.error ?? "Could not update role")
      setSaving(false)
      return
    }

    setUsers(prev => prev.map(u => u.id === editingUser.id ? { ...u, user_type: editRole } : u))
    setEditingUser(null)
    setSaving(false)
  }

  // Deactivation (status='suspended') is the honest offboarding rail: it frees the
  // seat (the invite gate excludes suspended users), keeps the user's records for
  // reassignment, and lands in the audit ledger via the guarded server action.
  async function handleDelete() {
    if (!deletingUser) return
    setSaving(true)
    setError(null)

    const result = await updateUser({ userId: deletingUser.id, updates: { status: "suspended" } })
    if (!result.success) {
      setError(result.error ?? "Could not deactivate user")
      setSaving(false)
      return
    }

    setUsers(prev => prev.filter(u => u.id !== deletingUser.id))
    setDeletingUser(null)
    setSaving(false)
    startTransition(() => router.refresh())
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">User Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage roles and access for {users.length} user{users.length !== 1 ? "s" : ""} in your brokerage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Pending invites live on the admin console's invitations list —
              linked here so the invite lifecycle is one click away. */}
          <Button variant="outline" size="sm" asChild>
            <a href="/dashboard/admin/users/invitations">Pending invitations</a>
          </Button>
          {/* Tier-aware invite — the same seat-gated dialog as /dashboard/admin/users.
              This surface previously had NO invite path at all. */}
          <InviteUserButton callerRole={callerRole} brokerageId={brokerageId} tier={tier} />
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search users..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    No users found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(u => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                          <User className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <span className="font-medium">
                          {[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}
                        </span>
                        {u.id === currentUserId && (
                          <Badge variant="outline" className="text-xs">You</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{u.email}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[u.user_type ?? "agent"] ?? "bg-gray-100 text-gray-800"}`}>
                        {u.user_type ?? "agent"}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setEditingUser(u)
                            setEditRole(u.user_type ?? "agent")
                            setError(null)
                          }}
                          disabled={u.id === currentUserId}
                          title="Edit role"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setDeletingUser(u)
                            setError(null)
                          }}
                          disabled={u.id === currentUserId}
                          className="text-destructive hover:text-destructive"
                          title="Remove user"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit Role Dialog */}
      <Dialog open={!!editingUser} onOpenChange={open => !open && setEditingUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User Role</DialogTitle>
            <DialogDescription>
              Change the role for {editingUser?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger>
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingUser(null)} disabled={saving}>Cancel</Button>
            <Button onClick={handleUpdateRole} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deletingUser} onOpenChange={open => !open && setDeletingUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate User</DialogTitle>
            <DialogDescription>
              Deactivate {deletingUser?.email}? They lose access immediately and their seat is freed.
              Their contacts, deals, and history are kept so you can reassign them.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingUser(null)} disabled={saving}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Deactivate User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
