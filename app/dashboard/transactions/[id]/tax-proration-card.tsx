"use client"

// THE PRORATION INPUT SCREEN (wave 145, lane 145Z — lane 145C requirement 7; m873). The settlement agent's property-tax
// proration instruction for this deal, recorded by its TC / agent WITH its source, and the line lane 144D's engine computes
// from it. Every term is asked for — no jurisdiction default is filled in (a nationwide constant is what 144D refused).
// The doors are app/actions/transactions/tax-proration.ts; the vocabularies arrive from the server, never retyped here.
import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getTaxProrationAction, saveTaxProrationAction, type TaxProrationView } from "@/app/actions/transactions/tax-proration"

const LABELS: Record<string, string> = {
  arrears: "In arrears (the seller credits the buyer)",
  advance: "In advance (the buyer reimburses the seller)",
  seller: "The seller owns the closing day",
  buyer: "The buyer owns the closing day",
  actual_365: "Actual days / 365",
  actual_actual: "Actual days / actual days in the period",
  banker_360: "30/360 (banker's year)",
}

type Form = { annualTax: string; periodStart: string; timing: string; closeDate: string; closingDayOwner: string; dayBasis: string; source: string }

const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function TaxProrationCard({ transactionId }: { transactionId: string }) {
  const [view, setView] = useState<TaxProrationView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Form>({ annualTax: "", periodStart: "", timing: "", closeDate: "", closingDayOwner: "", dayBasis: "", source: "" })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let live = true
    getTaxProrationAction(transactionId).then((r) => {
      if (!live) return
      if (r.ok) setView(r.view)
      else setLoadError(r.error)
    }).catch((e) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [transactionId])

  const startEdit = () => {
    const i = view?.instruction
    setForm({
      annualTax: i ? String(i.annualTax) : "",
      periodStart: i?.periodStart ?? "",
      timing: i?.timing ?? "",
      closeDate: i?.closeDate ?? view?.dealCloseDate ?? "",
      closingDayOwner: i?.closingDayOwner ?? "",
      dayBasis: i?.dayBasis ?? "",
      source: i?.source ?? "",
    })
    setError(null)
    setEditing(true)
  }

  const save = () => {
    startTransition(async () => {
      setError(null)
      const r = await saveTaxProrationAction({ transactionId, ...form })
      if (!r.ok) { setError(r.error); return }
      setView(r.view)
      setEditing(false)
    })
  }

  if (loadError) {
    return (
      <Card className="mt-4">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Property-tax proration</CardTitle></CardHeader>
        <CardContent><p className="text-xs text-destructive">The proration instruction could not be read: {loadError}</p></CardContent>
      </Card>
    )
  }
  if (!view) return null

  const line = view.line
  const set = (k: keyof Form) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const pick = (k: keyof Form, values: readonly string[], placeholder: string) => (
    <Select value={form[k] || undefined} onValueChange={set(k)} disabled={pending}>
      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {values.map((v) => <SelectItem key={v} value={v} className="text-xs">{LABELS[v] ?? v}</SelectItem>)}
      </SelectContent>
    </Select>
  )

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Property-tax proration</CardTitle>
        {view.canEdit && !view.notApplied && !editing ? (
          <Button size="sm" variant="outline" className="h-9 text-xs" onClick={startEdit}>
            {view.instruction ? "Update instruction" : "Record the settlement agent's instruction"}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {view.notApplied ? (
          <p className="text-xs text-muted-foreground">The proration instruction cannot be recorded yet — its storage (migration m873) is not applied.</p>
        ) : null}

        {line ? (
          line.pending ? (
            <p className="text-xs text-muted-foreground">{line.note}</p>
          ) : (
            <div className="text-sm">
              <p className="font-medium">
                {line.low >= 0 ? `The seller credits the buyer ${money(line.low)}` : `The buyer reimburses the seller ${money(line.low)}`}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{line.note}</p>
              <p className="text-xs text-muted-foreground mt-1">An estimate from the recorded instruction — the settlement statement is the authority.</p>
            </div>
          )
        ) : null}

        {view.closeDateDiffers ? (
          <p className="text-xs text-amber-700">
            The deal&apos;s closing date ({view.dealCloseDate}) differs from the one in the instruction ({view.instruction?.closeDate}). Re-confirm the proration with the settlement agent.
          </p>
        ) : null}

        {editing ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
            <div className="space-y-1">
              <Label className="text-xs">Tax bill for the whole period ($)</Label>
              <Input className="h-8 text-xs" inputMode="decimal" value={form.annualTax} onChange={(e) => set("annualTax")(e.target.value)} disabled={pending} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tax period starts</Label>
              <Input className="h-8 text-xs" type="date" value={form.periodStart} onChange={(e) => set("periodStart")(e.target.value)} disabled={pending} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">How the taxes are collected</Label>
              {pick("timing", view.options.timings, "Arrears or advance")}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Closing date (per the instruction)</Label>
              <Input className="h-8 text-xs" type="date" value={form.closeDate} onChange={(e) => set("closeDate")(e.target.value)} disabled={pending} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Closing day</Label>
              {pick("closingDayOwner", view.options.closingDayOwners, "Who owns the closing day")}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Day-count basis</Label>
              {pick("dayBasis", view.options.dayBases, "Day count")}
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Source (required)</Label>
              <Input className="h-8 text-xs" placeholder="e.g. the title company's proration instruction, dated …" value={form.source} onChange={(e) => set("source")(e.target.value)} disabled={pending} />
            </div>
            {error ? <p className="text-xs text-destructive sm:col-span-2">{error}</p> : null}
            <div className="flex gap-2 sm:col-span-2">
              <Button size="sm" className="h-9 text-xs" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save instruction"}</Button>
              <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={() => setEditing(false)} disabled={pending}>Cancel</Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
