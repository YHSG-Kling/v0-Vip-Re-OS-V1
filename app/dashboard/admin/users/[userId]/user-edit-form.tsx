"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { updateUser } from "@/app/actions/admin/update-user"
import { updateAgentProfileAction, type AgentProfile, type OfficeOption } from "@/app/actions/admin/agent-profile"
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
import { CheckCircle2, AlertCircle, Loader2, ShieldCheck } from "lucide-react"
import { ROLE_PERMISSIONS, ROLE_HIERARCHY, PERMISSION_DEFINITIONS } from "@/lib/security/permission-matrix"
import { toCanonicalRole } from "@/lib/security/types"
import { CommissionAgreementCard } from "./commission-agreement-card"

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
  phone: string | null
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
  agentProfile: AgentProfile | null
  offices: OfficeOption[]
}

const NO_OFFICE = "__none__"

export function UserEditForm({ user, callerRole, callerBrokerageId, brokerages, agentProfile, offices }: Props) {
  const router = useRouter()
  const isSuperadmin = callerRole === "superadmin"

  const [form, setForm] = useState({
    first_name: user.first_name ?? "",
    last_name: user.last_name ?? "",
    phone: user.phone ?? "",
    user_type: user.user_type ?? user.role ?? "",
    status: user.status ?? "active",
    brokerage_id: user.brokerage_id ?? "",
  })
  // Agent real-estate profile (present only when the user has an agent row).
  const [agent, setAgent] = useState({
    license_number: agentProfile?.licenseNumber ?? "",
    license_state: agentProfile?.licenseState ?? "",
    license_expiry: agentProfile?.licenseExpiry ?? "",
    commission_split: agentProfile?.commissionSplit != null ? String(agentProfile.commissionSplit) : "",
    team_override_percent:
      agentProfile?.teamOverridePercent != null ? String(agentProfile.teamOverridePercent) : "",
    location_id: agentProfile?.locationId ?? NO_OFFICE,
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setSaved(false)
    setError(null)
  }

  function setAgentField(field: keyof typeof agent, value: string) {
    setAgent((a) => ({ ...a, [field]: value }))
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
        phone: form.phone,
        user_type: form.user_type || undefined,
        role: form.user_type || undefined,
        status: form.status || undefined,
        brokerage_id: isSuperadmin ? (form.brokerage_id || null) : undefined,
      },
    })

    if (!result.success) {
      setSaving(false)
      setError(result.error ?? "Save failed. Please try again.")
      return
    }

    // Save the agent real-estate profile too (one Save button for the whole
    // person). Only fires when the user actually has an agent profile.
    if (agentProfile) {
      const agentRes = await updateAgentProfileAction({
        targetUserId: user.id,
        licenseNumber: agent.license_number,
        licenseState: agent.license_state,
        licenseExpiry: agent.license_expiry || null,
        commissionSplit: agent.commission_split === "" ? null : Number(agent.commission_split),
        // "" is a DELIBERATE CLEAR back to the team's standing terms, so it must
        // send null rather than be omitted — omitting it would leave a torn-up
        // agreement silently in force.
        teamOverridePercent:
          agent.team_override_percent === "" ? null : Number(agent.team_override_percent),
        locationId: agent.location_id === NO_OFFICE ? null : agent.location_id,
      })
      if (!agentRes.ok) {
        setSaving(false)
        setError(agentRes.error)
        return
      }
    }

    setSaving(false)
    setSaved(true)
    router.refresh()
  }

  const roleOptions = isSuperadmin ? USER_TYPE_OPTIONS : RESTRICTED_USER_TYPE_OPTIONS

  // Read-only "what this role can do" — sourced from the canonical permission
  // matrix (the live DB has no role_capabilities table; the matrix is the SSOT).
  const canonicalRole = toCanonicalRole(form.user_type)
  const rolePerms = canonicalRole ? ROLE_PERMISSIONS[canonicalRole] : null
  const roleHierarchy = canonicalRole ? ROLE_HIERARCHY[canonicalRole] : null

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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={user.email} disabled className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Email cannot be changed here</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(555) 123-4567"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </div>
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

      {/* Role Capabilities — read-only, from the canonical permission matrix */}
      {rolePerms && roleHierarchy && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              What this role can do
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">Data access: {roleHierarchy.canViewData}</Badge>
              {roleHierarchy.canManage.length > 0 && (
                <Badge variant="outline">Manages: {roleHierarchy.canManage.join(", ")}</Badge>
              )}
            </div>
            <div className="space-y-1.5">
              {rolePerms.permissions.map((p) => (
                <div key={p} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-600" />
                  <span>{PERMISSION_DEFINITIONS[p] ?? p}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Permissions are defined by the role. Changing the role above changes what this
              person can do across the OS.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Agent Profile — license / office / commission (only for agents) */}
      {agentProfile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Agent Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="licenseNumber">License #</Label>
                <Input
                  id="licenseNumber"
                  value={agent.license_number}
                  onChange={(e) => setAgentField("license_number", e.target.value)}
                  placeholder="e.g. 01234567"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="licenseState">License State</Label>
                <Input
                  id="licenseState"
                  value={agent.license_state}
                  onChange={(e) => setAgentField("license_state", e.target.value)}
                  placeholder="e.g. CA"
                  maxLength={2}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="licenseExpiry">License Expiry</Label>
                <Input
                  id="licenseExpiry"
                  type="date"
                  value={agent.license_expiry ?? ""}
                  onChange={(e) => setAgentField("license_expiry", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="commissionSplit">Commission Split (%)</Label>
                <Input
                  id="commissionSplit"
                  type="number"
                  min={0}
                  max={100}
                  step="0.5"
                  value={agent.commission_split}
                  onChange={(e) => setAgentField("commission_split", e.target.value)}
                  placeholder="e.g. 70"
                />
              </div>
            </div>
            {/*
              THE NEGOTIATED TEAM TERM (owner ruling: "all commission agreements
              can be negotiated per agent before signing"). Until this field
              existed, `agent_commission_profiles.team_override_percent` had no
              writer at all — a negotiated percentage could be agreed and had
              nowhere to be recorded, so the engine always charged the team default.
              Max is 99.9999, not 100: the column is numeric(6,4) and refuses 100
              with a numeric-overflow the broker could do nothing about.
            */}
            <div className="space-y-1.5">
              <Label htmlFor="teamOverridePercent">Negotiated Team Split (%)</Label>
              <Input
                id="teamOverridePercent"
                type="number"
                min={0}
                max={99.9999}
                step="0.25"
                value={agent.team_override_percent}
                onChange={(e) => setAgentField("team_override_percent", e.target.value)}
                placeholder="Leave blank to use the team's standard terms"
              />
              <p className="text-xs text-muted-foreground">
                {agentProfile?.teamOverrideUnavailable
                  ? "This agent's negotiated term could not be read — the value shown is not confirmed."
                  : agent.team_override_percent === ""
                    ? "Blank: this agent pays their team's standard percentage."
                    : "This agent's own agreement. It overrides the team's standard percentage on every deal."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Office / Location</Label>
              <Select value={agent.location_id} onValueChange={(v) => setAgentField("location_id", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="No office assigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_OFFICE}>No office assigned</SelectItem>
                  {offices.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {offices.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No offices yet — add them under Admin → Locations.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Commission Agreement — upload-driven form → e-sign → saved on profile */}
      {agentProfile && <CommissionAgreementCard targetUserId={user.id} />}

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
