"use client"

// app/components/calculators/CalculatorArtifact.tsx — THE ONE PUBLIC CALCULATOR (wave 156, lane 156H).
//
// Rendered by app/lm/[slug]/page.tsx for a calculator artifact — the same page the tenant website (/site/<slug>/lm/<form>),
// a connected custom domain and a QR scan land on — so web, mobile width and QR show this one component over the one engine
// (lib/calculators/engine.ts). The brand (name, colour, logo, tagline) arrives from the server with the first render.
//
// A visitor computes WITHOUT giving contact information. Only the explicit "save my results" / "talk to an agent" step shows
// the contact fields and the ONE consent component (C15), and only that step reaches the capture path.

import { useEffect, useMemo, useState, useTransition } from "react"
import { CALCULATOR_SPECS, type CalculatorKind, type CalculatorOutcome, type FieldSpec } from "@/lib/calculators/engine"
import type { LeadMagnetAttribution } from "@/lib/lead-magnets/attribution"
import { computeCalculatorArtifactAction, optInCalculatorArtifactAction, recordCalculatorOpenAction } from "@/app/actions/calculator-artifacts"
import { ConsentBoxes, useConsentBoxes } from "@/app/components/forms/ConsentBoxes"

export interface CalculatorArtifactProps {
  formId: string
  kind: CalculatorKind
  jurisdiction: string | null
  hiddenFields: string[]
  brand: { displayName: string; primaryColor: string; logoUrl: string | null; tagline: string | null }
  explainer: { videoUrl: string | null; guideUrl: string | null }
  cta: { label: string; mode: "save_results" | "talk_to_agent" }
  consentBrandName: string
  attribution: LeadMagnetAttribution | null
  /** Draft preview: compute locally is allowed, nothing is recorded and nothing is captured. */
  preview?: boolean
}

const fmt = (v: unknown, unit?: string) => {
  if (v === null || v === undefined) return "—"
  if (typeof v === "string") return v
  if (unit === "percent") return `${v}%`
  if (unit === "months") return `${v} months`
  return `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function CalculatorArtifact(p: CalculatorArtifactProps) {
  const spec = CALCULATOR_SPECS[p.kind]
  const fields = useMemo(() => spec.fields.filter((f) => !p.hiddenFields.includes(f.key)), [spec, p.hiddenFields])
  const [values, setValues] = useState<Record<string, string>>({})
  const [estimates, setEstimates] = useState<string[]>([])
  const [outcome, setOutcome] = useState<CalculatorOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [optIn, setOptIn] = useState<null | "save_results" | "talk_to_agent">(null)
  const [contact, setContact] = useState({ first_name: "", last_name: "", email: "", phone: "" })
  const [done, setDone] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const consent = useConsentBoxes("lead_magnet", p.consentBrandName)

  useEffect(() => {
    if (p.preview) return
    void recordCalculatorOpenAction(p.formId, p.attribution).catch(() => undefined)
  }, [p.formId, p.preview, p.attribution])

  const inputs = () => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""))

  function calculate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (p.preview) { setError("Draft preview — publish the calculator to compute here."); return }
    start(async () => {
      const r = await computeCalculatorArtifactAction({ formId: p.formId, inputs: inputs(), estimateKeys: estimates, attribution: p.attribution })
      if (!r.success) { setError(r.error); return }
      setOutcome(r.outcome)
    })
  }

  function submitOptIn(e: React.FormEvent) {
    e.preventDefault()
    if (!optIn) return
    if (!consent.serviceGiven) { setError("Please tick the first consent box so we can keep your results and reply to you."); return }
    setError(null)
    start(async () => {
      const r = await optInCalculatorArtifactAction({ formId: p.formId, inputs: inputs(), estimateKeys: estimates, intent: optIn, contact, consent: consent.submission, attribution: p.attribution })
      if (!r.success) { setError(r.error ?? "Could not save your results."); return }
      setDone(optIn === "talk_to_agent" ? "Thank you — an agent has your numbers and will reach out." : "Thank you — your results are saved.")
    })
  }

  const field = (f: FieldSpec) => (
    <div key={f.key} className="space-y-1">
      <label htmlFor={`calc-${f.key}`} className="block text-sm font-medium">
        {f.label}{f.required === true ? <span aria-hidden className="text-destructive"> *</span> : null}
      </label>
      {f.kind === "choice" ? (
        <select id={`calc-${f.key}`} className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
          <option value="">Choose…</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          id={`calc-${f.key}`}
          inputMode={f.kind === "date" ? "text" : "decimal"}
          type={f.kind === "date" ? "date" : "text"}
          placeholder={f.kind === "percent" ? "e.g. 6.25" : f.kind === "date" ? "YYYY-MM-DD" : ""}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={values[f.key] ?? ""}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
        />
      )}
      {f.kind !== "choice" && f.kind !== "date" && (
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={estimates.includes(f.key)} onChange={(e) => setEstimates(e.target.checked ? [...estimates, f.key] : estimates.filter((k) => k !== f.key))} />
          This is an estimate
        </label>
      )}
    </div>
  )

  return (
    <section className="w-full" aria-label={spec.title} data-calculator-kind={p.kind}>
      <header className="mb-4 flex items-center gap-3 rounded-lg px-4 py-3 text-white" style={{ backgroundColor: p.brand.primaryColor }}>
        {p.brand.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.brand.logoUrl} alt="" className="h-8 max-w-[120px] object-contain" />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{p.brand.displayName}</p>
          {p.brand.tagline && <p className="truncate text-xs opacity-90">{p.brand.tagline}</p>}
        </div>
      </header>
      {p.explainer.videoUrl && (
        <video src={p.explainer.videoUrl} controls preload="metadata" className="mb-4 w-full rounded-lg border" />
      )}
      {p.explainer.guideUrl && (
        <p className="mb-4 text-sm"><a className="underline" href={p.explainer.guideUrl} target="_blank" rel="noopener noreferrer">Read the guide that explains this calculator</a></p>
      )}
      <form onSubmit={calculate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map(field)}
        <div className="sm:col-span-2">
          <button type="submit" disabled={pending} className="w-full rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: p.brand.primaryColor }}>
            {pending ? "Calculating…" : "Calculate"}
          </button>
          <p className="mt-1 text-xs text-muted-foreground">No contact details needed to calculate.</p>
        </div>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

      {outcome && !outcome.ok && (
        <div role="status" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <ul className="list-disc pl-5">
            {outcome.missing.map((m) => <li key={m.key}>{m.message}</li>)}
            {outcome.refused.map((r) => <li key={r.key}>{r.label}: {r.reason}</li>)}
          </ul>
        </div>
      )}

      {outcome && outcome.ok && (
        <div className="mt-6 space-y-4" aria-live="polite">
          <div className="rounded-lg border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{outcome.period}</p>
            <p className="text-sm">{outcome.headline.label}</p>
            <p className="text-2xl font-semibold">{fmt(outcome.headline.value, outcome.headline.unit)}</p>
          </div>
          {outcome.lines.length > 0 && (
            <table className="w-full text-sm"><tbody>
              {outcome.lines.map((l) => <tr key={l.key} className="border-b last:border-0"><td className="py-1">{l.label}</td><td className="py-1 text-right">{fmt(l.amount)}</td></tr>)}
            </tbody></table>
          )}
          <details className="rounded-md border p-3 text-sm" open>
            <summary className="cursor-pointer font-medium">Assumptions</summary>
            <ul className="mt-2 space-y-1">
              {outcome.assumptions.map((a) => (
                <li key={a.key}>
                  <span className="font-medium">{a.label}:</span> {a.display}{" "}
                  <span className="text-xs text-muted-foreground">({a.basis === "you_entered" ? "you entered" : a.basis === "you_entered_estimate" ? "your estimate" : a.basis === "cited_source" ? "cited source" : a.basis === "not_included" ? "not included" : "agreement"})</span>
                  {a.source && <span className="block text-xs text-muted-foreground"><a className="underline" href={a.source.url} target="_blank" rel="noopener noreferrer">{a.source.citation}</a> — read {a.source.retrievedOn}. {a.source.caveats}</span>}
                </li>
              ))}
            </ul>
          </details>
          {outcome.notes.map((n) => <p key={n} className="text-sm text-muted-foreground">{n}</p>)}
          <div className="space-y-1 text-xs text-muted-foreground">{outcome.disclaimers.map((d) => <p key={d}>{d}</p>)}</div>

          {!done && !optIn && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={() => setOptIn("save_results")}>{p.cta.mode === "save_results" ? p.cta.label : "Save my results"}</button>
              <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={() => setOptIn("talk_to_agent")}>{p.cta.mode === "talk_to_agent" ? p.cta.label : "Talk with an agent about these numbers"}</button>
            </div>
          )}
          {!done && optIn && (
            <form onSubmit={submitOptIn} className="space-y-3 rounded-lg border p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(["first_name", "last_name", "email", "phone"] as const).map((k) => (
                  <div key={k} className="space-y-1">
                    <label htmlFor={`calc-optin-${k}`} className="block text-sm font-medium">{k === "first_name" ? "First name *" : k === "last_name" ? "Last name" : k === "email" ? "Email" : "Phone"}</label>
                    <input id={`calc-optin-${k}`} type={k === "email" ? "email" : k === "phone" ? "tel" : "text"} className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={contact[k]} onChange={(e) => setContact({ ...contact, [k]: e.target.value })} />
                  </div>
                ))}
              </div>
              <ConsentBoxes {...consent.boxProps} idPrefix={`calc-consent-${p.formId}`} />
              <button type="submit" disabled={pending || !!p.preview} className="w-full rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: p.brand.primaryColor }}>
                {pending ? "Saving…" : optIn === "talk_to_agent" ? "Send my numbers to an agent" : "Save my results"}
              </button>
            </form>
          )}
          {done && <p role="status" className="text-sm font-medium">{done}</p>}
        </div>
      )}
    </section>
  )
}
