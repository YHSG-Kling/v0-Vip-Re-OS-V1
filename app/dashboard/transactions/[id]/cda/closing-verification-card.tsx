"use client"

// ASK AT CLOSING (wave 145, lane 145C; owner rulings 6/7). The five layers — signed agreements, current effective terms, the
// offer/counters/addenda, the settlement statement, the commission waterfall — and ONE question for the agent before the CDA is
// submitted: is any executed change unrecorded? A "yes" holds the CDA until the executed evidence is recorded through its own
// door; the answer itself changes no term, agreement or ledger entry. Rules: lib/commission/closing-verification.ts.

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { getClosingVerificationAction, recordClosingAttestationAction } from "@/app/actions/commission-policy/closing-verification"
import { requestCdaCorrectionAction } from "@/app/actions/cda-portal"

type Loaded = Extract<Awaited<ReturnType<typeof getClosingVerificationAction>>, { success: true }>

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  consistent: "default", finding: "destructive", missing: "secondary", unreadable: "outline",
}

export function ClosingVerificationCard({ transactionId }: { transactionId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [description, setDescription] = useState("")
  const [correction, setCorrection] = useState("")
  const [correctionResult, setCorrectionResult] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const load = useCallback(() => {
    startTransition(async () => {
      const r = await getClosingVerificationAction({ transactionId })
      if (!r.success) { setError(r.error); return }
      setError(null)
      setData(r)
    })
  }, [transactionId])

  useEffect(() => { load() }, [load])

  const answer = (a: "no_unrecorded_change" | "unrecorded_change_reported") => {
    startTransition(async () => {
      const r = await recordClosingAttestationAction({ transactionId, answer: a, description: a === "unrecorded_change_reported" ? description : null })
      if (!r.success) { setError(r.error); return }
      setDescription("")
      load()
    })
  }

  // Compliance roster only (the action refuses everyone else): re-open an approved / sent CDA for an executed change that
  // arrived some other way than the addendum door (owner ruling 8 — the CDA follows the contract).
  const requestCorrection = () => {
    startTransition(async () => {
      const r = await requestCdaCorrectionAction({ transactionId, reason: correction })
      if (!r.success) { setError(r.error); return }
      setCorrection("")
      setCorrectionResult(`${r.outcome.replace(/_/g, " ")}${r.resendToTitle ? " — re-send the corrected CDA to the closing agent" : ""}`)
      load()
    })
  }

  const status = data?.attestation.status ?? null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Closing verification</CardTitle>
        <CardDescription>
          Before the CDA is submitted: the signed agreements, the terms in force, the executed contract and its addenda, the
          settlement statement and the commission calculation are compared — and you confirm whether any executed change is not
          recorded yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <ul className="space-y-2">
          {(data?.layers ?? []).map((l) => (
            <li key={l.key} className="rounded-md border p-3 text-sm space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{l.label}</span>
                <Badge variant={STATUS_VARIANT[l.status] ?? "outline"}>{l.status}</Badge>
              </div>
              {l.facts.map((f, i) => <p key={`f${i}`} className="text-xs text-muted-foreground">{f}</p>)}
              {l.findings.map((f, i) => <p key={`x${i}`} className="text-xs text-destructive">{f}</p>)}
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Has anything been signed that is not recorded here — an agreement amendment, a contract addendum, a fee change, a referral agreement?</p>
          <p className="text-xs text-muted-foreground">
            {status === "pass" ? "You confirmed nothing is unrecorded." : status === "fail" ? (data?.attestation.reason ?? "An unrecorded change was reported.") : status === "pending" ? (data?.attestation.reason ?? "Awaiting your answer.") : "Not asked yet — submitting the CDA asks it."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="sm" disabled={pending} onClick={() => answer("no_unrecorded_change")}>No — everything executed is recorded</Button>
          </div>
          <Textarea placeholder="Yes: what changed, and where is the executed paper?" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Button size="sm" variant="outline" disabled={pending || description.trim().length < 10} onClick={() => answer("unrecorded_change_reported")}>
            Yes — report an unrecorded executed change
          </Button>
        </div>
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Compliance: re-open the CDA for an executed change</p>
          <Textarea placeholder="What changed, and the executed document it is in" value={correction} onChange={(e) => setCorrection(e.target.value)} />
          <Button size="sm" variant="outline" disabled={pending || correction.trim().length < 5} onClick={requestCorrection}>Re-open the CDA for correction</Button>
          {correctionResult ? <p className="text-xs text-muted-foreground">{correctionResult}</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}
