/**
 * lib/marketing/marketing-qr.ts
 *
 * Tracked QR for PRINT / digital marketing material — listing flyers, the listing packet,
 * open-house flyers, just-sold flyers, CMAs. Same backend as the video outro QR and postcards
 * (qr_codes + /api/qr/scan?slug= resolver) via the shared tracked-QR core. This module only owns the
 * material KIND → destination mapping; mintTrackedQr does the DB write + PNG encode.
 *
 * Every code is IDEMPOTENT per (listing/brokerage, kind) so re-generating a packet reuses the same
 * tracked code, and uses only destination_type values the video path already proved enum-valid.
 */
import "server-only"
import { mintTrackedQr, normalizeOrigin, type MintedTrackedQr } from "./tracked-qr"
import { createServiceClient } from "@/lib/supabase/service"

export type MarketingQrKind =
  | "listing_flyer"
  | "listing_packet"
  | "open_house_flyer"
  | "just_sold_flyer"
  | "cma"

/** enum-valid destination_type subset (all already emitted by the video path). */
export type MarketingQrDestinationType = "listing_detail" | "book_meeting" | "landing_page"

export interface MarketingQrRefs {
  listingId?: string | null
  /** agent public slug — drives the CMA / home-value landing URL. */
  agentSlug?: string | null
}

export interface MarketingQrDestination {
  destinationType: MarketingQrDestinationType
  buildTargetUrl: (origin: string, refs: MarketingQrRefs) => string
}

/** PURE: marketing material kind → destination_type + target-URL builder. No I/O. */
export function qrDestinationForMaterial(kind: MarketingQrKind): MarketingQrDestination {
  switch (kind) {
    case "listing_flyer":
    case "listing_packet":
    case "just_sold_flyer":
      return {
        destinationType: "listing_detail",
        buildTargetUrl: (o, r) =>
          r.listingId ? `${normalizeOrigin(o)}/listings/${r.listingId}` : `${normalizeOrigin(o)}/listings`,
      }
    case "open_house_flyer":
      return {
        destinationType: "book_meeting",
        buildTargetUrl: (o, r) =>
          r.listingId ? `${normalizeOrigin(o)}/listings/${r.listingId}/rsvp` : `${normalizeOrigin(o)}/book`,
      }
    case "cma":
      return {
        destinationType: "landing_page",
        buildTargetUrl: (o, r) =>
          r.agentSlug ? `${normalizeOrigin(o)}/home-value/${r.agentSlug}` : `${normalizeOrigin(o)}/home-value`,
      }
  }
}

export interface MintMarketingQrArgs extends MarketingQrRefs {
  brokerageId: string
  /** agents.id (qr_codes.agent_id FK → agents.id). */
  agentId?: string | null
  kind: MarketingQrKind
  origin?: string
}

/**
 * mintMarketingQr — IDEMPOTENT per (entity, kind), NEVER throws (returns null → render without QR).
 * The entity is the listing when present, else the brokerage (a generic brand piece).
 */
export async function mintMarketingQr(
  args: MintMarketingQrArgs,
  client?: ReturnType<typeof createServiceClient>,
): Promise<MintedTrackedQr | null> {
  if (!args.brokerageId) return null
  const dest = qrDestinationForMaterial(args.kind)
  const entity = args.listingId ?? args.brokerageId
  return mintTrackedQr(
    {
      brokerageId: args.brokerageId,
      agentId: args.agentId ?? null,
      label: `material:${args.kind}:${entity}`,
      destinationType: dest.destinationType,
      targetUrl: dest.buildTargetUrl(normalizeOrigin(args.origin), args),
      listingId: args.listingId ?? null,
      purpose: args.kind === "open_house_flyer" ? "open_house" : "listing",
      origin: args.origin,
    },
    client,
  )
}
