"use client"

/**
 * OFFER DECISION BUTTONS — replaces the portal's inert Accept/Counter/Decline
 * buttons (production audit). The click records the client's decision as a
 * signal for the agent to execute; the confirmation copy says so plainly.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Loader2, CheckCircle2 } from "lucide-react"
import { recordClientOfferDecision } from "@/app/actions/portal-offer-decision"

const LABELS: Record<string, { confirm: string }> = {
  accept: { confirm: "Tell your agent to accept this offer? They'll confirm with you before anything is signed." },
  counter: { confirm: "Tell your agent you want to counter? They'll call you to shape the terms." },
  decline: { confirm: "Tell your agent to decline this offer?" },
  request_highest_best: { confirm: "Ask your agent to call for highest & best from all buyers?" },
}

export function OfferDecisionButtons({ contactId, offerId, kind = "seller" }: {
  contactId: string
  offerId: string
  kind?: "seller" | "buyer" | "multi"
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [acting, setActing] = useState<string | null>(null)

  const act = (decision: string) => {
    if (!confirm(LABELS[decision]?.confirm ?? "Send this to your agent?")) return
    setActing(decision)
    startTransition(async () => {
      const r = await recordClientOfferDecision({ contactId, offerId, decision })
      setResult(r.success ? { ok: true, text: r.message ?? "Sent to your agent." } : { ok: false, text: r.error ?? "That didn't go through — try again." })
      setActing(null)
    })
  }

  if (result?.ok) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 dark:bg-green-950/20 p-3 text-sm text-green-800 dark:text-green-200">
        <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <span>{result.text}</span>
      </div>
    )
  }

  const spin = (d: string) => pending && acting === d ? <Loader2 className="h-4 w-4 animate-spin" /> : null

  return (
    <div className="space-y-2">
      {kind === "multi" ? (
        <Button onClick={() => act("request_highest_best")} disabled={pending}>
          {spin("request_highest_best")} Request Highest &amp; Best from All
        </Button>
      ) : (
        <div className="flex gap-2 pt-1">
          <Button className="flex-1" onClick={() => act("accept")} disabled={pending}>
            {spin("accept")} {kind === "buyer" ? "Accept Current Terms" : "Accept Offer"}
          </Button>
          <Button variant="outline" className="flex-1 bg-transparent" onClick={() => act("counter")} disabled={pending}>
            {spin("counter")} {kind === "buyer" ? "Counter Back" : "Counter"}
          </Button>
          <Button variant="ghost" onClick={() => act("decline")} disabled={pending}>
            {spin("decline")} {kind === "buyer" ? "Decline" : "Reject"}
          </Button>
        </div>
      )}
      {result && !result.ok && <p className="text-sm text-red-600">{result.text}</p>}
      <p className="text-xs text-muted-foreground">Your agent confirms and executes every decision — nothing is final until the paperwork is signed.</p>
    </div>
  )
}
