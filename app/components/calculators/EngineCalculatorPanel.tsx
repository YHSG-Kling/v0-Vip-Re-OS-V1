"use client"

// app/components/calculators/EngineCalculatorPanel.tsx — one signed-in panel for any engine calculator (wave 156, lane 156H,
// round 2). The fields are the engine's own spec (lib/calculators/engine.ts CALCULATOR_SPECS), nothing is prefilled, and the run
// goes through app/actions/calculators.ts runCalculatorTool (the engine + the usage row / receipt the retired doors filed).
// The result shows its headline, its lines, every assumption with its basis, the period and the disclaimers.

import { useState, useTransition } from "react"
import { CALCULATOR_SPECS, type CalculatorKind, type CalculatorOutcome } from "@/lib/calculators/engine"
import { runCalculatorTool } from "@/app/actions/calculators"

const fmt = (v: unknown, unit?: string) =>
  v === null || v === undefined ? "—" : typeof v === "string" ? v : unit === "percent" ? `${v}%` : unit === "months" ? `${v} months` : unit === "years" ? `${v} years` : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`

export function EngineCalculatorPanel({ kind, visitorId, onResult }: { kind: CalculatorKind; visitorId?: string; onResult?: (o: CalculatorOutcome) => void }) {
  const spec = CALCULATOR_SPECS[kind]
  const [values, setValues] = useState<Record<string, string>>({})
  const [estimates, setEstimates] = useState<string[]>([])
  const [outcome, setOutcome] = useState<CalculatorOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function run() {
    setError(null)
    start(async () => {
      const inputs = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""))
      const r = await runCalculatorTool({ kind, inputs, estimateKeys: estimates, visitorId })
      if (!r.success) { setError(r.error); return }
      setOutcome(r.outcome)
      onResult?.(r.outcome)
    })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {spec.fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <label htmlFor={`eng-${kind}-${f.key}`} className="block text-sm font-medium">{f.label}{f.required === true ? " *" : ""}</label>
            {f.kind === "choice" ? (
              <select id={`eng-${kind}-${f.key}`} className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                <option value="">Choose…</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input id={`eng-${kind}-${f.key}`} inputMode="decimal" className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
            {f.kind !== "choice" && f.kind !== "date" && (
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input type="checkbox" checked={estimates.includes(f.key)} onChange={(e) => setEstimates(e.target.checked ? [...estimates, f.key] : estimates.filter((k) => k !== f.key))} /> estimate
              </label>
            )}
          </div>
        ))}
      </div>
      <button type="button" onClick={run} disabled={pending} className="rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-60">{pending ? "Calculating…" : "Calculate"}</button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {outcome && !outcome.ok && (
        <ul className="list-disc pl-5 text-sm text-amber-900">
          {outcome.missing.map((m) => <li key={m.key}>{m.message}</li>)}
          {outcome.refused.map((r) => <li key={r.key}>{r.label}: {r.reason}</li>)}
        </ul>
      )}
      {outcome && outcome.ok && (
        <div className="space-y-3 rounded-lg border p-4 text-sm">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{outcome.period}</p>
          <p>{outcome.headline.label}: <span className="text-lg font-semibold">{fmt(outcome.headline.value, outcome.headline.unit)}</span></p>
          <ul className="space-y-1">{Object.entries(outcome.outputs).map(([k, v]) => <li key={k}><span className="text-muted-foreground">{k.replace(/([A-Z])/g, " $1").toLowerCase()}:</span> {fmt(v, /Pct$/.test(k) ? "percent" : /Months$/.test(k) ? "months" : /Year$/.test(k) ? "years" : undefined)}</li>)}</ul>
          {outcome.lines.length > 0 && <ul className="space-y-1">{outcome.lines.map((l) => <li key={l.key}>{l.label}: {fmt(l.amount)}</li>)}</ul>}
          <details open><summary className="cursor-pointer font-medium">Assumptions</summary>
            <ul className="mt-1 space-y-1 text-xs">{outcome.assumptions.map((a) => <li key={a.key}>{a.label}: {a.display} ({a.basis.replace(/_/g, " ")}{a.source ? ` — ${a.source.citation}` : ""})</li>)}</ul>
          </details>
          {outcome.notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
          {outcome.disclaimers.map((d) => <p key={d} className="text-xs text-muted-foreground">{d}</p>)}
        </div>
      )}
    </div>
  )
}
