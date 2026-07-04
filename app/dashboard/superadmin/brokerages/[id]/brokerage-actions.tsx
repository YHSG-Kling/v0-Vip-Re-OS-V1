"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, RotateCcw, X, Loader2 } from "lucide-react"
import {
  changeBrokerageTierAction,
  suspendBrokerageAction,
  reactivateBrokerageAction,
  cancelBrokerageAction,
  extendTrialAction,
  pauseSubscriptionAction,
} from "@/app/actions/superadmin/brokerage-management"

type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

export function BrokerageActions({ brokerage }: { brokerage: any }) {
  const [tier, setTier] = useState<CanonicalTier>(brokerage.plan_tier ?? "solo_agent")
  const [reason, setReason] = useState("")
  const [mode, setMode] = useState<"idle" | "suspend" | "cancel">("idle")
  const [trialDays, setTrialDays] = useState("14")
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function applyExtendTrial() {
    setFeedback(null)
    startTransition(async () => {
      const r = await extendTrialAction({ brokerageId: brokerage.id, days: Number(trialDays), reason: reason.trim() || undefined })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: `Trial extended to ${r.newTrialEnd ? new Date(r.newTrialEnd).toLocaleDateString() : "—"}${r.stripeApplied ? " (pushed to Stripe)" : " (local — Stripe not configured)"}` })
    })
  }

  function applyPause(pause: boolean) {
    setFeedback(null)
    startTransition(async () => {
      const r = await pauseSubscriptionAction({ brokerageId: brokerage.id, pause, reason: reason.trim() || undefined })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: `${pause ? "Paused" : "Resumed"}${r.stripeApplied ? " (pushed to Stripe)" : " (local — Stripe not configured)"}` })
    })
  }

  function applyTierChange() {
    setFeedback(null)
    if (tier === brokerage.plan_tier) {
      setFeedback({ kind: "error", message: "Already on that tier" })
      return
    }
    startTransition(async () => {
      const r = await changeBrokerageTierAction({ brokerageId: brokerage.id, newTier: tier, reason: reason.trim() || undefined })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: `Tier changed from ${r.previousTier} → ${tier}` })
    })
  }

  function applySuspend() {
    if (reason.trim().length < 5) { setFeedback({ kind: "error", message: "Reason must be 5+ chars" }); return }
    startTransition(async () => {
      const r = await suspendBrokerageAction({ brokerageId: brokerage.id, reason: reason.trim() })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: "Brokerage suspended" })
      setMode("idle"); setReason("")
    })
  }

  function applyReactivate() {
    startTransition(async () => {
      const r = await reactivateBrokerageAction(brokerage.id)
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: "Brokerage reactivated" })
    })
  }

  function applyCancel() {
    if (reason.trim().length < 5) { setFeedback({ kind: "error", message: "Reason must be 5+ chars" }); return }
    if (!confirm("Cancel this brokerage? Billing will stop. Data retained 90 days before archive.")) return
    startTransition(async () => {
      const r = await cancelBrokerageAction({ brokerageId: brokerage.id, reason: reason.trim() })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: "Brokerage cancelled. 90-day archive window started." })
      setMode("idle"); setReason("")
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Superadmin actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Tier change */}
        <div className="border rounded p-3">
          <div className="text-xs text-muted-foreground mb-2">Plan tier</div>
          <div className="flex items-center gap-2 flex-wrap">
            {(["solo_agent","team","brokerage","multi_location"] as const).map(t => (
              <Button
                key={t}
                size="sm"
                variant={tier === t ? "default" : "outline"}
                onClick={() => setTier(t)}
                disabled={isPending}
              >
                {t === "solo_agent" ? "Solo" : t === "multi_location" ? "Multi-loc" : t.charAt(0).toUpperCase() + t.slice(1)}
              </Button>
            ))}
            <Button size="sm" onClick={applyTierChange} disabled={isPending || tier === brokerage.plan_tier} className="ml-2">
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Apply"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Tier changes apply immediately — fair-use quota recomputes on next AI call. Existing transactions are NOT locked out.
          </p>
        </div>

        {/* Subscription — comp trial + pause (write through to Stripe when configured) */}
        <div className="border rounded p-3">
          <div className="text-xs text-muted-foreground mb-2">Subscription</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="number" min={1} max={365} value={trialDays} onChange={(e) => setTrialDays(e.target.value)} className="h-8 w-20 rounded-md border px-2 text-sm" aria-label="Trial days" />
            <Button size="sm" variant="outline" onClick={applyExtendTrial} disabled={isPending || !(Number(trialDays) > 0)}>Extend trial / comp</Button>
            <Button size="sm" variant="outline" onClick={() => applyPause(true)} disabled={isPending}>Pause billing</Button>
            <Button size="sm" variant="outline" onClick={() => applyPause(false)} disabled={isPending}>Resume</Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Comp free time or pause a break. Writes through to Stripe when configured, else applies locally.</p>
        </div>

        {/* Status actions */}
        <div className="border rounded p-3">
          <div className="text-xs text-muted-foreground mb-2">Status</div>
          {brokerage.status === "active" && (
            <div className="space-y-2">
              {mode === "suspend" ? (
                <>
                  <textarea
                    value={reason} onChange={e => setReason(e.target.value)}
                    rows={2} placeholder="Reason (5+ chars) — e.g. failed payment, abuse review"
                    className="w-full text-sm border rounded p-2"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" onClick={applySuspend} disabled={isPending}>
                      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm suspend"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setMode("idle"); setReason("") }}>Cancel</Button>
                  </div>
                </>
              ) : mode === "cancel" ? (
                <>
                  <textarea
                    value={reason} onChange={e => setReason(e.target.value)}
                    rows={2} placeholder="Cancellation reason (5+ chars)"
                    className="w-full text-sm border rounded p-2"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" onClick={applyCancel} disabled={isPending}>
                      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm cancel"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setMode("idle"); setReason("") }}>Keep active</Button>
                  </div>
                </>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setMode("suspend")}>
                    <AlertTriangle className="h-3.5 w-3.5 mr-1 text-amber-600" />
                    Suspend
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode("cancel")}>
                    <X className="h-3.5 w-3.5 mr-1 text-red-600" />
                    Cancel subscription
                  </Button>
                </div>
              )}
            </div>
          )}
          {brokerage.status === "suspended" && (
            <Button size="sm" onClick={applyReactivate} disabled={isPending}>
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RotateCcw className="h-3.5 w-3.5 mr-1" />}
              Reactivate
            </Button>
          )}
          {brokerage.status === "cancelled" && (
            <Badge variant="outline" className="text-xs">
              Cancelled {brokerage.cancelled_at && `· ${new Date(brokerage.cancelled_at).toLocaleDateString()}`}
            </Badge>
          )}
          {brokerage.status === "archived" && (
            <p className="text-xs text-muted-foreground">Archived — past retention window.</p>
          )}
        </div>

        {feedback && (
          <div className={`rounded-md border p-3 text-sm ${
            feedback.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}>
            {feedback.message}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
