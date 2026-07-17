"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { inviteUser } from "@/app/actions/admin/invite-user"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
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
import { Plus, CheckCircle2 } from "lucide-react"

interface InviteUserButtonProps {
  callerRole: string
  brokerageId?: string | null
}

const ALL_ROLES = [
  { value: "agent", label: "Agent" },
  { value: "broker", label: "Broker" },
  { value: "admin", label: "Admin" },
  { value: "tc", label: "Transaction Coordinator" },
  { value: "isa", label: "ISA" },
  { value: "team_lead", label: "Team Lead" },
  { value: "vendor", label: "Vendor" },
  { value: "lender", label: "Lender" },
]

// Tenant admins/brokers may now invite admin/broker peers into their own
// brokerage (the server action pins the invite to the caller's brokerage), so
// the full role list is offered to everyone who can see this button.

export function InviteUserButton({ callerRole, brokerageId }: InviteUserButtonProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    email: "",
    firstName: "",
    lastName: "",
    userType: "",
    brokerageIdOverride: "",
  })

  const isSuperadmin = callerRole === "superadmin"
  const availableRoles = ALL_ROLES

  function updateForm(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  function handleOpen() {
    setOpen(true)
    setSuccess(false)
    setError(null)
    setForm({ email: "", firstName: "", lastName: "", userType: "", brokerageIdOverride: "" })
  }

  async function handleSubmit() {
    setError(null)
    setInviting(true)
    const res = await inviteUser({
      email: form.email,
      firstName: form.firstName,
      lastName: form.lastName,
      userType: form.userType,
      brokerageId: isSuperadmin
        ? form.brokerageIdOverride || brokerageId || undefined
        : brokerageId || undefined,
    })
    setInviting(false)
    if (res.success) {
      setSuccess(true)
      router.refresh()
    } else {
      setError(res.error || "Invite failed. Please try again.")
    }
  }

  const canSubmit =
    form.email.trim() !== "" &&
    form.userType !== "" &&
    form.email.includes("@")

  return (
    <>
      <Button
        size="sm"
        className="bg-blue-600 hover:bg-blue-700 text-white"
        onClick={handleOpen}
      >
        <Plus className="w-4 h-4 mr-2" />
        Invite User
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          {success ? (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-green-600" />
              </div>
              <div>
                <h2 className="text-lg font-bold">Invite Sent</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  An invite email has been sent to <strong>{form.email}</strong>
                </p>
              </div>
              <div className="flex gap-2 w-full">
                <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => {
                    setSuccess(false)
                    setForm({
                      email: "",
                      firstName: "",
                      lastName: "",
                      userType: "",
                      brokerageIdOverride: "",
                    })
                    setError(null)
                  }}
                >
                  Invite Another
                </Button>
              </div>
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Invite User</DialogTitle>
                <DialogDescription>
                  Send an invite email to add a new user to the platform
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 mt-2">
                <div>
                  <Label htmlFor="inviteEmail">Email *</Label>
                  <Input
                    id="inviteEmail"
                    type="email"
                    value={form.email}
                    onChange={(e) => updateForm("email", e.target.value)}
                    placeholder="user@example.com"
                    className="mt-1"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="inviteFirst">First Name</Label>
                    <Input
                      id="inviteFirst"
                      value={form.firstName}
                      onChange={(e) => updateForm("firstName", e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="inviteLast">Last Name</Label>
                    <Input
                      id="inviteLast"
                      value={form.lastName}
                      onChange={(e) => updateForm("lastName", e.target.value)}
                      className="mt-1"
                    />
                  </div>
                </div>

                <div>
                  <Label>Role *</Label>
                  <Select value={form.userType} onValueChange={(v) => updateForm("userType", v)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Select role..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableRoles.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {isSuperadmin && (
                  <div>
                    <Label htmlFor="inviteBrokerageId">Brokerage ID (optional)</Label>
                    <Input
                      id="inviteBrokerageId"
                      value={form.brokerageIdOverride}
                      onChange={(e) => updateForm("brokerageIdOverride", e.target.value)}
                      placeholder="Leave blank for platform-level user"
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Leave blank to create a platform-level user
                    </p>
                  </div>
                )}

                {error && (
                  <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setOpen(false)} disabled={inviting}>
                    Cancel
                  </Button>
                  <Button onClick={handleSubmit} disabled={!canSubmit || inviting}>
                    {inviting ? "Sending..." : "Send Invite"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
