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
  issueRefundAction,
} from "@/app/actions/superadmin/brokerage-management"
import { MessageAdminComposer } from "../../message-admin-composer"

type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

export function BrokerageActions({ brokerage }: { brokerage: any }) {
  const [tier, setTier] = useState<CanonicalTier>(brokerage.plan_tier ?? "solo_agent")
  const [reason, setReason] = useState("")
  const [mode, setMode] = useState<"idle" | "suspend" | "cancel">("idle")
  const [trialDays, setTrialDays] = useState("14")
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundReason, setRefundReason] = useState("")
  const [refundDollars, setRefundDollars] = useState("")
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  // ── ONE SENTENCE FOR "DID THE MONEY MOVE?" (§6) ────────────────────────────
  //
  // Every lifecycle action here writes local Postgres FIRST and pushes to Stripe
  // second (lib/billing/stripe-subscription-ops.ts: the local write is the
  // INTENT, Stripe is the money). Two of them said so; tier-change, reactivate
  // and CANCEL returned a bare ok and reported flat success — so an operator
  // cancelling a tenant read "Billing will stop" and then "Brokerage cancelled"
  // while the customer's card was never touched. All five now say the same
  // thing, from the same function, and it distinguishes a SKIP (no Stripe key /
  // no Stripe-linked subscription) from an ERROR, because those are different
  // problems for whoever has to fix them.
  function stripeSuffix(r: { stripeApplied?: boolean; stripeError?: string }): string {
    if (r.stripeApplied) return " · pushed to Stripe"
    if (r.stripeError) return ` · NOT pushed to Stripe: ${r.stripeError}`
    return " · LOCAL ONLY — Stripe was not called (no key, or this subscription is not Stripe-linked). Nothing changed at the payment provider."
  }

  function applyExtendTrial() {
    setFeedback(null)
    startTransition(async () => {
      const r = await extendTrialAction({ brokerageId: brokerage.id, days: Number(trialDays), reason: reason.trim() || undefined })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: `Trial extended to ${r.newTrialEnd ? new Date(r.newTrialEnd).toLocaleDateString() : "—"}${stripeSuffix(r)}` })
    })
  }

  function applyPause(pause: boolean) {
    setFeedback(null)
    startTransition(async () => {
      const r = await pauseSubscriptionAction({ brokerageId: brokerage.id, pause, reason: reason.trim() || undefined })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: `${pause ? "Paused" : "Resumed"}${stripeSuffix(r)}` })
    })
  }

  function applyRefund() {
    setFeedback(null)
    if (refundReason.trim().length < 5) { setFeedback({ kind: "error", message: "Refund reason must be 5+ chars — refunds are audited" }); return }
    const dollars = refundDollars.trim() ? Number(refundDollars) : null
    if (dollars !== null && (!Number.isFinite(dollars) || dollars <= 0)) {
      setFeedback({ kind: "error", message: "Amount must be a positive dollar figure, or blank for a full refund" })
      return
    }
    if (!confirm(dollars ? `Refund $${dollars.toFixed(2)} of the latest paid invoice?` : "Refund the FULL latest paid invoice?")) return
    startTransition(async () => {
      const r = await issueRefundAction({
        brokerageId: brokerage.id,
        reason: refundReason.trim(),
        amountCents: dollars !== null ? Math.round(dollars * 100) : null,
      })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Refund failed" }); return }
      setFeedback({ kind: "success", message: `Refunded${r.refundedCents ? ` $${(r.refundedCents / 100).toFixed(2)}` : ""} — logged to the audit ledger` })
      setRefundOpen(false); setRefundReason(""); setRefundDollars("")
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
      setFeedback({ kind: "success", message: `Tier changed from ${r.previousTier} → ${tier}${stripeSuffix(r)}` })
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
      setFeedback({ kind: "success", message: `Brokerage reactivated${stripeSuffix(r)}` })
    })
  }

  function applyCancel() {
    if (reason.trim().length < 5) { setFeedback({ kind: "error", message: "Reason must be 5+ chars" }); return }
    if (!confirm("Cancel this brokerage? Access ends and the local subscription is marked cancelled; the charge is stopped at Stripe only if this subscription is Stripe-linked and a key is configured — the result says which. Data retained 90 days before archive.")) return
    startTransition(async () => {
      const r = await cancelBrokerageAction({ brokerageId: brokerage.id, reason: reason.trim() })
      if (!r.ok) { setFeedback({ kind: "error", message: r.error ?? "Failed" }); return }
      setFeedback({ kind: "success", message: `Brokerage cancelled. 90-day archive window started.${stripeSuffix(r)}` })
      setMode("idle"); setReason("")
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Superadmin actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Direct message — proactive staff→tenant-admin email (suppression-checked, audited, in-app mirrored) */}
        <div className="border rounded p-3">
          <div className="text-xs text-muted-foreground mb-2">Contact</div>
          <MessageAdminComposer brokerageId={brokerage.id} brokerageName={brokerage.name ?? null} />
          <p className="text-xs text-muted-foreground mt-2">
            Email this tenant&apos;s broker/admin directly — outside any ticket. Suppression list is checked first; every send is audited and mirrored in-app.
          </p>
        </div>

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

        {/* Refund — the one billing remediation that moves money back */}
        <div className="border rounded p-3">
          <div className="text-xs text-muted-foreground mb-2">Refund</div>
          {refundOpen ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">$</span>
                <input
                  type="number" min={0.5} step="0.01" value={refundDollars}
                  onChange={(e) => setRefundDollars(e.target.value)}
                  placeholder="Full invoice"
                  className="h-8 w-28 rounded-md border px-2 text-sm" aria-label="Refund amount (dollars, blank = full)"
                />
                <span className="text-xs text-muted-foreground">blank = full latest paid invoice</span>
              </div>
              <textarea
                value={refundReason} onChange={(e) => setRefundReason(e.target.value)}
                rows={2} placeholder="Reason (5+ chars, audited) — e.g. billing error, service outage credit"
                className="w-full text-sm border rounded p-2"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={applyRefund} disabled={isPending}>
                  {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Issue refund"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setRefundOpen(false); setRefundReason(""); setRefundDollars("") }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setRefundOpen(true)} disabled={isPending}>
              Issue refund…
            </Button>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            Refunds the latest PAID invoice through Stripe (full or partial). Reason required — every refund lands in the audit ledger.
          </p>
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
