"use client"

// CLOSING WITHOUT A CDA — THE SMALLEST HONEST CLOSING PROOF (wave 151, lane 151K; owner: "if the brokerage doesn't use CDAs …
// it can close without a CDA"). Final settlement / closing record · the brokerage's recorded receipt (who, when) · transaction
// compliance status · the payout holds as they stand. Funds are never shown as received because a closing date exists; nothing on
// this card creates a CDA or releases a payout. Rule: lib/transactions/cda-closing-policy.ts noCdaClosingProof.

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getNoCdaClosingProofAction } from "@/app/actions/transactions/closing-proof"

type Loaded = Extract<Awaited<ReturnType<typeof getNoCdaClosingProofAction>>, { success: true }>

const ok = (b: boolean): "default" | "secondary" => (b ? "default" : "secondary")

export function ClosingProofCard({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await getNoCdaClosingProofAction({ transactionId })
      if (!r.success) { setError(r.error); return }
      setError(null)
      setData(r)
    })
  }, [transactionId])

  useEffect(() => { load() }, [load])

  const p = data?.proof
  return (
    <Card>
      <CardHeader>
        <CardTitle>Closing without a CDA — the closing proof</CardTitle>
        <CardDescription>
          This brokerage does not issue a CDA. The deal closes on the title company&apos;s final settlement record, the brokerage&apos;s
          recorded receipt of the commission and the transaction&apos;s compliance status. A closing date is not a receipt.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <p className="text-xs text-red-600">{error}</p>}
        {pending && !data && <p className="text-xs text-muted-foreground">Reading the closing evidence…</p>}
        {p && (
          <>
            {p.mode === "cda" && <p className="text-xs text-muted-foreground">This brokerage uses a CDA — the CDA workflow above is the closing proof; this reading is informational.</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded border p-2">
                <div className="flex items-center justify-between"><span className="font-medium">Final settlement / closing record</span><Badge variant={ok(p.settlement.status === "on_file")}>{p.settlement.status === "on_file" ? "on file" : "missing"}</Badge></div>
                {p.settlement.status === "on_file" && <p className="text-xs text-muted-foreground mt-1">document {p.settlement.documentId}{p.settlement.actor ? ` · from ${p.settlement.actor}` : " · uploader not recorded"}{p.settlement.at ? ` · ${p.settlement.at.slice(0, 10)}` : ""}</p>}
              </div>
              <div className="rounded border p-2">
                <div className="flex items-center justify-between"><span className="font-medium">Brokerage receipt of the commission</span><Badge variant={ok(p.receipt.status === "recorded")}>{p.receipt.status.replace(/_/g, " ")}</Badge></div>
                <p className="text-xs text-muted-foreground mt-1">{p.receipt.status === "recorded" ? `recorded ${p.receipt.at?.slice(0, 10) ?? ""}${p.receipt.by ? ` by ${p.receipt.by}` : ""}` : p.receipt.basis}</p>
              </div>
              <div className="rounded border p-2">
                <div className="flex items-center justify-between"><span className="font-medium">Transaction compliance</span><Badge variant={ok(p.compliance.status === "passed")}>{p.compliance.status.replace(/_/g, " ")}</Badge></div>
                <p className="text-xs text-muted-foreground mt-1">{p.compliance.status === "passed" ? `passed ${p.compliance.passedAt?.slice(0, 10) ?? ""}` : p.compliance.status === "open_blocking" ? `${p.compliance.openBlocking} blocking item(s) open` : "not passed yet"}</p>
              </div>
              <div className="rounded border p-2">
                <div className="flex items-center justify-between"><span className="font-medium">Payout</span><Badge variant="outline">{p.payout.state.replace(/_/g, " ")}</Badge></div>
                <p className="text-xs text-muted-foreground mt-1">{p.payout.detail}{p.payout.lifetimeHold === "open" ? " · CLOSED / PAYOUT PENDING — the lifetime conversion is held until the payout is recorded" : ""}</p>
              </div>
            </div>
            <p className="text-xs">Funds received: <strong>{p.fundsReceived ? "yes — recorded by a person" : "no — not recorded"}</strong>{p.closed && !p.fundsReceived ? " (the deal is closed; a closing date is not a receipt)" : ""}</p>
            {p.missing.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">{p.missing.map((m) => <li key={m}>{m}</li>)}</ul>
            )}
            {/* WAVE 152 (lane 152G — owner: "that is not informational"): the closing question holds the close until it is answered "no". */}
            <p className="text-xs text-muted-foreground">
              Closing question — required before closing: {data?.attestation.status === "pass" ? "answered — no executed change is unrecorded" : data?.attestation.status === "fail" ? "an executed change was reported as not recorded yet; record it, then answer again" : "not answered yet — answer it below"}.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
