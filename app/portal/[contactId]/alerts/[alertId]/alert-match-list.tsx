"use client"

import { useState } from "react"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { markResultViewed } from "@/app/actions/property-alerts/alert-actions"
// RENDER BOUNDARY (§6) — `is_price_reduction` is the INTERNAL column name and
// stays. This is the CLIENT PORTAL, so the badge the buyer reads is the public
// word. Owner ruling: public = price improvement.
import { priceImprovementLabel } from "@/lib/listings/price-improvement-label"

interface Result {
  id: string
  property_address: string
  city?: string | null
  list_price?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  match_score?: number | null
  match_reasons?: string[] | null
  is_price_reduction?: boolean | null
  is_new_listing?: boolean | null
  buyer_viewed?: boolean | null
  listing_url?: string | null
  primary_photo_url?: string | null
}

/**
 * The buyer's list of matches, and the one place `markResultViewed` is called.
 *
 * That action was complete and had ZERO callers anywhere in the repo, so
 * property_alert_results.buyer_viewed was never set: the agent's "unviewed"
 * badge and "Not viewed" filter counted up forever and could never come down.
 * Opening a match is the honest viewed signal, so it fires here.
 *
 * It is best-effort ON PURPOSE and says so: failing to record a view must never
 * stop the buyer from opening the listing they were emailed about. The optimistic
 * local flag is reverted if the write is refused, so the UI does not claim a
 * record that does not exist.
 */
export function AlertMatchList({ contactId, results }: { contactId: string; results: Result[] }) {
  const [viewed, setViewed] = useState<Record<string, boolean>>(
    Object.fromEntries(results.map((r) => [r.id, !!r.buyer_viewed])),
  )

  const open = async (r: Result) => {
    if (r.listing_url) window.open(r.listing_url, "_blank", "noopener,noreferrer")
    if (viewed[r.id]) return
    setViewed((v) => ({ ...v, [r.id]: true }))
    const res = await markResultViewed(r.id, contactId)
    if (!res.success) setViewed((v) => ({ ...v, [r.id]: false }))
  }

  if (results.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        Nothing new right now. We check continuously and will email you the moment
        a home matches.
      </p>
    )
  }

  const money = (n?: number | null) =>
    n == null
      ? "Price on request"
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

  return (
    <div className="divide-y rounded-md border">
      {results.map((r) => (
        <div key={r.id} className="p-3 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium leading-snug">
              {r.property_address}
              {r.city ? `, ${r.city}` : ""}
            </p>
            <div className="flex gap-1 shrink-0">
              {r.is_price_reduction && (
                <Badge variant="destructive" className="text-[10px]">{priceImprovementLabel("badge")}</Badge>
              )}
              {r.is_new_listing && <Badge className="text-[10px] bg-green-600">New</Badge>}
              {!viewed[r.id] && <Badge variant="outline" className="text-[10px]">Unseen</Badge>}
            </div>
          </div>
          <p className="text-sm font-semibold text-primary">
            {money(r.list_price)}
            {r.bedrooms ? ` · ${r.bedrooms} bd` : ""}
            {r.bathrooms ? ` · ${r.bathrooms} ba` : ""}
            {r.sqft ? ` · ${r.sqft.toLocaleString()} sqft` : ""}
          </p>
          {(r.match_reasons ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {r.match_reasons!.slice(0, 3).map((reason, i) => (
                <span key={i} className="text-xs bg-muted px-2 py-0.5 rounded-full">{reason}</span>
              ))}
            </div>
          )}
          {r.listing_url && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => open(r)}>
              View this home &nearr;
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
