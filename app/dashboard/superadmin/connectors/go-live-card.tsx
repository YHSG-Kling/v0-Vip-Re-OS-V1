"use client"

// Go-live readiness — every platform domain live-probed on demand (real
// vendor calls, so it's a button, not a page-load). Required domains gate
// the go/no-go line; optional ones inform.
//
// LaunchChecklistCard (below) is the companion PRESENCE surface: the launch
// env checklist from lib/platform/launch-checklist.ts, computed server-side
// (env presence only — no values ever leave the server) and rendered on load.

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Rocket, ListChecks } from "lucide-react"
import { getGoLiveReadinessAction, queueRenderPipelineProbeAction } from "@/app/actions/superadmin/go-live-readiness"
import type { GoLiveReadiness } from "@/lib/platform/go-live-readiness"
import type { LaunchChecklist } from "@/lib/platform/launch-checklist"

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

  const [probeBusy, setProbeBusy] = useState(false)
  const [probeNote, setProbeNote] = useState<string | null>(null)
  const probeRender = async () => {
    setProbeBusy(true); setProbeNote(null)
    const res = await queueRenderPipelineProbeAction()
    setProbeNote(res.ok
      ? `Probe queued (render ${res.renderId.slice(0, 8)}…) — the render queue drains it within minutes; the finished video's URL on the render row is the proof.`
      : res.error)
    setProbeBusy(false)
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
          <Button size="sm" variant="outline" onClick={probeRender} disabled={probeBusy}>
            {probeBusy ? "Queuing…" : "Queue render proof"}
          </Button>
          {r && (
            <span className={r.requiredReady === r.requiredTotal ? "text-green-600 font-medium" : "text-amber-600 font-medium"}>
              {r.requiredReady}/{r.requiredTotal} required domains ready
              {r.requiredReady === r.requiredTotal ? " — GO" : " — not yet"}
            </span>
          )}
        </div>
        {err && <div className="text-xs text-red-600">{err}</div>}
        {probeNote && <div className="text-xs text-muted-foreground">{probeNote}</div>}
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

const TIER_LABEL: Record<string, { label: string; missingVariant: "destructive" | "secondary" | "outline" }> = {
  "launch-blocking": { label: "Blocking", missingVariant: "destructive" },
  "launch-degraded": { label: "Degraded", missingVariant: "secondary" },
  optional: { label: "Optional", missingVariant: "outline" },
}

/**
 * THE LAUNCH CHECKLIST — env-var launch requirements as a live surface.
 * Presence-only (computed server-side in the page; values never leave the
 * server). Companion to the on-demand go-live probes above: this tells you
 * which gates are even configured; the probes tell you whether they WORK.
 */
export function LaunchChecklistCard({ checklist }: { checklist: LaunchChecklist }) {
  const [showConfigured, setShowConfigured] = useState(false)
  const gaps = checklist.items.filter((i) => !i.configured)
  const visible = showConfigured ? checklist.items : gaps
  const allBlockingSet = checklist.blockingConfigured === checklist.blockingTotal

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ListChecks className="h-4 w-4" /> Launch checklist (env gates)
        </CardTitle>
        <CardDescription className="text-xs">
          Every env-var gate the OS honestly stands down without, tiered by launch impact.
          Presence only — values are never read into this page. Run the probes above to verify
          configured keys actually work.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className={allBlockingSet ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
            {checklist.blockingConfigured}/{checklist.blockingTotal} launch-blocking configured
            {allBlockingSet ? " — launch-clean" : " — gaps below"}
          </span>
          <span className="text-muted-foreground text-xs">
            {checklist.degradedConfigured}/{checklist.degradedTotal} degraded-tier
            · {checklist.optionalConfigured}/{checklist.optionalTotal} optional
          </span>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setShowConfigured((s) => !s)}>
            {showConfigured ? "Show gaps only" : `Show all ${checklist.items.length}`}
          </Button>
        </div>
        {visible.length === 0 && (
          <div className="text-xs text-muted-foreground">Every tracked env gate is configured.</div>
        )}
        <ul className="space-y-1.5">
          {visible.map((item) => {
            const t = TIER_LABEL[item.tier] ?? TIER_LABEL.optional
            return (
              <li key={item.key} className="flex items-start gap-2 text-xs">
                <Badge
                  variant={item.configured ? "default" : t.missingVariant}
                  className="mt-0.5 shrink-0"
                >
                  {item.configured ? "Set" : t.label}
                </Badge>
                <div className="min-w-0">
                  <span className="font-medium">{item.capability}</span>
                  <span className="text-muted-foreground">
                    {" — "}
                    {item.envVars.join(item.anyOf ? " or " : " + ")}. {item.whatLightsUp}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
