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
  /** When true AND a NEW code was minted, notify the owner to confirm/assign the destination URL. */
  notifyOwner?: boolean
  /** human label for the notification body, e.g. the property address. */
  materialName?: string
}

const MATERIAL_LABELS: Record<MarketingQrKind, string> = {
  listing_flyer: "listing flyer",
  listing_packet: "listing packet",
  open_house_flyer: "open-house flyer",
  just_sold_flyer: "just-sold flyer",
  cma: "CMA",
}

/**
 * Tell the human who owns the piece to open the QR assignment page and confirm/customize the
 * destination URL. The auto-derived URL is a sensible default (the listing page), but the owner may
 * want it to point elsewhere (a landing page, a booking link). Routes to the AGENT who owns the
 * material; with NO agent, falls back to the brokerage's broker-admins. Best-effort, never throws.
 */
async function notifyOwnerToAssignUrl(
  svc: ReturnType<typeof createServiceClient>,
  args: { brokerageId: string; agentId?: string | null; kind: MarketingQrKind; qrCodeId: string; materialName?: string },
): Promise<void> {
  try {
    const piece = MATERIAL_LABELS[args.kind]
    const where = args.materialName ? ` for ${args.materialName}` : ""
    const body = `A QR code was added to your ${piece}${where}. Open the QR assignment page (Agent → QR Codes) to confirm or change where it points.`

    // Resolve the owning agent's user; else the brokerage's broker-admins.
    const recipients: string[] = []
    if (args.agentId) {
      const { data: a } = await svc.from("agents").select("user_id").eq("id", args.agentId).maybeSingle()
      const uid = (a as { user_id?: string | null } | null)?.user_id ?? null
      if (uid) recipients.push(uid)
    }
    if (recipients.length === 0) {
      const { data: admins } = await svc
        .from("users").select("id")
        .eq("brokerage_id", args.brokerageId)
        .in("user_type", ["broker_admin", "admin", "broker", "superadmin"])
      for (const u of admins ?? []) recipients.push(u.id)
    }

    for (const userId of recipients) {
      await svc.from("notifications").insert({
        user_id: userId,
        brokerage_id: args.brokerageId,
        type: "qr_url_assignment_needed",
        title: "Assign a destination for a new QR code",
        body,
        entity_type: "qr_code",
        entity_id: args.qrCodeId,
        priority: "medium",
        channel: "in_app",
      })
    }
  } catch {
    /* best-effort */
  }
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
  const svc = client ?? createServiceClient()
  const minted = await mintTrackedQr(
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
    svc,
  )

  // Only on a NEWLY minted code (never on idempotent re-use) tell the owner to confirm/assign the URL.
  if (minted?.created && args.notifyOwner) {
    await notifyOwnerToAssignUrl(svc, {
      brokerageId: args.brokerageId,
      agentId: args.agentId ?? null,
      kind: args.kind,
      qrCodeId: minted.qrCodeId,
      materialName: args.materialName,
    })
  }

  return minted
}
