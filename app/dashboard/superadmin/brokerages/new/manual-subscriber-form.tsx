"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, CheckCircle2 } from "lucide-react"
import { manualProvisionSubscriberAction } from "@/app/actions/superadmin/manual-subscriber"

type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

export function ManualSubscriberForm() {
  const router = useRouter()
  const [tier, setTier] = useState<CanonicalTier>("team")
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly")
  const [brokerageName, setBrokerageName] = useState("")
  const [brokerageEmail, setBrokerageEmail] = useState("")
  const [brokeragePhone, setBrokeragePhone] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [adminEmail, setAdminEmail] = useState("")
  const [notes, setNotes] = useState("")

  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string; brokerageId?: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFeedback(null)
    startTransition(async () => {
      const r = await manualProvisionSubscriberAction({
        brokerageName, brokerageCity: city || undefined, brokerageState: state || undefined,
        brokerageEmail, brokeragePhone: brokeragePhone || undefined,
        adminFirstName: firstName, adminLastName: lastName, adminEmail,
        tier, billingCycle, notes: notes || undefined,
      })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({
        kind: "success",
        message: `Provisioned ${brokerageName} on ${tier}. ${r.inviteSent ? "Invite email sent" : `Invite email ${r.inviteError ? "FAILED: " + r.inviteError : "skipped"}`}.`,
        brokerageId: r.brokerageId,
      })
    })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Tier + billing */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Plan</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {(["solo_agent","team","brokerage","multi_location"] as const).map(t => (
              <Button key={t} type="button" size="sm"
                variant={tier === t ? "default" : "outline"}
                onClick={() => setTier(t)}>
                {t === "solo_agent" ? "Solo $99" : t === "team" ? "Team $299" : t === "brokerage" ? "Brokerage $799" : "Multi-loc $1,999"}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            {(["monthly","annual"] as const).map(b => (
              <Button key={b} type="button" size="sm"
                variant={billingCycle === b ? "default" : "outline"}
                onClick={() => setBillingCycle(b)}>
                {b.charAt(0).toUpperCase() + b.slice(1)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Brokerage</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="brokerageName">Brokerage name</Label>
            <Input id="brokerageName" required value={brokerageName} onChange={e => setBrokerageName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="brokerageEmail">Brokerage email</Label>
              <Input id="brokerageEmail" type="email" required value={brokerageEmail} onChange={e => setBrokerageEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="brokeragePhone">Phone</Label>
              <Input id="brokeragePhone" value={brokeragePhone} onChange={e => setBrokeragePhone(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label htmlFor="city">City</Label>
              <Input id="city" value={city} onChange={e => setCity(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="state">State</Label>
              <Input id="state" value={state} maxLength={2} onChange={e => setState(e.target.value.toUpperCase())} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Billing admin</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="firstName">First name</Label>
              <Input id="firstName" required value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
            <div><Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" required value={lastName} onChange={e => setLastName(e.target.value)} /></div>
          </div>
          <div>
            <Label htmlFor="adminEmail">Admin email (invite goes here)</Label>
            <Input id="adminEmail" type="email" required value={adminEmail} onChange={e => setAdminEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="notes">Internal notes</Label>
            <textarea id="notes" rows={3} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Sales rep: Jane Doe. Custom terms negotiated."
              className="w-full text-sm border rounded p-2" />
          </div>
        </CardContent>
      </Card>

      {feedback && (
        <div className={`rounded-md border p-4 text-sm ${
          feedback.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
        }`}>
          <div className="flex items-center gap-2">
            {feedback.kind === "success" && <CheckCircle2 className="h-4 w-4" />}
            <span>{feedback.message}</span>
          </div>
          {feedback.brokerageId && (
            <div className="mt-2">
              <Button type="button" size="sm" variant="outline"
                onClick={() => router.push(`/dashboard/superadmin/brokerages/${feedback.brokerageId}`)}>
                Open brokerage
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.push("/dashboard/superadmin/brokerages")}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Provisioning…</> : "Create subscriber"}
        </Button>
      </div>
    </form>
  )
}
