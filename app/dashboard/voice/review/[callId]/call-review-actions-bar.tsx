"use client"

/**
 * CALL REVIEW ACTIONS BAR — replaces the inert Share-with-Coach /
 * Flag-for-Compliance buttons (production audit). Real effects: the flag
 * lands on the compliance ledger, the share notifies broker/team leads.
 */

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Share2, Flag, Loader2, CheckCircle2 } from "lucide-react"
import { flagCallForCompliance, shareCallWithCoach } from "@/app/actions/call-review-actions"

export function CallReviewActionsBar({ callId }: { callId: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [acting, setActing] = useState<string | null>(null)

  const run = (kind: "share" | "flag") => {
    setActing(kind)
    setMsg(null)
    startTransition(async () => {
      const r = kind === "share"
        ? await shareCallWithCoach({ callId })
        : await flagCallForCompliance({ callId })
      setMsg(r.success
        ? { ok: true, text: kind === "share" ? "Shared — your coach has been notified." : "Flagged — it's on the compliance ledger for review." }
        : { ok: false, text: r.error ?? "That didn't go through." })
      setActing(null)
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" className="gap-2" onClick={() => run("share")} disabled={pending}>
        {pending && acting === "share" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
        Share with Coach
      </Button>
      <Button variant="outline" className="gap-2" onClick={() => run("flag")} disabled={pending}>
        {pending && acting === "flag" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}
        Flag for Compliance
      </Button>
      {msg && (
        <span className={`inline-flex items-center gap-1 text-sm ${msg.ok ? "text-green-700" : "text-red-600"}`}>
          {msg.ok && <CheckCircle2 className="h-4 w-4" />} {msg.text}
        </span>
      )}
    </div>
  )
}
