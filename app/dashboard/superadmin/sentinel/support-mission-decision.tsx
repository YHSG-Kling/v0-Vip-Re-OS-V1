"use client"

import { useState, useTransition } from "react"
import { decidePlatformSupportMission } from "@/app/actions/superadmin/saas-operations"

/** Approve / dismiss a PROPOSED platform support mission (staff door, gated server-side). */
export function SupportMissionDecision({ missionId }: { missionId: string }) {
  const [pending, start] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const decide = (decision: "approve" | "dismiss") =>
    start(async () => {
      const r = await decidePlatformSupportMission({ missionId, decision })
      setMsg(r.ok ? `→ ${r.state}` : r.error ?? "Refused")
    })
  return (
    <span className="flex items-center gap-1">
      <button type="button" disabled={pending} onClick={() => decide("approve")} className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-emerald-50 disabled:opacity-50">Approve</button>
      <button type="button" disabled={pending} onClick={() => decide("dismiss")} className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-slate-50 disabled:opacity-50">Dismiss</button>
      {msg ? <span className="text-[11px] text-muted-foreground">{msg}</span> : null}
    </span>
  )
}
