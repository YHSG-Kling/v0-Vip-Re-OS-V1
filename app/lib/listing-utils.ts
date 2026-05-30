/**
 * Listing display utilities.
 *
 * DOM helper delegates to the canonical `lib/listings/compute-dom.ts` so
 * every surface reads from listings.go_live_date — the only date that
 * maps to industry DOM convention.
 */

import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

/**
 * @deprecated Pass `go_live_date` from the listings table. The parameter
 *             name `listingDate` is kept for back-compat with callers but
 *             semantically the value MUST be `go_live_date`, not the
 *             contract signature date (`listing_date`).
 */
export function calculateDaysOnMarket(goLiveDate: string | null): number | null {
  return computeDaysOnMarket(goLiveDate)
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(price)
}
