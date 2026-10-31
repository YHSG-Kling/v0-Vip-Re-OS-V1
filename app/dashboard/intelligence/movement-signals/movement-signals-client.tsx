"use client"

// The lead desk's view of early movement signals (wave 147, lane 147Z). Palette tokens only (test:ui-palette-contrast).

import { useState, useTransition } from "react"
import { markMovementSignalOutcomeAction } from "@/app/actions/movement-signals"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

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
}

interface SourceFreshnessView {
  sourceKey: string
  lastPolledAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  promisedFreshnessMinutes: number | null
}

const label = (s: string) => s.replace(/_/g, " ")
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never")

export function MovementSignalsClient({ records, sources, freshnessNote }: { records: MovementRecordView[]; sources: SourceFreshnessView[]; freshnessNote: string | null }) {
  const [rows, setRows] = useState(records)
  const [note, setNote] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const close = (id: string, outcome: "false_positive" | "declined") => {
    startTransition(async () => {
      const r = await markMovementSignalOutcomeAction(id, outcome)
      if (!r.success) { setNote(r.error); return }
      setRows((prev) => prev.map((x) => (x.id === id ? { ...x, outcome } : x)))
      setNote(outcome === "false_positive" ? "Marked as a false positive — the source's weight learns from it." : "Marked as declined — no one will reach out about it.")
    })
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Early movement signals</h1>
        <p className="text-sm text-muted-foreground">
          What the watchers noticed about people in your book, and how we know it. An inference is never a fact; a sensitive life event is a person&apos;s conversation, never an automated message.
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
                </div>
                <p className="text-sm text-foreground">{r.evidence}</p>
                {r.outcome ? (
                  <p className="text-xs text-muted-foreground">Closed: {label(r.outcome)}</p>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => close(r.id, "false_positive")}>Not accurate</Button>
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => close(r.id, "declined")}>They declined help</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
