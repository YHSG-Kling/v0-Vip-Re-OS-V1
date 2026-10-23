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
import { Rocket, ListChecks, Webhook } from "lucide-react"
import { getGoLiveReadinessAction, queueRenderPipelineProbeAction } from "@/app/actions/superadmin/go-live-readiness"
import { checkStripeWebhookEventsAction, registerStripeWebhookEventsAction } from "@/app/actions/superadmin/stripe-webhook-events"
import type { GoLiveReadiness } from "@/lib/platform/go-live-readiness"
import type { LaunchChecklist } from "@/lib/platform/launch-checklist"
import type { StripeWebhookRegistrationResult } from "@/lib/billing/stripe-webhook-registration"
import type { StripeWebhookEndpoint } from "@/lib/billing/stripe-account-scope"

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
        {/* ON-DEMAND DRIFT CHECKS — a presence map cannot see these; each is a
            real vendor read, run on click. The Stripe webhook-events item is the
            first (wave 80A). */}
        {checklist.driftChecks.length > 0 && (
          <ul className="space-y-2 border-t pt-3">
            {checklist.driftChecks.map((d) => (
              <li key={d.key} className="text-xs">
                <span className="font-medium">{d.capability}</span>
                <span className="text-muted-foreground"> — {d.whatDrifts}</span>
                {d.key === "stripe_webhook_events" && <StripeWebhookEventsDrift endpoint="tenant_billing" />}
                {d.key === "stripe_vendor_webhook_events" && <StripeWebhookEventsDrift endpoint="vendor_marketplace" />}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * THE WEBHOOK EVENTS DRIFT ITEM (wave 80A, owner: "go ahead with the add
 * event to stripe webhook endpoint but remember we use stripe sdk"). Check =
 * list the platform account's endpoint for /api/billing/webhook and diff its
 * enabled_events against what the route handles; Register = write the UNION
 * through stripe.webhookEndpoints.update. Publishes nothing else in Stripe.
 * `endpoint` names WHICH of the platform account's two endpoints (lane 81E
 * added the vendor marketplace one; its vocabulary is derived from the route's
 * two data maps — lib/vendors/vendor-webhook-events.ts).
 */
function StripeWebhookEventsDrift({ endpoint }: { endpoint: StripeWebhookEndpoint }) {
  const [busy, setBusy] = useState<"check" | "register" | null>(null)
  const [r, setR] = useState<StripeWebhookRegistrationResult | { ok: false; reason: "forbidden"; error: string } | null>(null)
  const run = async (mode: "check" | "register") => {
    setBusy(mode)
    setR(mode === "check" ? await checkStripeWebhookEventsAction(endpoint) : await registerStripeWebhookEventsAction(endpoint))
    setBusy(null)
  }
  const read = r && r.ok ? r : null
  const refusal = r && !r.ok ? r : null
  return (
    <div className="mt-1 space-y-1">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => run("check")} disabled={busy !== null}>
          <Webhook className="h-3 w-3 mr-1" />{busy === "check" ? "Checking…" : "Check webhook events"}
        </Button>
        {read && !read.plan.inSync && (
          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => run("register")} disabled={busy !== null}>
            {busy === "register" ? "Registering…" : `Register ${read.plan.missing.length} missing event${read.plan.missing.length === 1 ? "" : "s"}`}
          </Button>
        )}
        {read && (
          <Badge variant={read.plan.inSync ? "default" : "destructive"}>{read.plan.inSync ? "In sync" : "Drift"}</Badge>
        )}
      </div>
      {refusal && <div className="text-red-600">{refusal.error}</div>}
      {read && (
        <div className="text-muted-foreground">
          {read.url} · {read.status}{read.livemode ? " · live" : " · test"} · before: {read.before.length} event{read.before.length === 1 ? "" : "s"}
          {read.plan.wildcard ? " (wildcard — every event delivered)" : ""}
          {read.plan.missing.length > 0 && <> · missing: {read.plan.missing.join(", ")}</>}
          {read.plan.extra.length > 0 && <> · registered but unhandled: {read.plan.extra.join(", ")}</>}
          {read.applied && <> · <span className="text-green-600">registered — now {read.after.length} events</span></>}
          {read.otherEndpointUrls.length > 0 && <> · other endpoints on the account: {read.otherEndpointUrls.join(", ")}</>}
        </div>
      )}
    </div>
  )
}
