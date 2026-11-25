"use client"

// app/dashboard/superadmin/connector-healing/rentcast-cap-panel.tsx
// THE PLATFORM'S OWN RENTCAST CEILING (wave 156, lane 156G round 2). RentCast supplies no hard usage cap; the cutoff in
// lib/property/rentcast-eligibility.ts stops every RentCast request at this ceiling. Not set = the plan's included requests
// (zero paid overage). The billing anchor day is the RentCast plan's activation day — the counted window then matches
// RentCast's billing period instead of the calendar month. Writes go through setRentcastRequestCapAction (superadmin,
// validated, audited, receipted). Until m1019 is applied the panel says the setting is not available yet.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { setRentcastRequestCapAction } from "@/app/actions/superadmin/platform-controls"

interface CapSetting { monthly_requests: number | null; billing_anchor_day: number | null; set_by: string | null; set_at: string | null }
interface CapVerdict { allowed: boolean; cap: number | null; capSource: string; used: number | null; reason: string }

export function RentcastCapPanel({ applied, setting, verdict, windowStart, windowEnd }: { applied: boolean; setting: CapSetting | null; verdict: CapVerdict; windowStart: string; windowEnd: string }) {
  const router = useRouter()
  const [monthly, setMonthly] = useState(setting?.monthly_requests == null ? "" : String(setting.monthly_requests))
  const [anchor, setAnchor] = useState(setting?.billing_anchor_day == null ? "" : String(setting.billing_anchor_day))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()
  if (!applied) {
    return <p className="text-xs text-muted-foreground">The RentCast request ceiling setting is not available yet (migration m1019 is not applied). The cutoff runs on the plan&apos;s included requests ({verdict.cap ?? "unknown"} a month, zero paid overage) — live: {verdict.reason}.</p>
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Live: <strong>{verdict.allowed ? "requests allowed" : "STOPPED"}</strong> — {verdict.reason}. Counted window {windowStart.slice(0, 10)} → {windowEnd.slice(0, 10)} (UTC).
        {" "}Current setting: {setting?.monthly_requests == null ? "not set — the plan's included requests" : `${setting.monthly_requests} requests`}{setting?.billing_anchor_day == null ? ", calendar month" : `, billing period starts on day ${setting.billing_anchor_day}`}{setting?.set_at ? ` (set ${setting.set_at.slice(0, 10)})` : ""}.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs"><span>Monthly RentCast requests (positive whole number; blank keeps)</span>
          <Input type="number" min={1} step={1} value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="plan's included requests" />
        </label>
        <label className="space-y-1 text-xs"><span>Billing anchor day — the plan&apos;s activation day (1–31; blank keeps)</span>
          <Input type="number" min={1} max={31} step={1} value={anchor} onChange={(e) => setAnchor(e.target.value)} placeholder="calendar month" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending} onClick={() => start(async () => {
          setMsg(null)
          const r = await setRentcastRequestCapAction({ monthly_requests: monthly, billing_anchor_day: anchor })
          setMsg(r.ok ? { ok: true, text: "Saved, audited and receipted — the cutoff reads it on its next request." } : { ok: false, text: r.error })
          if (r.ok) router.refresh()
        })}>{pending ? "Saving…" : "Save ceiling"}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
          setMsg(null)
          const r = await setRentcastRequestCapAction({ monthly_requests: null, billing_anchor_day: null })
          setMsg(r.ok ? { ok: true, text: "Reset to the plan's included requests and the calendar month." } : { ok: false, text: r.error })
          if (r.ok) router.refresh()
        })}>Reset to plan default</Button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>{msg.text}</span>}
      </div>
    </div>
  )
}
