"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Layers, AlertTriangle, CheckCircle2 } from "lucide-react"
import { canBuyerSubmitOffer, getBuyerActiveOffers } from "@/app/actions/buyer-offer/handle-multi-offer"
import { MAX_PENDING_OFFERS, limitProximity, type LimitProximity } from "@/lib/offers/multi-offer-rules"

interface ActiveOffer { offer_id: string; listing_id: string; listing_address: string; state: string }

const STYLE: Record<LimitProximity, { card: string; icon: typeof Layers; label: string }> = {
  clear:       { card: "border-emerald-200 bg-emerald-50/60", icon: CheckCircle2, label: "Within limit" },
  approaching: { card: "border-amber-200 bg-amber-50/60",     icon: AlertTriangle, label: "Approaching limit" },
  at_limit:    { card: "border-red-200 bg-red-50/60",         icon: AlertTriangle, label: "At limit" },
}

/**
 * Multi-offer governance status for a buyer (System 7.1A Domain 2). Read-only:
 * surfaces how many of the buyer's MAX_PENDING_OFFERS pending slots are used so the
 * agent sees the limit BEFORE starting another offer. Does not block creation.
 */
export function MultiOfferStatusBanner({ contactId }: { contactId: string }) {
  const [pending, setPending] = useState<number | null>(null)
  const [canSubmit, setCanSubmit] = useState(true)
  const [active, setActive] = useState<ActiveOffer[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [limit, list] = await Promise.all([canBuyerSubmitOffer(contactId), getBuyerActiveOffers(contactId)])
      if (cancelled) return
      if (limit.success) { setPending(limit.pending_count ?? 0); setCanSubmit(limit.can_submit) }
      if (list.success && list.offers) setActive(list.offers as ActiveOffer[])
    })()
    return () => { cancelled = true }
  }, [contactId])

  if (pending === null) return null

  const proximity = limitProximity(pending)
  const meta = STYLE[proximity]
  const Icon = meta.icon

  return (
    <Card className={meta.card}>
      <CardContent className="py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Pending offers: {pending} / {MAX_PENDING_OFFERS}</span>
            <Badge variant="outline" className="text-xs gap-1"><Icon className="h-3 w-3" />{meta.label}</Badge>
          </div>
          {!canSubmit && (
            <span className="text-xs text-red-600">Resolve a pending offer before submitting another.</span>
          )}
        </div>
        {active.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {active.map((o) => (
              <Link
                key={o.offer_id}
                href={`/crm/contacts/${contactId}/offers/${o.offer_id}`}
                className="text-xs rounded border px-2 py-1 hover:bg-background"
              >
                {o.listing_address} · {o.state.replace(/_/g, " ").toLowerCase()}
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
