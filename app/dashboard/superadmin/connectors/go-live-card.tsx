"use client"

// Go-live readiness — every platform domain live-probed on demand (real
// vendor calls, so it's a button, not a page-load). Required domains gate
// the go/no-go line; optional ones inform.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Rocket } from "lucide-react"
import { getGoLiveReadinessAction } from "@/app/actions/superadmin/go-live-readiness"
import type { GoLiveReadiness } from "@/lib/platform/go-live-readiness"

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  ready: { label: "Ready", variant: "default" },
  broken: { label: "Broken", variant: "destructive" },
  not_configured: { label: "Not configured", variant: "outline" },
}

export function GoLiveCard() {
  const [busy, setBusy] = useState(false)
  const [r, setR] = useState<GoLiveReadiness | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = async () => {
    setBusy(true); setErr(null)
    const res = await getGoLiveReadinessAction()
    if (res.ok) setR(res.readiness)
    else setErr(res.error)
    setBusy(false)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Rocket className="h-4 w-4" /> Go-live readiness
        </CardTitle>
        <CardDescription className="text-xs">
          Live-probes every platform domain — Twilio master + platform line binding, SendGrid, Stripe
          (live vs test key), ElevenLabs, D-ID, storage, database, cron auth, A2P — and reports honest
          ready / broken / not-configured per domain. Runs real vendor calls, so it's on demand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={run} disabled={busy}>{busy ? "Probing…" : "Run readiness checks"}</Button>
          {r && (
            <span className={r.requiredReady === r.requiredTotal ? "text-green-600 font-medium" : "text-amber-600 font-medium"}>
              {r.requiredReady}/{r.requiredTotal} required domains ready
              {r.requiredReady === r.requiredTotal ? " — GO" : " — not yet"}
            </span>
          )}
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        {r && (
          <ul className="space-y-1.5">
            {r.domains.map((dom) => {
              const b = STATUS_BADGE[dom.status] ?? STATUS_BADGE.broken
              return (
                <li key={dom.key} className="flex items-start gap-2 text-xs">
                  <Badge variant={b.variant} className="mt-0.5 shrink-0">{b.label}</Badge>
                  <span className="font-medium shrink-0">{dom.label}{dom.optional ? " (optional)" : ""}:</span>
                  <span className="text-muted-foreground">{dom.detail}</span>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
