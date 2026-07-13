"use client"

/**
 * "DEAL FEELS SHAKY" toggle (concierge micro-detail) — the agent's gut,
 * made structural: while on, every earned autonomy grant is SUSPENDED for
 * this file (derived dates go back to human proposals) and the flag lands
 * on the ledger. Self-contained: loads and writes through its own actions.
 */

import { useEffect, useState, useTransition } from "react"
import { ShieldAlert, Loader2 } from "lucide-react"
import { getDealShakyAction, setDealShakyAction } from "@/app/actions/deal-shaky"

export function DealShakyToggle({ transactionId }: { transactionId: string }) {
  const [shaky, setShaky] = useState<boolean | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    getDealShakyAction({ transactionId }).then((r) => { if (r.ok) setShaky(r.shaky) }).catch(() => {})
  }, [transactionId])

  if (shaky === null) return null

  const toggle = () => {
    startTransition(async () => {
      const r = await setDealShakyAction({ transactionId, shaky: !shaky })
      if (r.ok) setShaky(r.shaky)
    })
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      title="While flagged, the AI team slows down on this file: earned autonomy is suspended and every derived date comes back as a proposal."
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
        shaky
          ? "border-amber-400 bg-amber-50 font-medium text-amber-900"
          : "text-muted-foreground hover:bg-muted/50"
      }`}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldAlert className="h-3 w-3" />}
      {shaky ? "Deal flagged shaky — AI on manual" : "Deal feels shaky?"}
    </button>
  )
}
