/**
 * <ListingAttribution /> — renders the ONE attribution line every RentCast-
 * (or IDX-/BatchData-/Perplexity-) fed listing display must carry.
 *
 * See lib/listings/attribution.ts for the ruling, the wording and why each
 * source maps where it does. Renders nothing for a platform/own listing —
 * an empty attribution line is the correct output, not a bug.
 *
 * Server- and client-safe: no hooks, no "use client" directive needed, no I/O.
 */

import { listingAttributionLine, type ListingAttributionSource } from "@/lib/listings/attribution"

export function ListingAttribution({
  source,
  className,
}: {
  source: ListingAttributionSource
  className?: string
}) {
  const line = listingAttributionLine(source)
  if (!line) return null
  return (
    <span className={className ?? "text-[11px] text-muted-foreground"} data-listing-attribution={source ?? "none"}>
      {line}
    </span>
  )
}
