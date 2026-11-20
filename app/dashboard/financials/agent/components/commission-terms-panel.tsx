"use client"

// COMMISSION TERMS — the pre-close change door on a listing, an offer or a deal (wave 153, lane 153B; owner ruling 4:
// "anyone attached to the offer/listing/transaction that holds a seat or admin can change comission terms but not after a
// transaction has closed"). Shows the terms as they stand, the agreement that governs them, whether they are frozen, who
// decides and what a change affects; submits through the ONE governed writer (app/actions/transactions.ts
// requestCommissionTermChangeAction → lib/commission/commission-term-change.ts). Nothing here decides who may act — the server
// does, from the session.

import { useState, useTransition } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, Lock, Percent } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  getCommissionTermsAction,
  requestCommissionTermChangeAction,
  withdrawCommissionTermChangeAction,
} from "@/app/actions/transactions"
import type { TermChangeRecord } from "@/lib/commission/commission-term-change"

type View = Extract<Awaited<ReturnType<typeof getCommissionTermsAction>>, { success: true }>["view"]

const STATUS_LABEL: Record<string, string> = {
  requested: "Awaiting the broker",
  approved: "Approved and applied",
  not_required: "Applied",
  denied: "Denied",
  withdrawn: "Withdrawn",
}

const shown = (valueType: "percent" | "flat", v: number | null) =>
  v == null ? "not set" : valueType === "percent" ? `${v}%` : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`

const usd = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`)

function newKey(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

export function CommissionTermsPanel(props: { transactionId?: string | null; offerId?: string | null; listingId?: string | null; label?: string | null }) {
  const anchor = { transactionId: props.transactionId ?? null, offerId: props.offerId ?? null, listingId: props.listingId ?? null }
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [valueType, setValueType] = useState<"percent" | "flat">("percent")
  const [value, setValue] = useState("")
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState("")
  const [evidenceId, setEvidenceId] = useState("")
  const [key, setKey] = useState(newKey)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  function load() {
    startTransition(async () => {
      const r = await getCommissionTermsAction(anchor)
      if (!r.success) { setView(null); setLoadError(r.error); return }
      setLoadError(null)
      setView(r.view)
      setValueType(r.view.valueTypes[0] ?? "percent")
    })
  }

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) { setKey(newKey()); load() }
  }

  function submit() {
    startTransition(async () => {
      const r = await requestCommissionTermChangeAction({
        ...anchor, valueType, value: Number(value), reason, effectiveDate,
        evidenceDocumentId: evidenceId.trim() || null, idempotencyKey: key,
      })
      if (!r.success) { toast({ title: "The commission was not changed", description: r.error, variant: "destructive" }); return }
      toast({
        title: r.applied ? "Commission changed" : "Sent to the broker",
        description: r.applied
          ? [r.recalculated && !r.recalculated.ok ? `The new rate is saved; the commission engine could not recalculate yet: ${r.recalculated.error}` : "The commission was recalculated.", ...r.recheck].join(" ")
          : "Nothing changes until a finance administrator approves it. The people on the deal were told.",
      })
      setValue(""); setReason(""); setEvidenceId(""); setKey(newKey())
      load()
    })
  }

  function withdraw(rec: TermChangeRecord) {
    startTransition(async () => {
      const r = await withdrawCommissionTermChangeAction({ adjustmentId: rec.id })
      if (!r.success) { toast({ title: "Not withdrawn", description: r.error, variant: "destructive" }); return }
      toast({ title: "Request withdrawn", description: "The commission stays as it was." })
      load()
    })
  }

  const current = view ? (valueType === "percent" ? view.current.percent : view.current.flat) : null
  const proposed = Number(value)
  const grossBefore = view?.price != null && valueType === "percent" && current != null ? Math.round(view.price * current) / 100 : null
  const grossAfter = view?.price != null && valueType === "percent" && Number.isFinite(proposed) && proposed > 0 ? Math.round(view.price * proposed) / 100 : null
  const executed = (view?.governing.length ?? 0) > 0

  return (
    <>
      <button type="button" onClick={() => onOpenChange(true)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
        Commission terms
      </button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Percent className="h-4 w-4" /> Commission terms</DialogTitle>
            <DialogDescription>{view?.label ?? props.label ?? "This deal"}{view?.stage ? ` · ${view.stage.replace(/_/g, " ")}` : ""}</DialogDescription>
          </DialogHeader>

          {isPending && !view ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div> : null}
          {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}

          {view ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                {view.valueTypes.map((vt) => (
                  <div key={vt} className="rounded-md border p-3">
                    <p className="text-xs text-muted-foreground">{vt === "percent" ? "Current rate" : "Current flat amount"}</p>
                    <p className="text-lg font-semibold">{shown(vt, vt === "percent" ? view.current.percent : view.current.flat)}</p>
                  </div>
                ))}
              </div>
              {executed ? (
                <p className="text-xs text-muted-foreground">Set by an executed agreement: {view.governing.map((g) => g.kind.replace(/_/g, " ")).join(", ")}. A change needs the executed amendment it rests on.</p>
              ) : (
                <p className="text-xs text-muted-foreground">No executed agreement sets this commission yet.</p>
              )}

              {view.frozen ? (
                <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900"><Lock className="mt-0.5 h-4 w-4 shrink-0" /><p>{view.frozen}</p></div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">{view.approvalNote}</p>
                  {view.valueTypes.length > 1 ? (
                    <div className="flex gap-2">
                      {view.valueTypes.map((vt) => (
                        <Button key={vt} type="button" size="sm" variant={vt === valueType ? "default" : "outline"} onClick={() => setValueType(vt)}>{vt === "percent" ? "Percent" : "Flat amount"}</Button>
                      ))}
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="term-value">{valueType === "percent" ? "New rate (%)" : "New amount ($)"}</Label>
                      <Input id="term-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={valueType === "percent" ? "2.5" : "7500"} />
                    </div>
                    <div>
                      <Label htmlFor="term-effective">Effective date</Label>
                      <Input id="term-effective" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
                    </div>
                  </div>
                  {grossAfter != null ? (
                    <p className="text-xs text-muted-foreground">At the recorded price of {usd(view.price)}, the gross commission moves from {usd(grossBefore)} to {usd(grossAfter)}. Shares, fees and any CDA are recalculated from the new rate.</p>
                  ) : null}
                  <div>
                    <Label htmlFor="term-reason">Why it is changing</Label>
                    <Textarea id="term-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What the client and the agent agreed, and when" rows={2} />
                  </div>
                  {executed ? (
                    <div>
                      <Label htmlFor="term-evidence">Executed amendment (document id)</Label>
                      <Input id="term-evidence" value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} placeholder="The signed amendment stored in Documents" />
                    </div>
                  ) : null}
                  <ul className="list-disc pl-5 text-xs text-muted-foreground">{view.affects.map((a) => <li key={a}>{a}</li>)}</ul>
                </div>
              )}

              {view.history.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium">Changes on record</p>
                  {view.history.map((h) => (
                    <div key={h.id} className="flex items-start justify-between gap-2 rounded-md bg-muted/50 p-2 text-xs">
                      <div>
                        <p>{shown(h.valueType, h.priorValue)} → {shown(h.valueType, h.value)} · effective {h.effectiveDate ?? "—"}</p>
                        {h.reason ? <p className="text-muted-foreground">{h.reason}</p> : null}
                        {h.decisionNote ? <p className="text-muted-foreground">Broker: {h.decisionNote}</p> : null}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge variant="secondary">{STATUS_LABEL[h.approvalStatus] ?? h.approvalStatus}</Badge>
                        {h.approvalStatus === "requested" ? <button type="button" className="underline" onClick={() => withdraw(h)} disabled={isPending}>Withdraw</button> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            {view && !view.frozen ? (
              <Button onClick={submit} disabled={isPending || !value || reason.trim().length < 5}>
                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {view.appliesDirectly ? "Apply change" : "Send for approval"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
