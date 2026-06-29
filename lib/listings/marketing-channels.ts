// lib/listings/marketing-channels.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE, HONEST marketing-channel status for the seller portal's "Marketing Live Now" card.
//
// The old card hard-coded MLS / Zillow / Realtor.com as "live" whenever listing.status==='active' — a
// status we CANNOT verify (there is no syndication-tracking table) and that was even shown as live when
// the listing had no MLS number at all. The seller portal's whole premise is honesty, so every channel
// here is grounded in a REAL signal:
//
//   Your Listing Page → live when we host a public slug (we publish it — verifiable).
//   MLS               → live only when a real MLS number is on file (it's genuinely on the MLS).
//   Zillow / Realtor  → live when MLS is (they IDX-syndicate FROM the MLS feed); else "scheduled".
//   Instagram/Facebook→ live when a real published social post exists.
//   Ad Campaigns      → live when an active marketing campaign is running.
//
// When a signal isn't there yet, the channel reads "scheduled" (Coming Soon) — honest, and it flips to
// live automatically the moment the real data lands (the broker enters the MLS #, a post publishes…).
// No I/O — unit-testable; the page feeds it the live facts.

export type ChannelStatus = "live" | "scheduled"
export interface MarketingChannel { name: string; status: ChannelStatus; description?: string }

export interface MarketingChannelInput {
  /** A real MLS number on the listing — present means it's genuinely on the MLS. */
  mlsNumber: string | null
  /** The public listing-page slug we host (verifiably live when present). */
  listingSlug: string | null
  /** A published Instagram post exists for this listing. */
  instagramLive: boolean
  /** A published Facebook post exists for this listing. */
  facebookLive: boolean
  /** Count of ACTIVE marketing campaigns running for this listing. */
  activeCampaignCount: number
}

/** PURE. Build the seller-facing channel list with statuses grounded in verifiable signals only. */
export function buildListingMarketingChannels(input: MarketingChannelInput): MarketingChannel[] {
  const onMls = !!input.mlsNumber?.trim()
  const channels: MarketingChannel[] = []

  // We host the listing page, so its "live" is provable when a slug exists.
  if (input.listingSlug?.trim()) {
    channels.push({ name: "Your Listing Page", status: "live", description: "Your home's dedicated page is live." })
  }

  // MLS + the portals that syndicate from it — grounded in a real MLS number, never just 'active'.
  channels.push({ name: "MLS", status: onMls ? "live" : "scheduled" })
  channels.push({ name: "Zillow", status: onMls ? "live" : "scheduled", description: onMls ? "Syndicated from the MLS." : undefined })
  channels.push({ name: "Realtor.com", status: onMls ? "live" : "scheduled", description: onMls ? "Syndicated from the MLS." : undefined })

  if (input.instagramLive) channels.push({ name: "Instagram", status: "live" })
  if (input.facebookLive) channels.push({ name: "Facebook", status: "live" })
  if (input.activeCampaignCount > 0) {
    channels.push({ name: "Ad Campaigns", status: "live", description: `${input.activeCampaignCount} active campaign${input.activeCampaignCount === 1 ? "" : "s"}.` })
  }

  return channels
}
