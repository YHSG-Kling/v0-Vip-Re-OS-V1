"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { updateUser } from "@/app/actions/admin/update-user"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react"

const USER_TYPE_OPTIONS = [
  { value: "agent", label: "Agent" },
  { value: "broker", label: "Broker" },
  { value: "admin", label: "Admin" },
  { value: "tc", label: "Transaction Coordinator" },
  { value: "isa", label: "ISA" },
  { value: "team_lead", label: "Team Lead" },
  { value: "vendor", label: "Vendor" },
  { value: "lender", label: "Lender" },
  { value: "superadmin", label: "Superadmin" },
]

const RESTRICTED_USER_TYPE_OPTIONS = USER_TYPE_OPTIONS.filter(
  (r) => r.value !== "superadmin"
)

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "pending", label: "Pending" },
]

interface UserData {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  user_type: string | null
  role: string | null
  status: string | null
  brokerage_id: string | null
  created_at: string
}

interface Props {
  user: UserData
  callerRole: string
  callerBrokerageId: string | null
  brokerages: { id: string; name: string }[]
}

export function UserEditForm({ user, callerRole, callerBrokerageId, brokerages }: Props) {
  const router = useRouter()
  const isSuperadmin = callerRole === "superadmin"

  const [form, setForm] = useState({
    first_name: user.first_name ?? "",
    last_name: user.last_name ?? "",
    user_type: user.user_type ?? user.role ?? "",
    status: user.status ?? "active",
    brokerage_id: user.brokerage_id ?? "",
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setSaved(false)
    setError(null)
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)

    const result = await updateUser({
      userId: user.id,
      updates: {
        first_name: form.first_name || undefined,
        last_name: form.last_name || undefined,
        user_type: form.user_type || undefined,
        role: form.user_type || undefined,
        status: form.status || undefined,
        brokerage_id: isSuperadmin ? (form.brokerage_id || null) : undefined,
      },
    })

    setSaving(false)
    if (result.success) {
      setSaved(true)
      router.refresh()
    } else {
      setError(result.error ?? "Save failed. Please try again.")
    }
  }

  const roleOptions = isSuperadmin ? USER_TYPE_OPTIONS : RESTRICTED_USER_TYPE_OPTIONS

  const statusBadgeVariant: Record<string, "default" | "secondary" | "outline"> = {
    active: "default",
    suspended: "secondary",
    pending: "outline",
  }

  return (
    <div className="space-y-6">
      {/* Identity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                value={form.first_name}
                onChange={(e) => set("first_name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                value={form.last_name}
                onChange={(e) => set("last_name", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={user.email} disabled className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Email cannot be changed here</p>
          </div>
        </CardContent>
      </Card>

      {/* Role */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Role</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>User Type</Label>
            <Select value={form.user_type} onValueChange={(v) => set("user_type", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select role..." />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Badge variant={statusBadgeVariant[form.status] ?? "outline"} className="capitalize">
              {form.status}
            </Badge>
            <span className="text-sm text-muted-foreground">Current status</span>
          </div>
          <div className="space-y-1.5">
            <Label>Change Status</Label>
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Brokerage Assignment — superadmin only */}
      {isSuperadmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Brokerage Assignment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <Label>Brokerage</Label>
            <Select
              value={form.brokerage_id}
              onValueChange={(v) => set("brokerage_id", v === "none" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="No brokerage assigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No brokerage (platform-level)</SelectItem>
                {brokerages.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {/* Feedback */}
      {saved && (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Changes saved successfully.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-muted-foreground">
          Joined {new Date(user.created_at).toLocaleDateString()}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push("/dashboard/admin/users")}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
