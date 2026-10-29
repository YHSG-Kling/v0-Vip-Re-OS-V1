"use client"

/**
 * PROMISED DELIVERABLES — what a lead magnet promised and has NOT delivered yet (wave 146, lane 146F — owner ruling 10).
 *
 * The reader of lib/lead-magnets/promised-deliverables.ts on the Lead Magnets workspace: every open promise (overdue first)
 * with its asset, status, attempts and last failure. "Try again" runs the same governed delivery the capture and the sweep
 * run; "Record hand delivery" records a person's own delivery ONLY with the document that went out (the server refuses an
 * attestation whose document is not this contact's). An empty list says so — it is never a blank box.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { listUndeliveredPromisesAction, retryPromisedDeliveryAction, attestPromiseDeliveredAction } from "@/app/actions/lead-magnets-actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { PackageCheck, RotateCw, AlertTriangle } from "lucide-react"

interface PromiseRow {
  promiseId: string
  contactId: string | null
  assetKind: string
  assetTitle: string | null
  fulfilment: "system" | "human"
  status: string
  attempts: number
  dueAt: string
  overdue: boolean
  lastError: string | null
  escalated: boolean
}

const STATUS_LABEL: Record<string, string> = {
  promised: "Promised",
  delivering: "Delivering",
  asset_missing: "Asset missing",
  awaiting_human: "Agent to deliver",
  failed: "Failed",
}

export function PromisesPanel() {
  const [rows, setRows] = useState<PromiseRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [docFor, setDocFor] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  const load = useCallback(() => {
    listUndeliveredPromisesAction().then((r) => {
      if (!r.success) { setError(r.error ?? "Promises unavailable"); setRows([]); return }
      setError(null)
      setRows(r.promises as PromiseRow[])
    })
  }, [])
  useEffect(() => { load() }, [load])

  const retry = (id: string) => startTransition(async () => {
    const r = await retryPromisedDeliveryAction(id)
    setNote(r.success ? `Promise ${id.slice(0, 8)}: ${r.status} — ${r.detail}` : `Not delivered: ${r.error}`)
    load()
  })
  const attest = (id: string) => startTransition(async () => {
    const doc = (docFor[id] ?? "").trim()
    if (!doc) { setNote("Enter the id of the document you sent (from the contact's documents)."); return }
    const r = await attestPromiseDeliveredAction(id, doc)
    setNote(r.success ? "Recorded as delivered, with the document as evidence." : `Not recorded: ${r.error}`)
    load()
  })

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <PackageCheck className="h-4 w-4 text-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-foreground">Promised deliverables not yet delivered</h2>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
        {rows === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {rows !== null && rows.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">Nothing pending — every guide, book and report a lead magnet promised has been delivered.</p>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((p) => (
              <li key={p.promiseId} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{p.assetTitle ?? p.assetKind}</span>
                  <span className={`text-xs font-medium ${p.overdue ? "text-destructive" : "text-muted-foreground"}`}>
                    {p.overdue && <AlertTriangle className="inline h-3 w-3 mr-1" aria-hidden="true" />}
                    {STATUS_LABEL[p.status] ?? p.status}{p.overdue ? " · overdue" : ""}{p.escalated ? " · raised to the follow-up desk" : ""}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {p.attempts} attempt{p.attempts === 1 ? "" : "s"} · due {new Date(p.dueAt).toLocaleString()}
                  {p.lastError ? ` · ${p.lastError}` : ""}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {p.fulfilment === "system" && (
                    <Button size="sm" variant="outline" className="h-9" disabled={pending} onClick={() => retry(p.promiseId)}>
                      <RotateCw className="h-4 w-4 mr-1" aria-hidden="true" /> Try again
                    </Button>
                  )}
                  <label className="sr-only" htmlFor={`doc-${p.promiseId}`}>Delivered document id</label>
                  <input
                    id={`doc-${p.promiseId}`}
                    className="h-9 w-full sm:w-64 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    placeholder="Delivered document id"
                    value={docFor[p.promiseId] ?? ""}
                    onChange={(e) => setDocFor((m) => ({ ...m, [p.promiseId]: e.target.value }))}
                  />
                  <Button size="sm" className="h-9" disabled={pending} onClick={() => attest(p.promiseId)}>Record hand delivery</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
