"use client"

import { useActionState, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { proposeClosingAppointment, type ClosingAppointmentDeal, type ClosingAppointmentState } from "@/app/actions/title/closing-appointment"

/**
 * The closing-appointment proposal form (wave 147, lane 147H) — bound to the server action through useActionState.
 * The day defaults to the contract's closing date. Under an "on or before" contract an EARLIER day may be proposed — no
 * amendment is needed (wave 149, lane 149G — owner ruling 17 / C33); a fixed "on" day stays fixed here, and any later
 * day is an extension. The server judges the day with the one closing-date assessment either way.
 */
export function ClosingAppointmentForm({ deals }: { deals: ClosingAppointmentDeal[] }) {
  const [state, formAction, pending] = useActionState<ClosingAppointmentState, FormData>(proposeClosingAppointment, null)
  const [dealId, setDealId] = useState(deals[0]?.id ?? "")
  const deal = deals.find((d) => d.id === dealId) ?? deals[0]
  const today = new Date().toISOString().slice(0, 10)
  const fixedDay = deal?.terms === "on"
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="closing-deal">Deal</Label>
        <select id="closing-deal" name="transactionId" value={dealId} onChange={(e) => setDealId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
          {deals.map((d) => <option key={d.id} value={d.id}>{d.propertyAddress ?? "Deal"} — closes {d.terms === "on_or_before" ? "on or before" : d.terms === "on" ? "on" : "by"} {d.closeDate}</option>)}
        </select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="closing-date">{fixedDay ? "Date (fixed by the contract)" : "Date (the contract's day, or earlier)"}</Label>
          {fixedDay
            ? <Input id="closing-date" name="date" value={deal?.closeDate ?? ""} readOnly aria-readonly="true" />
            : <Input key={deal?.id} id="closing-date" name="date" type="date" defaultValue={deal?.closeDate ?? ""} min={today} max={deal?.closeDate ?? undefined} required />}
          <p className="text-xs text-muted-foreground">
            {deal?.terms === "on_or_before" ? "The contract says \"on or before\" — an earlier day needs no amendment; the agent confirms everyone is ready."
              : fixedDay ? "The contract fixes the day (\"on\") — moving it needs an amendment every party signs; ask the transaction coordinator."
              : "The contract's wording is not recorded yet — an earlier day is sent to the agent to confirm against the executed contract."}
          </p>
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
