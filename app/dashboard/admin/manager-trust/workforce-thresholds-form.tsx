"use client"

import { useActionState } from "react"
import { submitWorkforceThresholdsAction, type WorkforceThresholdsSubmitState } from "@/app/actions/admin/improvement-proposals"
import type { WorkforceThresholds } from "@/lib/kernel/brokerage-twin"

type Field = { key: Exclude<keyof WorkforceThresholds, "overwhelmed_band">; label: string; unit: string; min: number; max: number }

/** The editor's form: current vs default with the resolver's bounds; two doors — propose / apply now. */
export function WorkforceThresholdsForm({ current, defaults, fields, bands }: { current: WorkforceThresholds; defaults: WorkforceThresholds; fields: readonly Field[]; bands: readonly WorkforceThresholds["overwhelmed_band"][] }) {
  const [state, action, pending] = useActionState<WorkforceThresholdsSubmitState, FormData>(submitWorkforceThresholdsAction, null)
  return (
    <form action={action} className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3">Threshold</th>
              <th className="py-2 pr-3">Default</th>
              <th className="py-2 pr-3">Bounds</th>
              <th className="py-2">Value</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key} className="border-b align-middle">
                <td className="py-2 pr-3">
                  <label htmlFor={`wt-${f.key}`} className="font-medium">{f.label}</label>
                  <div className="font-mono text-xs text-muted-foreground">{f.key}</div>
                </td>
                <td className="py-2 pr-3 text-xs">{defaults[f.key].toLocaleString()} {f.unit}</td>
                <td className="py-2 pr-3 text-xs text-muted-foreground">{f.min.toLocaleString()}–{f.max.toLocaleString()}</td>
                <td className="py-2">
                  <input id={`wt-${f.key}`} name={f.key} type="number" min={f.min} max={f.max} step="any" required defaultValue={current[f.key]}
                    className={`w-32 rounded border px-2 py-1 text-sm ${current[f.key] !== defaults[f.key] ? "border-blue-400" : ""}`} />
                </td>
              </tr>
            ))}
            <tr className="border-b align-middle">
              <td className="py-2 pr-3">
                <label htmlFor="wt-overwhelmed_band" className="font-medium">Overwhelmed — capacity band at or beyond</label>
                <div className="font-mono text-xs text-muted-foreground">overwhelmed_band</div>
              </td>
              <td className="py-2 pr-3 text-xs">{defaults.overwhelmed_band}</td>
              <td className="py-2 pr-3 text-xs text-muted-foreground">{bands.join(" / ")}</td>
              <td className="py-2">
                <select id="wt-overwhelmed_band" name="overwhelmed_band" defaultValue={current.overwhelmed_band} className="rounded border px-2 py-1 text-sm">
                  {bands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" name="mode" value="propose" disabled={pending} className="rounded border px-3 py-1 text-sm disabled:opacity-50">Propose for review</button>
        <button type="submit" name="mode" value="apply" disabled={pending} className="rounded border border-blue-500 px-3 py-1 text-sm text-blue-700 disabled:opacity-50">Apply now</button>
        {pending && <span className="text-xs text-muted-foreground">Submitting…</span>}
      </div>
      {state && (
        <div className={`text-sm ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
          {state.message}
          {state.errors && state.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        </div>
      )}
    </form>
  )
}
