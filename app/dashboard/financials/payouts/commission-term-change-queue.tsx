"use client"

// COMMISSION CHANGES AWAITING THE BROKER (wave 153, lane 153B; owner ruling 4). The finance administrators' queue of
// pre-close commission term changes an agent, team lead or TC submitted. Approving moves the deal's governing rate (only if
// it is still the value the request was made against — otherwise the server names the conflict) and re-runs the commission
// waterfall; denying keeps the terms and tells the deal team why. The server decides who may act (the finance roster, from
// the session) — this card only lists and asks.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Scale } from "lucide-react"
import Link from "next/link"
import { useToast } from "@/hooks/use-toast"
import { decideCommissionTermChangeAction, listPendingCommissionTermChangesAction } from "@/app/actions/transactions"
import type { TermChangeRecord } from "@/lib/commission/commission-term-change"

const shown = (vt: "percent" | "flat", v: number | null) =>
  v == null ? "not set" : vt === "percent" ? `${v}%` : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`

const anchorHref = (r: TermChangeRecord) =>
  r.anchor.kind === "transaction" ? `/dashboard/transactions/${r.anchor.id}` : r.anchor.kind === "listing" ? `/dashboard/listings/${r.anchor.id}` : null

export function CommissionTermChangeQueue() {
  const [records, setRecords] = useState<TermChangeRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  function load() {
    startTransition(async () => {
      const r = await listPendingCommissionTermChangesAction()
      if (!r.success) { setError(r.error); setRecords([]); return }
      setError(null)
      setRecords(r.records)
    })
  }
  useEffect(load, [])

  function decide(rec: TermChangeRecord, decision: "approved" | "denied") {
    startTransition(async () => {
      const r = await decideCommissionTermChangeAction({ adjustmentId: rec.id, decision, note: notes[rec.id] ?? null })
      if (!r.success) { toast({ title: decision === "approved" ? "Not approved" : "Not denied", description: r.error, variant: "destructive" }); return }
      toast({
        title: decision === "approved" ? "Commission change approved" : "Commission change denied",
        description: decision === "approved"
          ? [r.recalculated && !r.recalculated.ok ? `The new rate is saved; the commission engine could not recalculate yet: ${r.recalculated.error}` : "The commission was recalculated.", ...r.recheck].join(" ")
          : "The commission stays as it was, and the people on the deal were told why.",
      })
      load()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Scale className="h-5 w-5" /> Commission changes awaiting your decision</CardTitle>
        <CardDescription>Changes the agent, team lead or coordinator on a deal asked for before closing. Nothing changes until you approve.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {records == null && isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {error ? <p className="text-destructive">{error}</p> : null}
        {records && records.length === 0 && !error ? <p className="text-muted-foreground">No commission changes are waiting.</p> : null}
        {(records ?? []).map((r) => {
          const href = anchorHref(r)
          return (
            <div key={r.id} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {shown(r.valueType, r.priorValue)} → {shown(r.valueType, r.value)}
                  <span className="ml-2 text-xs text-muted-foreground">on {href ? <Link href={href} className="underline">this {r.anchor.kind === "transaction" ? "deal" : r.anchor.kind}</Link> : `an ${r.anchor.kind}`} · effective {r.effectiveDate ?? "—"}</span>
                </p>
                <span className="text-xs text-muted-foreground">asked {r.requestedAt ? new Date(r.requestedAt).toLocaleDateString("en-US") : "—"}</span>
              </div>
              {r.reason ? <p className="text-muted-foreground">Reason: {r.reason}</p> : null}
              {r.evidenceDocumentId ? <p className="text-xs text-muted-foreground">Executed amendment on file: {r.evidenceDocumentId}</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Input className="h-8 max-w-xs" placeholder="Note (required to deny)" value={notes[r.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} />
                <Button size="sm" onClick={() => decide(r, "approved")} disabled={isPending}>Approve</Button>
                <Button size="sm" variant="outline" onClick={() => decide(r, "denied")} disabled={isPending || (notes[r.id] ?? "").trim().length < 5}>Deny</Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
