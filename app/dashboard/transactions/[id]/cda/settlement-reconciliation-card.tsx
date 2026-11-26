"use client"

// THE SETTLEMENT RECONCILIATION (wave 152, lane 152G; owner: "anytime there is a change at closing to transaction, the final closing
// desclosure has to be correct … that is not informational"). Shown on the deal's closing page in BOTH CDA modes: per item what the
// executed contract says beside what the latest title / lender document says, who corrects it, the correction-request status and
// whether the closing is ready, needs review, is awaiting a revised closing document or is compliance blocked. Read-only — the
// official documents are corrected by their issuer, never here. Role privacy is applied by the server (buyer-only / seller-only lines,
// commission values for staff only). Rules: lib/transactions/cda-closing-policy.ts reconcileSettlement / settlementReconciliationForViewer.

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getSettlementReconciliationAction } from "@/app/actions/transactions/closing-proof"
import { SETTLEMENT_READINESS_LABEL, SETTLEMENT_ITEM_CATALOG } from "@/lib/transactions/cda-closing-policy"

type Loaded = Extract<Awaited<ReturnType<typeof getSettlementReconciliationAction>>, { success: true }>

const STATE_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  ready: "default", needs_review: "secondary", awaiting_revised_document: "outline", compliance_blocked: "destructive",
}
const BASIS_WORDS: Record<string, string> = { exact: "calculated from the executed contract", extracted_estimate: "estimate", authoritative_required: "issuer's figure" }
const REQUEST_WORDS: Record<string, string> = {
  none: "No correction requested",
  open_task: "A correction task is open for the transaction coordinator",
  requested: "Correction requested from the title company — waiting for the revised statement",
  revision_received: "A revised statement arrived after the request and was compared",
}

export function SettlementReconciliationCard({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showBasis, setShowBasis] = useState(false)
  const [pending, startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await getSettlementReconciliationAction({ transactionId })
      if (!r.success) {
        setError(r.error === "forbidden" ? "This closing check is visible to the deal's agents, its transaction coordinator and brokerage staff." : "The closing check could not be loaded right now. Nothing was changed — try again in a moment.")
        return
      }
      setError(null)
      setData(r)
    })
  }, [transactionId])

  useEffect(() => { load() }, [load])

  const rec = data?.reconciliation ?? null
  const rows = rec ? rec.items.filter((i) => i.status !== "agrees" || i.basis !== "exact") : []
  const agreeing = rec ? rec.items.filter((i) => i.status === "agrees" && i.basis === "exact").length : 0
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Closing Disclosure and settlement check
          {rec && <Badge variant={STATE_VARIANT[rec.state] ?? "outline"}>{SETTLEMENT_READINESS_LABEL[rec.state]}</Badge>}
        </CardTitle>
        <CardDescription>
          What the executed contract says, beside what the latest title company or lender document says. The deal closes only when they
          agree and the final statement is on file. The lender or title company corrects its own document — nothing here edits it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <p className="text-xs text-red-600">{error}</p>}
        {pending && !data && <p className="text-xs text-muted-foreground">Reading the closing check…</p>}
        {data && !rec && (
          <p className="text-xs text-muted-foreground">
            Not checked yet. It runs automatically when a settlement statement or Closing Disclosure is uploaded, when an executed
            change is recorded, and every time someone tries to close the deal.
          </p>
        )}
        {rec && (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded border p-2">
                <div className="font-medium">Closing record</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {rec.record.kind === "settlement_statement" ? "Settlement statement (cash or non-TRID closing — no borrower Closing Disclosure)" : rec.record.kind === "trid_cd" ? "Closing Disclosure and settlement statement" : "Closing record (financing not recorded yet)"}
                  {" · "}{rec.record.finalOnFile ? "final on file" : "final not on file yet"}
                  {rec.record.versions > 1 ? ` · ${rec.record.versions} versions received` : ""}
                </p>
                <p className="text-xs text-muted-foreground">Issued by {rec.record.issuer}.</p>
              </div>
              <div className="rounded border p-2">
                <div className="font-medium">Correction request</div>
                <p className="text-xs text-muted-foreground mt-1">{REQUEST_WORDS[rec.request.status] ?? rec.request.status}{rec.request.requestedAt ? ` (${rec.request.requestedAt.slice(0, 10)})` : ""}</p>
                {rec.trid.path !== "not_applicable" && <p className="text-xs text-muted-foreground">{rec.trid.detail}</p>}
              </div>
            </div>
            {rows.length > 0 && (
              <ul className="space-y-2 sm:hidden">
                {rows.map((i) => (
                  <li key={i.key} className="rounded border p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1 font-medium">{i.label}{i.blocking && <Badge variant="destructive">holds closing</Badge>}</div>
                    <div className="text-muted-foreground">{BASIS_WORDS[i.basis] ?? i.basis}</div>
                    <div className="mt-1">Contract says: {i.contractSays ?? "—"}</div>
                    <div>Latest title / lender document says: {i.documentSays ?? (i.status === "missing_on_document" ? "not shown" : "—")}</div>
                    {(i.responsible || i.action) && <div className="mt-1">{i.responsible ? <span className="font-medium">{i.responsible}. </span> : null}{i.action ?? ""}</div>}
                  </li>
                ))}
              </ul>
            )}
            {rows.length > 0 && (
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">Item</th>
                      <th className="py-1 pr-2 font-medium">Contract says</th>
                      <th className="py-1 pr-2 font-medium">Latest title / lender document says</th>
                      <th className="py-1 pr-2 font-medium">Who corrects it · next step</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i) => (
                      <tr key={i.key} className="border-t align-top">
                        <td className="py-1 pr-2">
                          {i.label}
                          {i.blocking && <Badge variant="destructive" className="ml-1">holds closing</Badge>}
                          <div className="text-muted-foreground">{BASIS_WORDS[i.basis] ?? i.basis}</div>
                        </td>
                        <td className="py-1 pr-2">{i.contractSays ?? "—"}</td>
                        <td className="py-1 pr-2">{i.documentSays ?? (i.status === "missing_on_document" ? "not shown" : "—")}</td>
                        <td className="py-1 pr-2">{i.responsible ? <span className="font-medium">{i.responsible}. </span> : null}{i.action ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {agreeing > 0 ? `${agreeing} contract term${agreeing === 1 ? "" : "s"} agree with the latest document. ` : ""}
              {rec.withheld > 0 ? `${rec.withheld} line${rec.withheld === 1 ? " belongs" : "s belong"} to the other party's disclosure and ${rec.withheld === 1 ? "is" : "are"} not shown to your side. ` : ""}
              {data?.snapshot?.version ? `Version ${data.snapshot.version}, checked ${data.snapshot.at?.slice(0, 10) ?? ""}. Earlier versions are kept.` : ""}
            </p>
            <button type="button" className="text-xs underline" onClick={() => setShowBasis((v) => !v)}>{showBasis ? "Hide" : "Show"} what VIPAgents calculates and what only the issuer can state</button>
            {showBasis && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {SETTLEMENT_ITEM_CATALOG.map((c) => <li key={c.key}>{c.label}: {BASIS_WORDS[c.basis]}{c.evaluated ? "" : " (shown, not compared yet)"} — {c.note}</li>)}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
