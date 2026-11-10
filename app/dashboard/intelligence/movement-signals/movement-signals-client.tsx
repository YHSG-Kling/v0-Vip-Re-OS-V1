"use client"

// The lead desk's view of early movement signals (wave 147, lane 147Z). Palette tokens only (test:ui-palette-contrast).

import { useState, useTransition } from "react"
import { markMovementSignalOutcomeAction, recordStatedDateAction } from "@/app/actions/movement-signals"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

/** WAVE 151 (151E): one documented door that re-opens a decision for an EXISTING contact (lib/intent/movement-signals.ts EXISTING_CONTACT_CHANGE_DOORS). */
interface ChangeDoorView { kind: string; sourceKey: string; what: string }

interface MovementRecordView {
  id: string
  subject: { type: string; id: string | null; ref: string | null }
  sourceKey: string
  relevance: string
  confidence: string
  identity: string
  observedAt: string
  outcome: string | null
  nextAction: string | null
  evidence: string
  protectedProxy: boolean
  /** C20 (wave 148): the life-event chronology (null on a non-life record). */
  lifeEvent?: string | null
  eventAt?: string | null
  sequence?: number | null
  supersedes?: string | null
}

interface SourceFreshnessView {
  sourceKey: string
  lastPolledAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  promisedFreshnessMinutes: number | null
}

/** C19 (wave 148, lane 148F): one market-registry dataset's verification as the lead desk reads it. */
interface DatasetVerificationView {
  datasetKey: string
  label: string
  kind: string
  markets: string[]
  status: string
  confidence: string
  lastVerifiedAt: string | null
  lastDataAt: string | null
  licence: string
  reasons: string[]
  ingested: boolean
}

const label = (s: string) => s.replace(/_/g, " ")
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never")

export function MovementSignalsClient({ records, sources, freshnessNote, verifications = [], verificationNote = null, verificationPolicy = null, changeDoors = [], deadlineKinds = [] }: { records: MovementRecordView[]; sources: SourceFreshnessView[]; freshnessNote: string | null; verifications?: DatasetVerificationView[]; verificationNote?: string | null; verificationPolicy?: { ttlDays: number; defaultMaxLagDays: number } | null; changeDoors?: ChangeDoorView[]; deadlineKinds?: string[] }) {
  const [rows, setRows] = useState(records)
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // 151E (rows 28 / 29): "they told us a date" — the form is open for ONE contact record at a time; the quote is required.
  const [dateFor, setDateFor] = useState<string | null>(null)
  const [dateForm, setDateForm] = useState<{ kind: string; date: string; quote: string }>({ kind: deadlineKinds[0] ?? "lease_end", date: "", quote: "" })

  const close = (id: string, outcome: "false_positive" | "declined") => {
    startTransition(async () => {
      const r = await markMovementSignalOutcomeAction(id, outcome)
      if (!r.success) { setNote(r.error); return }
      setRows((prev) => prev.map((x) => (x.id === id ? { ...x, outcome } : x)))
      setNote(outcome === "false_positive" ? "Marked as a false positive — the source's weight learns from it." : "Marked as declined — no one will reach out about it.")
    })
  }

  const recordDate = (contactId: string) => {
    startTransition(async () => {
      const r = await recordStatedDateAction({ contactId, kind: dateForm.kind, date: dateForm.date, quote: dateForm.quote })
      if (!r.success) { setNote(r.error); return }
      setDateFor(null)
      setDateForm((f) => ({ ...f, date: "", quote: "" }))
      setNote(r.status === "replayed" ? "That date was already on record — nothing recorded twice." : `Recorded with their words — the decision window and next step were reassessed for this contact (${r.reason}).`)
    })
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Early movement signals</h1>
        <p className="text-sm text-muted-foreground">
          What the watchers noticed about people in your book, and how we know it. An inference is never a fact; a sensitive life event is never the subject of a message — the AI decides how to warm engagement without mentioning it, or hands it to a person when judgment is needed.
        </p>
      </div>
      {note && <p role="status" className="text-sm text-foreground">{note}</p>}

      <Card>
        <CardContent className="p-4 space-y-2">
          <h2 className="text-base font-semibold text-foreground">Source freshness</h2>
          {freshnessNote && <p role="alert" className="text-sm text-destructive">{freshnessNote}</p>}
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No source has been polled for this brokerage yet.</p>
          ) : (
            <ul className="space-y-1">
              {sources.map((s) => (
                <li key={s.sourceKey} className="text-sm text-foreground">
                  <span className="font-medium">{label(s.sourceKey)}</span>
                  <span className="text-muted-foreground"> — last success {day(s.lastSuccessAt)}; {s.promisedFreshnessMinutes != null ? `fresh to within ${s.promisedFreshnessMinutes} minutes` : "no freshness promised yet"}</span>
                  {s.lastError && <span className="text-destructive"> · last error: {s.lastError}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-2">
          <h2 className="text-base font-semibold text-foreground">Dataset verification (market registry)</h2>
          <p className="text-sm text-muted-foreground">
            Only a verified dataset can raise a public-record signal above &ldquo;unknown&rdquo;: a live row read, its license read, its data fresh, nothing drifted since.
            {verificationPolicy && ` A live-row read counts for ${verificationPolicy.ttlDays} days; data older than a dataset's freshness window (${verificationPolicy.defaultMaxLagDays} days unless the dataset names its own) reads stale.`}
          </p>
          {verificationNote && <p role="alert" className="text-sm text-destructive">{verificationNote}</p>}
          <ul className="space-y-1">
            {verifications.map((v) => (
              <li key={v.datasetKey} className="text-sm text-foreground">
                <span className="font-medium">{v.label}</span>
                <span className="rounded border border-border px-2 py-0.5 ml-2 text-xs text-muted-foreground">{v.status}</span>
                <span className="text-muted-foreground"> — {label(v.kind)} · {v.markets.join(", ")} · license {label(v.licence)} · verified {day(v.lastVerifiedAt)} · data to {day(v.lastDataAt)}{v.ingested ? " · swept daily" : " · not swept yet"}</span>
                {v.status !== "verified" && v.reasons.length > 0 && <span className="text-destructive"> · {v.reasons.join("; ")}</span>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {changeDoors.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <h2 className="text-base font-semibold text-foreground">What re-opens a decision for a current contact</h2>
            <p className="text-sm text-muted-foreground">
              A change by someone already in your book is reassessed on the same record — never a new lead, never a purchased record. What they tell us outranks anything a data provider says.
            </p>
            <ul className="space-y-1">
              {changeDoors.map((d) => (
                <li key={d.kind} className="text-sm text-foreground"><span className="font-medium">{label(d.kind)}</span><span className="text-muted-foreground"> — {d.what}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No movement records yet.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{label(r.relevance)}</span>
                  <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">{r.confidence}</span>
                  <span className="text-xs text-muted-foreground">{label(r.subject.type)} · {label(r.sourceKey)} · {day(r.observedAt)}</span>
                  {r.protectedProxy && <span className="text-xs text-muted-foreground">sensitive — never used for targeting</span>}
                  {r.lifeEvent && <span className="text-xs text-muted-foreground">life event #{r.sequence ?? "?"}{r.eventAt ? ` · happened ${day(r.eventAt)}` : ""}{r.supersedes ? " · supersedes an earlier record" : ""}</span>}
                </div>
                <p className="text-sm text-foreground">{r.evidence}</p>
                {r.outcome ? (
                  <p className="text-xs text-muted-foreground">Closed: {label(r.outcome)}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => close(r.id, "false_positive")}>Not accurate</Button>
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => close(r.id, "declined")}>They declined help</Button>
                    {r.subject.type === "contact" && r.subject.id && (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => setDateFor(dateFor === r.id ? null : r.id)}>They told us a date</Button>
                    )}
                  </div>
                )}
                {dateFor === r.id && r.subject.type === "contact" && r.subject.id && (
                  <form className="space-y-2 rounded border border-border p-3" onSubmit={(e) => { e.preventDefault(); recordDate(r.subject.id as string) }}>
                    <p className="text-xs text-muted-foreground">A date the person themselves gave us, with the words they used. A stated date beats any inferred range; a date without its source is not evidence.</p>
                    <div className="flex flex-wrap gap-2">
                      <label className="text-sm text-foreground">
                        Kind of date{" "}
                        <select className="rounded border border-border bg-background px-2 py-1 text-sm" value={dateForm.kind} onChange={(e) => setDateForm((f) => ({ ...f, kind: e.target.value }))}>
                          {deadlineKinds.map((k) => <option key={k} value={k}>{label(k)}</option>)}
                        </select>
                      </label>
                      <label className="text-sm text-foreground">
                        Date{" "}
                        <input type="date" required className="rounded border border-border bg-background px-2 py-1 text-sm" value={dateForm.date} onChange={(e) => setDateForm((f) => ({ ...f, date: e.target.value }))} />
                      </label>
                    </div>
                    <label className="block text-sm text-foreground">
                      Their words (required)
                      <textarea required minLength={5} maxLength={300} className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm" placeholder={"e.g. \"our lease is up at the end of June\""} value={dateForm.quote} onChange={(e) => setDateForm((f) => ({ ...f, quote: e.target.value }))} />
                    </label>
                    <div className="flex gap-2">
                      <Button size="sm" type="submit" disabled={pending}>Record with their words</Button>
                      <Button size="sm" type="button" variant="outline" disabled={pending} onClick={() => setDateFor(null)}>Cancel</Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
