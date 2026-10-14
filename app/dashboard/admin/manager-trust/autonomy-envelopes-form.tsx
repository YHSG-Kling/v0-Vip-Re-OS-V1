"use client"

import { useActionState } from "react"
import { submitAutonomyEnvelopesAction, type AutonomyEnvelopesSubmitState } from "@/app/actions/admin/improvement-proposals"

type Field = { path: string; label: string; unit: string; money: boolean; min: number; max: number; current: number; default: number }

/** The envelope screen's form: current vs default, bounded; money fields locked for a non-commerce seat. */
export function AutonomyEnvelopesForm({ fields, mayEditMoney }: { fields: Field[]; mayEditMoney: boolean }) {
  const [state, action, pending] = useActionState<AutonomyEnvelopesSubmitState, FormData>(submitAutonomyEnvelopesAction, null)
  return (
    <form action={action} className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3">Envelope</th>
              <th className="py-2 pr-3">Default</th>
              <th className="py-2 pr-3">Bounds</th>
              <th className="py-2">Value</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => {
              const locked = f.money && !mayEditMoney
              return (
                <tr key={f.path} className="border-b align-middle">
                  <td className="py-2 pr-3">
                    <label htmlFor={`ae-${f.path}`} className="font-medium">{f.label}</label>
                    <div className="font-mono text-xs text-muted-foreground">{f.path}{f.money ? " · money" : ""}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs">{f.default} {f.unit}</td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{f.min}–{f.max.toLocaleString()}</td>
                  <td className="py-2">
                    <input id={`ae-${f.path}`} name={f.path} type="number" min={f.min} max={f.max} step="any" required defaultValue={f.current} readOnly={locked}
                      className={`w-32 rounded border px-2 py-1 text-sm ${locked ? "bg-muted" : ""} ${f.current !== f.default ? "border-blue-400" : ""}`} />
                  </td>
                </tr>
              )
            })}
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
