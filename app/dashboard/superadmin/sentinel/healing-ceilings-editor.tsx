"use client"

/**
 * The platform SELF-HEALING CEILING editor (wave 139, lane 139F) — no tenant `self_healing` policy can exceed
 * these numbers (or run a class unchecked here). Submits setHealingCeilingsAction (superadmin; validated by
 * lib/kernel/healing-policy.ts validateHealingCeilingsEdit; audited). Blank = keep the current value.
 */
import { useState } from "react"
import { setHealingCeilingsAction } from "@/app/actions/superadmin/platform-controls"

const FIELDS: Array<{ key: string; label: string }> = [
  { key: "diagnosis_cap_usd", label: "AI diagnosis cap per incident (USD)" },
  { key: "provider_research_cap_usd", label: "Provider research cap per heal (USD)" },
  { key: "law_rule_research_cap_usd", label: "Law-rule research cap per tenant pass (USD)" },
  { key: "law_rule_research_max_calls", label: "Law-rule research calls per pass" },
  { key: "max_attempts_per_day", label: "Playbook attempts per incident / 24h" },
  { key: "auto_fix_min_confidence", label: "Auto-fix confidence floor (0–1; below → approval)" },
]

export function HealingCeilingsEditor(props: { ceiling: Record<string, unknown> | null; defaults: Record<string, unknown>; applied: boolean; actingClasses: string[] }) {
  const current = (k: string) => props.ceiling?.[k] ?? props.defaults[k]
  const [values, setValues] = useState<Record<string, string>>({})
  const initialClasses = (props.ceiling?.allowed_remediation_classes ?? null) as string[] | null
  const [classes, setClasses] = useState<string[] | null>(initialClasses)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!props.applied) return <p className="text-xs text-amber-700">No platform ceiling is available yet — the ceiling column is missing in this environment, so the code defaults are the ceiling.</p>

  return (
    <form
      className="rounded border p-2 space-y-2 text-xs"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        const r = await setHealingCeilingsAction({ ...values, allowed_remediation_classes: classes })
        setBusy(false)
        setNote(r.ok ? "Ceiling saved." : r.error)
      }}
    >
      <div className="font-medium">Platform ceiling (tenant policy can only be at or below these)</div>
      {!props.ceiling || Object.keys(props.ceiling).length === 0 ? <p className="text-muted-foreground">No platform ceiling is set yet — the code defaults shown as placeholders are the ceiling until you save one.</p> : null}
      <div className="grid gap-2 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{f.label}</span>
            <input className="rounded border px-1 py-0.5" inputMode="decimal" placeholder={String(current(f.key))} value={values[f.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
          </label>
        ))}
      </div>
      <div className="space-y-1">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={classes === null} onChange={(e) => setClasses(e.target.checked ? null : [...props.actingClasses])} />
          <span>Every declared remediation class allowed</span>
        </label>
        {props.actingClasses.length === 0 ? (
          <p className="text-muted-foreground">No acting remediation classes are configured yet — only hand-offs to the owning manager run.</p>
        ) : classes !== null ? (
          <div className="flex flex-wrap gap-2">
            {props.actingClasses.map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input type="checkbox" checked={classes.includes(k)} onChange={(e) => setClasses((c) => (e.target.checked ? [...(c ?? []), k] : (c ?? []).filter((x) => x !== k)))} />
                <span>{k}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>
      <button type="submit" disabled={busy} className="rounded border px-2 py-0.5">{busy ? "Saving…" : "Save ceiling"}</button>
      {note ? <span className="ml-2 text-muted-foreground">{note}</span> : null}
    </form>
  )
}
