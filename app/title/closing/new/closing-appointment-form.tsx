"use client"

import { useActionState, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { proposeClosingAppointment, type ClosingAppointmentDeal, type ClosingAppointmentState } from "@/app/actions/title/closing-appointment"

/**
 * The closing-appointment proposal form (wave 147, lane 147H) — bound to the server action through useActionState.
 * The date is the contract's closing date, shown read-only (a different day is an amendment, refused server-side too).
 */
export function ClosingAppointmentForm({ deals }: { deals: ClosingAppointmentDeal[] }) {
  const [state, formAction, pending] = useActionState<ClosingAppointmentState, FormData>(proposeClosingAppointment, null)
  const [dealId, setDealId] = useState(deals[0]?.id ?? "")
  const deal = deals.find((d) => d.id === dealId) ?? deals[0]
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="closing-deal">Deal</Label>
        <select id="closing-deal" name="transactionId" value={dealId} onChange={(e) => setDealId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
          {deals.map((d) => <option key={d.id} value={d.id}>{d.propertyAddress ?? "Deal"} — closes {d.closeDate}</option>)}
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="closing-date">Date (from the contract)</Label>
          <Input id="closing-date" name="date" value={deal?.closeDate ?? ""} readOnly aria-readonly="true" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="closing-time">Time</Label>
          <Input id="closing-time" name="time" type="time" required />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="closing-location">Place</Label>
        <Input id="closing-location" name="location" required maxLength={300} placeholder="Our office, 200 Main St, Suite 4 — or mobile signing at the property" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="closing-note">Note for the agent (optional)</Label>
        <Textarea id="closing-note" name="note" maxLength={600} rows={2} placeholder="Bring photo ID; wire confirmation must be verbal, by phone." />
      </div>
      {state && <p className={`text-sm ${state.ok ? "text-foreground" : "text-destructive"}`} role={state.ok ? "status" : "alert"}>{state.message}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send to the deal's agent"}</Button>
    </form>
  )
}
