"use client"

// app/dashboard/superadmin/connector-healing/acquisition-caps-panel.tsx
// THE OWNER'S PLATFORM ACQUISITION CAPS (wave 151, lane 151F). Every field is a number or an explicit STOP (null); there is no
// default and the panel says so. The verdict shown is the live decision for a zero want: "every platform-paid pull refuses"
// until all three caps are set. Writes go through setAcquisitionCapsAction (superadmin, audited).

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { setAcquisitionCapsAction } from "@/app/actions/superadmin/platform-controls"
import { ACQUISITION_CAP_FIELDS, ACQUISITION_CAP_LABELS, type PlatformAcquisitionCaps, type PlatformAcquisitionSpendVerdict } from "@/lib/vendor-governance/platform-acquisition-caps"

export function AcquisitionCapsPanel({ caps, applied, spend, verdict }: { caps: PlatformAcquisitionCaps | null; applied: boolean; spend: { platformUsd: number | null; rows: number; error: string | null }; verdict: PlatformAcquisitionSpendVerdict }) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(ACQUISITION_CAP_FIELDS.map((f) => [f, caps?.[f] === null || caps?.[f] === undefined ? "" : String(caps[f])])))
  const [stop, setStop] = useState<Record<string, boolean>>(Object.fromEntries(ACQUISITION_CAP_FIELDS.map((f) => [f, false])))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        {applied ? "Column applied (m976)." : "Column NOT applied yet (m976) — every platform-paid acquisition pull refuses until the integrator applies it and you set the caps."}
        {" "}Month-to-date platform acquisition spend: {spend.error ? <span className="text-destructive">unreadable — {spend.error}</span> : `$${(spend.platformUsd ?? 0).toFixed(2)} over ${spend.rows} ledger rows`}.
        {" "}Live verdict: <strong>{verdict.action}</strong> — {verdict.reasons.join("; ")}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {ACQUISITION_CAP_FIELDS.map((f) => (
          <label key={f} className="space-y-1 text-xs">
            <span>{ACQUISITION_CAP_LABELS[f]}</span>
            <Input type="number" min={0} step="0.01" disabled={stop[f] || !applied} value={values[f]} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} placeholder={caps?.[f] === null || caps?.[f] === undefined ? "not set = stop" : ""} />
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={stop[f]} onChange={(e) => setStop((s) => ({ ...s, [f]: e.target.checked }))} /> set to STOP (null)</label>
            <span className="block text-[11px] text-muted-foreground">current: {caps?.[f] === null || caps?.[f] === undefined ? "not set — stop before spend" : `$${caps[f]!.toFixed(2)}`}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending || !applied} onClick={() => start(async () => {
          setMsg(null)
          const input: Record<string, unknown> = {}
          for (const f of ACQUISITION_CAP_FIELDS) input[f] = stop[f] ? null : values[f]
          const r = await setAcquisitionCapsAction(input)
          setMsg(r.ok ? { ok: true, text: "Caps saved and audited." } : { ok: false, text: r.error })
          if (r.ok) router.refresh()
        })}>{pending ? "Saving…" : "Save caps"}</Button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>{msg.text}</span>}
      </div>
      <p className="text-[11px] text-muted-foreground">No default exists: a blank field keeps the current value, STOP writes null and every platform-paid pull refuses on it. The caps bind the existing paid-pull path (paidPullApproval → decideSpendBackpressure) in the same cycle; a tenant-owned provider connection is the tenant&apos;s own expense and is never counted here.</p>
    </div>
  )
}
