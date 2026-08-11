"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Layers, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react"
// The LIMIT gate, aliased so this call site cannot be confused with the
// LIFECYCLE gate (`canBuyerSubmitOffers`, plural, in buyer-lifecycle-core.ts).
// Both are real, they answer different questions, and their names are one letter
// apart — see the note at the top of handle-multi-offer.ts.
import {
  canBuyerSubmitOffer as checkPendingOfferLimit,
  getBuyerActiveOffers,
} from "@/app/actions/buyer-offer/handle-multi-offer"
import { MAX_PENDING_OFFERS, limitProximity, type LimitProximity } from "@/lib/offers/multi-offer-rules"

interface ActiveOffer { offer_id: string; listing_id: string; listing_address: string; state: string }

const STYLE: Record<LimitProximity, { card: string; icon: typeof Layers; label: string }> = {
  clear:       { card: "border-emerald-200 bg-emerald-50/60", icon: CheckCircle2, label: "Within limit" },
  approaching: { card: "border-amber-200 bg-amber-50/60",     icon: AlertTriangle, label: "Approaching limit" },
  at_limit:    { card: "border-red-200 bg-red-50/60",         icon: AlertTriangle, label: "At limit" },
}

/**
 * Multi-offer governance status for a buyer (System 7.1A Domain 2).
 *
 * READ-ONLY, AND HONEST ABOUT BEING READ-ONLY. It surfaces how many of the
 * buyer's MAX_PENDING_OFFERS pending slots are used so the agent sees the limit
 * BEFORE starting another offer. It does not block creation and never could —
 * this is a browser. The cap is ENFORCED where the offer row is actually
 * written, app/actions/buyer-offers.ts:createOffer, which binds this same limit
 * gate plus the lifecycle gate.
 *
 * BOTH SERVER ACTIONS BEHIND THIS ARE NOW SESSION- AND TENANT-GATED. They were
 * not: `getBuyerActiveOffers` was called from here with a bare `contactId` and
 * read through a service-role client with no auth at all, which made this
 * component's own endpoint a way for any signed-in browser to read another
 * brokerage's buyer's live offers. Gating them means they can now REFUSE, and a
 * refusal must not render as a clean "0 pending" — every table is empty
 * pre-rollout, so a silent empty is exactly what a refusal looks like.
 */
export function MultiOfferStatusBanner({ contactId }: { contactId: string }) {
  const [pending, setPending] = useState<number | null>(null)
  const [canSubmit, setCanSubmit] = useState(true)
  const [active, setActive] = useState<ActiveOffer[]>([])
  /** The limit check did not run. Never rendered as a count. */
  const [limitError, setLimitError] = useState<string | null>(null)
  /** The active-offer list did not run — an empty list here means nothing. */
  const [listError, setListError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [limit, list] = await Promise.all([checkPendingOfferLimit(contactId), getBuyerActiveOffers(contactId)])
      if (cancelled) return
      if (limit.success) {
        setPending(limit.pending_count ?? 0)
        setCanSubmit(limit.can_submit)
        setLimitError(null)
      } else {
        setPending(null)
        setLimitError(limit.reason ?? "the pending-offer check did not run")
      }
      if (list.success && list.offers) {
        setActive(list.offers as ActiveOffer[])
        setListError(null)
      } else if (!list.success) {
        setActive([])
        setListError(list.error ?? "this buyer's active offers could not be read")
      }
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [contactId])

  if (!loaded) return null

  // THE CHECK DID NOT RUN. Say so, and say where the limit still binds — showing
  // nothing at all would read as "no pending offers", which is the one thing an
  // unreadable count cannot tell us.
  if (limitError !== null) {
    return (
      <Card className="border-amber-200 bg-amber-50/60">
        <CardContent className="py-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            <div className="text-sm">
              <span className="font-medium">Pending-offer status unavailable</span>
              <span className="text-muted-foreground"> — {limitError}.</span>
              <div className="text-xs text-muted-foreground mt-1">
                This is not a count of zero. The {MAX_PENDING_OFFERS}-offer limit is still enforced when the
                offer is created, and creation will refuse while the count cannot be read.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  const proximity = limitProximity(pending ?? 0)
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
            <span className="text-xs text-red-600">
              Withdraw or resolve a pending offer before submitting another — creating one will be refused.
            </span>
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
        {listError !== null && (
          <div className="mt-2 text-xs text-amber-700">
            The list of this buyer&apos;s active offers could not be read ({listError}), so none are shown —
            that is not the same as having none.
          </div>
        )}
      </CardContent>
    </Card>
  )
}
