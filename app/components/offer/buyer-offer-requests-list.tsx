"use client"

// app/components/offer/buyer-offer-requests-list.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE AGENT-FACING READER for `offer_intents` (m619). Renders the buyer's
// portal "submit an offer" clicks (app/actions/buyer-offer-tools.ts
// recordOfferIntent) as a durable, actionable queue — acknowledge, dismiss, or
// start the real offer (which bridges this row to the new offer on success;
// see app/actions/buyer-offers.ts::createOffer's OFFER_INTENT BRIDGE).
//
// Used in two places:
//   · app/crm/contacts/[contactId]/offers — scoped to one buyer (showLinkToContact=false)
//   · app/dashboard/offers — the agent's whole queue across every assigned buyer
//     (showLinkToContact=true, so each row can jump to the right buyer)

import { useState, useTransition } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { acknowledgeOfferIntent, dismissOfferIntent, type OfferIntentRow } from "@/app/actions/offer-intents"
import { Loader2, Check, X, FileEdit } from "lucide-react"

interface BuyerOfferRequestsListProps {
  initialIntents: OfferIntentRow[]
  /** When true, each row links to its buyer's contact page (the aggregate
   *  /dashboard/offers queue). When false, the caller already scopes the list
   *  to one contact, so only the "Start Offer" action links out. */
  showLinkToContact?: boolean
  emptyMessage?: string
}

const STATUS_LABEL: Record<string, string> = {
  requested: "New request",
  acknowledged: "Acknowledged",
}

export function BuyerOfferRequestsList({
  initialIntents,
  showLinkToContact = false,
  emptyMessage = "No pending buyer offer requests.",
}: BuyerOfferRequestsListProps) {
  const [intents, setIntents] = useState<OfferIntentRow[]>(initialIntents)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function act(id: string, fn: () => Promise<{ success: boolean; error?: string }>) {
    setError(null)
    setPendingId(id)
    startTransition(async () => {
      const result = await fn()
      setPendingId(null)
      if (result.success) {
        setIntents((prev) => prev.filter((i) => i.id !== id))
      } else {
        setError(result.error ?? "That didn't go through — try again.")
      }
    })
  }

  if (intents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {intents.map((intent) => {
        const busy = isPending && pendingId === intent.id
        const startOfferHref =
          `/crm/contacts/${intent.contact_id}/offers/new` +
          `?intentId=${encodeURIComponent(intent.id)}` +
          (intent.property_address ? `&propertyAddress=${encodeURIComponent(intent.property_address)}` : "") +
          (intent.listing_id ? `&listingId=${encodeURIComponent(intent.listing_id)}` : "")
        return (
          <div
            key={intent.id}
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                {showLinkToContact ? (
                  <Link href={`/crm/contacts/${intent.contact_id}`} className="text-sm font-medium hover:underline">
                    {intent.contact_name}
                  </Link>
                ) : (
                  <span className="text-sm font-medium">{intent.contact_name}</span>
                )}
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                    intent.status === "requested"
                      ? "bg-amber-100 border-amber-300 text-amber-800"
                      : "bg-blue-50 border-blue-200 text-blue-700",
                  )}
                >
                  {STATUS_LABEL[intent.status] ?? intent.status}
                </span>
                {intent.listing_id && (
                  <span className="text-[10px] text-muted-foreground">Brokerage listing</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                wants to submit an offer on {intent.property_address || "a property"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {new Date(intent.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {intent.status === "requested" && (
                <button
                  onClick={() => act(intent.id, () => acknowledgeOfferIntent(intent.id))}
                  disabled={busy}
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50 transition-colors flex items-center gap-1"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Acknowledge
                </button>
              )}
              <Link
                href={startOfferHref}
                className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors flex items-center gap-1"
              >
                <FileEdit className="h-3 w-3" />
                Start Offer
              </Link>
              <button
                onClick={() => act(intent.id, () => dismissOfferIntent(intent.id))}
                disabled={busy}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors flex items-center gap-1"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                Dismiss
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
