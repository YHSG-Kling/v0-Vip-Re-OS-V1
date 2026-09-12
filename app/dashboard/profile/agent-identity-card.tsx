"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { User, Save, AlertCircle } from "lucide-react"
import { toast } from "sonner"
import { updateMyAgentIdentity, type AgentIdentity } from "@/app/actions/user-profile"

/**
 * The agent's own professional identity — editable by them.
 *
 * Walkthrough [44]: the profile page was a settings page, and the one identity card on
 * it was read-only with "edit via admin". In real estate this is the material the agent
 * is judged on — it appears on listing presentations, client email, their public site,
 * and the license line compliance requires. Needing a broker to fix a typo in your own
 * license number is the wrong shape, so this writes the caller's own rows only.
 */
export function AgentIdentityCard({
  identity,
  email,
  role,
  isAgent,
}: {
  identity: AgentIdentity
  email: string | null
  role: string | null
  isAgent: boolean
}) {
  const [form, setForm] = useState(identity)
  const [pending, start] = useTransition()

  const set = <K extends keyof AgentIdentity>(k: K, v: AgentIdentity[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  // License is a compliance surface: a number with no state (or the reverse) is a
  // half-record, so say so rather than silently accepting it.
  const licenseHalfFilled =
    (!!form.licenseNumber && !form.licenseState) || (!!form.licenseState && !form.licenseNumber)

  function save() {
    start(async () => {
      const res = await updateMyAgentIdentity({
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone,
        bio: form.bio,
        licenseNumber: form.licenseNumber,
        licenseState: form.licenseState,
        licenseExpiry: form.licenseExpiry,
        phoneMobile: form.phoneMobile,
        phoneOffice: form.phoneOffice,
        yearsExperience: form.yearsExperience,
      })
      if (res.success) toast.success("Profile saved")
      else toast.error(res.error ?? "Couldn't save your profile")
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <User className="h-4 w-4" />
          Who you are
          {role && <Badge variant="outline" className="ml-auto text-xs capitalize">{role}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={form.firstName ?? ""} onChange={e => set("firstName", e.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={form.lastName ?? ""} onChange={e => set("lastName", e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Email" hint="Changing your sign-in email is handled by your broker.">
            <Input value={email ?? ""} disabled />
          </Field>
          <Field label="Phone">
            <Input value={form.phone ?? ""} onChange={e => set("phone", e.target.value)} placeholder="(555) 555-5555" />
          </Field>
        </div>

        {isAgent && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Mobile">
                <Input value={form.phoneMobile ?? ""} onChange={e => set("phoneMobile", e.target.value)} />
              </Field>
              <Field label="Office">
                <Input value={form.phoneOffice ?? ""} onChange={e => set("phoneOffice", e.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="License #">
                <Input value={form.licenseNumber ?? ""} onChange={e => set("licenseNumber", e.target.value)} />
              </Field>
              <Field label="License state" hint="2-letter code">
                <Input
                  value={form.licenseState ?? ""}
                  onChange={e => set("licenseState", e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="CA"
                  maxLength={2}
                />
              </Field>
              <Field label="License expires">
                <Input
                  type="date"
                  value={form.licenseExpiry ?? ""}
                  onChange={e => set("licenseExpiry", e.target.value || null)}
                />
              </Field>
            </div>

            {licenseHalfFilled && (
              <p className="text-xs text-amber-600 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                A license number and its state belong together — disclosure lines need both.
              </p>
            )}

            <Field label="Years in real estate">
              <Input
                type="number"
                min={0}
                max={80}
                className="sm:w-32"
                value={form.yearsExperience ?? ""}
                onChange={e => set("yearsExperience", e.target.value === "" ? null : Number(e.target.value))}
              />
            </Field>

            <Field label="Bio" hint="Used on your public site and listing presentations.">
              <Textarea
                rows={4}
                value={form.bio ?? ""}
                onChange={e => set("bio", e.target.value)}
                placeholder="How you work, who you serve, what you're known for."
              />
            </Field>
          </>
        )}

        <Button size="sm" onClick={save} disabled={pending}>
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {pending ? "Saving…" : "Save profile"}
        </Button>
      </CardContent>
    </Card>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
