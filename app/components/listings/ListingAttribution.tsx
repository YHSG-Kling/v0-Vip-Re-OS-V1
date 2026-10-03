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

import { listingAttributionLine, listingAttributionHref, type ListingAttributionSource } from "@/lib/listings/attribution"

export function ListingAttribution({
  source,
  className,
}: {
  source: ListingAttributionSource
  className?: string
}) {
  const line = listingAttributionLine(source)
  if (!line) return null
  // A RentCast line links to RentCast's governing Terms of Use (verified live
  // 2026-09-18, lane 76C — lib/listings/attribution.ts RENTCAST_TERMS_URL);
  // sources with no verified terms page render the plain sentence.
  const href = listingAttributionHref(source)
  return (
    <span className={className ?? "text-[11px] text-muted-foreground"} data-listing-attribution={source ?? "none"}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
          {line}
        </a>
      ) : (
        line
      )}
    </span>
  )
}
