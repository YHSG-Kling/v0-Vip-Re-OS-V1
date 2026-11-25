"use client"

/**
 * GOVERNING-TERMS PROPOSALS — the human review of what a model read out of a contract (wave 156, lane 156E).
 *
 * Shows each UNDECIDED proposed term beside the deal's current value; Accept or Dismiss is per field. Both doors ask the deal
 * desk (app/actions/governing-terms.ts): a seat that does not work the deal sees the refusal text, and nothing changes.
 * Self-contained: mount it with the deal's id; it renders nothing when there is nothing to decide.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { confirmGoverningTermsAction, loadProposedGoverningTermsAction, type ProposedTermView } from "@/app/actions/governing-terms"

const show = (v: string | number | null) => (v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? v.toLocaleString("en-US") : String(v))

export function GoverningTermsProposalsCard({ transactionId }: { transactionId: string }) {
  const [terms, setTerms] = useState<ProposedTermView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await loadProposedGoverningTermsAction(transactionId)
    if (r.success) { setTerms(r.terms); setError(null) } else { setTerms([]); setError(r.error) }
  }, [transactionId])
  useEffect(() => { void load() }, [load])

  async function decide(t: ProposedTermView, how: "accept" | "dismiss") {
    const key = `${t.proposalId}:${t.field}`
    setBusy(key); setError(null); setDone(null)
    const r = await confirmGoverningTermsAction({ transactionId, proposalId: t.proposalId, [how]: [t.field] })
    setBusy(null)
    if (!r.success) { setError(r.error); return }
    setDone(how === "accept" ? `${t.label} accepted — the deal now reads ${show(t.proposed)}.` : `${t.label} dismissed — the deal is unchanged.`)
    await load()
  }

  if (terms === null) return null
  if (terms.length === 0 && !error) return null
  return (
    <Card data-testid="governing-terms-proposals">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Proposed contract terms</CardTitle>
        <p className="text-xs text-muted-foreground">Read from a contract by AI. Nothing on the deal changes until you accept a term.</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {done && <p role="status" className="text-sm text-green-700">{done}</p>}
        {terms.map((t) => {
          const key = `${t.proposalId}:${t.field}`
          return (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm" data-field={t.field}>
              <div className="min-w-0">
                <div className="font-medium">{t.label}</div>
                <div className="text-xs text-muted-foreground">
                  Current: <span data-role="current">{show(t.current)}</span> · Proposed: <span data-role="proposed" className="font-medium text-foreground">{show(t.proposed)}</span>
                  {" · "}from {t.source.kind === "client_document" ? (t.source.document_name || "an uploaded document") : "pasted contract text"}
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" disabled={busy !== null} onClick={() => decide(t, "accept")} aria-label={`Accept ${t.label}`}>Accept</Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => decide(t, "dismiss")} aria-label={`Dismiss ${t.label}`}>Dismiss</Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
