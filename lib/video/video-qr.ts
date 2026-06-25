/**
 * lib/video/video-qr.ts
 *
 * Scannable, TRACKED QR for the OUTRO of AI-made videos.
 *
 * This REUSES the existing QR backend — the same `qr_codes` + `qr_scan_events`
 * tables, the same dynamic indirection resolver at /api/qr/scan?slug= (the slug
 * never goes stale; target_url is editable), and the same m148 destination_type
 * enum that postcards already use. NOTHING new is added to the schema.
 *
 * Two pieces:
 *
 *   qrDestinationForKind(kind)
 *     PURE map from a video KIND to a { destinationType, buildTargetUrl } pair.
 *     just_listed/just_sold → listing_detail (the public listing page)
 *     open_house            → book_meeting   (the RSVP/booking link)
 *     presentation_chapter  → video_avatar_tour
 *     anniversary           → anniversary_video (the portal equity card)
 *     newsletter            → landing_page
 *
 *   mintVideoQr({ ... }, client?)
 *     Records (or REUSES) a qr_codes row for (entity, kind) and returns the
 *     slug + scan URL + a PNG data URL (QRCode.toDataURL) the Remotion outro
 *     overlay drops into an <Img>. IDEMPOTENT per (entity, kind): a re-render
 *     looks up the existing row by its deterministic label first so the SAME
 *     tracked code rides every render of the same video. NEVER throws — a video
 *     must still render even when minting fails (returns null → outro skips QR).
 *
 * The mint writes via the SERVICE client (the producers run in cron/server
 * context). It mirrors createQrCodeAction's insert shape (app/actions/
 * marketing-studio.ts ~L1002) but additionally stamps destination_type +
 * listing_id/contact_id so analytics can bucket video-tour scans by destination
 * — exactly like the direct-mail path stamps destination_type post-insert
 * (app/actions/ai-direct-mail.ts).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { mintTrackedQr, normalizeOrigin } from "@/lib/marketing/tracked-qr"

/** Canonical video kinds that carry a tracked outro QR. */
export type VideoQrKind =
  | "just_listed"
  | "just_sold"
  | "open_house"
  | "presentation_chapter"
  | "anniversary"
  | "newsletter"
  | "lead_intro"

/** m148 destination_type values this module emits (subset of the enum). */
export type VideoQrDestinationType =
  | "listing_detail"
  | "book_meeting"
  | "video_avatar_tour"
  | "anniversary_video"
  | "landing_page"

export interface VideoQrEntityRefs {
  /** Listing the video promotes — drives listing_detail / book_meeting URLs. */
  listingId?: string | null
  /** Contact the video is addressed to — drives anniversary portal URL. */
  contactId?: string | null
  /** Marketing/newsletter campaign id — drives the newsletter landing URL. */
  campaignId?: string | null
  /** Pre-conversion LEAD the intro reel is addressed to — drives the lead_intro
   *  idempotency entity (a lead has no listing/contact yet). The QR itself lands on
   *  the brokerage's general book-a-consult page (no per-lead PII in the URL). */
  leadId?: string | null
}

export interface VideoQrDestination {
  destinationType: VideoQrDestinationType
  /** Builds the SEMANTIC target the scan ultimately lands on. The QR itself
   *  always encodes the /api/qr/scan?slug= redirector — this URL is stored as
   *  qr_codes.target_url so the resolver can edit it without reprinting. */
  buildTargetUrl: (origin: string, refs: VideoQrEntityRefs) => string
}

/**
 * qrDestinationForKind — PURE. Maps a video kind to its destination_type + a
 * target-URL builder. No I/O, no DB, no env reads beyond the passed origin.
 */
export function qrDestinationForKind(kind: VideoQrKind): VideoQrDestination {
  switch (kind) {
    case "just_listed":
    case "just_sold":
      return {
        destinationType: "listing_detail",
        buildTargetUrl: (origin, refs) =>
          refs.listingId
            ? `${normalizeOrigin(origin)}/listings/${refs.listingId}`
            : `${normalizeOrigin(origin)}/listings`,
      }
    case "open_house":
      return {
        destinationType: "book_meeting",
        buildTargetUrl: (origin, refs) =>
          refs.listingId
            ? `${normalizeOrigin(origin)}/listings/${refs.listingId}/rsvp`
            : `${normalizeOrigin(origin)}/book`,
      }
    case "presentation_chapter":
      return {
        destinationType: "video_avatar_tour",
        buildTargetUrl: (origin, refs) =>
          refs.listingId
            ? `${normalizeOrigin(origin)}/tour/${refs.listingId}`
            : `${normalizeOrigin(origin)}/tour`,
      }
    case "anniversary":
      return {
        destinationType: "anniversary_video",
        buildTargetUrl: (origin, refs) =>
          refs.contactId
            ? `${normalizeOrigin(origin)}/portal/equity/${refs.contactId}`
            : `${normalizeOrigin(origin)}/portal`,
      }
    case "newsletter":
      return {
        destinationType: "landing_page",
        buildTargetUrl: (origin, refs) =>
          refs.campaignId
            ? `${normalizeOrigin(origin)}/n/${refs.campaignId}`
            : `${normalizeOrigin(origin)}`,
      }
    case "lead_intro":
      // A lead-addressed intro reel's CTA is "book a quick consult" — the general
      // booking page (no listing, no per-lead PII in the scannable URL). The /api/qr/scan
      // resolver still tracks the scan + lets the target be re-pointed without reprinting.
      return {
        destinationType: "book_meeting",
        buildTargetUrl: (origin) => `${normalizeOrigin(origin)}/book`,
      }
  }
}

export interface MintVideoQrArgs extends VideoQrEntityRefs {
  brokerageId: string
  agentUserId: string
  kind: VideoQrKind
  /** Origin for the scan + target URLs. Defaults to NEXT_PUBLIC_APP_URL. */
  origin?: string
}

export interface MintedVideoQr {
  qrCodeId: string
  slug: string
  /** The /api/qr/scan?slug= URL the QR PNG actually encodes. */
  scanUrl: string
  /** data:image/png;base64,... ready for a Remotion <Img>. */
  qrCodeDataUrl: string
  destinationType: VideoQrDestinationType
}

type AnyClient = ReturnType<typeof createServiceClient>

/**
 * Deterministic idempotency key for (entity, kind). A re-render of the same
 * video resolves to the SAME qr_codes row via this label, so scans accrue to
 * one tracked code across re-renders. The chosen entity is the listing (most
 * video kinds), then the contact (anniversary), then the campaign (newsletter),
 * then the brokerage as a last resort.
 */
function videoQrLabel(args: MintVideoQrArgs): string {
  const entity =
    args.listingId ??
    args.contactId ??
    args.leadId ??
    args.campaignId ??
    args.brokerageId
  return `video:${args.kind}:${entity}`
}

/**
 * mintVideoQr — IDEMPOTENT per (entity, kind), NEVER throws.
 *
 * 1. Look up an existing qr_codes row by the deterministic label. If found,
 *    re-encode its slug and return (re-render reuses the tracked code).
 * 2. Otherwise insert a new active row with the right destination_type +
 *    listing_id/contact_id, then patch target_url to the canonical scan URL
 *    (the slug is only known after insert).
 * 3. Encode /api/qr/scan?slug= to a PNG data URL with QRCode.toDataURL
 *    (errorCorrectionLevel "M" — the same settings the postcard path uses).
 *
 * Returns null on ANY failure so the caller renders the video without a QR.
 */
export async function mintVideoQr(
  args: MintVideoQrArgs,
  client?: AnyClient,
): Promise<MintedVideoQr | null> {
  if (!args.brokerageId || !args.agentUserId) return null
  const dest = qrDestinationForKind(args.kind)
  // Delegate the DB write + PNG encode to the shared tracked-QR core; this module only owns the
  // video KIND→destination mapping + the idempotency label.
  const minted = await mintTrackedQr(
    {
      brokerageId: args.brokerageId,
      agentId: args.agentUserId,
      label: videoQrLabel(args),
      destinationType: dest.destinationType,
      targetUrl: dest.buildTargetUrl(normalizeOrigin(args.origin), args),
      listingId: args.listingId ?? null,
      purpose: "campaign",
      origin: args.origin,
    },
    client,
  )
  if (!minted) return null
  return {
    qrCodeId: minted.qrCodeId,
    slug: minted.slug,
    scanUrl: minted.scanUrl,
    qrCodeDataUrl: minted.qrCodeDataUrl,
    destinationType: dest.destinationType,
  }
}
