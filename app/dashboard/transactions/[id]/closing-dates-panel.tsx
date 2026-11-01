"use client"

// app/dashboard/transactions/[id]/closing-dates-panel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSING-DATE MODEL ON THE DEAL (wave 148, lane 148I — owner ruling 21): the contract's deadline and how it is worded
// ("On" vs "On or before"), the anticipated day, and the actual day — three facts, each with its source — plus the one
// door that changes them (recordClosingDateChange): a PROPOSED day moves the anticipated date only (and the panel says what
// the contract would need); an EXECUTED amendment changes the deadline with its reference; the wording is read off the
// executed contract with its reference. The state note names who conducts the closing — the people who decide.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getClosingDates, recordClosingDateChange } from "@/app/actions/transactions"
import { CLOSING_DATE_TERMS, CLOSING_DATE_TERMS_LABELS, type ClosingDates, type ClosingDateChangeAssessment } from "@/lib/transactions/closing-dates"
import { OVERRIDE_REASON_MIN_CHARS } from "@/lib/kernel/status-override"

type Kind = "anticipated" | "executed_amendment" | "contract_wording"
const KIND_LABELS: Record<Kind, string> = {
  anticipated: "Expected closing day (a proposal — the contract is unchanged)",
  executed_amendment: "Executed amendment (every party signed)",
  contract_wording: "Contract wording (on / on or before)",
}

export function ClosingDatesPanel({ transactionId }: { transactionId: string }) {
  const [dates, setDates] = useState<ClosingDates | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>("anticipated")
  const [date, setDate] = useState("")
  const [terms, setTerms] = useState<"on" | "on_or_before" | "">("")
  const [reason, setReason] = useState("")
  const [evidenceRef, setEvidenceRef] = useState("")
  const [assessment, setAssessment] = useState<ClosingDateChangeAssessment | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    let live = true
    getClosingDates(transactionId).then((r) => { if (!live) return; if (r.ok) setDates(r.dates); else setError(r.error) })
    return () => { live = false }
  }, [transactionId])

  const submit = () => {
    setError(null)
    start(async () => {
      const r = await recordClosingDateChange({ transactionId, kind, date: kind === "contract_wording" ? null : date || null, terms: terms || null, reason, evidenceRef: evidenceRef || null })
      if (!r.ok) { setError(r.error); setAssessment(r.assessment ?? null); return }
      setDates(r.dates); setAssessment(r.assessment); setReason(""); setEvidenceRef(""); setDate("")
    })
  }

  const fmt = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString() : "—")
  const needsProof = kind !== "anticipated"
  const ready = reason.trim().length >= OVERRIDE_REASON_MIN_CHARS && (!needsProof || evidenceRef.trim().length >= 3) && (kind === "contract_wording" ? !!terms : !!date)

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm font-medium">Closing dates</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {dates && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <p className="text-muted-foreground">Contract deadline</p>
              <p className="font-medium">{dates.contractual ? `${dates.contractual.terms ? CLOSING_DATE_TERMS_LABELS[dates.contractual.terms] : "Wording not read"} ${fmt(dates.contractual.date)}` : "Not on file"}</p>
              {dates.contractual?.source === "executed_amendment" && <p className="text-xs text-muted-foreground">Amended ({dates.contractual.amendmentRef})</p>}
            </div>
            <div>
              <p className="text-muted-foreground">Expected</p>
              <p className="font-medium">{dates.anticipated ? fmt(dates.anticipated.date) : "—"}</p>
              {dates.anticipated && <p className="text-xs text-muted-foreground">{dates.anticipated.basis === "title_schedule" ? "title / escrow appointment" : dates.anticipated.basis === "contract" ? "the contract's day" : "expected day"}</p>}
            </div>
            <div>
              <p className="text-muted-foreground">Actual</p>
              <p className="font-medium">{dates.actual ? fmt(dates.actual.date) : "Not closed"}</p>
            </div>
          </div>
        )}
        {dates && <p className="text-xs text-muted-foreground">{dates.stateNote.note}</p>}
        {dates?.notes.map((n) => <p key={n} className="text-xs text-amber-800">{n}</p>)}
        {assessment && (
          <div className="rounded-md border p-3 space-y-1">
            <p className="font-medium">{assessment.requiresExecutedAmendment ? "This needs an executed amendment" : "Within the contract as written"}</p>
            <p className="text-xs text-muted-foreground">{assessment.explanation}</p>
            <p className="text-xs text-muted-foreground">Coordinate with: {assessment.coordinate.join("; ")}.</p>
          </div>
        )}
        <div className="space-y-2 border-t pt-3">
          <Label htmlFor="closing-kind">Record a change</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger id="closing-kind"><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(KIND_LABELS) as Kind[]).map((k) => <SelectItem key={k} value={k}>{KIND_LABELS[k]}</SelectItem>)}</SelectContent>
          </Select>
          {kind !== "contract_wording" && <Input type="date" aria-label="Closing day" value={date} onChange={(e) => setDate(e.target.value)} />}
          {kind !== "anticipated" && (
            <Select value={terms} onValueChange={(v) => setTerms(v as "on" | "on_or_before")}>
              <SelectTrigger aria-label="Contract wording"><SelectValue placeholder="How the contract words it" /></SelectTrigger>
              <SelectContent>{CLOSING_DATE_TERMS.map((t) => <SelectItem key={t} value={t}>{CLOSING_DATE_TERMS_LABELS[t]}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <Textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`Why (at least ${OVERRIDE_REASON_MIN_CHARS} characters)`} />
          {needsProof && <Input aria-label="Document reference" value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder="The executed document's id or file name" />}
          {error && <p className="text-xs text-red-700">{error}</p>}
          <Button size="sm" onClick={submit} disabled={pending || !ready}>{pending ? "Recording…" : "Record"}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
